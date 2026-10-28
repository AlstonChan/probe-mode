// User and project command patterns.
//
//   node --test shared/test/policy.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPolicy, matchPolicy, analyzeCommand } from '../../shared/shell.mjs';

const HOOKS = path.join(import.meta.dirname, '..', '..', 'hooks');
const SID = 'policy-test';
let CFG, PROJECT, SANDBOX;

const guard = (command) => {
  const out = execFileSync(process.execPath, [path.join(HOOKS, 'probe-guard.mjs')], {
    input: JSON.stringify({ session_id: SID, cwd: PROJECT, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
};
const writeUser = (o) => fs.writeFileSync(path.join(CFG, 'probe.json'), JSON.stringify(o));
const writeProject = (o) => fs.writeFileSync(path.join(PROJECT, '.probe.json'), JSON.stringify(o));

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-policy-'));
  PROJECT = path.join(CFG, 'project');
  SANDBOX = path.join(CFG, 'probe-state', SID, 'sandbox');
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'probe-state', `${SID}.json`), JSON.stringify({ phase: 'probe', sandbox: SANDBOX, cwd: PROJECT }));
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('through the real guard', () => {
  test('a user allow lets a command the analysis denies run', () => {
    assert.equal(guard('make clean'), 'deny');
    writeUser({ allow: ['make clean'] });
    assert.equal(guard('make clean'), 'allow');
  });

  test('a user deny blocks a command the analysis allows', () => {
    writeUser({ deny: ['./scripts/seed*'] });
    assert.equal(guard('./scripts/seed.sh --all'), 'deny');
    assert.equal(guard('./scripts/test.sh'), 'allow');
  });

  test('a project file can deny but never allow', () => {
    writeUser({});
    writeProject({ allow: ['git commit*'], deny: ['npm run migrate*'] });
    assert.equal(guard('git commit -m x'), 'deny', 'project allow ignored');
    assert.equal(guard('npm run migrate:up'), 'deny');
    fs.rmSync(path.join(PROJECT, '.probe.json'));
  });

  test('an allow pattern never covers a chained, redirected or substituted command', () => {
    writeUser({ allow: ['make *'] });
    assert.equal(guard('make lint'), 'allow');
    assert.equal(guard('make x && rm -rf src'), 'deny');
    assert.equal(guard('make x > README.md'), 'deny');
    assert.equal(guard('make $(rm -rf src)'), 'deny');
  });

  test('deny wins over allow', () => {
    writeUser({ allow: ['make *'], deny: ['make deploy*'] });
    assert.equal(guard('make deploy prod'), 'deny');
  });

  test('a broken user file allows nothing extra', () => {
    fs.writeFileSync(path.join(CFG, 'probe.json'), '{ not json');
    assert.equal(guard('make clean'), 'deny');
  });
});

describe('loadPolicy', () => {
  test('wildcard-only allows are refused and reported', () => {
    writeUser({ allow: ['*', ' ** ', 'make lint'] });
    const p = loadPolicy({ userFile: path.join(CFG, 'probe.json'), projectDir: PROJECT });
    assert.deepEqual(p.allow.map((r) => r.pattern), ['make lint']);
    assert.equal(p.errors.length, 2);
  });

  test('matching is whole-line and case-insensitive', () => {
    const policy = { allow: [{ pattern: 'make lint', source: 'u' }], deny: [] };
    assert.equal(matchPolicy('MAKE LINT', policy)?.effect, 'allow');
    assert.equal(matchPolicy('make lint && rm -rf .', policy), null);
  });

  test('analyzeCommand without a policy is unchanged', () => {
    assert.equal(analyzeCommand('ls', { cwd: PROJECT, roots: [SANDBOX] }), null);
  });
});
