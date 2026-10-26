// Runs on every model request (not just each prompt), so the contract
// survives compaction, steering, and subagent continuations for free.
import fs from 'node:fs';
import { statePath } from '../shared/state.mjs';
import { contractText } from '../shared/contract.mjs';
import { CMD } from './lib.mjs';

export async function registerContextHook(env, session) {
  const { ctx, stateDir } = env;

  await ctx.session.hook('context', async (event) => {
    const armed = await session.armedFor(event.sessionID);
    if (!armed || armed.state.phase === 'off') return;
    const { owner, state } = armed;

    // Liveness heartbeat: the retention sweep prunes by mtime, so touching the
    // file here means "age" is "not used since" rather than "phase-changed
    // since". Only after the phase check, so an `off` state is never
    // resurrected.
    try {
      const now = new Date();
      fs.utimesSync(statePath(stateDir, owner), now, now);
    } catch {}

    event.system.push({
      type: 'text',
      text: contractText({
        phase: state.phase,
        round: state.round || 1,
        sandbox: state.sandbox,
        cmd: CMD,
        host: 'opencode',
      }),
    });
  });
}
