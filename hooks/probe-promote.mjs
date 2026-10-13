#!/usr/bin/env node
// PostToolUse on ExitPlanMode. This event only fires when the tool SUCCEEDED,
// which means the user approved the plan. That approval is the one and only
// thing that unlocks writes in probe mode.
import { readStdin, readState, writeState, normalizeRounds, CMD } from './probe-lib.mjs';

// A failed or timed-out read yields {}, so readState(undefined) is null and we exit
// below without promoting. That is the safe direction: a broken promote leaves writes
// BLOCKED, never accidentally unlocked.
const input = await readStdin();
const state = readState(input.session_id);

// Only a plan written after `implement` unlocks. An ExitPlanMode in the research
// phase skipped the user's explicit request, and one after `stop` belongs to a
// session that is no longer in probe mode at all — neither may flip the lock.
if (state && state.phase === 'probe') {
  process.stdout.write(
    `Plan approved, but probe mode is still in research, so writes stay BLOCKED. ` +
    `Unlocking needs the user to run ${CMD} implement and approve a plan after that.`
  );
}
if (!state || state.phase !== 'planning') process.exit(0);

state.phase = 'implementing';
state.approvedAt = new Date().toISOString();
writeState(input.session_id, state);

const rounds = normalizeRounds(state);
const cur = rounds[rounds.length - 1];
const restorePoint = cur
  ? `${String(cur.ref).slice(0, 12)} (start of round ${cur.n})`
  : `none (${state.snapshotError ? `snapshot failed: ${state.snapshotError}` : 'not a git repo'})`;

process.stdout.write(
  'Plan approved — probe mode unlocked writes for this session. ' +
  `Restore point: ${restorePoint}. ` +
  `Run ${CMD} restore to roll the working tree back to that point.`
);
