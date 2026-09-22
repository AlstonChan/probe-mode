// Phase-aware pruning in probe-cleanup.mjs, plus the liveness heartbeat that makes
// mtime mean "last used" instead of "last phase change".
//
//   node --test test/cleanup.test.mjs
//
// Drives the real hooks as subprocesses with CLAUDE_CONFIG_DIR pointed at a temp
// dir. execFileSync({ input }) is fine here -- stdin semantics are hooks-stdin's job.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOKS = path.join(import.meta.dirname, '..', 'hooks');
const CLEANUP = path.join(HOOKS, 'probe-cleanup.mjs');
const CONTEXT = path.join(HOOKS, 'probe-context.mjs');

function freshCfg() {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cleanup-cfg-'));
  fs.mkdirSync(path.join(cfg, 'probe-state'), { recursive: true });
  return cfg;
}
const stateDir = (cfg) => path.join(cfg, 'probe-state');
const backdate = (p, days) => {
  const t = new Date(Date.now() - days * 864e5);
  fs.utimesSync(p, t, t);
};

/** Writes a state file (+ its sandbox dir) and backdates both. */
function fabricate(cfg, sid, { phase, ageDays, sandbox = true, raw = null }) {
  const file = path.join(stateDir(cfg), `${sid}.json`);
  fs.writeFileSync(file, raw ?? JSON.stringify({ phase, sandbox: `/tmp/${sid}`, round: 1 }, null, 2));
  if (sandbox) {
    const dir = path.join(stateDir(cfg), sid);
    fs.mkdirSync(path.join(dir, 'sandbox'), { recursive: true });
    backdate(dir, ageDays);
  }
  backdate(file, ageDays);
  return file;
}

function runCleanup(cfg) {
  return execFileSync(process.execPath, [CLEANUP], {
    input: JSON.stringify({ session_id: 'ending-session' }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'ending-session' },
  });
}

const survives = (cfg, sid) => fs.existsSync(path.join(stateDir(cfg), `${sid}.json`));
const dirSurvives = (cfg, sid) => fs.existsSync(path.join(stateDir(cfg), sid));

describe('phase-aware retention', () => {
  // LOCKED (probe/planning) keeps the old 30 days: deleting one makes a RESUMED
  // session come back silently unlocked, because the guard finds no state and passes.
  // UNLOCKED (implementing/off) is already unlocked, so early pruning costs only
  // restore history -- which is why the aggressive arm is the counterintuitive one.
  const CASES = [
    { phase: 'probe', ageDays: 1, expect: true },
    { phase: 'probe', ageDays: 29, expect: true },
    { phase: 'probe', ageDays: 31, expect: false },
    { phase: 'planning', ageDays: 10, expect: true },
    { phase: 'planning', ageDays: 29, expect: true },
    { phase: 'planning', ageDays: 40, expect: false },
    { phase: 'implementing', ageDays: 1, expect: true },
    { phase: 'implementing', ageDays: 6.5, expect: true },
    { phase: 'implementing', ageDays: 7.5, expect: false },
    { phase: 'off', ageDays: 1, expect: true },
    { phase: 'off', ageDays: 7.5, expect: false },
  ];

  for (const { phase, ageDays, expect } of CASES) {
    test(`${phase} @ ${ageDays}d -> ${expect ? 'survives' : 'pruned'}`, () => {
      const cfg = freshCfg();
      fabricate(cfg, 'sess', { phase, ageDays });
      runCleanup(cfg);
      assert.equal(survives(cfg, 'sess'), expect);
      // The sandbox always shares its state file's fate.
      assert.equal(dirSurvives(cfg, 'sess'), expect);
    });
  }

  test('a 29-day probe state surviving is the safety property, not an accident', () => {
    const cfg = freshCfg();
    fabricate(cfg, 'armed', { phase: 'probe', ageDays: 29 });
    runCleanup(cfg);
    assert.ok(survives(cfg, 'armed'),
      'deleting an armed state makes a resumed session come back UNLOCKED');
  });
});

describe('unreadable state is never pruned', () => {
  for (const ageDays of [5, 40, 400]) {
    test(`corrupt JSON @ ${ageDays}d survives`, () => {
      const cfg = freshCfg();
      fabricate(cfg, 'corrupt', { phase: 'x', ageDays, raw: '{not json' });
      runCleanup(cfg);
      assert.ok(survives(cfg, 'corrupt'),
        'probe-guard DENIES on unreadable state, so the file is still protecting something');
    });
  }
});

