// Session ancestry, permission-rule application and the one unlock.
import { writeState } from '../shared/state.mjs';
import { sessionRules } from '../shared/rules.mjs';

/** @param {import('./index.mjs').PluginEnv} env */
export function createSession(env) {
  const { ctx, stateDir, plansDir, locationDir, extraRoots, stateOf } = env;

  // A subagent inherits this session's permission rules but gets its own
  // sessionID. Looking only at the child would leave it without the contract
  // and without the shell path analysis, even though the block still applies
  // — Claude Code's hooks see the parent's id instead, so this is how the
  // two hosts end up behaving the same. State resolution therefore walks up
  // to the armed ancestor; the parent chain is cached because it cannot
  // change after creation.
  const parentCache = new Map();
  const parentOf = async (sessionID) => {
    if (parentCache.has(sessionID)) return parentCache.get(sessionID);
    let parent;
    try {
      parent = (await ctx.session.get({ sessionID }))?.parentID;
    } catch {
      parent = undefined;
    }
    parentCache.set(sessionID, parent);
    return parent;
  };

  /** Nearest session at-or-above `sessionID` that has probe state, else
   *  `sessionID` itself (so `armedFor` returns null for unarmed lineages). */
  const ownerOf = async (sessionID) => {
    let current = sessionID;
    for (let depth = 0; depth < 10; depth++) {
      if (stateOf(current)) return current;
      const parent = await parentOf(current);
      if (!parent) return sessionID;
      current = parent;
    }
    return sessionID;
  };

  /** `{ owner, state }` for an armed lineage (state lives on `owner`), or
   *  null when neither the session nor any ancestor is armed. */
  const armedFor = async (sessionID) => {
    const owner = await ownerOf(sessionID);
    const state = stateOf(owner);
    return state ? { owner, state } : null;
  };

  /** Install (or clear) this session's permission rules for a phase. */
  const applyRules = (sessionID, phase, state) =>
    ctx.session.update({
      sessionID,
      permissions: sessionRules({
        phase,
        sandbox: state?.sandbox,
        plansDir,
        stateDir,
        locationDir,
        extraRoots,
      }),
    });

  /** Rules are per-session, so an armed lineage gets every member updated:
   *  the owner holds the state, and the session that asked keeps matching it
   *  (existing children already carry a copy from creation time). */
  const applyRulesFor = async (sessionID, phase, state) => {
    const owner = await ownerOf(sessionID);
    await applyRules(owner, phase, state);
    if (owner !== sessionID) await applyRules(sessionID, phase, state);
  };

  /** The one and only unlock: approved plan -> free execution. A dialog or
   *  question answer only counts while a plan is actually awaiting approval;
   *  the user's own `approve` command is accepted from research too. */
  const unlock = async (sessionID, source) => {
    const owner = await ownerOf(sessionID);
    const state = stateOf(owner);
    if (!state || state.phase === 'off') return false;
    if (source !== 'command' && state.phase !== 'planning' && state.phase !== 'implementing') return false;
    if (state.phase !== 'implementing') {
      state.phase = 'implementing';
      state.approvedAt = new Date().toISOString();
      state.approvedBy = source;
      writeState(stateDir, owner, state);
    }
    await applyRulesFor(sessionID, 'implementing', state);
    return true;
  };

  return { ownerOf, armedFor, applyRules, applyRulesFor, unlock };
}
