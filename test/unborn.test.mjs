// Arming in a repo with no commits yet, restoring from such a snapshot, and
// failing closed when the snapshot cannot be taken at all.
//
//   node --test test/unborn.test.mjs
//
// Drives the real probe-ctl (and the real OpenCode plugin against a stub ctx)
// in throwaway repos, with all state redirected to a temp directory.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTL = path.join(import.meta.dirname, '..', 'hooks', 'probe-ctl.mjs');
const GUARD = path.join(import.meta.dirname, '..', 'hooks', 'probe-guard.mjs');
const SID = 'unborn-test-session';

let ROOT, CFG, REPO;

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ctl = (...args) =>
  execFileSync(process.execPath, [CTL, ...args], {
    cwd: REPO, encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID },
  });
const statePath = () => path.join(CFG, 'probe-state', `${SID}.json`);
const state = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').trim();
const born = () => { try { git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); return true; } catch { return false; } };

/** `git init` + one untracked file, no commits: the reported repro. */
function freshUnbornRepo() {
  fs.rmSync(path.join(CFG, 'probe-state'), { recursive: true, force: true });
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(REPO, 'a.txt'), 'hi');
}

/** Runs the Claude guard against the armed session: "allow" or "deny". */
function guardDecision(toolName, toolInput) {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: SID, cwd: REPO, tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-unborn-'));
  CFG = path.join(ROOT, 'cfg');
  REPO = path.join(ROOT, 'repo');
});

after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

