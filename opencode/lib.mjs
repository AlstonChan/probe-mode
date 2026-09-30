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
export const SUBCOMMANDS = ['start', 'status', 'implement', 'approve', 'restore', 'stop'];

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
    return { sub, args: rest ? rest.split(/\s+/) : [], question: '' };
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
    lines.push('  none (not a git repository — restore is unavailable)');
  }
  if (state.undo) lines.push(`Undo point: ${String(state.undo.ref).slice(0, 12)} (${state.undo.at})`);
  lines.push('', phaseHint(state.phase));
  return lines.join('\n');
}

/** Every command runs by submitting a prompt — OpenCode commands print nothing
 *  on their own — so these build what the user actually sees. */

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
    question ? `Investigate: ${question}` : "Probe mode is armed. Confirm what you want investigated.",
    'Follow the probe contract injected with this turn; report findings and stop.',
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

export function relayPrompt({ title, body, instruction }) {
  return [title, instruction, '', body].filter(Boolean).join('\n');
}

export function stopPrompt() {
  return [
    'Probe mode OFF. Snapshots are kept; `/probe restore` still works this session.',
    'Return to your normal behavior.',
  ].join('\n');
}

/** Claude's preview footer names probe-ctl; ours names the slash command. */
export const RESTORE_WORDING = {
  undoSaved: `Undo point saved — reverse this with: ${CMD} restore --undo --force`,
  reversible: `\`${CMD} restore --undo\` puts it back. Changes are also stashed.`,
  confirm: `Show this preview to the user, then run ${CMD} restore --force only after they confirm.`,
};

export function restoreRelay({ text, force }) {
  if (force) {
    return relayPrompt({
      title: 'Restore applied:',
      instruction: 'Report what changed (HEAD, rolled-back commits) briefly, then stop.',
      body: text,
    });
  }
  return relayPrompt({
    title: 'RESTORE PREVIEW — show this to the user verbatim:',
    instruction: `Nothing has been changed. Tell them to run \`${CMD} restore --force\` to apply it (or \`${CMD} restore --round N\` / \`--all\` to target another round) — do NOT apply it yourself.`,
    body: text,
  });
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
