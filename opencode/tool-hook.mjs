// Post-tool hook: blocked calls get a reason that names the mode instead of a
// rules dump (what Claude's guard messages do on the other host), and a plan
// approved through the `question` tool unlocks writes.
import { CMD, deniedMessageFor } from './lib.mjs';
import { trace } from '../shared/trace.mjs';

/** `event.input` arrives as `unknown`; narrow it once. */
function toolInput(event) {
  return event.input && typeof event.input === 'object' ? event.input : {};
}

export async function registerToolHook({ ctx, stateDir }, session) {
  const log = (event, decision) => trace(stateDir, {
    host: 'opencode',
    hook: 'tool.execute.after',
    sessionId: event.sessionID ?? null,
    input: { tool: event.tool, status: event.status, input: event.input, result: event.result, error: event.error?.message },
    decision,
  });
  await ctx.tool.hook('execute.after', async (event) => {
    const armed = await session.armedFor(event.sessionID);
    if (!armed) return;
    const state = armed.state;
    if (state.phase === 'off') return;

    if (event.status === 'error') {
      const replacement = deniedMessageFor({
        tool: event.tool,
        message: event.error?.message,
        input: toolInput(event),
        phase: state.phase,
        sandbox: state.sandbox,
        cmd: CMD,
      });
      if (!replacement) return log(event, 'ignored');
      try {
        event.error.message = replacement;
      } catch {
        // The host owns the error object; if it refuses mutation the model
        // keeps the generic message. Enforcement is unaffected either way.
      }
      log(event, 'denied-message');
      return;
    }

    // Plan approval answered through the `question` tool: the model presents
    // the plan and asks; the user's own answer is what unlocks writes.
    if (event.tool === 'question' && state.phase === 'planning') {
      const payload = toolInput(event);
      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      const index = questions.findIndex((q) => /probe plan approval/i.test(String(q?.header ?? '')));
      if (index === -1) return log(event, 'ignored');
      // The answers arrive structured either in `output` or, when `output` is
      // the human-readable summary string, in `metadata`.
      const out = event.result?.output;
      const output = (out && typeof out === 'object') ? out : (event.result?.metadata ?? {});
      const answers = Array.isArray(output.answers) ? output.answers : [];
      const answer = String((answers[index] ?? [])[0] ?? '');
      // Exact label: the model writes the options, so a prefix match would let
      // "Approve later — keep researching" unlock.
      if (answer.trim().toLowerCase() === 'approve') {
        await session.unlock(event.sessionID, 'question');
        log(event, 'unlocked:question');
      } else {
        log(event, 'ignored');
      }
    }
  });
}
