#!/usr/bin/env node
// UserPromptSubmit: re-injects the probe-mode contract every turn so it survives
// compaction and cannot drift. The wording itself lives in shared/contract.mjs,
// where the OpenCode host reads the same text.
import fs from 'node:fs';
import { readStdin, readState, statePath, CMD } from './probe-lib.mjs';
import { contractText } from '../shared/contract.mjs';

const input = await readStdin();
const state = readState(input.session_id);
if (!state || state.phase === 'off') process.exit(0);

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
