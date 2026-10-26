// Every hook must exit even when its stdin pipe is never closed.
//
//   node --test test/hooks-stdin.test.mjs
//
// This is the regression guard for the process leak: fs.readFileSync(0) blocks the
// event loop forever when Claude Code writes a payload and never closes the pipe.
// Measured before the fix: 10 orphaned node.exe, 0.00 CPU, 1 thread, 17-24h old,
// parents dead, ~168MB resident.
//
// NOTE: these tests deliberately do NOT use execFileSync({ input }) like the rest of
// the suite does. That helper CLOSES stdin, which is precisely why the bug survived
// 120 existing assertions -- the old harness cannot express a never-closed pipe.
// Use spawn(), write if the case calls for it, and never call end().

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOKS_DIR = path.join(import.meta.dirname, '..', 'hooks');
const SID = 'stdin-test-session';

// Anything still alive when the file finishes gets killed, so a FAILING test can
// never itself leak processes onto the developer's machine -- which is the exact
// failure mode under test.
const strays = new Set();
after(() => {
  for (const child of strays) {
    try { child.kill('SIGKILL'); } catch {}
  }
});

function freshCfg() {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-stdin-cfg-'));
  fs.mkdirSync(path.join(cfg, 'probe-state'), { recursive: true });
  return cfg;
}

/**
 * Spawns a hook with a piped stdin that is NEVER ended, optionally writing some
 * bytes first. Resolves with how long the process took to exit on its own, or
 * rejects the deadline by resolving { exited: false } after force-killing it.
 */
function runWithOpenStdin(hook, { write = null, chunks = null, deadlineMs, cfg }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HOOKS_DIR, hook)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: SID },
    });
    strays.add(child);

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', () => {});
    // A hook that exits while we still hold the write end produces EPIPE here.
    // That is the success path, not an error.
    child.stdin.on('error', () => {});

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ exited: false, ms: Date.now() - started, stdout });
    }, deadlineMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      strays.delete(child);
      resolve({ exited: true, ms: Date.now() - started, code, stdout });
    });

    if (write !== null) child.stdin.write(write);
    if (chunks) {
      // Split across writes with a gap, so a chunk boundary lands mid-payload.
      child.stdin.write(chunks[0]);
      setTimeout(() => { try { child.stdin.write(chunks[1]); } catch {} }, 300);
    }
    // Deliberately no child.stdin.end() -- that is the whole point.
  });
}

// The statusline re-runs on a timer (refreshInterval), so its budget must stay
// INSIDE one interval: if a stuck instance outlives its own refresh, a successor
// spawns on top of it and they compound. Every other hook has a hooks.json timeout
// of 15-20s, so a 5s soft / 7s hard budget leaves plenty of headroom.
const HOOKS = [
  { hook: 'probe-statusline.mjs', deadline: 3000 },
  { hook: 'probe-guard.mjs', deadline: 9000 },
  { hook: 'probe-context.mjs', deadline: 9000 },
  { hook: 'probe-promote.mjs', deadline: 9000 },
  { hook: 'probe-cleanup.mjs', deadline: 9000 },
];

const PAYLOAD = JSON.stringify({
  session_id: SID,
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
});

describe('hooks exit when stdin is never closed', () => {
  for (const { hook, deadline } of HOOKS) {
    test(`${hook}: no data, pipe held open`, async () => {
      const cfg = freshCfg();
      const r = await runWithOpenStdin(hook, { deadlineMs: deadline, cfg });
      assert.equal(r.exited, true,
        `${hook} did not exit within ${deadline}ms with an open, empty stdin -- it is leaking`);
    });

    test(`${hook}: payload written, pipe held open`, async () => {
      const cfg = freshCfg();
      const r = await runWithOpenStdin(hook, { write: PAYLOAD, deadlineMs: deadline, cfg });
      assert.equal(r.exited, true,
        `${hook} did not exit within ${deadline}ms after a complete payload -- it is leaking`);
    });

    test(`${hook}: payload split across chunks, pipe held open`, async () => {
      const cfg = freshCfg();
      const half = Math.floor(PAYLOAD.length / 2);
      const r = await runWithOpenStdin(hook, {
        chunks: [PAYLOAD.slice(0, half), PAYLOAD.slice(half)],
        deadlineMs: deadline,
        cfg,
      });
      assert.equal(r.exited, true,
        `${hook} did not exit within ${deadline}ms after a chunked payload -- it is leaking`);
    });
  }
});

describe('the clean-EOF path still works', () => {
  // Guards against "fixing" the hang by breaking normal payload delivery.
  for (const { hook } of HOOKS) {
    test(`${hook}: exits promptly when stdin closes normally`, async () => {
      const cfg = freshCfg();
      const r = await new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [path.join(HOOKS_DIR, hook)], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: SID },
        });
        strays.add(child);
        child.stdout.on('data', () => {});
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => {});
        child.on('exit', (code) => {
          strays.delete(child);
          resolve({ ms: Date.now() - started, code });
        });
        child.stdin.end(PAYLOAD);
      });
      assert.ok(r.ms < 3000, `${hook} took ${r.ms}ms on a clean EOF; should be near-instant`);
      assert.equal(r.code, 0, `${hook} exited ${r.code} on a clean EOF`);
    });
  }
});
