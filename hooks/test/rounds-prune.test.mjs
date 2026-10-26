// rounds / rounds prune: list restore points, drop all but the current one.
//
//   node --test test/rounds-prune.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTL = path.join(import.meta.dirname, '..', 'hooks', 'probe-ctl.mjs');
const SID = 'prune-test';
let CFG, REPO;

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ctl = (...args) => execFileSync(process.execPath, [CTL, ...args], {
  cwd: REPO, encoding: 'utf8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_SESSION_ID: SID },
});
const refs = () => git(['for-each-ref', '--format=%(refname)', `refs/probe/${SID}*`]).split('\n').filter(Boolean).sort();
const state = () => JSON.parse(fs.readFileSync(path.join(CFG, 'probe-state', `${SID}.json`), 'utf8'));

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-prune-'));
  REPO = path.join(CFG, 'repo');
  fs.mkdirSync(REPO, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  ctl('start');
  ctl('start');
  ctl('start');
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('rounds', () => {
  test('lists every round', () => {
    const out = ctl('rounds');
    assert.match(out, /current: 3/);
    for (const n of [1, 2, 3]) assert.match(out, new RegExp(`ok round ${n} `));
  });

  test('prune without --force only previews', () => {
    const out = ctl('rounds', 'prune');
    assert.match(out, /PRUNE PREVIEW/);
    assert.match(out, /round 1/);
    assert.equal(refs().length, 3);
  });

  test('prune --force keeps only the current round', () => {
    assert.match(ctl('rounds', 'prune', '--force'), /Pruned 2 restore point\(s\)/);
    assert.deepEqual(refs(), [`refs/probe/${SID}-r3`]);
    assert.deepEqual(state().rounds.map((r) => r.n), [3]);
    assert.equal(state().snapshot, null);
    assert.match(ctl('restore'), /RESTORE PREVIEW/, 'restore still works on the kept round');
  });

  test('nothing left to prune', () => assert.match(ctl('rounds', 'prune'), /Nothing to prune/));
});
