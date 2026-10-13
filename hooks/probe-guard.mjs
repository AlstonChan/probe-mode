#!/usr/bin/env node
// PreToolUse guard for probe mode: blocks every project mutation until a plan has
// been explicitly approved. Sandbox directories stay writable so Claude can write
// benchmark / validation / assertion scripts and prove an idea before touching code.
//
// No static imports on purpose: one that failed to load would crash the process
// before the handlers below exist, and Claude Code runs the tool when a PreToolUse
// hook exits non-zero. The one dependency, the shared shell analysis, is loaded
// with a dynamic import inside a try, so its failure denies too. Every failure
// path below denies rather than passes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BACKSLASH = String.fromCharCode(92);
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'probe-state');
// Plan mode writes the plan to a file here. Blocking it would break the implement
// step at the exact moment it is supposed to work. A plan file is notes,
// never a project change, so it stays writable in every phase.
const PLANS_DIR = path.join(CONFIG_DIR, 'plans');
// How long the user's own stop command stays valid for the model to carry out.
const STOP_INTENT_MS = 2 * 60 * 1000;

// Same detection as probe-lib.mjs, duplicated on purpose (see the NOTE in that file:
// this guard never imports anything, so it can fail closed even if the shared lib breaks).
const isPlugin = fs.existsSync(path.join(path.dirname(import.meta.dirname), '.claude-plugin'))
  || Boolean(process.env.CLAUDE_PLUGIN_ROOT);
const CMD = isPlugin ? '/probe-mode:probe' : '/probe';

const emit = (decision, reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};
const deny = (reason) => emit('deny', reason);
const pass = () => process.exit(0);

// Going async makes an escaped throw exit 1, and Claude Code treats a non-zero
// PreToolUse exit OTHER than 2 as a non-blocking error — the tool then runs. That
// would be a silent open door, so catch anything that reaches the top level and deny.
const crashed = (err) =>
  deny(`probe-mode guard crashed (${err && err.message}); denying to stay safe. Run ${CMD} status.`);
process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);

// Inlined, never imported — see the header: an import that failed to parse would let
// writes through, so this file carries its own copy of everything.
//
// fs.readFileSync(0) blocked the event loop, so a stdin pipe Claude Code wrote to but
// never closed pinned this process forever, and no setTimeout could interrupt it
// because the sync read never yielded. A hung guard is worse in kind than a hung
// statusline: it stalls the tool call itself until Claude Code's 20s timeout. 5s is
// ~1000x the measured payload arrival and well under that 20s, so our timer always
// wins and the guard emits its own decision instead of being killed mid-flight.
const STDIN_SOFT_MS = 5000;
const STDIN_HARD_MS = 7000;

let input = null;
{
  const chunks = [];
  let soft = null;
  let hard = null;
  try {
    if (process.stdin.isTTY) pass(); // hand-run in a terminal: nothing to judge
    soft = setTimeout(() => process.stdin.destroy(), STDIN_SOFT_MS);
    // Backstop only. pass() matches the timeout semantics chosen below.
    hard = setTimeout(pass, STDIN_HARD_MS);
    hard.unref();
    try {
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
        // Stop at the first complete object: Claude Code writes the payload and then
        // holds the pipe open, so waiting for EOF would cost the full timeout on every
        // guarded tool call. A JSON prefix cannot parse, so breaking early is safe.
        // Buffer.concat, never `+=`: tool_input carries file contents, and a chunk
        // boundary can split a multi-byte UTF-8 sequence.
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); break; } catch {}
      }
    } catch { /* our own destroy() rejects the iterator; keep what arrived */ }
  } catch {
    // fd 0 closed entirely (EBADF): fall through with no payload.
  } finally {
    clearTimeout(soft);
    clearTimeout(hard);
    try { process.stdin.destroy(); } catch {}
  }

  // No readable payload: not our call to make. This PASSES, which is the one failure
  // path in this file that does not deny — deliberately, and unchanged from before.
  // Without a session_id we cannot know whether probe mode is even on, and a blanket
  // deny would block every Edit/Write/Bash for users who have never run /probe,
  // turning a payload-delivery bug into a global outage. The narrower risk accepted
  // here is an armed session whose payload never arrives; the state-file-unreadable
  // path below still denies, and the git snapshot remains the real backstop.
  if (!input || typeof input !== 'object') pass();
}

const stateFile = path.join(STATE_DIR, `${input.session_id}.json`);
if (!fs.existsSync(stateFile)) pass(); // probe mode not active -> hook is inert

