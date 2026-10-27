import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GUARD = path.join(import.meta.dirname, '..', 'probe-guard.mjs');
const SID = 'trace-session';
let CFG, STATE, SANDBOX, PROJECT;

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-trace-wiring-'));
  STATE = path.join(CFG, 'probe-state');
  SANDBOX = path.join(STATE, SID, 'sandbox');
  PROJECT = path.join(CFG, 'project');
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.writeFileSync(path.join(STATE, `${SID}.json`), JSON.stringify({ phase: 'probe', sandbox: SANDBOX, cwd: PROJECT }));
});

after(() => {
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {}
});

function runGuard(record) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: CFG };
  delete env.PROBE_RECORD;
  if (record) env.PROBE_RECORD = '1';
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      session_id: SID,
      cwd: PROJECT,
      tool_name: 'Write',
      tool_input: { file_path: path.join(PROJECT, 'src', 'main.py'), content: 'x' },
    }),
    encoding: 'utf8',
    env,
  });
  return res.stdout;
}

const traceFile = () => path.join(STATE, 'trace.jsonl');
const reset = () => fs.rmSync(traceFile(), { recursive: true, force: true });

test('PROBE_RECORD set: guard logs one deny entry', () => {
  reset();
  const out = runGuard(true);
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  const lines = fs.readFileSync(traceFile(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.host, 'claude-code');
  assert.equal(e.hook, 'guard');
  assert.equal(e.sessionId, SID);
  assert.equal(e.decision, 'deny');
  assert.equal(e.input.tool_name, 'Write');
});

test('PROBE_RECORD unset: same deny, no trace file', () => {
  reset();
  const out = runGuard(false);
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(fs.existsSync(traceFile()), false);
});

test('unwritable trace path: guard still prints the same deny', () => {
  reset();
  const expected = runGuard(false);
  fs.mkdirSync(traceFile());
  const out = runGuard(true);
  assert.equal(out, expected);
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
});
