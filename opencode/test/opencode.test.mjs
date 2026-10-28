// OpenCode host: command parsing, status/prompt text, and the phase -> rules
// lifecycle the plugin drives.
//
//   node --test opencode/test/opencode.test.mjs
//
// Everything here is pure (no plugin API, no server), so the same assertions
// hold whichever host reads the state. The enforcement itself is covered by
// test/rules.test.mjs against the real Claude guard.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CMD, SUBCOMMANDS, parseInvocation, statusText, phaseHint, armPrompt, implementPrompt,
  approvePrompt, restoreNotice, stopNotice, notice, RESTORE_WORDING, PRUNE_WORDING, sandboxFor, deniedMessageFor,
} from '../../opencode/lib.mjs';
import { sessionRules, matchEffect } from '../../shared/rules.mjs';
import {
  readState, writeState, normalizeRounds, roundRef, undoRef, heartbeat,
  pruneStateDir, LOCKED_PRUNE_DAYS, UNLOCKED_PRUNE_DAYS, DAY,
} from '../../shared/state.mjs';

const SID = 'oc-session';
const LOCATION = path.join('C:', path.sep, 'project');

let STATE_DIR, SANDBOX, PLANS, PROJECT;

before(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-opencode-'));
  STATE_DIR = path.join(root, 'probe-state');
  PROJECT = path.join(root, 'project');
  PLANS = path.join(root, 'plans');
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(PLANS, { recursive: true });
  SANDBOX = sandboxFor(STATE_DIR, SID);
});

after(() => {
  try { fs.rmSync(path.dirname(STATE_DIR), { recursive: true, force: true }); } catch {}
});

const rulesFor = (phase) =>
  sessionRules({
    phase,
    sandbox: SANDBOX,
    plansDir: PLANS,
    stateDir: STATE_DIR,
    locationDir: LOCATION,
    extraRoots: [path.join(LOCATION, '.probe-sandbox')],
  });

describe('command parsing', () => {
  test('bare and explicit start arm with the question', () => {
    assert.deepEqual(parseInvocation(''), { sub: 'start', args: [], question: '' });
    assert.deepEqual(parseInvocation('does batching help?'), {
      sub: 'start', args: [], question: 'does batching help?',
    });
    assert.deepEqual(parseInvocation('start does batching help?'), {
      sub: 'start', args: [], question: 'does batching help?',
    });
  });

  test('subcommands are recognized with their flags', () => {
    assert.equal(parseInvocation('status').sub, 'status');
    assert.equal(parseInvocation('STATUS').sub, 'status');
    assert.deepEqual(parseInvocation('restore --force --round 2').args, ['--force', '--round', '2']);
    assert.equal(parseInvocation('implement').sub, 'implement');
    assert.equal(parseInvocation('approve').sub, 'approve');
    assert.equal(parseInvocation('stop').sub, 'stop');
    assert.equal(parseInvocation('restore').sub, 'restore');
  });

  test('every advertised subcommand is handled', () => {
    for (const sub of SUBCOMMANDS) {
      const parsed = parseInvocation(sub);
      assert.equal(parsed.sub, sub);
    }
  });

  test('anything that is not a subcommand is the research question', () => {
    // Same ambiguity as Claude's /probe: the six subcommand words win, so a
    // question must not start with one (documented in the command table).
    const parsed = parseInvocation('question about batching');
    assert.equal(parsed.sub, 'start');
    assert.equal(parsed.question, 'question about batching');
  });
});

