// Host-agnostic probe-mode state: phases, rounds, restore points, and the
// phase-aware retention sweep.
//
// Both hosts read and write the same state-file shape (ProbeState below).
// The file lives at <stateDir>/<sessionID>.json and the session's sandbox at
// <stateDir>/<sessionID>/sandbox/. Sessions are per-host, so a directory is
// never shared between Claude Code and OpenCode.
//
// Nothing in here talks to the filesystem beyond state files: the guard reads
// state directly (it must stay self-contained), git lives in shared/git.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** @typedef {'probe' | 'planning' | 'implementing' | 'off'} Phase */

/**
 * A git restore point. `head` is null in a repository with no commits.
 * @typedef {object} Snapshot
 * @property {string} ref - Commit the snapshot is stored as (worktree incl. untracked files).
 * @property {string | null} head - HEAD when it was taken.
 * @property {string} branch - Branch name, or `'HEAD'` when detached.
 * @property {string} at - ISO time it was taken.
 */

/** @typedef {Snapshot & { n: number }} Round - One research round's restore point. */

/**
 * The state file, shared by both hosts.
 * @typedef {object} ProbeState
 * @property {Phase} phase
 * @property {number} round - Current round; a round whose snapshot failed still counts.
 * @property {Round[]} [rounds] - Restore points; absent in files written before rounds (see normalizeRounds).
 * @property {Snapshot | null} [snapshot] - Round 1's snapshot, kept for old state files.
 * @property {string} [snapshotError] - Why the latest round has no restore point.
 * @property {string} sandbox - The only writable directory while locked.
 * @property {string} cwd - Project directory the session was armed in.
 * @property {string} startedAt - ISO time of arming.
 * @property {string} [planningAt] - ISO time `implement` began (Claude: plan must be newer).
 * @property {string} [approvedAt] - ISO time writes were unlocked.
 * @property {'command' | 'question' | 'permission'} [approvedBy] - OpenCode: which path unlocked.
 * @property {Snapshot} [undo] - Pre-restore point, so a restore can be reversed.
 * @property {number} [stopIntent] - Claude: epoch ms the user asked to stop; the guard honors it briefly.
 * @property {string} [sessionID] - OpenCode: the session that owns this state.
 * @property {'claude' | 'opencode'} [host] - Which host armed the session.
 */

export const PHASES = ['probe', 'planning', 'implementing', 'off'];

/** Unlocked phases: deleting one of these early costs restore history only.
 *  A locked state (`probe`/`planning`) must outlive its session, because a
 *  resumed session that finds no state file comes back silently unlocked. */
export const isUnlockedPhase = (phase) => phase === 'implementing' || phase === 'off';

export function statePath(stateDir, sessionId) {
  return path.join(stateDir, `${sessionId}.json`);
}

/**
 * The session's state, or null when it is absent or unusable.
 * @param {string} stateDir
 * @param {string} sessionId
 * @returns {ProbeState | null}
 */
export function readState(stateDir, sessionId) {
  const s = inspectState(stateDir, sessionId);
  return s.status === 'ok' ? s.state : null;
}

/**
 * Like readState, but tells "no state" apart from "a state file we cannot use".
 * The guard denies on the second, so a caller that treated it as "off" would
 * report one thing while the guard enforced another.
 * @param {string} stateDir
 * @param {string} sessionId
 * @returns {{status: 'absent'} | {status: 'unreadable', error: string} | {status: 'ok', state: ProbeState}}
 */
export function inspectState(stateDir, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(statePath(stateDir, sessionId), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'absent' };
    return { status: 'unreadable', error: err && err.message };
  }
  try {
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { status: 'unreadable', error: 'not a state object' };
    }
    return { status: 'ok', state };
  } catch (err) {
    return { status: 'unreadable', error: err && err.message };
  }
}

/**
 * Atomic: written to a temp file and renamed over the old one, so a reader
 * (the guard runs on every tool call) never sees a half-written state.
 * @param {string} stateDir
 * @param {string} sessionId
 * @param {ProbeState} state
 * @throws when the rename still fails after retries; the temp file is removed.
 */
export function writeState(stateDir, sessionId, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  const target = statePath(stateDir, sessionId);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  try {
    renameWithRetry(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** Windows refuses a rename over a file another process has open for a moment
 *  (EPERM/EBUSY/EACCES); a few short retries ride that out. */
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err && err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt * 5);
    }
  }
}

/**
 * Liveness heartbeat: move the state file's mtime so "age" means "not used
 * since", not "phase-changed since". utimes rather than a lastSeen field:
 * rewriting the file on every prompt would race the write that records an
 * approval. Deliberately a no-op for a missing or `off` state — a heartbeat
 * must never resurrect a disarmed session.
 */
