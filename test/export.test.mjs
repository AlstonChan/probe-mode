// export: one markdown file outside the project with the round's findings.
//
//   node --test test/export.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTL = path.join(import.meta.dirname, '..', 'hooks', 'probe-ctl.mjs');
const SID = 'export-test';
let CFG, REPO;

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ctl = (...args) => execFileSync(process.execPath, [CTL, ...args], {
  cwd: REPO, encoding: 'utf8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID },
});

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-export-'));
  REPO = path.join(CFG, 'repo');
  fs.mkdirSync(REPO, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(REPO, 'f.txt'), 'v1\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('probe-ctl export', () => {
  test('writes findings, sandbox listing, changes and denials outside the project', () => {
    ctl('start');
    const sandbox = path.join(CFG, 'probe-state', SID, 'sandbox');
    fs.writeFileSync(path.join(sandbox, 'findings.md'), '# Result\n\nThe cache is 3x faster.\n');
    fs.mkdirSync(path.join(sandbox, 'bench'));
    fs.writeFileSync(path.join(sandbox, 'bench', 'run.js'), 'x');
    fs.writeFileSync(path.join(REPO, 'f.txt'), 'v2\n');
    fs.appendFileSync(path.join(CFG, 'probe-state', `${SID}.denials.jsonl`),
      `${JSON.stringify({ at: 't', tool: 'Bash', what: 'git commit -m x', reason: 'r' })}\n`);

    const out = ctl('export');
    const file = out.match(/Exported to (.*)/)[1].trim();
    assert.ok(file.startsWith(path.join(CFG, 'probe-exports')), 'outside the project');
    assert.ok(file.endsWith(`${SID}-r1.md`));

    const md = fs.readFileSync(file, 'utf8');
    assert.match(md, /The cache is 3x faster\./);
    assert.match(md, /bench\/run\.js {2}\(1 B\)/);
    assert.match(md, /f\.txt/);
    assert.match(md, /## Denials \(1\)/);
    assert.match(md, /git commit -m x/);
    assert.equal(git(['status', '--porcelain']), 'M f.txt', 'the project is untouched');
  });

  test('without probe mode it says so', () => {
    const out = execFileSync(process.execPath, [CTL, 'export'], {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: 'never-armed' },
    });
    assert.match(out, /not active/);
  });
});
