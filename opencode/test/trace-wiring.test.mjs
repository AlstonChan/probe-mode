import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let ROOT, STATE_DIR, REPO, run, evaluate;

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
      prompt: async () => {},
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