export function heartbeat(stateDir, sessionId) {
  try {
    const state = readState(stateDir, sessionId);
    if (!state || state.phase === 'off') return false;
    const now = new Date();
    fs.utimesSync(statePath(stateDir, sessionId), now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rounds list for a state, synthesizing one for state files written before
 * rounds existed. Those have a bare `snapshot` and no `rounds`, and must keep
 * working without a migration step.
 * @param {ProbeState | null} state
 * @returns {Round[]}
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

// ---------------------------------------------------------------- retention
//
// Phase-aware on purpose, and counterintuitively the ALREADY-unlocked states
// are the ones safe to prune early:
//
//   probe / planning     kept 30 days — deleting one would make a resumed
//                        session come back silently UNLOCKED (the guard finds
//                        no state file and passes everything)
//   implementing / off   pruned after 7 idle days — already unlocked, so only
//                        restore history is lost
//
// Ages come from mtime, which every host heartbeats on prompt/request, so
// "age" means "not used since", not "phase-changed since". An unreadable state
// is never pruned at all: a guard that denies on an unreadable file is still
// protecting something, and deleting it turns that deny into a pass. A session
// directory goes with its own state file rather than on its own mtime, and
// orphaned sandboxes (no state file left) go after the unlocked window.
export const DAY = 24 * 60 * 60 * 1000;
export const LOCKED_PRUNE_DAYS = 30;
export const UNLOCKED_PRUNE_DAYS = 7;

/** null means unreadable, which is never pruned at all. */
function readPhase(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && parsed.phase) || 'unknown';
  } catch {
    return null;
  }
}

const ageMs = (p) => { try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return -1; } };

function readField(file, key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed[key] === 'string' ? parsed[key] : null;
  } catch {
    return null;
  }
}

/** Delete refs/probe/<sid>, <sid>-rN and <sid>-undo in `repo`. Best-effort:
 *  a moved or deleted repo just leaves nothing to clean. Never touches another
 *  session's refs, even one whose id starts with this one. */
export function deleteSessionRefs(repo, sid) {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
  try {
    if (!fs.existsSync(repo)) return [];
    const mine = new RegExp(`^refs/probe/${sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-r\\d+|-undo)?$`);
    const refs = git(['for-each-ref', '--format=%(refname)', 'refs/probe/']).split('\n').filter((r) => mine.test(r));
    for (const r of refs) { try { git(['update-ref', '-d', r]); } catch {} }
    return refs;
  } catch {
    return [];
  }
}

/**
 * Prune stale state files and their sandboxes from `stateDir`.
 * Returns the session IDs it removed (for tests and logging).
 * Any I/O failure stops the sweep without throwing: cleanup must never break
 * the hook that called it.
 */
export function pruneStateDir(stateDir) {
  const pruned = new Set();
  try {
    const entries = fs.readdirSync(stateDir, { withFileTypes: true });
    const hasState = new Set(
      entries.filter((e) => !e.isDirectory() && e.name.endsWith('.json')).map((e) => e.name),
    );

    // pass 1: state files, phase-aware; the sandbox goes with its own state
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.name.endsWith('.json')) continue;
      const file = path.join(stateDir, entry.name);
      const phase = readPhase(file);
      if (phase === null) continue; // unreadable: still guarding something
      const age = ageMs(file);
      if (age < 0) continue;
      if (age < (isUnlockedPhase(phase) ? UNLOCKED_PRUNE_DAYS : LOCKED_PRUNE_DAYS) * DAY) continue;

      const sid = entry.name.slice(0, -'.json'.length);
      const repo = readField(file, 'cwd');
      try { fs.unlinkSync(file); } catch { continue; }
      try { fs.rmSync(path.join(stateDir, sid), { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(path.join(stateDir, `${sid}.stop-intent`)); } catch {}
      try { fs.unlinkSync(path.join(stateDir, `${sid}.denials.jsonl`)); } catch {}
      // The snapshot refs go with the state that pointed at them. Left behind,
      // they keep every untracked file a snapshot captured alive in the repo
      // forever (gc cannot collect them, and `push --mirror` would publish them).
      if (repo) deleteSessionRefs(repo, sid);
      pruned.add(sid);
    }

    // pass 2: orphan sandboxes whose state file is already gone
    for (const entry of entries) {
      if (!entry.isDirectory() || pruned.has(entry.name)) continue;
      if (hasState.has(`${entry.name}.json`)) continue; // still paired: pass 1 owns it
      const dir = path.join(stateDir, entry.name);
      if (!fs.existsSync(path.join(dir, 'sandbox'))) continue; // only sweep ours
      const age = ageMs(dir);
      if (age < 0 || age < UNLOCKED_PRUNE_DAYS * DAY) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  } catch {}
  return pruned;
}

// ------------------------------------------------------------------ denials

export const denialLogPath = (stateDir, sessionId) => path.join(stateDir, `${sessionId}.denials.jsonl`);

/** Append one denial. Best-effort and size-capped, like the guard's own copy. */
export function logDenial(stateDir, sessionId, entry) {
  try {
    const file = denialLogPath(stateDir, sessionId);
    try { if (fs.statSync(file).size > 256 * 1024) return; } catch {}
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {}
}

/** Every logged denial for a session, oldest first; unparseable lines skipped. */
export function readDenials(stateDir, sessionId) {
  try {
    return fs.readFileSync(denialLogPath(stateDir, sessionId), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

/** The status summary: a count and the most recent few. */
export function denialSummary(stateDir, sessionId, last = 3) {
  const all = readDenials(stateDir, sessionId);
  if (!all.length) return 'Denials: none this session';
  const lines = [`Denials: ${all.length} this session${all.length > last ? ` (last ${last})` : ''}:`];
  for (const d of all.slice(-last)) lines.push(`  ${d.at}  ${d.tool}  ${String(d.what).slice(0, 80)}`);
  return lines.join('\n');
}
