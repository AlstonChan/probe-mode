// Restore acts on the right repository and the right branch, and puts the
// index back as it was.
//
//   node --test hooks/test/restore.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTL = path.join(import.meta.dirname, '..', '..', 'hooks', 'probe-ctl.mjs');
const SID = 'restore-test-session';

let ROOT, CFG, A, B;

const gitIn = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ctlIn = (dir, ...args) => execFileSync(process.execPath, [CTL, ...args], {
  cwd: dir, encoding: 'utf8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID },
});
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8').trim();
const exists = (dir, f) => fs.existsSync(path.join(dir, f));

function repo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, ['init', '-q', '-b', 'main']);
  gitIn(dir, ['config', 'user.email', 't@t']);
  gitIn(dir, ['config', 'user.name', 't']);
  gitIn(dir, ['config', 'commit.gpgsign', 'false']);
  gitIn(dir, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'v1');
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-qm', 'base']);
}

function fresh() {
  fs.rmSync(path.join(CFG, 'probe-state'), { recursive: true, force: true });
  repo(A);
  repo(B);
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-restore-'));
  CFG = path.join(ROOT, 'cfg');
  A = path.join(ROOT, 'a');
  B = path.join(ROOT, 'b');
});
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

describe('the recorded repository, wherever restore is run from', () => {
  test('restore run from another repo acts on the armed one and leaves the other alone', () => {
    fresh();
    ctlIn(A, 'start');
    fs.writeFileSync(path.join(A, 'f.txt'), 'edited in A');
    fs.writeFileSync(path.join(B, 'f.txt'), 'edited in B');

    const preview = ctlIn(B, 'restore');
    assert.match(preview, new RegExp(`Repository: .*${path.basename(ROOT)}.a`));

    ctlIn(B, 'restore', '--force');
    assert.equal(read(A, 'f.txt'), 'v1');
    assert.equal(read(B, 'f.txt'), 'edited in B', 'the other repo is untouched');
    assert.equal(gitIn(B, ['stash', 'list']), '');
    assert.equal(gitIn(B, ['for-each-ref', 'refs/probe']), '');
  });

  test('a snapshot missing from the repository is refused', () => {
    fresh();
    ctlIn(A, 'start');
    const statePath = path.join(CFG, 'probe-state', `${SID}.json`);
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    s.cwd = B; // as if the session had been armed somewhere else
    fs.writeFileSync(statePath, JSON.stringify(s));
    const out = ctlIn(A, 'restore', '--force');
    assert.match(out, /is not in the repository/);
    assert.match(out, /Nothing was changed/);
  });
});

describe('the snapshot branch, and only that branch', () => {
  test('restore refuses while on another branch, and changes nothing', () => {
    fresh();
    ctlIn(A, 'start');
    gitIn(A, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(A, 'f.txt'), 'feature work');
    gitIn(A, ['commit', '-qam', 'feature 1']);
    const tip = gitIn(A, ['rev-parse', 'HEAD']);

    for (const args of [['restore'], ['restore', '--force']]) {
      const out = ctlIn(A, ...args);
      assert.match(out, /taken on branch main, but you are on feature/);
      assert.match(out, /git switch main/);
    }
    assert.equal(gitIn(A, ['rev-parse', 'HEAD']), tip);
    assert.equal(read(A, 'f.txt'), 'feature work');
  });

  test('after switching back it restores, naming the branch it moved', () => {
    gitIn(A, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(A, 'f.txt'), 'main edit');
    gitIn(A, ['commit', '-qam', 'main 1']);
    const out = ctlIn(A, 'restore', '--force');
    assert.match(out, /main is at [0-9a-f]{12}/);
    assert.match(out, /1 commit\(s\) rolled back/);
    assert.equal(read(A, 'f.txt'), 'v1');
    assert.notEqual(gitIn(A, ['rev-parse', 'feature']), gitIn(A, ['rev-parse', 'main']), 'feature untouched');
  });
});

describe('worktree and index come back as they were', () => {
  test('a file staged at snapshot time is staged again after restore', () => {
    fresh();
    fs.writeFileSync(path.join(A, 'new.txt'), 'staged');
    gitIn(A, ['add', 'new.txt']);
    ctlIn(A, 'start');
    gitIn(A, ['reset', '-q']);
    fs.writeFileSync(path.join(A, 'new.txt'), 'changed later');

    ctlIn(A, 'restore', '--force');
    assert.equal(read(A, 'new.txt'), 'staged');
    assert.equal(gitIn(A, ['status', '--porcelain']), 'A  new.txt');
  });

  test('nothing staged: the snapshot has only HEAD as parent', () => {
    fresh();
    ctlIn(A, 'start');
    const s = JSON.parse(fs.readFileSync(path.join(CFG, 'probe-state', `${SID}.json`), 'utf8'));
    const parents = gitIn(A, ['rev-list', '--parents', '-n1', s.rounds[0].ref]).split(' ').slice(1);
    assert.deepEqual(parents, [gitIn(A, ['rev-parse', 'HEAD'])]);
  });

  test('an untracked file created since is removed, previewed, and comes back with --undo', () => {
    fresh();
    ctlIn(A, 'start');
    fs.mkdirSync(path.join(A, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(A, 'stray.txt'), 'new');

    const preview = ctlIn(A, 'restore');
    assert.match(preview, /stray\.txt/);

    ctlIn(path.join(A, 'sub'), 'restore', '--force'); // from a subdirectory
    assert.equal(exists(A, 'stray.txt'), false);
    assert.equal(gitIn(A, ['stash', 'list']), '', 'no stash: the undo point is the safety net');

    ctlIn(A, 'restore', '--undo', '--force');
    assert.equal(read(A, 'stray.txt'), 'new');
  });

  test('restoring a no-commit snapshot from a subdirectory clears the repo root', () => {
    fs.rmSync(path.join(CFG, 'probe-state'), { recursive: true, force: true });
    fs.rmSync(A, { recursive: true, force: true });
    fs.mkdirSync(path.join(A, 'sub'), { recursive: true });
    gitIn(A, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(A, 'a.txt'), 'hi');
    ctlIn(A, 'start');
    fs.writeFileSync(path.join(A, 'stray.txt'), 'x');

    ctlIn(path.join(A, 'sub'), 'restore', '--force');
    assert.equal(exists(A, 'stray.txt'), false);
    assert.equal(read(A, 'a.txt'), 'hi');
  });
});
