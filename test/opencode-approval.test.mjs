// OpenCode approval paths, driven through the real plugin with a stub ctx.
//
//   node --test test/opencode-approval.test.mjs
//
// Only an explicit approval of a plan written after `implement` may unlock:
// not a dialog raised during research, not a child session's stale rules, not
// a question answer that merely starts with "approve".

import { test, before, after, describe } from 'node:test';
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
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-oc-approval-'));
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

  const { default: plugin } = await import('../opencode/index.mjs');
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

describe('research phase', () => {
  test('a child edit is denied, and an Allow on its dialog does not unlock', async () => {
    await run({ sessionID: 'parent', prompt: { text: 'is X faster?' } });
    assert.equal(phase(), 'probe');

    const ev = { sessionID: 'child', action: 'edit', effect: 'ask', resources: ['src/app.js'] };
    await evaluate(ev);
    assert.equal(ev.effect, 'deny');
    assert.equal(ev.message, undefined, 'no approval dialog during research');

    push({ type: 'permission.asked', data: { id: 'p1', sessionID: 'child', action: 'edit' } });
    await tick();
    push({ type: 'permission.replied', data: { requestID: 'p1', sessionID: 'child', reply: 'once' } });
    await tick();
    assert.equal(phase(), 'probe');
  });

  test('sandbox edits stay allowed', async () => {
    const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'parent.json'), 'utf8'));
    const ev = { sessionID: 'child', action: 'edit', effect: 'ask', resources: [path.join(state.sandbox, 'a.txt')] };
    await evaluate(ev);
    assert.equal(ev.effect, 'allow');
  });
});

describe('a new round re-locks children created while unlocked', () => {
  test('a stale child allow becomes a deny', async () => {
    await run({ sessionID: 'parent', prompt: { text: 'approve' } }); // user's own command
    assert.equal(phase(), 'implementing');
    await run({ sessionID: 'parent', prompt: { text: 'round 2 question' } });
    assert.equal(phase(), 'probe');

    const ev = { sessionID: 'child', action: 'edit', effect: 'allow', resources: ['src/app.js'] };
    await evaluate(ev);
    assert.equal(ev.effect, 'deny');
  });
});

describe('question-tool approval while planning', () => {
  test('a label that only starts with "approve" does not unlock', async () => {
    await run({ sessionID: 'parent', prompt: { text: 'implement' } });
    assert.equal(phase(), 'planning');
    await answerQuestion('Approve later — keep researching first');
    assert.equal(phase(), 'planning');
  });

  test('the exact Approve label unlocks, with answers in metadata', async () => {
    await answerQuestion('Approve', 'string');
    assert.equal(phase(), 'implementing');
  });

  test('an edit in planning resolves to the approval dialog', async () => {
    await run({ sessionID: 'parent', prompt: { text: 'round 3' } });
    await run({ sessionID: 'parent', prompt: { text: 'implement' } });
    const ev = { sessionID: 'parent', action: 'edit', effect: 'ask', resources: ['src/app.js'] };
    await evaluate(ev);
    assert.equal(ev.effect, 'ask');
    assert.match(ev.message, /APPROVAL/i);
  });
});
