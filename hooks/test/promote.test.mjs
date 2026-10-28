// The ExitPlanMode hook: the one thing that unlocks writes.
//
//   node --test hooks/test/promote.test.mjs

import { test, before, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROMOTE = path.join(import.meta.dirname, '..', '..', 'hooks', 'probe-promote.mjs');
const SID = 'promote-test-session';
const MIN = 60 * 1000;

let CFG, PLANS;
const statePath = () => path.join(CFG, 'probe-state', `${SID}.json`);
const setState = (s) => fs.writeFileSync(statePath(), JSON.stringify(s));
const phase = () => JSON.parse(fs.readFileSync(statePath(), 'utf8')).phase;
const promote = (payload = {}) =>
  execFileSync(process.execPath, [PROMOTE], {
    input: JSON.stringify({ session_id: SID, tool_name: 'ExitPlanMode', tool_input: {}, tool_response: {}, ...payload }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });

/** A planning phase that began a minute ago. */
const planningAt = () => new Date(Date.now() - MIN).toISOString();
/** A plan file; `ageMs` backdates it. */
const plan = (name, body, ageMs = 0) => {
  const file = path.join(PLANS, name);
  fs.writeFileSync(file, body);
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(file, t, t); }
  return file;
};

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-promote-'));
  PLANS = path.join(CFG, 'plans');
  fs.mkdirSync(path.join(CFG, 'probe-state'), { recursive: true });
  fs.mkdirSync(PLANS, { recursive: true });
});
afterEach(() => {
  for (const f of fs.readdirSync(PLANS)) fs.rmSync(path.join(PLANS, f), { force: true });
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('only a plan approved after implement unlocks', () => {
  test('planning with a plan written this phase -> implementing', () => {
    setState({ phase: 'planning', sandbox: '/s', planningAt: planningAt() });
    plan('fresh.md', '# Plan\n');
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

describe('an approval with no plan behind it unlocks nothing', () => {
  // Regression: the plan Write was denied in the same batch as ExitPlanMode, the
  // user approved an empty prompt, and this hook unlocked writes anyway.
  test('no plan written: stays planning and says why', () => {
    setState({ phase: 'planning', sandbox: '/s', planningAt: planningAt() });
    const out = promote();
    assert.match(out, /no plan behind it.*no plan was written.*BLOCKED/s);
    assert.match(out, /separate turn/);
    assert.equal(phase(), 'planning');
  });

  test('a stale plan from before planning began: stays planning', () => {
    setState({ phase: 'planning', sandbox: '/s', planningAt: planningAt() });
    plan('old.md', '# Old plan\n', 2 * MIN);
    assert.match(promote(), /BLOCKED/);
    assert.equal(phase(), 'planning');
  });

  test('a planning phase with no start time: stays planning, points at implement', () => {
    setState({ phase: 'planning', sandbox: '/s' });
    plan('fresh.md', '# Plan\n');
    assert.match(promote(), /re-run \/probe(-mode:probe)? implement/);
    assert.equal(phase(), 'planning');
  });

  test('the response names a fresh plan file: unlocks', () => {
    setState({ phase: 'planning', sandbox: '/s', planningAt: planningAt() });
    const file = plan('fresh.md', '# Plan\n');
    promote({ tool_response: { plan: '# Plan\n', filePath: file } });
    assert.equal(phase(), 'implementing');
  });

  test('the response names a stale plan file: stays planning', () => {
    setState({ phase: 'planning', sandbox: '/s', planningAt: planningAt() });
    const old = plan('old.md', '# Old\n', 2 * MIN);
    plan('other-session.md', '# Someone else\n');
    promote({ tool_response: { plan: '# Old\n', filePath: old } });
    assert.equal(phase(), 'planning');
  });
});

describe('the unlock message names the current round', () => {
  test('round 2 restore point, not round 1', () => {
    setState({
      phase: 'planning', sandbox: '/s', round: 2, planningAt: planningAt(),
      snapshot: { ref: 'a'.repeat(40), head: 'h', branch: 'main', at: 't1' },
      rounds: [
        { n: 1, ref: 'a'.repeat(40), head: 'h', branch: 'main', at: 't1' },
        { n: 2, ref: 'b'.repeat(40), head: 'h', branch: 'main', at: 't2' },
      ],
    });
    plan('fresh.md', '# Plan\n');
    const out = promote();
    assert.match(out, /bbbbbbbbbbbb \(start of round 2\)/);
    assert.doesNotMatch(out, /aaaaaaaaaaaa/);
  });

  test('a failed snapshot says so instead of "not a git repo"', () => {
    setState({ phase: 'planning', sandbox: '/s', rounds: [], snapshot: null, snapshotError: 'disk full', planningAt: planningAt() });
    plan('fresh.md', '# Plan\n');
    assert.match(promote(), /snapshot failed: disk full/);
  });
});
