// The `/probe` command and its subcommands.
import path from 'node:path';
import { writeState, denialSummary } from '../shared/state.mjs';
import { diffSince, listRounds, pruneRounds, restore, refExists } from '../shared/git.mjs';
import { checkReport, loadPolicy } from '../shared/shell.mjs';
import { implementRefusal } from '../shared/contract.mjs';
import { exportRound } from '../shared/export.mjs';
import {
  CMD, parseInvocation, statusText, implementPrompt, approvePrompt, notice,
  restoreNotice, stopNotice, RESTORE_WORDING, PRUNE_WORDING,
} from './lib.mjs';
import { plansFileFor } from './lifecycle.mjs';
import { trace } from '../shared/trace.mjs';

/** @param {import('./index.mjs').PluginEnv} env */
export async function registerCommands(env, session, lifecycle) {
  const { ctx, stateDir, locationDir, rootsFor } = env;

  const runCommand = async (invocation) => {
    const { sessionID, prompt, delivery } = invocation;
    const { sub, args, question, rest } = parseInvocation(prompt?.text);
    const armed = await session.armedFor(sessionID);
    const owner = armed?.owner ?? sessionID;
    const state = armed?.state ?? null;
    // `say` starts a model turn; `note` only shows a notice (see lib.mjs notice).
    const say = (text) =>
      ctx.session.prompt({ sessionID, text, delivery, ...(prompt?.files ? { files: prompt.files } : {}) });
    const show = (n) => ctx.session.synthetic({ sessionID, ...n, resume: false });
    const note = (body, extra) => show(notice(sub, body, extra));

    if (sub === 'start') {
      const text = await lifecycle.arm(sessionID, question);
      return question ? say(text) : note(text);
    }

    if (sub === 'export') {
      if (!state) return note('Probe mode is not active for this session; nothing to export.');
      const file = exportRound({ cwd: locationDir, sessionId: owner, stateDir, state, outDir: path.join(stateDir, 'exports') }); // never swept: no sandbox/ inside
      return note(`Exported to ${file}`);
    }

    if (sub === 'rounds') {
      if (!state) return note('Probe mode is not active for this session.');
      const text = args[0] === 'prune'
        ? pruneRounds({ cwd: locationDir, sessionId: owner, stateDir, state, force: args.includes('--force'), wording: PRUNE_WORDING })
        : listRounds({ cwd: locationDir, sessionId: owner, state });
      return note(text, 'Never add --force yourself; only the user does.');
    }

    if (sub === 'diff') {
      if (!state) return note('Probe mode is not active for this session; no snapshot to compare against.');
      return note(diffSince({ cwd: locationDir, sessionId: owner, state, argv: args }));
    }

    if (sub === 'check') {
      const text = checkReport(rest || '', {
        cwd: locationDir,
        roots: state ? rootsFor(state) : [],
        phase: state ? state.phase : 'probe',
        policy: loadPolicy({ userFile: env.userPolicy, projectDir: locationDir }),
      });
      const unarmed = state ? '' : 'Probe mode is not active, so nothing is blocked. As if it were:\n';
      return note(`${unarmed}${text}`);
    }

    if (sub === 'status') {
      const status = statusText(state, { sessionId: owner, refExists: (ref) => refExists(locationDir, ref) });
      return note(state ? `${status}\n${denialSummary(stateDir, owner)}` : status);
    }

    if (sub === 'implement') {
      if (!state) return note('Probe mode is not active.');
      const refusal = implementRefusal(state.phase, CMD);
      if (refusal) return note(refusal, 'Do not start planning.');
      state.phase = 'planning';
      writeState(stateDir, owner, state);
      await session.applyRulesFor(sessionID, 'planning', state);
      return say(implementPrompt({ plansFile: plansFileFor(env, owner) }));
    }

    if (sub === 'approve') {
      const unlocked = await session.unlock(sessionID, 'command');
      return unlocked ? say(approvePrompt()) : note('Probe mode is not active; nothing to approve.');
    }

    if (sub === 'restore') {
      if (!state) return note('Probe mode is not active for this session; no snapshot to restore.');
      const force = args.includes('--force');
      const result = restore({
        cwd: locationDir,
        sessionId: owner,
        stateDir,
        state,
        argv: args,
        force,
        wording: RESTORE_WORDING,
      });
      return show(restoreNotice({ text: result.text, force }));
    }

    if (sub === 'stop') {
      if (state) {
        state.phase = 'off';
        writeState(stateDir, owner, state);
        await session.applyRulesFor(sessionID, 'off', state);
      }
      return show(stopNotice());
    }
  };

  // Records each /probe call with the phase before and after, so a command that
  // did not take effect can be found in the trace. Never changes the outcome.
  const tracedCommand = async (invocation) => {
    const { sub } = parseInvocation(invocation.prompt?.text);
    const phaseOf = async () => (await session.armedFor(invocation.sessionID))?.state.phase ?? null;
    const phaseBefore = await phaseOf().catch(() => null);
    const log = async (decision) => trace(stateDir, {
      host: 'opencode',
      hook: 'command',
      sessionId: invocation.sessionID ?? null,
      input: { sub, phaseBefore },
      decision,
    });
    try {
      const result = await runCommand(invocation);
      await log({ phaseAfter: await phaseOf().catch(() => null) });
      return result;
    } catch (err) {
      await log({ error: String(err?.message ?? err) });
      throw err;
    }
  };

  await ctx.command.transform((editor) => {
    editor.add({
      name: 'probe',
      description:
        'research-only mode: [question | status | implement | approve | restore [--force] | stop | check <cmd> | diff [--round N] [--patch] | rounds [prune [--force]] | export]',
      execute: tracedCommand,
    });
  });
}
