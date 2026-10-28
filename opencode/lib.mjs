// Pure OpenCode-side logic for probe-mode: argument parsing, status text, and
// the prompts the command submits to the session. No plugin API in here, so
// test/opencode.test.mjs can exercise it directly under `node --test`.
import path from 'node:path';
import { normalizeRounds, roundRef } from '../shared/state.mjs';
import { denyMessage, shellDenyMessage } from '../shared/rules.mjs';

export const CMD = '/probe';

/** Subcommands the user can type. Anything else is treated as a research
 *  question, so `/probe does batching help?` arms the mode with that question —
 *  exactly how Claude Code's `/probe <question>` behaves. */
export const SUBCOMMANDS = ['start', 'status', 'implement', 'approve', 'restore', 'stop', 'check', 'diff', 'rounds', 'export'];

export function parseInvocation(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { sub: 'start', args: [], question: '' };
  const match = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const head = match[1];
  const rest = (match[2] || '').trim();
  const sub = head.toLowerCase();
  if (sub === 'start') {
    // `/probe start <question>` and bare `/probe <question>` are the same arm.
    return { sub, args: [], question: rest };
  }
  if (SUBCOMMANDS.includes(sub)) {
    return { sub, args: rest ? rest.split(/\s+/) : [], question: '', rest };
  }
  return { sub: 'start', args: [], question: raw };
}

export function phaseHint(phase) {
  if (phase === 'probe') return `Investigating. Say \`${CMD} implement\` when you want a plan.`;
  if (phase === 'planning') return 'Plan not approved yet. Writes stay blocked until the user approves it.';
  if (phase === 'implementing') return `Writes unlocked. \`${CMD} <question>\` starts another research round; \`${CMD} restore\` rewinds.`;
  return `Disarmed. \`${CMD} <question>\` arms a new round.`;
}

const fmtRound = (sessionId, r, mark) =>
  `  ${mark} round ${r.n}  ${r.at}  ${String(r.ref || '').slice(0, 12)}  (${roundRef(sessionId, r.n)})`;

/** `status` output, mirroring Claude's probe-ctl status line for line. */
export function statusText(state, { sessionId, refExists }) {
  if (!state) return `Probe mode: OFF`;
  const rounds = normalizeRounds(state);
  const lines = [
    `Probe mode: ${state.phase} (round ${state.round || rounds.length || 1})`,
    `Sandbox:  ${state.sandbox}`,
    `Project:  ${state.cwd}`,
    `Started:  ${state.startedAt}`,
    'Rounds:',
  ];
  if (rounds.length) {
    rounds.forEach((r) => lines.push(fmtRound(sessionId, r, refExists(roundRef(sessionId, r.n)) ? 'ok' : '!!')));
  } else {
    lines.push(state.snapshotError
      ? `  none (snapshot failed: ${state.snapshotError} — restore is unavailable)`
      : '  none (not a git repository — restore is unavailable)');
  }
  if (state.undo) lines.push(`Undo point: ${String(state.undo.ref).slice(0, 12)} (${state.undo.at})`);
  lines.push('', phaseHint(state.phase));
  return lines.join('\n');
}

/** OpenCode commands print nothing on their own, so a subcommand either
 *  prompts the model (when the model has to act: arm with a question,
 *  implement, approve) or posts a notice. These build both. */

/** Output a subcommand reports without starting a model turn. OpenCode shows
 *  `description` to the user as a Notice; `text` reaches the model with its
 *  next request, so it still knows what happened. `note` is model-only
 *  guidance, never shown. */
export function notice(sub, body, note) {
  const head = `[${CMD}${sub ? ` ${sub}` : ''}]`;
  return { description: body, text: [`${head} ${body}`, note].filter(Boolean).join('\n\n') };
}

