import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ROOT, STATE_DIR, REPO, run, evaluate, failPrompt = false;

before(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-oc-trace-'));
  STATE_DIR = path.join(ROOT, 'state');
  REPO = path.join(ROOT, 'repo');
  fs.mkdirSync(REPO, { recursive: true });
  process.env.PROBE_STATE_DIR = STATE_DIR;
  process.env.PROBE_RECORD = '1';

  async function* stream() { await new Promise(() => {}); }
  const { default: plugin } = await import('../../opencode/index.mjs');
  await plugin.setup({
    location: { directory: REPO },
    session: {
      get: async () => ({}),
      update: async () => {},
      switchAgent: async () => {},
      prompt: async () => { if (failPrompt) throw new Error('boom'); },
      synthetic: async () => { if (failPrompt) throw new Error('boom'); },
      hook: async () => {},
    },
    agent: { transform: async () => {} },
    command: { transform: async (fn) => fn({ add: (c) => { run = c.execute; } }) },
    permission: { hook: async (_n, fn) => { evaluate = fn; } },
    tool: { hook: async () => {} },
    event: { subscribe: () => stream() },
  });
});

after(() => {
  delete process.env.PROBE_STATE_DIR;
  delete process.env.PROBE_RECORD;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

test('permission.evaluate logs one entry for an out-of-sandbox edit', async () => {
  await run({ sessionID: 's1', prompt: { text: 'is X faster?' } });
  const file = path.join(STATE_DIR, 'trace.jsonl');
  fs.rmSync(file, { force: true });
  const ev = { sessionID: 's1', action: 'edit', effect: 'ask', resources: ['src/app.js'] };
  await evaluate(ev);
  assert.equal(ev.effect, 'deny');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.host, 'opencode');
  assert.equal(e.hook, 'permission.evaluate');
  assert.equal(e.sessionId, 's1');
  assert.equal(e.decision, 'deny');
});

test('/probe subcommands log the phase before and after', async () => {
  await run({ sessionID: 's9', prompt: { text: 'is X faster?' } });
  const file = path.join(STATE_DIR, 'trace.jsonl');
  fs.rmSync(file, { force: true });
  await run({ sessionID: 's9', prompt: { text: 'implement' } });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const e = lines.find((l) => l.hook === 'command');
  assert.ok(e, 'a command entry was written');
  assert.equal(e.host, 'opencode');
  assert.equal(e.sessionId, 's9');
  assert.equal(e.input.sub, 'implement');
  assert.equal(e.input.phaseBefore, 'probe');
  assert.equal(e.decision.phaseAfter, 'planning');
});

test('a failing command is logged with its error and still rethrown', async () => {
  await run({ sessionID: 's10', prompt: { text: 'is X faster?' } });
  const file = path.join(STATE_DIR, 'trace.jsonl');
  fs.rmSync(file, { force: true });
  failPrompt = true;
  try {
    await assert.rejects(run({ sessionID: 's10', prompt: { text: 'status' } }));
  } finally { failPrompt = false; }
  const e = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.hook === 'command');
  assert.match(e.decision.error, /boom/);
});