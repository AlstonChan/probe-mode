#!/usr/bin/env node
// PreToolUse guard for probe mode: blocks every project mutation until a plan has
// been explicitly approved. Sandbox directories stay writable so Claude can write
// benchmark / validation / assertion scripts and prove an idea before touching code.
//
// Self-contained on purpose: an import that fails to parse would let writes through.
// Every failure path below denies rather than passes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BACKSLASH = String.fromCharCode(92);
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'probe-state');
// Plan mode writes the plan to a file here. Blocking it would break /probe
// implement at the exact moment it is supposed to work. A plan file is notes,
// never a project change, so it stays writable in every phase.
const PLANS_DIR = path.join(CONFIG_DIR, 'plans');

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

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  pass(); // no readable payload: not our call to make
}

const stateFile = path.join(STATE_DIR, `${input.session_id}.json`);
if (!fs.existsSync(stateFile)) pass(); // probe mode not active -> hook is inert

let state = null;
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
} catch (err) {
  // The file exists but we cannot read it. That is a broken guard, not an absent
  // one, so deny rather than assume the session is unprotected.
  deny(`probe-mode state file is unreadable (${err && err.message}). Denying until /probe status or /probe stop resolves it.`);
}

try {
  if (!state || state.phase === 'implementing' || state.phase === 'off') pass();

  const phase = state.phase; // 'probe' | 'planning'
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  const norm = (p) => path.resolve(p).split(BACKSLASH).join('/').toLowerCase();

  const roots = [
    path.join(STATE_DIR, input.session_id || 'none'),
    STATE_DIR,
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
    `Implementation requires an explicit request from the user, then /probe implement, ` +
    `then an approved plan. Nothing outside the sandbox may change before that.`;

  // ---------- file tools ----------
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const target = ti.file_path || ti.notebook_path;
    if (fileWritable(target)) pass();
    deny(`Blocked by ${phaseWord}: no writes outside the sandbox.\nTarget: ${target}\n${hint}`);
  }

  // ---------- shell tools ----------
  if (tool !== 'Bash' && tool !== 'PowerShell') pass();

  const cmd = String(ti.command || '');

  // Resolve relative paths against a leading `cd <dir> &&` if present.
  let base = input.cwd || process.cwd();
  const cdMatch = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/);
  if (cdMatch) base = path.resolve(base, cdMatch[1] || cdMatch[2] || cdMatch[3]);

  const unquote = (t) => t.replace(/^["']|["']$/g, '');
  // A token counts as a path only if it exists on disk, or it carries a separator
  // and its parent exists. Without the separator clause, bare words like `mkdir`
  // and `hi` resolve against cwd and look like paths; with it, `sed`'s `s/a/b/`
  // still does not, because no `s/a` directory exists.
  const looksLikePath = (tok) => {
    if (!tok || tok.startsWith('-')) return false;
    const clean = unquote(tok);
    if (!clean) return false;
    try {
      const abs = path.resolve(base, clean);
      if (fs.existsSync(abs)) return true;
      const hasSep = clean.includes('/') || clean.includes(BACKSLASH);
      return hasSep && fs.existsSync(path.dirname(abs));
    } catch {
      return false;
    }
  };
  const resolveTok = (tok) => path.resolve(base, unquote(tok));

  // Redirection / tee targets are always path candidates.
  const redirTargets = [];
  for (const m of cmd.matchAll(/(?<![0-9&])>>?\s*("[^"]+"|'[^']+'|[^\s|;&<>]+)/g)) redirTargets.push(m[1]);
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s|;&<>]+)/g)) redirTargets.push(m[1]);

  const MUTATORS = [
    /\brm\b/, /\brmdir\b/, /\bmv\b/, /\bcp\b/, /\bmkdir\b/, /\btouch\b/, /\bln\b/,
    /\bchmod\b/, /\bchown\b/, /\btruncate\b/, /\bdd\b/, /\bshred\b/, /\bunlink\b/,
    /\bsed\s+(-[a-z]*i|--in-place)/, /\bperl\s+-[a-z]*i/, /\bpatch\b/,
    /\bgit\s+(add|commit|checkout|switch|restore|reset|merge|rebase|cherry-pick|revert|stash|clean|apply|am|push|rm|mv|tag|config|worktree)\b/,
    /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|rm|uninstall|update|upgrade|link|publish)\b/,
    /\bpip3?\s+(install|uninstall)\b/, /\b(poetry|uv)\s+(add|remove|install|sync|lock|pip)\b/,
    /\bcargo\s+(add|remove|install|fix)\b/, /\bgo\s+(get|install|mod\s+tidy)\b/,
    /\bdotnet\s+(add|remove|restore|new|publish)\b/,
    /\bprettier\b[^|;&]*--write/, /\beslint\b[^|;&]*--fix/, /\bblack\b/, /\bruff\s+format\b/,
    /\bgofmt\s+-w\b/, /\bterraform\s+(apply|destroy|import)\b/,
    /\bkubectl\s+(apply|delete|create|patch|edit|scale)\b/,
    /\bdocker\s+(run|build|rm|rmi|compose)\b/,
    /\b(New-Item|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-ItemProperty|New-ItemProperty)\b/i,

    // More package managers. Only the mutating subcommands: `mvn test` and
    // `gradle test` must keep working, since running tests is the point.
    /\bbundle\s+(install|update|add|remove)\b/,
    /\bcomposer\s+(install|update|require|remove)\b/,
    /\bmvn\s+(install|deploy)\b/, /\bgradle\s+(publish|publishToMavenLocal)\b/,
    /\bgem\s+(install|uninstall)\b/, /\bapt(-get)?\s+(install|remove|purge|upgrade)\b/,
    /\b(brew|choco|winget|scoop)\s+(install|uninstall|remove|upgrade)\b/,
    // `make` alone builds so tests can run; these targets mutate on purpose.
    /\bmake\s+(install|uninstall|clean|distclean)\b/,

    // Database migrations. Unambiguously state-changing and often irreversible,
    // which makes them the worst thing to run "just to see".
    /\brake\s+db:/, /\balembic\s+(upgrade|downgrade|stamp|revision)\b/,
    /\bprisma\s+(migrate|db\s+push)\b/, /\bflyway\s+(migrate|clean|undo)\b/,
    /\bknex\s+migrate\b/, /\bsequelize\s+db:/,
    /\bmanage\.py\s+migrate\b/, /\bartisan\s+migrate\b/,
    /\bdotnet\s+ef\s+database\s+update\b/,

    // Deploys and cloud mutation. Nothing here belongs in a research pass.
    /\bhelm\s+(install|upgrade|uninstall|rollback|delete)\b/,
    /\bansible(-playbook)?\b/, /\b(serverless|sls)\s+deploy\b/,
    /\b(vercel|netlify|fly|flyctl|heroku|railway)\s+\w*\s*deploy\b/, /\bvercel\s+--prod\b/,
    /\baws\s+\w+\s+(create|delete|put|update|remove|sync|cp|mv|rm)\b/,
    /\bgcloud\s+\w+\s+(create|delete|deploy|update)\b/,
    /\baz\s+\w+\s+(create|delete|update)\b/,

    // Publishing and anything that reaches other people.
    /\bcargo\s+publish\b/, /\btwine\s+upload\b/,
    /\bgh\s+(release|pr|issue|repo)\s+(create|merge|edit|delete|close)\b/,

    // Downloads write files. wget writes by default; curl needs -o/-O. Both are
    // still allowed when every path they name resolves inside the sandbox.
    /\bwget\b/, /\bcurl\b[^|;&]*\s-[oO]\b/,
  ];

  const mutates = MUTATORS.some((re) => re.test(cmd)) || redirTargets.length > 0;
  if (!mutates) pass();

  const tokens = cmd.split(/\s+|\||;|&&/).filter(Boolean);
  const candidates = [
    ...redirTargets.map(resolveTok),
    ...tokens.filter(looksLikePath).map(resolveTok),
  ];
  const outside = candidates.filter((c) => !inSandbox(c));

  if (candidates.length > 0 && outside.length === 0) pass();

  deny(
    `Blocked by ${phaseWord}: this command mutates state outside the sandbox.\n` +
    `Command: ${cmd}\n` +
    (outside.length
      ? `Outside the sandbox: ${outside.join(', ')}\n`
      : `No target resolved inside the sandbox.\n`) +
    `Reading, running tests and running benchmarks are fine. Put scripts and their ` +
    `output in the sandbox instead.\n${hint}`
  );
} catch (err) {
  // Fail closed. A broken guard must never become an open door.
  deny(`probe-mode guard failed (${err && err.message}); denying to stay safe. Run /probe status.`);
}
