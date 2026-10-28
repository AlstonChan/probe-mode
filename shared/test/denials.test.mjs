// The denial log: every guard denial is recorded, outside the model's reach,
// and summarized by status.
//
//   node --test shared/test/denials.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readDenials, denialSummary, logDenial } from '../../shared/state.mjs';

const HOOKS = path.join(import.meta.dirname, '..', '..', 'hooks');
const SID = 'denials-test';
let CFG, PROJECT, SANDBOX, STATE_DIR;

const env = () => ({ ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID });
const guard = (tool, toolInput) => {
  const out = execFileSync(process.execPath, [path.join(HOOKS, 'probe-guard.mjs')], {
    input: JSON.stringify({ session_id: SID, cwd: PROJECT, tool_name: tool, tool_input: toolInput }),
    encoding: 'utf8', env: env(),
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
};

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-denials-'));
  STATE_DIR = path.join(CFG, 'probe-state');
  PROJECT = path.join(CFG, 'project');
  SANDBOX = path.join(STATE_DIR, SID, 'sandbox');
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, `${SID}.json`), JSON.stringify({
    phase: 'probe', sandbox: SANDBOX, cwd: PROJECT, round: 1, rounds: [], startedAt: 't',
  }));
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('the guard logs denials', () => {
  test('a denied write and a denied command are recorded; allowed calls are not', () => {
    assert.equal(guard('Write', { file_path: path.join(PROJECT, 'a.txt') }), 'deny');
    assert.equal(guard('Bash', { command: 'git commit -m x' }), 'deny');
    assert.equal(guard('Bash', { command: 'git status' }), 'allow');
    assert.equal(guard('Write', { file_path: path.join(SANDBOX, 'a.txt') }), 'allow');

    const log = readDenials(STATE_DIR, SID);
    assert.equal(log.length, 2);
    assert.equal(log[0].tool, 'Write');
    assert.match(log[0].what, /a\.txt$/);
    assert.equal(log[1].what, 'git commit -m x');
    assert.match(log[1].reason, /Blocked by probe mode/);
  });

  test('the log is not writable from inside probe mode', () => {
    const file = path.join(STATE_DIR, `${SID}.denials.jsonl`);
    assert.equal(guard('Write', { file_path: file }), 'deny');
    assert.equal(guard('Bash', { command: `rm ${file.split(path.sep).join('/')}` }), 'deny');
  });

  test('status shows a count and the latest denials', () => {
    const out = execFileSync(process.execPath, [path.join(HOOKS, 'probe-ctl.mjs'), 'status'], { cwd: PROJECT, encoding: 'utf8', env: env() });
    assert.match(out, /Denials: \d+ this session/);
    assert.match(out, /git commit -m x/);
  });
});

describe('shared helpers', () => {
  test('empty and populated summaries', () => {
    const dir = path.join(CFG, 'helpers');
    assert.equal(denialSummary(dir, 's'), 'Denials: none this session');
    for (let i = 0; i < 5; i++) logDenial(dir, 's', { tool: 'shell', what: `cmd ${i}`, reason: 'r' });
    const out = denialSummary(dir, 's');
    assert.match(out, /Denials: 5 this session \(last 3\)/);
    assert.match(out, /cmd 4/);
    assert.doesNotMatch(out, /cmd 1/);
  });
});
