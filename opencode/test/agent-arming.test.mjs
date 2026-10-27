// Selecting the `probe` agent (Shift+Tab) must arm the session or block it,
// not leave it unenforced.
//
//   node --test opencode/test/agent-arming.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOpencodeHarness } from '../../test/fixtures/harness.mjs';

const stateFile = (h, sid) => path.join(h.stateDir, `${sid}.json`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function withHarness(fn) {
  const h = await createOpencodeHarness();
  try { await fn(h); } finally { h.close(); }
}

test('probe agent, unarmed: first context event arms the session', () => withHarness(async (h) => {
  const event = { sessionID: 's1', agent: 'probe', system: [] };
  await h.context(event);
  assert.ok(fs.existsSync(stateFile(h, 's1')));
  const state = readJson(stateFile(h, 's1'));
  assert.equal(state.phase, 'probe');
  assert.equal(state.round, 1);
  assert.equal(event.system.length, 1);
  assert.match(event.system[0].text, /probe/i);
}));

test('two concurrent context events arm once', () => withHarness(async (h) => {
  const a = { sessionID: 's1', agent: 'probe', system: [] };
  const b = { sessionID: 's1', agent: 'probe', system: [] };
  await Promise.all([h.context(a), h.context(b)]);
  assert.equal(readJson(stateFile(h, 's1')).round, 1);
  assert.equal(h.calls.filter((c) => c.fn === 'update').length, 1);
}));

test('other agent, unarmed: nothing happens', () => withHarness(async (h) => {
  const event = { sessionID: 's1', agent: 'build', system: [] };
  await h.context(event);
  assert.equal(fs.existsSync(stateFile(h, 's1')), false);
  assert.equal(event.system.length, 0);
}));

test('already armed: no re-arm', () => withHarness(async (h) => {
  await h.context({ sessionID: 's1', agent: 'probe', system: [] });
  const before = h.calls.length;
  await h.context({ sessionID: 's1', agent: 'probe', system: [] });
  assert.equal(readJson(stateFile(h, 's1')).round, 1);
  assert.equal(h.calls.length, before);
}));

test('arm failure is swallowed and does not reject', () => withHarness(async (h) => {
  fs.rmSync(h.stateDir, { recursive: true, force: true });
  fs.writeFileSync(h.stateDir, 'not a directory');
  await assert.doesNotReject(h.context({ sessionID: 's1', agent: 'probe', system: [] }));
}));

const edit = (agent, action = 'edit', resources = ['C:/proj/package.json']) =>
  ({ sessionID: 's2', agent, action, resources, effect: 'allow' });

test('probe agent, unarmed: edit is denied', () => withHarness(async (h) => {
  const event = edit('probe');
  await h.evaluate(event);
  assert.equal(event.effect, 'deny');
  assert.match(event.message, /\/probe/);
}));

test('probe agent, unarmed: shell is denied', () => withHarness(async (h) => {
  const event = edit('probe', 'shell', ['npm install']);
  await h.evaluate(event);
  assert.equal(event.effect, 'deny');
}));

test('probe agent, unarmed: read is untouched', () => withHarness(async (h) => {
  const event = edit('probe', 'read');
  await h.evaluate(event);
  assert.equal(event.effect, 'allow');
}));

test('build agent, unarmed: edit is untouched', () => withHarness(async (h) => {
  const event = edit('build');
  await h.evaluate(event);
  assert.equal(event.effect, 'allow');
}));
