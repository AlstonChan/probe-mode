#!/usr/bin/env node
// UserPromptSubmit: re-injects the probe-mode contract every turn so it survives
// compaction and cannot drift.
import fs from 'node:fs';
import { readStdin, readState, statePath, CMD } from './probe-lib.mjs';

const input = await readStdin();
const state = readState(input.session_id);
if (!state || state.phase === 'off') process.exit(0);

// Liveness heartbeat. probe-cleanup.mjs prunes by mtime, and nothing else ever
// touches a state file after its last phase change — so without this, an
// 'implementing' mtime means "when the plan was approved", not "when this session
// was last used", and the prune would delete the state of a session still in
// active use. One utimes per prompt, deliberately after the phase check so an
// 'off' state is never resurrected.
//
// utimes rather than a lastSeen field in the JSON: rewriting the file on every
// prompt would race probe-promote.mjs's write.
try {
  const now = new Date();
  fs.utimesSync(statePath(input.session_id), now, now);
} catch {}

const emit = (text) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
  }));
  process.exit(0);
};

const round = state.round || 1;

// Unlocked. Deliberately short: this runs on every prompt for the rest of the
// session, and its only job is to make the next step of the cycle discoverable.
if (state.phase === 'implementing') {
  emit([
    `PROBE MODE: round ${round}, writes unlocked (plan approved). Execute directly.`,
    `To research again instead, the user runs \`${CMD} <question>\` — that opens a new`,
    `round and re-blocks writes. \`${CMD} restore\` rewinds; every round is restorable.`,
  ].join('\n'));
}

const planning = state.phase === 'planning';

emit([
  `PROBE MODE IS ACTIVE (round ${round}, phase: ${state.phase}).`,
  '',
  'Contract for this turn:',
  '- Investigate freely: read, search, fetch, run tests and benchmarks, inspect anything.',
  `- Do NOT change anything outside the sandbox: ${state.sandbox}`,
  '- Scripts you write to benchmark, validate, test or assert an idea go in the sandbox.',
  '  Run them from the project directory if they need to import project code; just do not write there.',
  '- Do NOT start implementing. Not "a small fix first", not "while I am here".',
  `- To ask for a plan when you are ready: \`${CMD} implement\`.`,
  planning
    ? '- The user has asked for implementation. Write the plan to the plan file (that directory is writable), then call ExitPlanMode. Everything else stays blocked until they approve it.'
    : '- Entering plan mode requires an EXPLICIT request from the user. Do not call EnterPlanMode on your own initiative, and do not ask for it repeatedly. Report findings and stop.',
  '- When you finish investigating, report: what you verified, the evidence, and what you would do — then stop.',
  '',
  'A PreToolUse hook enforces this. If a write is denied, that is expected; do not work around it.',
].join('\n'));
