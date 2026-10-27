// Arming: state creation, per-round snapshot, rules and agent switch.
import fs from 'node:fs';
import path from 'node:path';
import { writeState, normalizeRounds, roundRef, statePath } from '../shared/state.mjs';
import { trySnapshot } from '../shared/git.mjs';
import { CMD, armPrompt, sandboxFor } from './lib.mjs';

/** What to tell the model when a round has no restore point. */
const noSnapshot = (error) => error
  ? `NONE — snapshot failed (${error}), so ${CMD} restore cannot roll this round back`
  : `NONE — not a git repository, so ${CMD} restore cannot roll anything back`;

export const plansFileFor = (env, sessionID) => path.join(env.plansDir, `probe-${sessionID}.md`);

export function createLifecycle(env, session) {
  const { ctx, stateDir, locationDir, stateOf } = env;

  const arm = async (sessionID, question) => {
    const sandbox = sandboxFor(stateDir, sessionID);
    fs.mkdirSync(sandbox, { recursive: true });
    const existing = stateOf(sessionID);
    let state;
    let snapshotLine;

    if (!existing) {
      // Arm even if the snapshot failed: writes must be blocked either way.
      const { snap, error } = trySnapshot({ cwd: locationDir, sessionId: sessionID, ref: roundRef(sessionID, 1) });
      state = {
        phase: 'probe',
        round: 1,
        rounds: snap ? [{ n: 1, at: snap.at, ref: snap.ref, head: snap.head, branch: snap.branch }] : [],
        snapshot: snap,
        ...(error ? { snapshotError: error } : {}),
        sandbox,
        cwd: locationDir,
        startedAt: new Date().toISOString(),
        sessionID,
        host: 'opencode',
      };
      writeState(stateDir, sessionID, state);
      snapshotLine = snap ? `${snap.ref.slice(0, 12)} (restorable via ${CMD} restore)` : noSnapshot(error);
    } else {
      const rounds = normalizeRounds(existing);
      const n = Math.max(rounds[rounds.length - 1]?.n || 0, existing.round || 0) + 1; // a round without a snapshot still counts
      const { snap, error } = trySnapshot({ cwd: locationDir, sessionId: sessionID, ref: roundRef(sessionID, n) });
      existing.phase = 'probe';
      existing.round = n;
      existing.rounds = snap
        ? [...rounds, { n, at: snap.at, ref: snap.ref, head: snap.head, branch: snap.branch }]
        : rounds;
      existing.sandbox = sandbox;
      if (error) existing.snapshotError = error; else delete existing.snapshotError;
      existing.sessionID = sessionID;
      existing.host = 'opencode';
      writeState(stateDir, sessionID, existing);
      state = existing;
      snapshotLine = snap ? `${snap.ref.slice(0, 12)} pinned at ${roundRef(sessionID, n)}` : noSnapshot(error);
    }

    await session.applyRules(sessionID, 'probe', state);
    // Selecting the mode is what makes it visible: the agent shows in the
    // agent switcher and carries the description the model reads.
    await ctx.session.switchAgent({ sessionID, agent: 'probe' });
    return armPrompt({ state, question, snapshotLine });
  };

  // Selecting the Probe agent (Shift+Tab) arms nothing by itself, so the
  // first model request on that agent arms it here. One in-flight promise per
  // session keeps concurrent requests from arming twice.
  const inflight = new Map();
  const ensureArmed = (sessionID) => {
    if (inflight.has(sessionID)) return inflight.get(sessionID);
    const run = (async () => {
      try {
        if (!(await session.armedFor(sessionID))) await arm(sessionID, '');
        return true;
      } catch {
        // Half-armed (state written, rules not applied) must not look armed:
        // drop the state so the permission hook fails closed and the next request retries.
        try { fs.rmSync(statePath(stateDir, sessionID), { force: true }); } catch {}
        return false;
      } finally {
        inflight.delete(sessionID);
      }
    })();
    inflight.set(sessionID, run);
    return run;
  };

  return { arm, ensureArmed };
}
