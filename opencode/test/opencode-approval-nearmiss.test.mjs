// Near-miss answers to the OpenCode plan-approval question.
//
// Only the exact label "approve" (trimmed, case-insensitive) unlocks; every
// other answer must leave the session in planning. Each case re-arms a fresh
// planning round so one case cannot mask another.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let ROOT, STATE_DIR, REPO, run, evaluate, afterTool, push;
const parents = { child: 'parent' };
const phase = () => JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'parent.json'), 'utf8')).phase;
const tick = () => new Promise((r) => setTimeout(r, 30));
const answerQuestion = (answer, shape = 'object') => afterTool({
  sessionID: 'parent', tool: 'question', status: 'completed',
  input: { questions: [{ header: 'Probe plan approval', question: 'ok?' }] },
  result: shape === 'object'
    ? { output: { answers: [[answer]] } }
    : { output: `User answered: "ok?"="${answer}"`, metadata: { answers: [[answer]] } },
});

before(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-oc-nearmiss-'));
  STATE_DIR = path.join(ROOT, 'state');
  REPO = path.join(ROOT, 'repo');
  fs.mkdirSync(REPO, { recursive: true });
  process.env.PROBE_STATE_DIR = STATE_DIR;

  const queue = [];
  let wake;
  push = (e) => { queue.push(e); wake?.(); };
  async function* stream() {
    for (;;) {
      while (queue.length) yield queue.shift();
      await new Promise((r) => { wake = r; });
    }
  }

  const { default: plugin } = await import('../../opencode/index.mjs');
  await plugin.setup({
    location: { directory: REPO },
    session: {
      get: async ({ sessionID }) => ({ parentID: parents[sessionID] }),
      update: async () => {},
      switchAgent: async () => {},
      prompt: async () => {},
      hook: async () => {},
    },
    agent: { transform: async () => {} },
    command: { transform: async (fn) => fn({ add: (c) => { run = c.execute; } }) },
    permission: { hook: async (_n, fn) => { evaluate = fn; } },
    tool: { hook: async (_n, fn) => { afterTool = fn; } },
    event: { subscribe: () => stream() },
  });
});

after(() => {
  delete process.env.PROBE_STATE_DIR;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

const arm = async () => {
  await run({ sessionID: 'parent', prompt: { text: 'new round question' } });
  assert.equal(phase(), 'probe');
  await run({ sessionID: 'parent', prompt: { text: 'implement' } });
  assert.equal(phase(), 'planning');
};

for (const answer of ['Approve.', 'Approve!', 'Approved', 'Approve it', '']) {
  test(`near-miss answer ${JSON.stringify(answer)} does not unlock`, async () => {
    await arm();
    await answerQuestion(answer);
    assert.equal(phase(), 'planning');
  });
}
test('"  APPROVE  " unlocks (trim + lowercase)', async () => {
  await arm();
  await answerQuestion('  APPROVE  ');
  assert.equal(phase(), 'implementing');
});

