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
//
// The policy itself (retention windows, unreadable-never-pruned, orphan sweep)
// lives in shared/state.mjs so the OpenCode host applies the exact same matrix.
import { readStdin, prune } from './probe-lib.mjs';

await readStdin(); // bounded drain; a pipe that never closes can no longer pin this process

prune();
