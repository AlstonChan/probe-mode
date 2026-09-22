#!/usr/bin/env node
// PostToolUse on ExitPlanMode. This event only fires when the tool SUCCEEDED,
// which means the user approved the plan. That approval is the one and only
// thing that unlocks writes in probe mode.
import { readStdin, readState, writeState, CMD } from './probe-lib.mjs';

// A failed or timed-out read yields {}, so readState(undefined) is null and we exit
// below without promoting. That is the safe direction: a broken promote leaves writes
// BLOCKED, never accidentally unlocked.
const input = await readStdin();
const state = readState(input.session_id);
if (!state || state.phase === 'implementing') process.exit(0);

state.phase = 'implementing';
state.approvedAt = new Date().toISOString();
writeState(input.session_id, state);

process.stdout.write(
  'Plan approved — probe mode unlocked writes for this session. ' +
  `Snapshot taken at probe start: ${state.snapshot?.ref || 'none (not a git repo)'}. ` +
  `Run ${CMD} restore to roll the working tree back to that point.`
);
