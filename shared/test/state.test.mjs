// State file integrity: atomic writes, and a corrupted state that the user can
// see and recover from without losing restore points.
//
//   node --test test/state.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeState, readState, inspectState } from '../shared/state.mjs';

const HOOKS = path.join(import.meta.dirname, '..', 'hooks');
const SID = 'state-test-session';
let ROOT, CFG, REPO;

const statePath = () => path.join(CFG, 'probe-state', `${SID}.json`);
const env = () => ({ ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID });
const ctl = (...args) => execFileSync(process.execPath, [path.join(HOOKS, 'probe-ctl.mjs'), ...args], { cwd: REPO, encoding: 'utf8', env: env() });
const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const userTypes = (prompt) => execFileSync(process.execPath, [path.join(HOOKS, 'probe-context.mjs')], {
  input: JSON.stringify({ session_id: SID, prompt }), encoding: 'utf8', env: env(),
});
const guard = (command) => {
  const out = execFileSync(process.execPath, [path.join(HOOKS, 'probe-guard.mjs')], {
    input: JSON.stringify({ session_id: SID, cwd: REPO, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8', env: env(),
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
};

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-state-'));
  CFG = path.join(ROOT, 'cfg');
  REPO = path.join(ROOT, 'repo');
  fs.mkdirSync(REPO, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(REPO, 'f.txt'), 'v1');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
});
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

describe('writeState', () => {
  test('replaces the file atomically and leaves no temp files behind', () => {
    const dir = path.join(ROOT, 'atomic');
    for (let i = 0; i < 50; i++) writeState(dir, 's', { phase: 'probe', i });
    assert.equal(readState(dir, 's').i, 49);
    assert.deepEqual(fs.readdirSync(dir), ['s.json']);
  });

  test('inspectState tells absent, unreadable and ok apart', () => {
    const dir = path.join(ROOT, 'inspect');
    assert.equal(inspectState(dir, 'x').status, 'absent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.json'), '{"phase":');
    assert.equal(inspectState(dir, 'x').status, 'unreadable');
    fs.writeFileSync(path.join(dir, 'x.json'), 'null');
    assert.equal(inspectState(dir, 'x').status, 'unreadable');
    writeState(dir, 'x', { phase: 'off' });
    assert.equal(inspectState(dir, 'x').status, 'ok');
  });
});

describe('a corrupted state file', () => {
  test('status reports it instead of "OFF", and the guard lets status run', () => {
    ctl('start');
    ctl('start'); // round 2
    const refsBefore = git(['for-each-ref', '--format=%(refname) %(objectname)', `refs/probe/${SID}*`]);
    fs.writeFileSync(statePath(), '{"phase": "probe", "rou');

    assert.match(ctl('status'), /STATE FILE UNREADABLE/);
    assert.equal(guard(`node "${HOOKS}/probe-ctl.mjs" status`), 'allow');
    assert.equal(guard('echo hi > f.txt'), 'deny', 'writes stay blocked');

    // start must not treat it as a fresh session and overwrite round 1.
    assert.match(ctl('start'), /STATE FILE UNREADABLE/);
    assert.equal(git(['for-each-ref', '--format=%(refname) %(objectname)', `refs/probe/${SID}*`]), refsBefore);
  });

  test('stop needs the user to type it, then resets the state and keeps the refs', () => {
    const stop = `node "${HOOKS}/probe-ctl.mjs" stop`;
    assert.equal(guard(stop), 'deny', 'the model cannot stop on its own');
    assert.equal(guard(`${stop}; rm -rf src`), 'deny');

    userTypes('/probe stop');
    assert.equal(guard(stop), 'allow');
    assert.match(ctl('stop'), /has been reset/);
    assert.equal(inspectState(path.join(CFG, 'probe-state'), SID).state.phase, 'off');
    assert.equal(fs.existsSync(path.join(CFG, 'probe-state', `${SID}.stop-intent`)), false);
    assert.match(git(['for-each-ref', `refs/probe/${SID}*`]), /-r2/);
  });

  test('a fresh start never reuses an existing round ref', () => {
    fs.rmSync(statePath());
    const out = ctl('start');
    assert.match(out, /PROBE MODE ON \(round 3/);
    const refs = git(['for-each-ref', '--format=%(refname)', `refs/probe/${SID}*`]).split('\n');
    assert.ok(refs.some((r) => r.endsWith(`${SID}-r3`)));
  });
});
