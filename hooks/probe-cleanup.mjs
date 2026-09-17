#!/usr/bin/env node
// SessionEnd cleanup.
//
// Deletes nothing at session end. Two reasons, both found by testing:
//
//   1. Resuming a session preserves its session_id. Deleting a 'probe' or
//      'planning' state would mean a resumed session comes back silently
//      UNLOCKED — the guard finds no state file and passes everything.
//   2. The state file holds the snapshot ref that backs /probe restore.
//      Deleting an 'implementing' state would destroy a working restore point
//      for a session the user can still resume.
//
// So the only cleanup is an age-based prune of things nobody is coming back to.
// Use /probe stop to disarm, and delete a sandbox yourself when you are done
// with it — they can get large (build output, dependencies).
import fs from 'node:fs';
import path from 'node:path';
import { readStdin, STATE_DIR } from './probe-lib.mjs';

const PRUNE_AFTER_DAYS = 30;

readStdin(); // drain stdin so the hook does not block

// Age-based prune of anything orphaned by a crash or a machine that never
// fired SessionEnd. Only touches entries older than the cutoff.
try {
  const cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(STATE_DIR, { withFileTypes: true })) {
    const full = path.join(STATE_DIR, entry.name);
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) continue;
      if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else if (entry.name.endsWith('.json')) fs.unlinkSync(full);
    } catch {}
  }
} catch {}
