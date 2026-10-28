// Informational /probe subcommands show their output once, as a notice that
// starts no model turn; only the ones that need the model act through a prompt.
//
//   node --test opencode/test/command-output.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeHarness } from '../../test/fixtures/harness.mjs';

async function withHarness(fn) {
  const h = await createOpencodeHarness();
  try { await fn(h); } finally { h.close(); }
}

/** The prompt/synthetic calls one `/probe` invocation made. */
async function output(h, sessionID, text) {
  const start = h.calls.length;
  await h.run({ sessionID, prompt: { text } });
  return h.calls.slice(start).filter((c) => c.fn === 'prompt' || c.fn === 'synthetic');
}

function assertNotice(calls, pattern) {
  assert.equal(calls.length, 1, `one output call, got ${calls.map((c) => c.fn)}`);
  const [{ fn, input }] = calls;
  assert.equal(fn, 'synthetic');
  assert.equal(input.resume, false);
  assert.match(input.description, pattern);
  assert.doesNotMatch(input.description, /as-is/);
  assert.match(input.text, pattern);
}

function assertPrompt(calls) {
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'prompt');
}

test('armed: reporting subcommands are notices', () => withHarness(async (h) => {
  assertPrompt(await output(h, 's1', 'is X faster?'));
  assertNotice(await output(h, 's1', 'status'), /Probe mode: probe \(round 1\)/);
  assertNotice(await output(h, 's1', 'check rm x'), /rm x|deny|allow/i);
  assertNotice(await output(h, 's1', 'diff'), /\S/);
  assertNotice(await output(h, 's1', 'rounds'), /\S/);
  assertNotice(await output(h, 's1', 'rounds prune'), /\S/);
  assertNotice(await output(h, 's1', 'export'), /Exported to/);
  assertNotice(await output(h, 's1', 'restore'), /\S/);
}));

test('unarmed: every refusal is a notice', () => withHarness(async (h) => {
  assertNotice(await output(h, 's2', 'status'), /Probe mode: OFF/);
  assertNotice(await output(h, 's2', 'check rm x'), /not active/);
  for (const sub of ['diff', 'rounds', 'export', 'restore', 'implement', 'approve']) {
    assertNotice(await output(h, 's2', sub), /not active/);
  }
}));

test('stop and a bare /probe are notices; bare /probe still arms', () => withHarness(async (h) => {
  assertNotice(await output(h, 's3', ''), /PROBE MODE ON/);
  assert.ok(h.calls.some((c) => c.fn === 'switchAgent'));
  assertNotice(await output(h, 's3', 'stop'), /Probe mode OFF/);
}));

test('a bare /probe is labeled as typed, not as the start alias', () => withHarness(async (h) => {
  const [{ input }] = await output(h, 's6', '');
  assert.match(input.text, /^\[\/probe\] /);
}));

test('a bare /probe with an attachment hands the turn to the model', () => withHarness(async (h) => {
  const start = h.calls.length;
  await h.run({ sessionID: 's7', prompt: { text: '', files: [{ path: 'spec.md' }] } });
  const calls = h.calls.slice(start).filter((c) => c.fn === 'prompt' || c.fn === 'synthetic');
  assertPrompt(calls);
  assert.deepEqual(calls[0].input.files, [{ path: 'spec.md' }]);
}));

test('notices keep the delivery the host asked for', () => withHarness(async (h) => {
  await h.run({ sessionID: 's8', prompt: { text: 'status' }, delivery: 'queue' });
  assert.equal(h.calls.at(-1).input.delivery, 'queue');
}));

test('only the prune preview warns the model off --force', () => withHarness(async (h) => {
  await output(h, 's9', 'is X faster?');
  const [list] = await output(h, 's9', 'rounds');
  assert.doesNotMatch(list.input.text, /--force yourself/);
  const [prune] = await output(h, 's9', 'rounds prune');
  assert.match(prune.input.text, /--force yourself/);
}));

test('implement refusal is a notice', () => withHarness(async (h) => {
  await output(h, 's4', 'is X faster?');
  await output(h, 's4', 'approve');
  assertNotice(await output(h, 's4', 'implement'), /\S/);
}));

test('subcommands that need the model still prompt it', () => withHarness(async (h) => {
  assertPrompt(await output(h, 's5', 'is X faster?'));
  assertPrompt(await output(h, 's5', 'implement'));
  assertPrompt(await output(h, 's5', 'approve'));
  assertPrompt(await output(h, 's5', 'round two question'));
}));
