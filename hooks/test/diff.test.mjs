// The diff subcommand: what changed since a round's snapshot, read-only.
//
//   node --test hooks/test/diff.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTL = path.join(import.meta.dirname, '..', '..', 'hooks', 'probe-ctl.mjs');
const SID = 'diff-test';
let CFG, REPO;

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ctl = (...args) => execFileSync(process.execPath, [CTL, ...args], {
  cwd: REPO, encoding: 'utf8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID },
});

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-diff-'));
  REPO = path.join(CFG, 'repo');
  fs.mkdirSync(REPO, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(REPO, 'f.txt'), 'v1\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('probe-ctl diff', () => {
  test('nothing changed yet', () => {
    ctl('start');
    assert.match(ctl('diff'), /No changes\./);
  });

  test('edits, new untracked files and commits all show, and nothing is touched', () => {
    fs.writeFileSync(path.join(REPO, 'f.txt'), 'v2\n');
    git(['commit', '-qam', 'second']);
    fs.writeFileSync(path.join(REPO, 'new.txt'), 'n\n');
    const statusBefore = git(['status', '--porcelain']);

    const out = ctl('diff');
    assert.match(out, /f\.txt/);
    assert.match(out, /new\.txt/);
    assert.match(out, /Commits since then:\n {2}[0-9a-f]+ second/);
    assert.equal(git(['status', '--porcelain']), statusBefore, 'diff changes nothing');
  });

  test('--patch shows the content', () => assert.match(ctl('diff', '--patch'), /\+v2/));

  test('--round picks an earlier round', () => {
    ctl('start'); // round 2, taken after the edits
    assert.match(ctl('diff'), /No changes\./);
    assert.match(ctl('diff', '--round', '1'), /new\.txt/);
  });

  test('without probe mode it says so', () => {
    const out = execFileSync(process.execPath, [CTL, 'diff'], {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: 'never-armed' },
    });
    assert.match(out, /not active/);
  });
});
