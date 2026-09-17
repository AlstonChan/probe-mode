#!/usr/bin/env node
// UserPromptSubmit: re-injects the probe-mode contract every turn so it survives
// compaction and cannot drift.
import { readStdin, readState } from './probe-lib.mjs';

const input = readStdin();
const state = readState(input.session_id);
if (!state || state.phase === 'implementing' || state.phase === 'off') process.exit(0);

const planning = state.phase === 'planning';

const text = [
  `PROBE MODE IS ACTIVE (phase: ${state.phase}).`,
  '',
  'Contract for this turn:',
  '- Investigate freely: read, search, fetch, run tests and benchmarks, inspect anything.',
  `- Do NOT change anything outside the sandbox: ${state.sandbox}`,
  '- Scripts you write to benchmark, validate, test or assert an idea go in the sandbox.',
  '  Run them from the project directory if they need to import project code; just do not write there.',
  '- Do NOT start implementing. Not "a small fix first", not "while I am here".',
  planning
    ? '- The user has asked for implementation. Write the plan to the plan file (that directory is writable), then call ExitPlanMode. Everything else stays blocked until they approve it.'
    : '- Entering plan mode requires an EXPLICIT request from the user. Do not call EnterPlanMode on your own initiative, and do not ask for it repeatedly. Report findings and stop.',
  '- When you finish investigating, report: what you verified, the evidence, and what you would do — then stop.',
  '',
  'A PreToolUse hook enforces this. If a write is denied, that is expected; do not work around it.',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
}));