describe('start in a repo with no commits (Claude)', () => {
  test('arms, and snapshots the working tree as a parentless commit', () => {
    freshUnbornRepo();
    const out = ctl('start');
    assert.match(out, /PROBE MODE ON/);
    assert.doesNotMatch(out, /NONE/);

    const s = state();
    assert.equal(s.phase, 'probe');
    assert.equal(s.rounds.length, 1);
    assert.equal(s.rounds[0].head, null);
    assert.equal(s.rounds[0].branch, 'main', 'branch name comes from symbolic-ref on an unborn branch');

    const snap = s.rounds[0].ref;
    assert.equal(git(['rev-list', '--parents', '-n1', snap]), snap, 'snapshot has no parent');
    assert.equal(git(['show', `${snap}:a.txt`]), 'hi', 'untracked file is in the snapshot');
  });

  test('leaves the repo exactly as it was: still unborn, nothing staged', () => {
    assert.equal(born(), false);
    assert.equal(git(['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.equal(git(['status', '--porcelain']), '?? a.txt');
  });

  test('writes are blocked once armed', () => {
    assert.equal(guardDecision('Write', { file_path: path.join(REPO, 'b.txt') }), 'deny');
  });

  test('a second round on a still-unborn branch also snapshots', () => {
    const out = ctl('start');
    assert.match(out, /NEW RESEARCH ROUND 2/);
    const s = state();
    assert.equal(s.rounds.length, 2);
    assert.equal(s.rounds[1].head, null);
  });
});

describe('restore from a no-commit snapshot', () => {
  test('preview with no commits since: nothing to roll back, and it changes nothing', () => {
    freshUnbornRepo();
    ctl('start');
    fs.writeFileSync(path.join(REPO, 'a.txt'), 'edited');

    const out = ctl('restore');
    assert.match(out, /RESTORE PREVIEW/);
    assert.match(out, /main would go back to an empty history \(no commits\)/);
    assert.match(out, /No commits would be rolled back/);
    assert.match(out, /a\.txt/);
    assert.match(out, /--force/);
    assert.equal(read('a.txt'), 'edited', 'preview must not touch the worktree');
  });

  test('preview after commits lists them and says history goes back to empty', () => {
    git(['add', '-A']);
    git(['commit', '-qm', 'first']);
    fs.writeFileSync(path.join(REPO, 'a.txt'), 'second');
    git(['commit', '-qam', 'second']);

    const out = ctl('restore');
    assert.match(out, /2 commit\(s\) WOULD BE ROLLED BACK/);
    assert.match(out, /empty history/);
    assert.match(out, /first/);
    assert.match(out, /second/);
    assert.equal(born(), true, 'preview must not touch history');
    assert.equal(git(['rev-list', '--count', 'HEAD']), '2');
  });

  test('--force takes the branch back to unborn with the snapshot worktree', () => {
    const before = git(['rev-parse', 'HEAD']);
    const out = ctl('restore', '--force');
    assert.match(out, /Restored to/);
    assert.match(out, /2 commit\(s\) rolled back/);
    assert.equal(born(), false, 'branch is unborn again');
    assert.equal(git(['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.equal(read('a.txt'), 'hi');
    assert.equal(git(['status', '--porcelain']), '?? a.txt', 'index is empty again');
    assert.equal(state().undo.head, before);
  });

  test('--undo reverses it: commits and the latest worktree come back', () => {
    const preview = ctl('restore', '--undo');
    assert.match(preview, /RESTORE PREVIEW/);
    assert.equal(born(), false, 'undo preview changes nothing');

    ctl('restore', '--undo', '--force');
    assert.equal(born(), true);
    assert.equal(git(['log', '--format=%s', '-n2']), 'second\nfirst');
    assert.equal(read('a.txt'), 'second');
  });

  test('--force while still unborn clears files created since; --undo brings them back', () => {
    freshUnbornRepo();
    ctl('start');
    fs.writeFileSync(path.join(REPO, 'a.txt'), 'edited');
    fs.writeFileSync(path.join(REPO, 'b.txt'), 'new');

    ctl('restore', '--force');
    assert.equal(born(), false);
    assert.equal(read('a.txt'), 'hi');
    assert.equal(fs.existsSync(path.join(REPO, 'b.txt')), false);

    ctl('restore', '--undo', '--force');
    assert.equal(read('a.txt'), 'edited');
    assert.equal(read('b.txt'), 'new');
  });
});

describe('fail closed when the snapshot cannot be taken', () => {
  // A file where the refs/probe/ directory should be makes update-ref fail
  // after every other snapshot step has succeeded.
  const breakRefs = () => fs.writeFileSync(path.join(REPO, '.git', 'refs', 'probe'), '');

  test('start still arms, says there is no restore point, and blocks writes', () => {
    freshUnbornRepo();
    breakRefs();
    const out = ctl('start');
    assert.match(out, /PROBE MODE ON/);
    assert.match(out, /NONE — snapshot failed/);

    const s = state();
    assert.equal(s.phase, 'probe');
    assert.deepEqual(s.rounds, []);
    assert.ok(s.snapshotError);
    assert.equal(guardDecision('Write', { file_path: path.join(REPO, 'b.txt') }), 'deny');
  });

  test('restore explains why there is nothing to restore', () => {
    const out = ctl('restore');
    assert.match(out, /snapshotting failed/);
  });

  test('a new round from implementing still re-locks writes', () => {
    const s = state();
    s.phase = 'implementing';
    fs.writeFileSync(statePath(), JSON.stringify(s));
    assert.equal(guardDecision('Write', { file_path: path.join(REPO, 'b.txt') }), 'allow');

    const out = ctl('start');
    assert.match(out, /NEW RESEARCH ROUND 2/);
    assert.match(out, /NONE — snapshot failed/);
    assert.equal(state().phase, 'probe');
    assert.equal(guardDecision('Write', { file_path: path.join(REPO, 'b.txt') }), 'deny');
  });
});

describe('start in a repo with no commits (OpenCode)', () => {
  // The smallest ctx the plugin's setup() needs; `run` is the /probe command.
  async function loadPlugin(stateDir) {
    process.env.PROBE_STATE_DIR = stateDir;
    const { default: plugin } = await import('../opencode/index.mjs');
    const prompts = [];
    const updates = [];
    let run;
    const abort = { aborted: false };
    const ctx = {
      location: { directory: REPO },
      session: {
        get: async () => ({}),
        update: async (u) => { updates.push(u); },
        switchAgent: async () => {},
        prompt: async (p) => { prompts.push(p.text); },
        hook: async () => {},
      },
      agent: { transform: async () => {} },
      command: { transform: async (fn) => fn({ add: (c) => { run = c.execute; } }) },
      permission: { hook: async () => {} },
      tool: { hook: async () => {} },
      event: { subscribe: async function* () { while (!abort.aborted) return; } },
    };
    await plugin.setup(ctx);
    return { run, prompts, updates };
  }

  test('arms with a parentless snapshot and records head null', async () => {
    freshUnbornRepo();
    const stateDir = path.join(ROOT, 'oc-state');
    const { run, prompts } = await loadPlugin(stateDir);
    await run({ sessionID: 'oc-unborn', prompt: { text: 'why is this slow' } });

    const s = JSON.parse(fs.readFileSync(path.join(stateDir, 'oc-unborn.json'), 'utf8'));
    assert.equal(s.phase, 'probe');
    assert.equal(s.rounds[0].head, null);
    assert.equal(s.rounds[0].branch, 'main');
    assert.doesNotMatch(prompts.at(-1), /NONE/);
    assert.equal(born(), false);
  });

  test('fails closed: arms with no restore point when the snapshot fails', async () => {
    freshUnbornRepo();
    fs.writeFileSync(path.join(REPO, '.git', 'refs', 'probe'), '');
    const stateDir = path.join(ROOT, 'oc-state-broken');
    const { run, prompts, updates } = await loadPlugin(stateDir);
    await run({ sessionID: 'oc-broken', prompt: { text: 'a question' } });

    const s = JSON.parse(fs.readFileSync(path.join(stateDir, 'oc-broken.json'), 'utf8'));
    assert.equal(s.phase, 'probe');
    assert.deepEqual(s.rounds, []);
    assert.match(prompts.at(-1), /NONE — snapshot failed/);
    assert.ok(updates.some((u) => u.sessionID === 'oc-broken'), 'probe rules were installed');
  });
});
