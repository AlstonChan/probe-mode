// Only the user may switch probe mode off.
//
//   node --test hooks/test/stop-intent.test.mjs
//
// The skill runs `probe-ctl stop` through the model's Bash tool, so the guard
// needs proof the user typed the stop command: a one-shot token the
// UserPromptSubmit hook leaves in the state file.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOKS = path.join(import.meta.dirname, '..', '..', 'hooks');
const SID = 'stop-intent-session';
const STOP_CMD = `node "${path.join(HOOKS, 'probe-ctl.mjs').split(path.sep).join('/')}" stop`;

let CFG, PROJECT;
const statePath = () => path.join(CFG, 'probe-state', `${SID}.json`);
const state = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const env = () => ({ ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID });

const arm = (extra = {}) => fs.writeFileSync(statePath(), JSON.stringify({
  phase: 'probe', sandbox: path.join(CFG, 'probe-state', SID, 'sandbox'), cwd: PROJECT, ...extra,
}));

const userTypes = (prompt) => execFileSync(process.execPath, [path.join(HOOKS, 'probe-context.mjs')], {
  input: JSON.stringify({ session_id: SID, hook_event_name: 'UserPromptSubmit', prompt }),
  encoding: 'utf8', env: env(),
});

const guard = (command, tool = 'Bash') => {
  const out = execFileSync(process.execPath, [path.join(HOOKS, 'probe-guard.mjs')], {
    input: JSON.stringify({ session_id: SID, cwd: PROJECT, tool_name: tool, tool_input: { command } }),
    encoding: 'utf8', env: env(),
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
};

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-stop-'));
  PROJECT = path.join(CFG, 'project');
  fs.mkdirSync(path.join(CFG, 'probe-state', SID, 'sandbox'), { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('the model cannot disarm on its own', () => {
  test('probe-ctl stop without the user asking is denied', () => {
    arm();
    assert.equal(guard(STOP_CMD), 'deny');
    assert.equal(guard(STOP_CMD, 'PowerShell'), 'deny');
  });

  test('a prompt that only mentions stopping leaves no token', () => {
    arm();
    userTypes('why does /probe stop exist?');
    userTypes('/probe status');
    assert.equal(state().stopIntent, undefined);
    assert.equal(guard(STOP_CMD), 'deny');
  });

  test('a stale token is refused', () => {
    arm({ stopIntent: Date.now() - 3 * 60 * 1000 });
    assert.equal(guard(STOP_CMD), 'deny');
  });

  test('other probe-ctl subcommands are unaffected', () => {
    arm();
    assert.equal(guard(STOP_CMD.replace(/stop$/, 'status')), 'allow');
  });
});

describe("the user's own stop command goes through once", () => {
  for (const typed of ['/probe stop', '/probe-mode:probe stop']) {
    test(`${typed} -> allowed, then consumed by probe-ctl stop`, () => {
      arm();
      userTypes(typed);
      assert.ok(Number.isFinite(state().stopIntent));
      assert.equal(guard(STOP_CMD), 'allow');

      execFileSync(process.execPath, [path.join(HOOKS, 'probe-ctl.mjs'), 'stop'], { cwd: PROJECT, env: env() });
      assert.equal(state().phase, 'off');
      assert.equal(state().stopIntent, undefined);
    });
  }
});
