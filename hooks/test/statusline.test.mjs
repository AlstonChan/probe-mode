// The status line names the current round's restore point, and why it is
// missing when it is.
//
//   node --test hooks/test/statusline.test.mjs

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { statusText } from '../../opencode/lib.mjs';

const STATUSLINE = path.join(import.meta.dirname, '..', '..', 'hooks', 'probe-statusline.mjs');
const SID = 'statusline-test';
let CFG;

// eslint-disable-next-line no-control-regex
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const line = (state) => {
  fs.writeFileSync(path.join(CFG, 'probe-state', `${SID}.json`), JSON.stringify(state));
  return plain(execFileSync(process.execPath, [STATUSLINE, '--cmd=probe'], {
    input: JSON.stringify({ session_id: SID }), encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  }));
};
const snap = (n) => ({ n, ref: `${n}`.repeat(40), head: 'h', branch: 'main', at: 't' });

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-statusline-'));
  fs.mkdirSync(path.join(CFG, 'probe-state'), { recursive: true });
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

describe('status line restore hint', () => {
  test('a snapshot for the current round', () => {
    assert.match(line({ phase: 'probe', round: 2, rounds: [snap(1), snap(2)] }), /⟲ \/probe restore$/);
  });

  test('round 2 snapshotted even though round 1 was not', () => {
    const out = line({ phase: 'probe', round: 2, snapshot: null, rounds: [snap(2)] });
    assert.doesNotMatch(out, /no snapshot/);
  });

  test('a failed snapshot says so, not "not a git repo"', () => {
    const out = line({ phase: 'probe', round: 1, snapshot: null, rounds: [], snapshotError: 'disk full' });
    assert.match(out, /no snapshot \(snapshot failed\)/);
  });

  test('this round failed but an earlier one exists: point at it', () => {
    const out = line({ phase: 'probe', round: 3, rounds: [snap(1), snap(2)], snapshotError: 'x' });
    assert.match(out, /no snapshot this round \(snapshot failed\) · ⟲ \/probe restore --round 2/);
  });

  test('not a git repo', () => {
    assert.match(line({ phase: 'probe', round: 1, snapshot: null, rounds: [] }), /no snapshot \(not a git repo\)/);
  });
});

describe('OpenCode status text', () => {
  test('a failed snapshot is named', () => {
    const text = statusText(
      { phase: 'probe', round: 1, rounds: [], snapshot: null, snapshotError: 'disk full', sandbox: '/s', cwd: '/p' },
      { sessionId: SID, refExists: () => false },
    );
    assert.match(text, /snapshot failed: disk full/);
  });
});
