#!/usr/bin/env node
// UserPromptSubmit: re-injects the probe-mode contract every turn so it survives
// compaction and cannot drift. The wording itself lives in shared/contract.mjs,
// where the OpenCode host reads the same text. It also records the user's own
// stop command, which the guard requires before the model may run it.
import fs from 'node:fs';
import path from 'node:path';
import { readStdin, inspectState, writeState, statePath, STATE_DIR, CMD } from './probe-lib.mjs';
import { contractText } from '../shared/contract.mjs';

/** `/probe stop` (standalone) or `/probe-mode:probe stop` (plugin). */
const STOP_PROMPT = /^\s*\/(?:probe-mode:)?probe\s+stop\b/i;

const input = await readStdin();
const inspected = inspectState(input.session_id);

// An unusable state file has nowhere to hold the stop token, so it goes in a
// sidecar the guard checks on that path (it is outside every writable root too).
if (inspected.status === 'unreadable') {
  if (STOP_PROMPT.test(String(input.prompt || ''))) {
    try { fs.writeFileSync(path.join(STATE_DIR, `${input.session_id}.stop-intent`), String(Date.now())); } catch {}
  }
  process.exit(0);
}
const state = inspected.status === 'ok' ? inspected.state : null;
if (!state || state.phase === 'off') process.exit(0);

// The skill runs `probe-ctl stop` through the model's own Bash tool, so the guard
// cannot tell the user's /probe stop from the model deciding to disarm itself.
// This hook sees what the USER typed (the raw slash command, verified), so it
// leaves a one-shot token the guard requires before letting that call through.
if (STOP_PROMPT.test(String(input.prompt || ''))) {
  state.stopIntent = Date.now();
  writeState(input.session_id, state);
}

// Liveness heartbeat. probe-cleanup.mjs prunes by mtime, and nothing else ever
// touches a state file after its last phase change — so without this, an
// 'implementing' mtime means "when the plan was approved", not "when this session
// was last used", and the prune would delete the state of a session still in
// active use. One utimes per prompt, deliberately after the phase check so an
// 'off' state is never resurrected.
//
// utimes rather than a lastSeen field in the JSON: rewriting the file on every
// prompt would race probe-promote.mjs's write.
try {
  const now = new Date();
  fs.utimesSync(statePath(input.session_id), now, now);
} catch {}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: contractText({
      phase: state.phase,
      round: state.round || 1,
      sandbox: state.sandbox,
      cmd: CMD,
      host: 'claude',
    }),
  },
}));
process.exit(0);
