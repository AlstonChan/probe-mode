// Rounds, snapshot durability, and restore targeting.
//
//   node --test test/rounds.test.mjs
//
// Drives the real probe-ctl against a throwaway git repo, with CLAUDE_CONFIG_DIR
// pointed at a temp directory so nothing touches your real state.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTL = path.join(import.meta.dirname, '..', 'hooks', 'probe-ctl.mjs');
const SID = 'rounds-test-session';

let CFG, REPO;

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const ctl = (...args) =>
  execFileSync(process.execPath, [CTL, ...args], {
    cwd: REPO, encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID },
  });

const state = () => JSON.parse(fs.readFileSync(path.join(CFG, 'probe-state', `${SID}.json`), 'utf8'));
const refOf = (r) => { try { return git(['rev-parse', '--verify', '--quiet', r]); } catch { return null; } };
const content = () => fs.readFileSync(path.join(REPO, 'f.txt'), 'utf8').trim();

// The command name (/probe vs /probe-mode:probe) is resolved by checking for a
// .claude-plugin/ dir next to hooks/. This repo checkout always has one (it's the
// plugin's own manifest), so running probe-ctl.mjs from its real path here always
// looks like a plugin install regardless of env vars. To exercise the standalone
// branch, copy the files under test into an isolated dir that has no such sibling.
function withIsolatedHooks(pluginLike, files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-iso-'));
  const hooksDir = path.join(dir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(import.meta.dirname, '..', 'hooks', f), path.join(hooksDir, f));
  }
  if (pluginLike) fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  try {
    return fn(path.join(hooksDir, 'probe-ctl.mjs'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function freshRepo() {
  fs.rmSync(path.join(CFG, 'probe-state'), { recursive: true, force: true });
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(REPO, 'f.txt'), 'v1');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
}

const commitAs = (text, msg) => {
  fs.writeFileSync(path.join(REPO, 'f.txt'), text);
  git(['add', '-A']);
  git(['commit', '-qm', msg]);
};

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-rounds-'));
  REPO = path.join(CFG, 'repo');
  fs.mkdirSync(REPO, { recursive: true });
});

after(() => {
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {}
});

describe('starting a new round never destroys an earlier restore point', () => {
  before(() => {
    freshRepo();
    ctl('start');              // round 1
    commitAs('v2', 'feat: round 1 work');
    ctl('start');              // round 2 — the case that used to clobber
  });

  test('state.snapshot still points at round 1', () => {
    const s = state();
    assert.equal(s.snapshot.ref, s.rounds[0].ref);
  });

  test('two rounds are recorded', () => {
    const s = state();
    assert.equal(s.rounds.length, 2);
    assert.equal(s.round, 2);
  });

  test('round 1 keeps the original flat ref name', () => {
    assert.equal(refOf(`refs/probe/${SID}`), state().rounds[0].ref);
  });

  test('round 2 gets its own suffixed ref, coexisting with the flat one', () => {
    assert.equal(refOf(`refs/probe/${SID}-r2`), state().rounds[1].ref);
    assert.notEqual(state().rounds[0].ref, state().rounds[1].ref);
  });

  test('starting a round re-blocks writes', () => {
    assert.equal(state().phase, 'probe');
  });

  test('both snapshots survive an aggressive gc', () => {
    // The original bug left round 1 unreferenced, so gc destroyed it outright.
    git(['reflog', 'expire', '--expire=now', '--all']);
    git(['gc', '--prune=now', '--quiet']);
    for (const r of state().rounds) {
      assert.equal(refOf(`refs/probe/${SID}${r.n === 1 ? '' : `-r${r.n}`}`), r.ref);
      assert.doesNotThrow(() => git(['cat-file', '-e', r.ref]));
    }
  });
});

describe('restore targeting', () => {
  before(() => {
    freshRepo();
    ctl('start');                          // round 1, tree = v1
    commitAs('v2', 'feat: A');
    ctl('start');                          // round 2, tree = v2
    commitAs('v3', 'feat: B');
  });

  test('preview changes nothing', () => {
    const before = content();
    const out = ctl('restore');
    assert.match(out, /RESTORE PREVIEW/);
    assert.equal(content(), before);
  });

  test('preview lists the rounds and marks the default target', () => {
    const out = ctl('restore');
    assert.match(out, /round 1/);
    assert.match(out, /round 2/);
    assert.match(out, /-> round 2/);
  });

  test('bare restore goes to the start of the current round', () => {
    ctl('restore', '--force');
    assert.equal(content(), 'v2');
  });

  test('--undo reverses the restore', () => {
    ctl('restore', '--undo', '--force');
    assert.equal(content(), 'v3');
  });

  test('--all goes back to the very beginning', () => {
    ctl('restore', '--all', '--force');
    assert.equal(content(), 'v1');
  });

  test('--round N targets a specific round', () => {
    ctl('restore', '--undo', '--force');   // back to v3
    ctl('restore', '--round', '1', '--force');
    assert.equal(content(), 'v1');
  });

  test('an unknown round is refused', () => {
    assert.match(ctl('restore', '--round', '99'), /No round 99/);
  });
});

describe('state files written before rounds existed still work', () => {
  before(() => {
    freshRepo();
    ctl('start');
    // Rewrite the state in the OLD shape: a bare snapshot, no rounds/round.
    const s = state();
    delete s.rounds;
    delete s.round;
    fs.writeFileSync(path.join(CFG, 'probe-state', `${SID}.json`), JSON.stringify(s, null, 2));
  });

  test('status reports it without crashing', () => {
    assert.match(ctl('status'), /round 1/);
  });

  test('restore preview resolves the legacy snapshot', () => {
    assert.match(ctl('restore'), /RESTORE PREVIEW/);
  });

  test('starting a round upgrades it to round 2 and keeps the old snapshot', () => {
    const oldRef = state().snapshot.ref;
    ctl('start');
    const s = state();
    assert.equal(s.round, 2);
    assert.equal(s.rounds.length, 2);
    assert.equal(s.rounds[0].ref, oldRef);
    assert.equal(refOf(`refs/probe/${SID}`), oldRef);
  });
});

describe('command name resolves from install layout', () => {
  // freshRepo() per test (not once in before()) so every case hits the FRESH-install
  // branch of `start` (the one that mentions `restore`), not the new-round branch —
  // state persists across calls to the same SID otherwise.
  const runIsolated = (pluginLike, extraEnv = {}) => {
    freshRepo();
    return withIsolatedHooks(pluginLike, ['probe-ctl.mjs', 'probe-lib.mjs'], (ctlPath) =>
      execFileSync(process.execPath, [ctlPath, 'start'], {
        cwd: REPO, encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID, ...extraEnv },
      }));
  };

  test('standalone layout (no .claude-plugin sibling, no env var) uses plain /probe', () => {
    const out = runIsolated(false);
    assert.match(out, /\/probe restore/);
    assert.doesNotMatch(out, /probe-mode:probe/);
  });

  test('plugin layout (.claude-plugin sibling present) uses /probe-mode:probe', () => {
    const out = runIsolated(true);
    assert.match(out, /\/probe-mode:probe restore/);
  });

  test('CLAUDE_PLUGIN_ROOT alone also selects /probe-mode:probe', () => {
    const out = runIsolated(false, { CLAUDE_PLUGIN_ROOT: 'C:\\fake\\plugin\\root' });
    assert.match(out, /\/probe-mode:probe restore/);
  });
});