let state = null;
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
} catch (err) {
  // The file exists but we cannot read it. That is a broken guard, not an absent
  // one, so deny rather than assume the session is unprotected.
  deny(`probe-mode state file is unreadable (${err && err.message}). Denying until ${CMD} status or ${CMD} stop resolves it.`);
}

// Valid JSON that is not a state object (`null`, a number, an array) is as broken
// as unparseable JSON, and passing it would let one write disarm the guard.
if (!state || typeof state !== 'object' || Array.isArray(state)) {
  deny(`probe-mode state file is not a state object. Denying until ${CMD} status or ${CMD} stop resolves it.`);
}

try {
  if (state.phase === 'implementing' || state.phase === 'off') pass();

  const phase = state.phase; // 'probe' | 'planning'
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  const norm = (p) => path.resolve(p).split(BACKSLASH).join('/').toLowerCase();

  // Never STATE_DIR itself: it holds this session's state file, and a model that
  // could rewrite or delete that file could switch the guard off.
  const roots = [
    input.scratchpad_dir,
    state.sandbox,
    input.cwd ? path.join(input.cwd, '.probe-sandbox') : null,
  ].filter(Boolean).map(norm);

  // The plan directory is writable by the file tools only. Plan mode writes plan
  // files with Edit/Write; nothing legitimately touches them from the shell, and
  // treating the directory as a shell-writable root would permit `rm -rf` on the
  // user's entire plan history.
  const fileRoots = [...roots, norm(PLANS_DIR)];

  const within = (target, list) => {
    if (!target) return false;
    const t = norm(path.isAbsolute(target) ? target : path.join(input.cwd || '.', target));
    return list.some((r) => t === r || t.startsWith(r + '/'));
  };
  const inSandbox = (target) => within(target, roots);
  const fileWritable = (target) => within(target, fileRoots);

  const phaseWord = phase === 'planning'
    ? 'probe mode (planning — plan not approved yet)'
    : 'probe mode (research only)';
  const hint =
    `Sandbox (writable): ${state.sandbox}\n` +
    `Implementation requires an explicit request from the user, then ${CMD} implement, ` +
    `then an approved plan. Nothing outside the sandbox may change before that.`;

  // ---------- file tools ----------
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const target = ti.file_path || ti.notebook_path;
    if (fileWritable(target)) pass();
    deny(`Blocked by ${phaseWord}: no writes outside the sandbox.\nTarget: ${target}\n${hint}`);
  }

  // ---------- shell tools ----------
  if (tool !== 'Bash' && tool !== 'PowerShell') pass();

  const rawCmd = String(ti.command || '');

  // Disarming. The skill runs `probe-ctl stop` through this very tool, so only a
  // fresh token left by the UserPromptSubmit hook — proof the USER typed the stop
  // command — lets it through. The model cannot mint one: the state file is
  // outside every writable root.
  if (/probe-ctl(?:\.mjs)?["']?\s+stop\b/i.test(rawCmd)) {
    const fresh = Number.isFinite(state.stopIntent) && Date.now() - state.stopIntent <= STOP_INTENT_MS;
    if (fresh) pass();
    deny(
      `Blocked by ${phaseWord}: only the user can switch probe mode off.\n` +
      `If they want to, they type ${CMD} stop themselves.\n${hint}`
    );
  }

  // The analysis lives in shared/shell.mjs, which OpenCode runs too, so the two
  // hosts cannot drift. It is loaded only here — armed session, shell tool — and
  // inside this try, after the crash handlers: a module that fails to load or
  // parse DENIES, which is what the old inline copy existed to guarantee.
  let shell;
  try {
    shell = await import('../shared/shell.mjs');
  } catch (err) {
    deny(`probe-mode guard could not load its shell analysis (${err && err.message}); denying to stay safe. Run ${CMD} status.`);
  }

  const verdict = shell.analyzeCommand(rawCmd, {
    cwd: input.cwd || process.cwd(),
    roots,
    shell: tool === 'PowerShell' ? 'powershell' : 'bash',
  });
  if (!verdict) pass();

  deny(
    `Blocked by ${phaseWord}: this command mutates state outside the sandbox.
` +
    `Command: ${rawCmd}
` +
    (verdict.offenders.length ? `Outside the sandbox: ${verdict.offenders.join(', ')}
` : '') +
    (verdict.unresolved.length ? `Could not resolve a sandbox target for: ${verdict.unresolved.join('; ')}
` : '') +
    `Reading, running tests and running benchmarks are fine. Put scripts and their ` +
    `output in the sandbox instead.
${hint}`
  );
} catch (err) {
  // Fail closed. A broken guard must never become an open door.
  deny(`probe-mode guard failed (${err && err.message}); denying to stay safe. Run ${CMD} status.`);
}