describe('sandbox is paired to its state file, not pruned on its own mtime', () => {
  test('fresh state + ancient sandbox dir: both survive', () => {
    // A directory mtime only moves when a direct child is added, so the two drift.
    // The old code pruned the dir independently and could delete it out from under
    // a live session.
    const cfg = freshCfg();
    fabricate(cfg, 'sess', { phase: 'implementing', ageDays: 1 });
    backdate(path.join(stateDir(cfg), 'sess'), 90);
    runCleanup(cfg);
    assert.ok(survives(cfg, 'sess'));
    assert.ok(dirSurvives(cfg, 'sess'), 'sandbox must not be pruned while its state lives');
  });

  test('ancient state + fresh sandbox dir: both go', () => {
    const cfg = freshCfg();
    fabricate(cfg, 'sess', { phase: 'implementing', ageDays: 30 });
    backdate(path.join(stateDir(cfg), 'sess'), 0);
    runCleanup(cfg);
    assert.equal(survives(cfg, 'sess'), false);
    assert.equal(dirSurvives(cfg, 'sess'), false);
  });
});

describe('orphan directories', () => {
  test('orphan sandbox older than the unlocked window is swept', () => {
    const cfg = freshCfg();
    const dir = path.join(stateDir(cfg), 'orphan');
    fs.mkdirSync(path.join(dir, 'sandbox'), { recursive: true });
    backdate(dir, 30);
    runCleanup(cfg);
    assert.equal(fs.existsSync(dir), false);
  });

  test('a recent orphan is kept', () => {
    const cfg = freshCfg();
    const dir = path.join(stateDir(cfg), 'orphan');
    fs.mkdirSync(path.join(dir, 'sandbox'), { recursive: true });
    backdate(dir, 1);
    runCleanup(cfg);
    assert.ok(fs.existsSync(dir));
  });

  test('a directory that does not look like ours is never touched', () => {
    const cfg = freshCfg();
    const dir = path.join(stateDir(cfg), 'something-else');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    backdate(dir, 400);
    runCleanup(cfg);
    assert.ok(fs.existsSync(dir), 'no sandbox/ child means it is not ours to delete');
  });
});

test('the stable probe-statusline.mjs copy survives any prune', () => {
  // `setup` writes this into probe-state/ and every plugin install depends on it.
  // Pruning it would silently kill the status indicator.
  const cfg = freshCfg();
  const stable = path.join(stateDir(cfg), 'probe-statusline.mjs');
  fs.writeFileSync(stable, '// stable copy');
  backdate(stable, 400);
  fabricate(cfg, 'sess', { phase: 'implementing', ageDays: 90 });
  runCleanup(cfg);
  assert.ok(fs.existsSync(stable));
  assert.equal(survives(cfg, 'sess'), false, 'sanity: the prune did run');
});

describe('liveness heartbeat', () => {
  test('probe-context refreshes mtime, protecting a session still in use', () => {
    const cfg = freshCfg();
    const sid = 'live-session';
    const file = fabricate(cfg, sid, { phase: 'implementing', ageDays: 30 });
    const before = fs.statSync(file).mtimeMs;

    execFileSync(process.execPath, [CONTEXT], {
      input: JSON.stringify({ session_id: sid }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: sid },
    });

    const after = fs.statSync(file).mtimeMs;
    assert.ok(after > before, 'UserPromptSubmit must heartbeat the state file');
    runCleanup(cfg);
    assert.ok(survives(cfg, sid),
      'a 30-day-old implementing state used this turn must NOT be pruned');
  });

  test('an off state is never resurrected by the heartbeat', () => {
    const cfg = freshCfg();
    const file = fabricate(cfg, 'done', { phase: 'off', ageDays: 30 });
    const before = fs.statSync(file).mtimeMs;
    execFileSync(process.execPath, [CONTEXT], {
      input: JSON.stringify({ session_id: 'done' }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: 'done' },
    });
    assert.equal(fs.statSync(file).mtimeMs, before, 'heartbeat must sit after the phase check');
  });
});
