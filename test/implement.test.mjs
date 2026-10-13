// implement only works from research: from off or implementing it explains
// instead of silently re-locking writes.
//
//   node --test test/implement.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { implementRefusal } from '../shared/contract.mjs';

const CTL = path.join(import.meta.dirname, '..', 'hooks', 'probe-ctl.mjs');
const SID = 'implement-test';
let CFG, PROJECT;

const statePath = () => path.join(CFG, 'probe-state', `${SID}.json`);
const setPhase = (phase) => fs.writeFileSync(statePath(), JSON.stringify({ phase, sandbox: '/s', cwd: PROJECT, round: 1, rounds: [] }));
const phase = () => JSON.parse(fs.readFileSync(statePath(), 'utf8')).phase;
const ctl = (...args) => execFileSync(process.execPath, [CTL, ...args], {
  cwd: PROJECT, encoding: 'utf8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID },
});

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-implement-'));
  PROJECT = path.join(CFG, 'project');
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(path.join(CFG, 'probe-state'), { recursive: true });
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('probe-ctl implement', () => {
  test('probe -> planning', () => {
    setPhase('probe');
    assert.match(ctl('implement'), /Phase -> planning/);
    assert.equal(phase(), 'planning');
  });

  test('planning stays planning (re-running is harmless)', () => {
    assert.match(ctl('implement'), /Phase -> planning/);
    assert.equal(phase(), 'planning');
  });

  test('implementing is refused and stays unlocked', () => {
    setPhase('implementing');
    assert.match(ctl('implement'), /already unlocked.*Nothing was changed/s);
    assert.equal(phase(), 'implementing');
  });

  test('off is refused and stays off', () => {
    setPhase('off');
    assert.match(ctl('implement'), /Probe mode is off.*Nothing was changed/s);
    assert.equal(phase(), 'off');
  });
});

describe('implementRefusal', () => {
  test('null for the phases that may plan', () => {
    assert.equal(implementRefusal('probe', '/probe'), null);
    assert.equal(implementRefusal('planning', '/probe'), null);
  });
});
