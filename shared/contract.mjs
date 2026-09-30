// The research contract, injected into the model's context every turn.
//
// One source of truth for both hosts: Claude Code injects it from
// hooks/probe-context.mjs on UserPromptSubmit, OpenCode from the plugin's
// session `context` hook on every model request (which also makes it survive
// compaction for free — the injection happens per request, not per prompt).
//
// Three lines are host-specific, because the mechanisms are: Claude Code has
// EnterPlanMode/ExitPlanMode and a PreToolUse hook; OpenCode has neither, so it
// names the command and the session permission rules instead. Everything else
// the model is told to DO is identical, so the two hosts cannot drift apart on
// the contract itself.
export const HOST_TEXT = {
  claude: {
    enforcement: 'A PreToolUse hook enforces this. If a write is denied, that is expected; do not work around it.',
    research: '- Entering plan mode requires an EXPLICIT request from the user. Do not call EnterPlanMode on your own initiative, and do not ask for it repeatedly. Report findings and stop.',
    planning: '- The user has asked for implementation. Write the plan to the plan file (that directory is writable), then call ExitPlanMode. Everything else stays blocked until they approve it.',
  },
  opencode: {
    enforcement: 'Session permission rules enforce this. If a write is denied, that is expected; do not work around it.',
    research: (cmd) => `- Implementation requires an EXPLICIT request from the user: they run \`${cmd} implement\`. Do not ask for it repeatedly. Report findings and stop.`,
    planning: '- The user has asked for implementation. Write the plan to the plan file (that directory is writable), present it in full, then ask for approval with the `question` tool (header: "Probe plan approval", options: Approve / Revise / Reject). Everything else stays blocked until they approve it.',
  },
};

const pick = (host, key, cmd) => {
  const value = (HOST_TEXT[host] ?? HOST_TEXT.claude)[key];
  return typeof value === 'function' ? value(cmd) : value;
};

/**
 * @param {object} input
 * @param {'probe'|'planning'|'implementing'|'off'} input.phase
 * @param {number} input.round
 * @param {string} input.sandbox   the only writable path while armed
 * @param {string} input.cmd       how the user invokes this host's command
 * @param {'claude'|'opencode'} [input.host]
 */
export function contractText({ phase, round, sandbox, cmd, host = 'claude' }) {
  // Unlocked. Deliberately short: this runs on every prompt for the rest of the
  // session, and its only job is to make the next step of the cycle discoverable.
  if (phase === 'implementing') {
    return [
      `PROBE MODE: round ${round}, writes unlocked (plan approved). Execute directly.`,
      `To research again instead, the user runs \`${cmd} <question>\` — that opens a new`,
      `round and re-blocks writes. \`${cmd} restore\` rewinds; every round is restorable.`,
    ].join('\n');
  }

  return [
    `PROBE MODE IS ACTIVE (round ${round}, phase: ${phase}).`,
    '',
    'Contract for this turn:',
    '- Investigate freely: read, search, fetch, run tests and benchmarks, inspect anything.',
    `- Do NOT change anything outside the sandbox: ${sandbox}`,
    '- Scripts you write to benchmark, validate, test or assert an idea go in the sandbox.',
    '  Run them from the project directory if they need to import project code; just do not write there.',
    '- Do NOT start implementing. Not "a small fix first", not "while I am here".',
    `- To ask for a plan when you are ready: \`${cmd} implement\`.`,
    pick(host, phase === 'planning' ? 'planning' : 'research', cmd),
    '- When you finish investigating, report: what you verified, the evidence, and what you would do — then stop.',
    '',
    pick(host, 'enforcement', cmd),
  ].join('\n');
}
