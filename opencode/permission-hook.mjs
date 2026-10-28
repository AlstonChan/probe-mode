// Permission evaluation: edit decisions from the session rules, shell
// decisions from the shared path analysis.
import { logDenial } from '../shared/state.mjs';
import { sessionRules, matchEffect, shellDenied, shellDenyMessage, approvalAskMessage } from '../shared/rules.mjs';
import { analyzeSegments, loadPolicy, matchPolicy } from '../shared/shell.mjs';
import { CMD } from './lib.mjs';
import { trace } from '../shared/trace.mjs';

/** @param {import('./index.mjs').PluginEnv} env */
export async function registerPermissionHook(env, session) {
  const { ctx, stateDir, plansDir, locationDir, extraRoots, rootsFor } = env;

  // Edits are judged against the OWNER's current phase, not whatever rules
  // this session happens to carry: a child created while unlocked keeps its
  // empty rule set into the next round, and a user's own `edit: ask` config
  // would otherwise turn a research-phase write into an approval dialog.
  const evaluateEdit = (event, armed) => {
    const state = armed.state;
    const rules = sessionRules({
      phase: state.phase, sandbox: state.sandbox, plansDir, stateDir, locationDir, extraRoots,
    });
    const effects = (event.resources ?? []).map((r) => matchEffect(rules, 'edit', String(r)));
    if (effects.includes('deny')) {
      event.effect = 'deny';
      logDenial(stateDir, armed.owner, { tool: 'edit', what: (event.resources ?? []).join(', ').slice(0, 500), reason: 'edit outside the sandbox' });
      return;
    }
    // The approval moment. An `edit` that resolves to `ask` while planning
    // is a write outside the sandbox, so the dialog the user is looking at
    // IS the plan approval. Only the planning phase has one.
    if (effects.includes('ask')) {
      event.effect = 'ask';
      event.message = approvalAskMessage({ sandbox: state.sandbox, cmd: CMD });
      return;
    }
    if (effects.length > 0 && event.effect !== 'deny') event.effect = 'allow';
  };

  // Shell: the rules park every mutating command at `ask`; here we decide
  // it with the same path analysis Claude's guard uses.
  //   target outside the sandbox  -> deny, with a reason
  //   target inside the sandbox    -> allow (the sandbox is the model's)
  //   not a mutating command       -> leave the effect alone, so a user's
  //                                   own ask/allow still applies
  const evaluateShell = (event, armed) => {
    const state = armed.state;
    if (event.effect === 'deny') return;
    const policy = loadPolicy({ userFile: env.userPolicy, projectDir: locationDir });
    const rule = matchPolicy(event.resources.join(' && '), policy);
    if (rule && rule.effect === 'allow') { event.effect = 'allow'; return; }
    if (rule && rule.effect === 'deny') {
      event.effect = 'deny';
      event.message = shellDenyMessage({ phase: state.phase, command: event.resources.join(' && '), sandbox: state.sandbox, cmd: CMD });
      logDenial(stateDir, armed.owner, { tool: 'shell', what: event.resources.join(' && ').slice(0, 500), reason: `deny pattern "${rule.pattern}"` });
      return;
    }
    const verdict = analyzeSegments(event.resources, {
      cwd: locationDir,
      roots: rootsFor(state),
    });
    if (!verdict.sawMutation) {
      // The fallback patterns are coarse (`git tag *` also matches a listing).
      // When the analysis finds no write, an `ask` that only our own pattern
      // raised is a false alarm, not a decision for the user.
      if (event.effect === 'ask' && event.resources.some((r) => shellDenied(String(r)))) event.effect = 'allow';
      return;
    }
    if (verdict.offenders.length > 0 || verdict.unresolved.length > 0) {
      event.effect = 'deny';
      logDenial(stateDir, armed.owner, {
        tool: 'shell',
        what: event.resources.join(' && ').slice(0, 500),
        reason: [...verdict.offenders, ...verdict.unresolved][0] ?? 'mutates outside the sandbox',
      });
      event.message = shellDenyMessage({
        phase: state.phase,
        command: event.resources.join(' && '),
        sandbox: state.sandbox,
        cmd: CMD,
      });
      return;
    }
    event.effect = 'allow';
  };

  await ctx.permission.hook('evaluate', async (event) => {
    const armed = await session.armedFor(event.sessionID);
    if (!armed) {
      // The Probe agent with no armed state (arming failed or has not run
      // yet) must still block writes: fail closed.
      if (event.agent === 'probe' && (event.action === 'edit' || event.action === 'shell')) {
        event.effect = 'deny';
        event.message = `Probe mode is not armed for this session, so writes are blocked. Run ${CMD} to arm it.`;
        trace(stateDir, {
          host: 'opencode',
          hook: 'permission.evaluate',
          sessionId: event.sessionID ?? null,
          input: { sessionID: event.sessionID, agent: event.agent, action: event.action, resources: event.resources },
          decision: 'deny',
        });
      }
      return;
    }
    const phase = armed.state.phase;
    if (phase === 'off' || phase === 'implementing') return;
    if (event.action !== 'edit' && event.action !== 'shell') return;
    const input = { sessionID: event.sessionID, action: event.action, resources: event.resources, effect: event.effect };
    if (event.action === 'edit') evaluateEdit(event, armed);
    else evaluateShell(event, armed);
    trace(stateDir, {
      host: 'opencode',
      hook: 'permission.evaluate',
      sessionId: event.sessionID ?? null,
      input,
      decision: event.effect ?? null,
    });
  });
}
