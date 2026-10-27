#!/usr/bin/env node
// PostToolUse on ExitPlanMode. This event only fires when the tool SUCCEEDED,
// which means the user approved the plan. That approval is the one and only
// thing that unlocks writes in probe mode.
import path from 'node:path';
import { readStdin, readState, writeState, normalizeRounds, CMD, CONFIG_DIR } from './probe-lib.mjs';
import { planCheck, PLAN_STEPS } from './probe-plan.mjs';
import { trace } from '../shared/trace.mjs';

// A failed or timed-out read yields {}, so readState(undefined) is null and we exit
// below without promoting. That is the safe direction: a broken promote leaves writes
// BLOCKED, never accidentally unlocked.
const input = await readStdin();
const state = readState(input.session_id);
const logPromote = (decision) => trace(path.join(CONFIG_DIR, 'probe-state'), {
  host: 'claude-code', hook: 'promote', sessionId: input.session_id ?? null, input, decision,
});

// Only a plan written after `implement` unlocks. An ExitPlanMode in the research
// phase skipped the user's explicit request, and one after `stop` belongs to a
// session that is no longer in probe mode at all — neither may flip the lock.
if (state && state.phase === 'probe') {
  process.stdout.write(
    `Plan approved, but probe mode is still in research, so writes stay BLOCKED. ` +
    `Unlocking needs the user to run ${CMD} implement and approve a plan after that.`
  );
}
if (!state || state.phase !== 'planning') { logPromote('ignored'); process.exit(0); }

// The guard already refuses an ExitPlanMode with no plan behind it; this repeats
// the check so an approval that slipped past it (guard not wired, payload lost)
// still cannot unlock writes on an empty plan.
const found = planCheck({ input, state, plansDir: path.join(CONFIG_DIR, 'plans'), cmd: CMD });
if (!found.ok) {
  process.stdout.write(
    `Plan approved, but there is no plan behind it (${found.reason}), so writes stay BLOCKED ` +
    `and probe mode is still planning. ${PLAN_STEPS}`
  );
  logPromote('no-plan');
  process.exit(0);
}

state.phase = 'implementing';
state.approvedAt = new Date().toISOString();
writeState(input.session_id, state);
logPromote('unlocked');

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
