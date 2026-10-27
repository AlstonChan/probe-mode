// Claude guard coverage of every write/shell tool, and hooks.json routing.
//
//   node --test hooks/test/write-tools.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GUARD = path.join(import.meta.dirname, '..', '..', 'hooks', 'probe-guard.mjs');
const HOOKS_JSON = path.join(import.meta.dirname, '..', '..', 'hooks', 'hooks.json');
const SID = 'write-tools-session';

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];

let CFG, SANDBOX, PROJECT;

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-write-tools-'));
  SANDBOX = path.join(CFG, 'probe-state', SID, 'sandbox');
  PROJECT = path.join(CFG, 'project');
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
});

after(() => {
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {}
});

function setPhase(phase) {
  fs.writeFileSync(
    path.join(CFG, 'probe-state', `${SID}.json`),
    JSON.stringify({ phase, sandbox: SANDBOX, cwd: PROJECT }),
  );
}

function decide(toolName, toolInput) {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: SID, cwd: PROJECT, tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });
  if (!out.trim()) return 'allow';
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

// The guard reads file_path, falling back to notebook_path.
const inputFor = (tool, target) =>
  tool === 'NotebookEdit' ? { notebook_path: target } : { file_path: target };

for (const tool of WRITE_TOOLS) {
  test(`probe: ${tool} outside the sandbox is denied`, () => {
    setPhase('probe');
    assert.equal(decide(tool, inputFor(tool, path.join(PROJECT, 'a.txt'))), 'deny');
  });
  test(`probe: ${tool} inside the sandbox is allowed`, () => {
    setPhase('probe');
    assert.equal(decide(tool, inputFor(tool, path.join(SANDBOX, 'a.txt'))), 'allow');
  });
}

for (const tool of SHELL_TOOLS) {
  test(`probe: ${tool} redirect into the project is denied`, () => {
    setPhase('probe');
    assert.equal(decide(tool, { command: `echo hi > ${path.join(PROJECT, 'out.txt')}` }), 'deny');
  });
}

test('every write and shell tool is routed to the guard by hooks.json', () => {
  const cfg = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const names = cfg.hooks.PreToolUse.flatMap((e) => e.matcher.split('|'));
  for (const tool of [...WRITE_TOOLS, ...SHELL_TOOLS]) {
    assert.ok(names.includes(tool), `${tool} missing from PreToolUse matcher`);
  }
});

// Observed: the guard ALLOWS an unknown tool even while armed (probe-guard.mjs
// only checks the four named file tools and the two shell tools, then passes).
// Real hooks.json routing never sends unknown tools to the guard, so this is
// only reachable if the matcher is widened or a new write tool is not added.
test('unknown tool FutureWriteTool is allowed by the guard (finding)', () => {
  setPhase('probe');
  assert.equal(decide('FutureWriteTool', { file_path: path.join(PROJECT, 'a.txt') }), 'allow');
});
