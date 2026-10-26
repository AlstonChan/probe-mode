// The check subcommand: a dry run of the guard, on both hosts.
//
//   node --test test/check.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkReport } from '../shared/shell.mjs';
import { parseInvocation } from '../opencode/lib.mjs';

const CTL = path.join(import.meta.dirname, '..', 'hooks', 'probe-ctl.mjs');
const SID = 'check-test';
let CFG, PROJECT, SANDBOX;

const ctl = (...args) => execFileSync(process.execPath, [CTL, ...args], {
  cwd: PROJECT, encoding: 'utf8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID },
});

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-check-'));
  PROJECT = path.join(CFG, 'project');
  SANDBOX = path.join(CFG, 'probe-state', SID, 'sandbox');
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'probe-state', `${SID}.json`), JSON.stringify({ phase: 'probe', sandbox: SANDBOX, cwd: PROJECT }));
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('probe-ctl check', () => {
  test('a project write is DENY, with the path', () => {
    const out = ctl('check', 'echo hi > README.md');
    assert.match(out, /Verdict: DENY/);
    assert.match(out, /README\.md/);
  });

  test('a read is ALLOW', () => assert.match(ctl('check', 'git log --oneline'), /ALLOW — it does not write/));

  test('a sandbox write is ALLOW', () => {
    assert.match(ctl('check', `echo hi > ${SANDBOX.split(path.sep).join('/')}/x`), /ALLOW — every write lands inside the sandbox/);
  });

  test('--shell=powershell analyses PowerShell', () => {
    assert.match(ctl('check', '--shell=powershell', 'del README.md'), /Verdict: DENY/);
    assert.match(ctl('check', 'del README.md'), /Verdict: DENY/, 'bash still sees cmd del');
  });

  test('an unlocked phase allows everything', () => {
    const report = checkReport('rm -rf src', { cwd: PROJECT, roots: [SANDBOX], phase: 'implementing' });
    assert.match(report, /not blocked in the implementing phase/);
  });

  test('no command prints usage', () => assert.match(ctl('check'), /Usage: check/));
});

describe('OpenCode parses check with the command intact', () => {
  test('rest keeps quotes and spacing', () => {
    const p = parseInvocation('check echo "a  b" > out.txt');
    assert.equal(p.sub, 'check');
    assert.equal(p.rest, 'echo "a  b" > out.txt');
  });
});