describe('status text', () => {
  const refExists = (ref) => ref === roundRef(SID, 1);

  test('never armed', () => {
    assert.equal(statusText(null, { sessionId: SID, refExists }), 'Probe mode: OFF');
  });

  test('armed session reports phase, sandbox and rounds', () => {
    const state = {
      phase: 'probe',
      round: 2,
      sandbox: SANDBOX,
      cwd: LOCATION,
      startedAt: '2026-01-01T00:00:00.000Z',
      rounds: [
        { n: 1, at: '2026-01-01T00:00:00.000Z', ref: 'aaa', head: 'h1', branch: 'main' },
        { n: 2, at: '2026-01-02T00:00:00.000Z', ref: 'bbb', head: 'h2', branch: 'main' },
      ],
    };
    const text = statusText(state, { sessionId: SID, refExists });
    assert.match(text, /Probe mode: probe \(round 2\)/);
    assert.match(text, new RegExp(`Sandbox: {2}${SANDBOX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(text, /round 1/);
    assert.match(text, /round 2/);
    assert.match(text, /!!\s+round 2/); // round 2 ref does not resolve in this stub
    assert.match(text, /\/probe implement/);
  });

  test('legacy state (bare snapshot, no rounds) still reports round 1', () => {
    const text = statusText(
      { phase: 'probe', sandbox: SANDBOX, cwd: LOCATION, snapshot: { ref: 'aaa', head: 'h', branch: 'main' } },
      { sessionId: SID, refExists: () => true },
    );
    assert.match(text, /\(round 1\)/);
    assert.match(text, /ok/);
  });

  test('each phase hints at the next step', () => {
    assert.match(phaseHint('probe'), /implement/);
    assert.match(phaseHint('planning'), /approv/);
    assert.match(phaseHint('implementing'), /restore/);
    assert.match(phaseHint('off'), /arms a new round/);
  });
});

describe('prompts name the paths and approval the user needs', () => {
  test('arm prompt carries sandbox, snapshot and the question', () => {
    const text = armPrompt({
      state: { round: 1, sandbox: SANDBOX, cwd: LOCATION },
      question: 'does batching help?',
      snapshotLine: 'abc123 (restorable via /probe restore)',
    });
    assert.match(text, /PROBE MODE ON \(round 1\)/);
    assert.match(text, /does batching help\?/);
    assert.match(text, /Snapshot: abc123/);
  });

  test('implement prompt points at the plan file and the approval dialog', () => {
    const text = implementPrompt({ plansFile: '/home/u/.opencode/plan/probe-x.md' });
    assert.match(text, /Writes are STILL blocked/);
    assert.match(text, /\/home\/u\/\.opencode\/plan\/probe-x\.md/);
    assert.match(text, /question` tool/);
    assert.match(text, /\/probe approve/);
  });

  test('approve prompt says execution is free now', () => {
    assert.match(approvePrompt(), /APPROVED/);
    assert.match(approvePrompt(), /No further approval is needed/);
    assert.match(stopNotice().description, /Snapshots are kept/);
    assert.match(stopNotice().text, /Return to your normal behavior/);
    assert.doesNotMatch(stopNotice().description, /normal behavior/);
  });

  test('arm without a question asks the user, not the model', () => {
    const text = armPrompt({ state: { round: 1, sandbox: SANDBOX, cwd: LOCATION }, question: '', snapshotLine: 'x' });
    assert.match(text, /Ask your question in the chat/);
    assert.doesNotMatch(text, /contract/);
  });

  test('a notice shows the body and tells the model which command ran', () => {
    const n = notice('status', 'Probe mode: OFF', 'model only');
    assert.equal(n.description, 'Probe mode: OFF');
    assert.equal(n.text, '[/probe status] Probe mode: OFF\n\nmodel only');
    assert.equal(notice('', 'armed').text, '[/probe] armed');
  });

  test('restore preview keeps the model from applying it; force does not', () => {
    const preview = restoreNotice({ text: 'RESTORE PREVIEW — nothing has been changed yet.', force: false });
    assert.match(preview.description, /RESTORE PREVIEW/);
    assert.doesNotMatch(preview.description, /do NOT apply/);
    assert.match(preview.text, /do NOT apply it yourself/);
    const applied = restoreNotice({ text: 'Restored to the start of round 1.', force: true });
    assert.doesNotMatch(applied.text, /do NOT apply/);
    assert.match(applied.description, /Restored to the start/);
  });

  test('restore and prune footers speak to the user', () => {
    assert.match(RESTORE_WORDING.confirm, /Run \/probe restore --force/);
    assert.match(PRUNE_WORDING.confirm, /Run \/probe rounds prune --force/);
    assert.doesNotMatch(RESTORE_WORDING.confirm + PRUNE_WORDING.confirm, /Show this preview/);
  });

  test('restore wording names this host, not the Claude control script', () => {
    assert.match(RESTORE_WORDING.undoSaved, /^Undo point saved/);
    assert.match(RESTORE_WORDING.undoSaved, /\/probe restore --undo --force/);
    assert.doesNotMatch(RESTORE_WORDING.reversible, /probe-ctl/);
    assert.ok(CMD === '/probe');
  });
});

describe('phase -> rules lifecycle', () => {
  test('arming installs the hard block', () => {
    const rules = rulesFor('probe');
    assert.equal(matchEffect(rules, 'edit', 'src/index.ts'), 'deny');
    assert.equal(matchEffect(rules, 'edit', `${SANDBOX.replaceAll('\\', '/')}/bench.py`), 'allow');
    assert.equal(matchEffect(rules, 'shell', 'git commit -m x'), 'ask');
  });

  test('implement downgrades outside edits to the approval dialog', () => {
    const rules = rulesFor('planning');
    assert.equal(matchEffect(rules, 'edit', 'src/index.ts'), 'ask');
    assert.equal(matchEffect(rules, 'edit', `${PLANS.replaceAll('\\', '/')}/plan.md`), 'allow');
  });

  test('approve clears every rule', () => {
    assert.deepEqual(rulesFor('implementing'), []);
    assert.deepEqual(rulesFor('off'), []);
  });

  test('state written by the arm step round-trips through the shared helpers', () => {
    writeState(STATE_DIR, SID, { phase: 'probe', round: 1, sandbox: SANDBOX, rounds: [] });
    const state = readState(STATE_DIR, SID);
    assert.equal(state.phase, 'probe');
    assert.equal(state.sandbox, SANDBOX);
    assert.deepEqual(normalizeRounds(state), []);
    assert.equal(roundRef(SID, 1), `refs/probe/${SID}`);
    assert.equal(roundRef(SID, 3), `refs/probe/${SID}-r3`);
    assert.equal(undoRef(SID), `refs/probe/${SID}-undo`);
  });
});

describe('blocked calls get a reason, not a rules dump', () => {
  const rewrite = (input) => deniedMessageFor({ phase: 'probe', sandbox: SANDBOX, ...input });

  test('a denied write names the mode, the target and the sandbox', () => {
    const message = rewrite({
      tool: 'write',
      message: 'Permission denied: edit',
      input: { path: 'src/index.ts' },
    });
    assert.match(message, /Blocked by probe mode \(research only\)/);
    assert.match(message, /Target: src\/index\.ts/);
    assert.ok(message.includes(SANDBOX));
    assert.match(message, /\/probe implement/);
  });

  test('the planning phase says the plan is what is missing', () => {
    const message = deniedMessageFor({
      phase: 'planning', sandbox: SANDBOX, tool: 'edit',
      message: 'Permission denied: edit', input: { path: 'src/index.ts' },
    });
    assert.match(message, /planning — plan not approved yet/);
  });

  test('a denied shell command quotes the command', () => {
    const message = rewrite({
      tool: 'shell',
      message: 'Permission denied: shell',
      input: { command: 'git commit -m x' },
    });
    assert.match(message, /mutates state/);
    assert.match(message, /git commit -m x/);
    assert.match(message, /sandbox instead/);
  });

  test('nothing to rewrite for other failures or other tools', () => {
    assert.equal(rewrite({ tool: 'write', message: 'ENOENT: no such file' }), null);
    assert.equal(rewrite({ tool: 'read', message: 'Permission denied: read' }), null);
    assert.equal(rewrite({ tool: 'write', message: undefined, input: {} }), null);
    // A denial for a reason that is not ours stays untouched.
    assert.equal(rewrite({ tool: 'write', message: 'file is too large' }), null);
  });

  test('a missing input still produces a usable message', () => {
    const message = rewrite({ tool: 'write', message: 'Permission denied: edit' });
    assert.match(message, /Blocked by probe mode/);
    assert.doesNotMatch(message, /Target:/);
  });
});

describe('retention sweep (what the plugin runs at startup)', () => {
  const aged = (file, days) => {
    const then = new Date(Date.now() - days * DAY);
    fs.utimesSync(file, then, then);
  };

  test('an old implementing state is pruned with its sandbox; an old probe state is not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-prune-'));
    try {
      const write = (id, phase) => {
        fs.mkdirSync(path.join(dir, id, 'sandbox'), { recursive: true });
        fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ phase }));
        return path.join(dir, `${id}.json`);
      };
      const unlocked = write('unlocked', 'implementing');
      const locked = write('locked', 'probe');
      const unreadable = path.join(dir, 'corrupt.json');
      fs.writeFileSync(unreadable, '{not json');

      aged(unlocked, UNLOCKED_PRUNE_DAYS + 1);
      aged(locked, UNLOCKED_PRUNE_DAYS + 1); // still inside the locked window
      aged(unreadable, LOCKED_PRUNE_DAYS + 1);

      const pruned = pruneStateDir(dir);

      assert.ok(pruned.has('unlocked'), 'an idle unlocked state goes first');
      assert.ok(!fs.existsSync(unlocked));
      assert.ok(!fs.existsSync(path.join(dir, 'unlocked')), 'its sandbox goes with it');
      assert.ok(fs.existsSync(locked), 'a locked state is kept for the resumed session');
      assert.ok(fs.existsSync(unreadable), 'an unreadable state is never pruned');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('heartbeat touches a live state and refuses to resurrect an off one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-heart-'));
    try {
      writeState(dir, 'live', { phase: 'probe' });
      const live = path.join(dir, 'live.json');
      const then = new Date(Date.now() - 60_000);
      fs.utimesSync(live, then, then);
      assert.equal(heartbeat(dir, 'live'), true);
      assert.ok(fs.statSync(live).mtimeMs > then.getTime(), 'mtime moved');

      writeState(dir, 'gone', { phase: 'off' });
      const off = path.join(dir, 'gone.json');
      fs.utimesSync(off, then, then);
      assert.equal(heartbeat(dir, 'gone'), false, 'an off state must not be resurrected');
      assert.equal(fs.statSync(off).mtimeMs, then.getTime());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
