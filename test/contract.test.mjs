// Contract parity: the text injected into the model must be the same on both
// hosts, except for the three lines that name each host's mechanism.
//
//   node --test test/contract.test.mjs
//
// Drives the real hooks/probe-context.mjs (stdin payload in, additionalContext
// out) and compares it against shared/contract.mjs — the module the OpenCode
// plugin injects. If someone edits one copy and not the other, this fails.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contractText, HOST_TEXT } from '../shared/contract.mjs';

const HOOKS = path.join(import.meta.dirname, '..', 'hooks');
const SID = 'contract-session';

let CFG, STATE_DIR;

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-contract-'));
  STATE_DIR = path.join(CFG, 'probe-state');
  fs.mkdirSync(path.join(STATE_DIR, SID, 'sandbox'), { recursive: true });
});

after(() => {
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {}
});

function writeState(state) {
  fs.writeFileSync(path.join(STATE_DIR, `${SID}.json`), JSON.stringify(state));
}

/** Runs the real UserPromptSubmit hook and returns what it injects ('' when it
 *  exits silently). */
function runHook(pluginLike) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: CFG };
  if (pluginLike) env.CLAUDE_PLUGIN_ROOT = 'C:\\fake\\plugin';
  const out = execFileSync(process.execPath, [path.join(HOOKS, 'probe-context.mjs')], {
    input: JSON.stringify({ session_id: SID }),
    encoding: 'utf8',
    env,
  });
  if (!out.trim()) return '';
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

const base = { sandbox: path.join(STATE_DIR, SID, 'sandbox'), cwd: '/project' };

describe('the Claude hook injects exactly shared/contract.mjs', () => {
  test('research phase (plugin install: /probe-mode:probe)', () => {
    writeState({ ...base, phase: 'probe', round: 1 });
    assert.equal(
      runHook(true),
      contractText({ phase: 'probe', round: 1, sandbox: base.sandbox, cmd: '/probe-mode:probe', host: 'claude' }),
    );
  });

  test('planning phase (same install layout: /probe-mode:probe)', () => {
    // This checkout always has .claude-plugin/ next to hooks/, so it resolves
    // as a plugin install; the standalone name is covered by rounds.test.mjs.
    writeState({ ...base, phase: 'planning', round: 2 });
    assert.equal(
      runHook(false),
      contractText({ phase: 'planning', round: 2, sandbox: base.sandbox, cmd: '/probe-mode:probe', host: 'claude' }),
    );
  });

  test('implementing phase', () => {
    writeState({ ...base, phase: 'implementing', round: 3 });
    const text = runHook(true);
    assert.match(text, /writes unlocked \(plan approved\)/);
    assert.equal(
      text,
      contractText({ phase: 'implementing', round: 3, sandbox: base.sandbox, cmd: '/probe-mode:probe', host: 'claude' }),
    );
  });

  test('disarmed sessions inject nothing', () => {
    writeState({ ...base, phase: 'off', round: 1 });
    assert.equal(runHook(true), '');
    fs.rmSync(path.join(STATE_DIR, `${SID}.json`));
    assert.equal(runHook(true), '', 'no state file at all');
  });
});

// Lines that legitimately differ, because the mechanisms do.
const HOST_LINES = [
  /PreToolUse hook enforces/,
  /Session permission rules enforce/,
  /Entering plan mode requires/,
  /Implementation requires an EXPLICIT/,
  /call ExitPlanMode/,
  /ask for approval with the `question` tool/,
];
const withoutHostLines = (text) =>
  text.split('\n').filter((line) => !HOST_LINES.some((marker) => marker.test(line)));

describe('both hosts carry the same contract', () => {
  for (const phase of ['probe', 'planning', 'implementing']) {
    test(`${phase} phase differs only in its mechanism lines`, () => {
      const args = { phase, round: 2, sandbox: base.sandbox, cmd: '/probe' };
      const claude = contractText({ ...args, host: 'claude' });
      const opencode = contractText({ ...args, host: 'opencode' });
      // `implementing` has no host-specific lines: once approved, both hosts
      // tell the model exactly the same thing.
      if (phase !== 'implementing') {
        assert.notEqual(claude, opencode, 'the mechanism lines must differ');
      }
      assert.deepEqual(withoutHostLines(opencode), withoutHostLines(claude));
    });
  }

  test('the OpenCode contract names the real approval paths', () => {
    const planning = contractText({
      phase: 'planning', round: 1, sandbox: base.sandbox, cmd: '/probe', host: 'opencode',
    });
    assert.match(planning, /question` tool/);
    assert.match(planning, /plan file/);
    const research = contractText({
      phase: 'probe', round: 1, sandbox: base.sandbox, cmd: '/probe', host: 'opencode',
    });
    assert.match(research, /\/probe implement/);
    assert.doesNotMatch(research, /ExitPlanMode|EnterPlanMode/);
  });

  test('the Claude contract still names plan mode (behaviour preserved)', () => {
    const research = contractText({
      phase: 'probe', round: 1, sandbox: base.sandbox, cmd: '/probe', host: 'claude',
    });
    assert.match(research, /EnterPlanMode/);
    const planning = contractText({
      phase: 'planning', round: 1, sandbox: base.sandbox, cmd: '/probe', host: 'claude',
    });
    assert.match(planning, /ExitPlanMode/);
    assert.match(planning, /plan file/);
  });

  test('both hosts tell the model the contract is enforced', () => {
    for (const host of ['claude', 'opencode']) {
      const text = contractText({ phase: 'probe', round: 1, sandbox: base.sandbox, cmd: '/probe', host });
      assert.match(text, /do not work around it/);
      assert.ok(HOST_TEXT[host].enforcement.length > 0);
    }
  });

  test('the Claude contract scopes "do not work around it" to probe mode\'s own denials', () => {
    // Another hook (e.g. ECC GateGuard) can deny a first sandbox write and allow the
    // retry. A blanket "denied = expected" made the model drop that evidence instead.
    const text = contractText({ phase: 'probe', round: 1, sandbox: base.sandbox, cmd: '/probe', host: 'claude' });
    assert.match(text, /Blocked by probe mode/);
    assert.match(text, /other hook/);
    assert.match(text, /retry the same write/);
  });
});
