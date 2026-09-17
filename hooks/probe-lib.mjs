// Shared helpers for the probe-mode hooks.
//
// NOTE: probe-guard.mjs deliberately does NOT import from this file. It is the
// enforcement point, and an import that failed to parse would let writes through,
// so it inlines everything it needs and fails closed. Do not "DRY it up" by
// pointing it here — the duplication is the safety property. Any path rule
// changed here must be changed in probe-guard.mjs too.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const STATE_DIR = path.join(CONFIG_DIR, 'probe-state');

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

export function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
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
