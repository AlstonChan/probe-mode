// The ExitPlanMode hook: the one thing that unlocks writes.
//
//   node --test test/promote.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROMOTE = path.join(import.meta.dirname, '..', 'hooks', 'probe-promote.mjs');
const SID = 'promote-test-session';

let CFG;
const statePath = () => path.join(CFG, 'probe-state', `${SID}.json`);
const setState = (s) => fs.writeFileSync(statePath(), JSON.stringify(s));
const phase = () => JSON.parse(fs.readFileSync(statePath(), 'utf8')).phase;
const promote = (toolResponse = {}) =>
  execFileSync(process.execPath, [PROMOTE], {
    input: JSON.stringify({ session_id: SID, tool_name: 'ExitPlanMode', tool_response: toolResponse }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-promote-'));
  fs.mkdirSync(path.join(CFG, 'probe-state'), { recursive: true });
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('only a plan approved after implement unlocks', () => {
  test('planning -> implementing', () => {
    setState({ phase: 'planning', sandbox: '/s' });
    promote();
    assert.equal(phase(), 'implementing');
  });

  test('probe stays probe, and says why writes are still blocked', () => {
    setState({ phase: 'probe', sandbox: '/s' });
    assert.match(promote(), /still in research.*BLOCKED.*implement/);
    assert.equal(phase(), 'probe');
  });

  test('off stays off, silently', () => {
    setState({ phase: 'off', sandbox: '/s' });
    assert.equal(promote(), '');
    assert.equal(phase(), 'off');
  });

  test('no state file: nothing happens', () => {
    fs.rmSync(statePath(), { force: true });
    assert.equal(promote(), '');
    assert.equal(fs.existsSync(statePath()), false);
  });
});

describe('the unlock message names the current round', () => {
  test('round 2 restore point, not round 1', () => {
    setState({
      phase: 'planning', sandbox: '/s', round: 2,
      snapshot: { ref: 'a'.repeat(40), head: 'h', branch: 'main', at: 't1' },
      rounds: [
        { n: 1, ref: 'a'.repeat(40), head: 'h', branch: 'main', at: 't1' },
        { n: 2, ref: 'b'.repeat(40), head: 'h', branch: 'main', at: 't2' },
      ],
    });
    const out = promote();
    assert.match(out, /bbbbbbbbbbbb \(start of round 2\)/);
    assert.doesNotMatch(out, /aaaaaaaaaaaa/);
  });

  test('a failed snapshot says so instead of "not a git repo"', () => {
    setState({ phase: 'planning', sandbox: '/s', rounds: [], snapshot: null, snapshotError: 'disk full' });
    assert.match(promote(), /snapshot failed: disk full/);
  });
});
