// Shared helpers for the probe-mode hooks.
//
// NOTE: probe-guard.mjs deliberately does NOT import from this file. It is the
// enforcement point, and an import that failed to parse would let writes through,
// so it inlines everything it needs and fails closed. Do not "DRY it up" by
// pointing it here — the duplication is the safety property. Any path rule
// changed here must be changed in probe-guard.mjs too — and so must the stdin
// reader, which probe-statusline.mjs also inlines for a different reason
// (`probe-ctl setup` relocates that ONE file to ~/.claude/probe-state/, where this
// module does not exist, so an import there breaks every install that ran setup).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const STATE_DIR = path.join(CONFIG_DIR, 'probe-state');

// A plugin-cache install always has a .claude-plugin/ manifest dir next to hooks/; a
// standalone install.sh install never does. CLAUDE_PLUGIN_ROOT is ORed in too, but it is
// only reliably set for true hooks.json-dispatched processes, not for probe-ctl.mjs
// (invoked via a Bash tool call built from SKILL.md prose) — so the directory check is
// the signal that actually matters here, not a redundant belt-and-suspenders extra.
const isPlugin = fs.existsSync(path.join(path.dirname(import.meta.dirname), '.claude-plugin'))
  || Boolean(process.env.CLAUDE_PLUGIN_ROOT);
export const CMD = isPlugin ? '/probe-mode:probe' : '/probe';

export function statePath(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`);
}

export function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(sessionId, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(sessionId), JSON.stringify(state, null, 2));
}

/**
 * Soft budget for reading the hook payload, in ms. The soft timer destroys the
 * stream; the hard timer is a backstop that exits the process outright.
 *
 * Measured payload arrival on a working pipe is 5-8ms, so 5s is ~1000x headroom
 * for a cold Node start on a loaded machine, while staying well under every
 * hooks.json timeout (guard/promote 20s, context/cleanup 15s). Ours must win that
 * race so the hook emits its own deliberate decision instead of being killed
 * mid-flight by Claude Code.
 *
 * probe-statusline.mjs and probe-guard.mjs inline their own copies of the reader
 * (they must not import from this file — see the header) and probe-statusline
 * deliberately uses a much shorter budget. Keep all three in sync.
 */
export const STDIN_SOFT_MS = 5000;
export const STDIN_HARD_MS = 7000;

/**
 * Reads the hook payload from stdin without ever blocking forever.
 *
 * Replaces fs.readFileSync(0), which blocks the EVENT LOOP — so no setTimeout
 * watchdog could ever interrupt it, and a stdin pipe Claude Code wrote to but
 * never closed left the process alive until reboot. Measured on Windows: 10
 * orphaned node.exe, 0.00 CPU, 1 thread, 17-24h old, parents dead, ~168MB. The
 * old try/catch only ever guarded JSON.parse, never the block.
 *
 * The async iterator leaves the event loop free, so the soft timer CAN fire and
 * destroy() the stream — which rejects the iterator and hands back whatever bytes
 * already arrived (verified on Windows: ~20ms after destroy, buffered bytes intact).
 *
 * Parsing after every chunk and stopping at the first complete object matters:
 * Claude Code writes the payload and then holds the pipe open, so waiting for EOF
 * would cost the full soft timeout on EVERY call. Measured 5ms this way versus
 * 1529ms waiting for the watchdog. A JSON prefix cannot parse, so breaking early
 * is safe.
 *
 * Never throws, never hangs, always returns.
 */
export async function readStdin({ softMs = STDIN_SOFT_MS, hardMs = STDIN_HARD_MS } = {}) {
  const chunks = [];
  let parsed = null;
  let soft = null;
  let hard = null;
  try {
    // A hand-run hook in a terminal has no payload and would otherwise sit on the
    // soft timer waiting for someone to type. Decide immediately instead.
    if (process.stdin.isTTY) return {};

    soft = setTimeout(() => process.stdin.destroy(), softMs);
    hard = setTimeout(() => process.exit(0), hardMs);
    hard.unref();

    try {
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
        // Buffer.concat, never `str += chunk`: a chunk boundary can land mid-UTF-8
        // sequence and += corrupts it. Payloads carry prompts and file contents.
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); break; } catch {}
      }
    } catch {
      // Either our own destroy() rejecting the iterator, or a pipe error. Both mean
      // the bytes collected so far are all we are ever going to get.
    }
  } catch {
    // fd 0 closed entirely: touching process.stdin can throw EBADF.
  } finally {
    clearTimeout(soft);
    clearTimeout(hard);
    try { process.stdin.destroy(); } catch {}
  }

  return parsed && typeof parsed === 'object' ? parsed : {};
}

/**
 * Rounds list for a state, synthesizing one for state files written before
 * rounds existed. Those have a bare `snapshot` and no `rounds`, and must keep
 * working without a migration step.
 */
export function normalizeRounds(state) {
  if (!state) return [];
  if (Array.isArray(state.rounds) && state.rounds.length) return state.rounds;
  if (!state.snapshot) return [];
  return [{
    n: 1,
    at: state.snapshot.at || state.startedAt,
    ref: state.snapshot.ref,
    head: state.snapshot.head,
    branch: state.snapshot.branch,
  }];
}

/** The git ref a round's snapshot is pinned to. Round 1 keeps the original
 *  flat name so sessions created before rounds existed still resolve. */
export function roundRef(sessionId, n) {
  return n === 1 ? `refs/probe/${sessionId}` : `refs/probe/${sessionId}-r${n}`;
}

export function undoRef(sessionId) {
  return `refs/probe/${sessionId}-undo`;
}

/**
 * Status-line refresh, in seconds.
 *
 * Not a cosmetic knob. Claude Code runs the statusLine command through bash, so on
 * Windows every tick costs a four-process chain (bash.exe -> bash.exe -> conhost.exe
 * -> node.exe). At the old default of 2 that measured ~524 process creations per
 * minute across five open sessions, about 31,400 an hour. 10 keeps the row
 * self-healing after a plan approval (see README) at a fifth of the churn, and bounds
 * the worst-case stale phase to ten seconds.
 *
 * The ceiling is arbitrary, but it stops a typo like --refresh=100000 from silently
 * meaning "never refresh".
 */
export const DEFAULT_REFRESH_INTERVAL = 10;
export const MIN_REFRESH_INTERVAL = 1;
export const MAX_REFRESH_INTERVAL = 3600;

/**
 * Parses `--refresh=N` or `--refresh N` out of an argv slice.
 * Returns {} when absent, { value } when valid, { error } when not.
 */
export function parseRefreshFlag(argv) {
  const i = argv.findIndex((a) => a === '--refresh' || a.startsWith('--refresh='));
  if (i === -1) return {};
  const raw = argv[i].startsWith('--refresh=')
    ? argv[i].slice('--refresh='.length)
    : argv[i + 1];
  if (raw === undefined || raw === '') {
    return { error: '--refresh needs a value in seconds, e.g. --refresh=30' };
  }
  // Deliberately rejects -5, 1.5, 1e3, 0x10 and empty.
  if (!/^\d+$/.test(String(raw).trim())) {
    return { error: `--refresh must be a whole number of seconds, got "${raw}"` };
  }
  const n = Number(raw);
  if (n < MIN_REFRESH_INTERVAL || n > MAX_REFRESH_INTERVAL) {
    return { error: `--refresh must be between ${MIN_REFRESH_INTERVAL} and ${MAX_REFRESH_INTERVAL} seconds, got ${n}` };
  }
  return { value: n };
}