export function armPrompt({ state, question, snapshotLine }) {
  const head = state.round > 1
    ? `NEW RESEARCH ROUND ${state.round} — writes are blocked again.`
    : 'PROBE MODE ON (round 1).';
  return [
    `${head}`,
    `Sandbox (only writable path): ${state.sandbox}`,
    `Project: ${state.cwd}`,
    `Snapshot: ${snapshotLine}`,
    '',
    ...(question
      ? [`Investigate: ${question}`, 'Follow the probe contract injected with this turn; report findings and stop.']
      : [`Ask your question in the chat. When research is done, \`${CMD} implement\` asks for a plan; writes stay blocked until you approve it.`]),
  ].join('\n');
}

export function implementPrompt({ plansFile }) {
  return [
    'Phase -> planning. Writes are STILL blocked outside the sandbox.',
    `Write the plan to ${plansFile} (that directory is writable), then present the full plan`,
    'in the conversation and ask for approval with the `question` tool',
    '(header: "Probe plan approval"; options: Approve / Revise / Reject).',
    `The user's approval unlocks writes. Do not attempt project edits before that; they can also`,
    `approve explicitly by running \`${CMD} approve\`.`,
  ].join('\n');
}

export function approvePrompt() {
  return [
    'The user APPROVED the plan. Writes are unlocked for this session.',
    'Execute the approved plan now, or answer the user. No further approval is needed.',
    `\`${CMD} <question>\` re-blocks writes for a new research round; \`${CMD} restore\` rewinds.`,
  ].join('\n');
}

export function stopNotice() {
  return notice(
    'stop',
    `Probe mode OFF. Snapshots are kept; \`${CMD} restore\` still works this session.`,
    'Return to your normal behavior.',
  );
}

/** Claude's preview footer names probe-ctl and speaks to the model; ours names
 *  the slash command and speaks to the user, who reads it as a notice. */
export const RESTORE_WORDING = {
  undoSaved: `Undo point saved — reverse this with: ${CMD} restore --undo --force`,
  reversible: `\`${CMD} restore --undo\` puts it back.`,
};

/** The command that applies a restore preview: the same flags plus --force.
 *  Dropping them would restore a different target, and an --undo preview
 *  applied as plain --force overwrites the very undo point it showed. */
const applyRestore = (args) => [`${CMD} restore`, ...args.filter((a) => a !== '--force'), '--force'].join(' ');

/** Footer for a restore preview, built from the previewed flags. */
export const restoreConfirm = (args) => `Nothing has changed yet. Run ${applyRestore(args)} to apply it.`;

export const PRUNE_WORDING = {
  confirm: `Nothing has been deleted yet. Run ${CMD} rounds prune --force to apply it.`,
};

/** `restore` output. The preview's model note keeps the model from applying
 *  it: only the user runs `--force`. */
export function restoreNotice({ text, force, args = [] }) {
  return force
    ? notice('restore', text, 'The project was rolled back; re-read files before relying on what you saw earlier.')
    : notice('restore', text, `Nothing has been changed. Only the user runs \`${applyRestore(args)}\`; do NOT apply it yourself.`);
}

/** Sandbox the arm step creates: outside the workspace, so its rules grant the
 *  `external_directory` boundary too. */
export const sandboxFor = (stateDir, sessionId) => path.join(stateDir, sessionId, 'sandbox');

/** Messages a blocked tool call surfaces as its error. OpenCode reports
 *  `Permission denied: edit` — a bare fact with no reason — so the plugin
 *  rewrites it to the same kind of explanation Claude's guard prints.
 *  Returns null when this is not one of our denials (nothing to rewrite).
 *
 *  Deliberately pure: the plugin applies it, this decides it. */
export function deniedMessageFor({ tool, message, input, phase, sandbox, cmd = CMD }) {
  if (typeof message !== 'string' || !/permission denied|blocked|prevents you/i.test(message)) return null;
  const payload = input && typeof input === 'object' ? input : {};
  if (tool === 'edit' || tool === 'write' || tool === 'patch') {
    return denyMessage({
      phase,
      sandbox,
      cmd,
      target: payload.path ?? payload.file_path ?? '',
    });
  }
  if (tool === 'shell') {
    return shellDenyMessage({ phase, command: String(payload.command ?? ''), sandbox, cmd });
  }
  return null;
}
