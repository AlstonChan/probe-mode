// Opt-in trace logger: off by default, never throws, truncates large strings.
//
//   node --test shared/test/trace.test.mjs

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { trace } from '../trace.mjs';

let DIR, SAVED;
const file = () => path.join(DIR, 'trace.jsonl');

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-trace-'));
  SAVED = process.env.PROBE_RECORD;
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.PROBE_RECORD;
  else process.env.PROBE_RECORD = SAVED;
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('PROBE_RECORD unset: no trace file', () => {
  delete process.env.PROBE_RECORD;
  trace(DIR, { host: 'opencode', hook: 'guard', input: { a: 1 } });
  assert.equal(fs.existsSync(file()), false);
});

test('PROBE_RECORD set: one line with all six fields', () => {
  process.env.PROBE_RECORD = '1';
  trace(DIR, { host: 'opencode', hook: 'guard', sessionId: 's1', input: { a: 1 }, decision: 'allow' });
  const lines = fs.readFileSync(file(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const o = JSON.parse(lines[0]);
  for (const k of ['at', 'host', 'hook', 'sessionId', 'input', 'decision']) assert.ok(k in o, k);
  assert.equal(o.host, 'opencode');
  assert.equal(o.decision, 'allow');
});

test('long strings are truncated to 2000 chars plus suffix', () => {
  process.env.PROBE_RECORD = '1';
  trace(DIR, { host: 'claude-code', hook: 'guard', input: { cmd: 'x'.repeat(5000), nested: ['y'.repeat(3000)] } });
  const o = JSON.parse(fs.readFileSync(file(), 'utf8'));
  assert.equal(o.input.cmd, 'x'.repeat(2000) + '…[truncated]');
  assert.equal(o.input.nested[0], 'y'.repeat(2000) + '…[truncated]');
});

test('circular payload: no throw, nothing written', () => {
  process.env.PROBE_RECORD = '1';
  const a = {};
  a.self = a;
  assert.doesNotThrow(() => trace(DIR, { host: 'opencode', hook: 'guard', input: a }));
  assert.equal(fs.existsSync(file()), false);
});

test('non-JSON value (bigint): no throw, nothing written', () => {
  process.env.PROBE_RECORD = '1';
  assert.doesNotThrow(() => trace(DIR, { host: 'opencode', hook: 'guard', input: { n: 1n } }));
  assert.equal(fs.existsSync(file()), false);
});

test('unwritable stateDir (parent is a file): no throw', () => {
  process.env.PROBE_RECORD = '1';
  const blocker = path.join(DIR, 'blocker');
  fs.writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => trace(path.join(blocker, 'sub'), { host: 'opencode', hook: 'guard', input: {} }));
});

test('trace.jsonl is a directory: no throw', () => {
  process.env.PROBE_RECORD = '1';
  fs.mkdirSync(file());
  assert.doesNotThrow(() => trace(DIR, { host: 'opencode', hook: 'guard', input: {} }));
});
