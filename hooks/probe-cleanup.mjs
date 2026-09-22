#!/usr/bin/env node
// SessionEnd cleanup.
//
// Still deletes nothing belonging to the session that just ended, and still never
// deletes a LOCKED state early. Two reasons, both found by testing:
//
//   1. Resuming a session preserves its session_id. Deleting a 'probe' or
//      'planning' state would mean a resumed session comes back silently
//      UNLOCKED — the guard finds no state file and passes everything.
//   2. The state file holds the snapshot ref that backs /probe restore.
//
// What changed: reason 1 does not apply to an 'implementing' or 'off' state. That
// phase is ALREADY unlocked, so deleting it is not a safety regression — the only
// thing lost is restore history. So the prune is phase-aware, and counterintuitively
// the already-unlocked states are the ones safe to prune EARLY. A uniform 30-day
// mtime prune left 23 stale state files on a reporter's machine (19 'implementing',
// 4 'probe') with the oldest only 5 days old.
//
// Ages come from mtime, which probe-context.mjs now heartbeats on every prompt, so
// "age" means "not used since", not "not phase-changed since". Without that
// heartbeat nothing would touch a state file after its last phase transition, and
// an 'implementing' mtime would mean "when the plan was approved" — which would
// prune the state of a session that is still open and in active use.
//
// A sandbox now dies with its state file rather than on its own mtime. The two
// drift badly: a directory's mtime only moves when a direct CHILD is added, so a
// long-lived session could have its sandbox deleted out from under it.
//
// Only *.json entries and directories are ever considered. The stable
// probe-statusline.mjs copy that `setup` writes into this same directory is a plain
// file with another extension, and must survive any prune — deleting it silently
// breaks the status indicator for every plugin install.
import fs from 'node:fs';
import path from 'node:path';
import { readStdin, STATE_DIR } from './probe-lib.mjs';

const DAY = 24 * 60 * 60 * 1000;
const LOCKED_PRUNE_DAYS = 30;   // probe / planning — the safety arm, unchanged
const UNLOCKED_PRUNE_DAYS = 7;  // implementing / off — restore history only

await readStdin(); // bounded drain; a pipe that never closes can no longer pin this process

/** null means unreadable, which is never pruned at all. */
const readPhase = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && parsed.phase) || 'unknown';
  } catch {
    return null;
  }
};

const isUnlocked = (phase) => phase === 'implementing' || phase === 'off';
const ageMs = (p) => { try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return -1; } };

try {
  const entries = fs.readdirSync(STATE_DIR, { withFileTypes: true });
  const hasState = new Set(
    entries.filter((e) => !e.isDirectory() && e.name.endsWith('.json')).map((e) => e.name),
  );
  const pruned = new Set();

  // --- pass 1: state files, phase-aware; the sandbox goes with its own state ----
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith('.json')) continue;
    const file = path.join(STATE_DIR, entry.name);
    const phase = readPhase(file);
    // Unreadable state is never pruned. probe-guard.mjs denies rather than passes on
    // an unreadable state file, so the file is still actively protecting something;
    // deleting it would silently turn that deny into a pass.
    if (phase === null) continue;

    const age = ageMs(file);
    if (age < 0) continue;
    if (age < (isUnlocked(phase) ? UNLOCKED_PRUNE_DAYS : LOCKED_PRUNE_DAYS) * DAY) continue;

    const sid = entry.name.slice(0, -'.json'.length);
    try { fs.unlinkSync(file); } catch { continue; }
    try { fs.rmSync(path.join(STATE_DIR, sid), { recursive: true, force: true }); } catch {}
    pruned.add(sid);
  }

  // --- pass 2: orphan sandboxes whose state file is already gone ---------------
  for (const entry of entries) {
    if (!entry.isDirectory() || pruned.has(entry.name)) continue;
    if (hasState.has(`${entry.name}.json`)) continue; // still paired: pass 1 owns it
    const dir = path.join(STATE_DIR, entry.name);
    // Only sweep things that actually look like one of ours.
    if (!fs.existsSync(path.join(dir, 'sandbox'))) continue;
    const age = ageMs(dir);
    if (age < 0 || age < UNLOCKED_PRUNE_DAYS * DAY) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
} catch {}
