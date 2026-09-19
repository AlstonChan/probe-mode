#!/usr/bin/env node
// probe-ctl: start / status / implement / restore / stop / setup
//
// Rounds: the loop is research -> plan -> implement, then either keep executing
// or start another research round. Each round takes its own snapshot pinned to
// its own git ref, so going back to research never destroys an earlier restore
// point. Round 1 keeps the original flat ref name for backward compatibility.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  CONFIG_DIR, STATE_DIR, readState, writeState, normalizeRounds, roundRef, undoRef, CMD,
} from './probe-lib.mjs';

const PHASE_HINT = {
  probe: `Investigating. Say \`${CMD} implement\` when you want a plan.`,
  planning: 'Plan not approved yet. Writes stay blocked until ExitPlanMode is approved.',
  implementing: `Writes unlocked. \`${CMD} <question>\` starts another research round; \`${CMD} restore\` rewinds.`,
  off: `Disarmed. \`${CMD} <question>\` arms a new round.`,
};

const sid = process.env.CLAUDE_CODE_SESSION_ID;
if (!sid) { console.error('CLAUDE_CODE_SESSION_ID not set; run this from inside a Claude Code session.'); process.exit(1); }

const cmd = process.argv[2] || 'status';
const argv = process.argv.slice(3);
const cwd = process.cwd();
const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

const isRepo = () => { try { return git(['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; } };
const refExists = (r) => { try { git(['rev-parse', '--verify', '--quiet', r]); return true; } catch { return false; } };

/**
 * Commit the current working tree (including untracked files) without touching
 * the real index or worktree, and pin it to `ref` so gc cannot collect it.
 */
function snapshot(ref) {
  if (!isRepo()) return null;
  const head = git(['rev-parse', 'HEAD']);
  const branch = (() => { try { return git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return 'HEAD'; } })();
  const idx = path.join(os.tmpdir(), `probe-index-${sid}-${Date.now()}`);
  try { fs.unlinkSync(idx); } catch {}
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  git(['read-tree', 'HEAD'], { env });
  git(['add', '-A'], { env });
  const tree = git(['write-tree'], { env });
  const commit = git(['commit-tree', tree, '-p', head, '-m', `probe snapshot ${sid} ${ref}`]);
  git(['update-ref', ref, commit]); // pin against gc
  try { fs.unlinkSync(idx); } catch {}
  return { head, branch, ref: commit, at: new Date().toISOString() };
}

const fmtRound = (r, mark) =>
  `  ${mark} round ${r.n}  ${r.at}  ${String(r.ref || '').slice(0, 12)}  (${roundRef(sid, r.n)})`;

/** Resolve which snapshot a restore should target, from the CLI flags. */
function resolveTarget(state) {
  const rounds = normalizeRounds(state);
  if (!rounds.length) return { error: 'No snapshot: this directory is not a git repository. Nothing to restore.' };

  if (argv.includes('--undo')) {
    const u = state.undo;
    if (!u) return { error: 'No undo point: nothing has been restored in this session yet.' };
    return { label: `the state just before the last restore (${u.at})`, snap: u, isUndo: true };
  }
  if (argv.includes('--all')) {
    return { label: 'the very beginning (round 1)', snap: rounds[0], round: rounds[0].n };
  }
  const i = argv.indexOf('--round');
  if (i !== -1) {
    const n = Number(argv[i + 1]);
    const r = rounds.find((x) => x.n === n);
    if (!r) return { error: `No round ${argv[i + 1]}. Available: ${rounds.map((x) => x.n).join(', ')}` };
    return { label: `the start of round ${n}`, snap: r, round: n };
  }
  const cur = rounds[rounds.length - 1];
  return { label: `the start of the current round (${cur.n})`, snap: cur, round: cur.n };
}

function restore(state, force) {
  const target = resolveTarget(state);
  if (target.error) return target.error;

  const snap = target.snap;
  const rounds = normalizeRounds(state);
  const commits = (() => {
    try { return git(['log', '--oneline', `${snap.head}..HEAD`]).split('\n').filter(Boolean); }
    catch { return []; }
  })();
  const changed = (() => {
    try { return git(['diff', '--stat', snap.ref]).split('\n').filter(Boolean); }
    catch { return []; }
  })();
  const branch = (() => { try { return git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return snap.branch; } })();

  if (!force) {
    const out = ['RESTORE PREVIEW — nothing has been changed yet.', ''];
    out.push(`Target: ${target.label}`);
    out.push(`  HEAD would go from ${branch} back to ${snap.head.slice(0, 12)} on ${snap.branch}`);
    out.push('');
    if (!target.isUndo && rounds.length > 1) {
      out.push('Rounds in this session:');
      rounds.forEach((r) => out.push(fmtRound(r, r.n === target.round ? '->' : '  ')));
      out.push('  Use --round N for a specific round, or --all for the very beginning.');
      out.push('');
    }
    if (commits.length) {
      out.push(`${commits.length} commit(s) WOULD BE ROLLED BACK:`);
      commits.forEach((c) => out.push(`  ${c}`));
    } else {
      out.push('No commits would be rolled back.');
    }
    out.push('');
    if (changed.length) {
      out.push('Working tree changes that would be undone:');
      changed.slice(-12).forEach((c) => out.push(`  ${c}`));
    } else {
      out.push('Working tree already matches the target; nothing to undo.');
    }
    out.push('');
    out.push('This restore is reversible: the current state is snapshotted first,');
    out.push('and `probe-ctl.mjs restore --undo` puts it back. Changes are also stashed.');
    out.push('Ask the user to confirm, then re-run the same command with --force');
    return out.join('\n');
  }

  const lines = [];

  // Snapshot where we are now, so the restore itself can be undone.
  const undo = snapshot(undoRef(sid));
  if (undo) {
    state.undo = undo;
    lines.push(`Undo point saved — reverse this with: probe-ctl.mjs restore --undo --force`);
  }
  if (git(['status', '--porcelain']).length > 0) {
    git(['stash', 'push', '-u', '-m', `probe-discard ${new Date().toISOString()}`]);
    lines.push('Current changes also stashed (git stash list).');
  }

  git(['reset', '--hard', snap.head]);           // branch tip back where it was
  git(['read-tree', '-u', '--reset', snap.ref]); // worktree + index == snapshot
  git(['reset', '--quiet']);                     // unstage, keep worktree

  writeState(sid, state);
  lines.push(`Restored to ${target.label}.`);
  lines.push(`HEAD: ${snap.head.slice(0, 12)} on ${snap.branch}`);
  if (commits.length) lines.push(`${commits.length} commit(s) rolled back — also in git reflog.`);
  lines.push(`Sandbox kept at ${state.sandbox} — delete it yourself if you want it gone.`);
  return lines.join('\n');
}

const toForwardSlash = (p) => p.split(path.sep).join('/');

function backupTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const statuslineSource = path.join(import.meta.dirname, 'probe-statusline.mjs');
const statuslineStable = path.join(STATE_DIR, 'probe-statusline.mjs');

/**
 * Plugins cannot ship a statusLine, so a plugin install has no status-bar indicator
 * unless the user hand-edits their own settings.json. This wires it up: copies the
 * statusline script to a stable path outside the versioned plugin cache (so it survives
 * `claude plugin update` deleting that directory), and merges a statusLine entry into
 * settings.json pointing there — mirroring install.sh's own backup/merge/foreign-check
 * logic, but writing only the statusLine key, never hooks.
 */
function setupStatusline() {
  if (CMD === '/probe') {
    console.log('Standalone install — install.sh already wired up the status line; nothing to do here.');
    return;
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.copyFileSync(statuslineSource, statuslineStable);

  const settingsPath = path.join(CONFIG_DIR, 'settings.json');
  const existed = fs.existsSync(settingsPath);
  if (existed) fs.copyFileSync(settingsPath, `${settingsPath}.probe-backup-${backupTimestamp()}`);

  let settings;
  try {
    settings = existed ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  } catch (err) {
    console.log(`settings.json is not valid JSON (${err.message}). Backed it up but left it ` +
      'untouched — fix the JSON, then re-run setup.');
    return;
  }

  // --cmd= carries no leading "/": on a machine with Git Bash, MSYS rewrites a
  // leading-slash argv token as if it were a POSIX path (probe-statusline.mjs adds the
  // slash back). The stable path is built with forward slashes for the same reason
  // install.sh's topath()/cygpath -m exists — Node accepts "/" on Windows regardless of
  // which shell runs this command.
  const command = `node "${toForwardSlash(statuslineStable)}" --cmd=${CMD.slice(1)}`;

  const foreign = settings.statusLine && !String(settings.statusLine.command).includes('probe-statusline');
  if (foreign) {
    console.log(`You already have a statusLine configured, so it was left untouched.
For the probe indicator, point statusLine at:
  ${command}`);
    return;
  }

  settings.statusLine = { type: 'command', command, padding: 0, refreshInterval: 2 };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`Status line wired up.
Copied the current probe-statusline.mjs to: ${statuslineStable}
${existed ? 'Backed up your previous settings.json first.' : 'Created settings.json.'}
Re-run this any time to refresh it — it always overwrites the copy above, so keep any
local edits to it elsewhere. Restart Claude Code to see the indicator.`);
}

/** Nudges status toward `setup` when it would actually help: never under a standalone
 *  install (already wired by install.sh), and only when the stable copy is missing or
 *  stale relative to the plugin's current probe-statusline.mjs. */
function statuslineNudge() {
  if (CMD === '/probe') return '';
  if (!fs.existsSync(statuslineStable)) {
    return `\nNo status-line indicator wired up for this plugin install. Run \`${CMD} setup\` once to add it.`;
  }
  try {
    if (fs.readFileSync(statuslineStable, 'utf8') !== fs.readFileSync(statuslineSource, 'utf8')) {
      return `\nThe status-line script has changed since you last ran \`${CMD} setup\`. Run it again to refresh.`;
    }
  } catch {
    // Unreadable stable copy isn't fatal — just skip the nudge rather than crash status.
  }
  return '';
}

const existing = readState(sid);

if (cmd === 'start') {
  const sandbox = path.join(STATE_DIR, sid, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });

  if (!existing) {
    const snap = snapshot(roundRef(sid, 1));
    writeState(sid, {
      phase: 'probe', sandbox, cwd, startedAt: new Date().toISOString(),
      snapshot: snap, round: 1,
      rounds: snap ? [{ n: 1, at: snap.at, ref: snap.ref, head: snap.head, branch: snap.branch }] : [],
    });
    const snapLine = snap
      ? `${snap.ref.slice(0, 12)} (restorable via ${CMD} restore)`
      : `NONE — not a git repository, so ${CMD} restore cannot roll anything back`;
    console.log(`PROBE MODE ON (round 1, phase: probe)
Sandbox (only writable path): ${sandbox}
Project: ${cwd}
Snapshot: ${snapLine}
Writes outside the sandbox are denied by hook until a plan is approved.`);
    console.log(`\n${PHASE_HINT.probe}`);
  } else {
    // Already armed: begin a NEW round. Earlier snapshots are never overwritten.
    const rounds = normalizeRounds(existing);
    const n = (rounds[rounds.length - 1]?.n || 0) + 1;
    const snap = snapshot(roundRef(sid, n));
    const was = existing.phase;
    existing.phase = 'probe';
    existing.round = n;
    existing.rounds = snap
      ? [...rounds, { n, at: snap.at, ref: snap.ref, head: snap.head, branch: snap.branch }]
      : rounds;
    existing.sandbox = sandbox;
    writeState(sid, existing);
    console.log(`NEW RESEARCH ROUND ${n} (was: ${was}, now phase: probe)
Sandbox (only writable path): ${sandbox}
Project: ${cwd}
Snapshot: ${snap ? `${snap.ref.slice(0, 12)} pinned at ${roundRef(sid, n)}` : 'NONE — not a git repository'}
WRITES ARE BLOCKED AGAIN until a new plan is approved.
Earlier restore points are intact: ${rounds.map((r) => `round ${r.n}`).join(', ') || 'none'}.`);
    console.log(`\n${PHASE_HINT.probe}`);
  }
} else if (cmd === 'implement') {
  if (!existing) { console.log('Probe mode is not active.'); process.exit(0); }
  existing.phase = 'planning';
  writeState(sid, existing);
  console.log('Phase -> planning. Writes are STILL blocked. Call EnterPlanMode, write the plan, then ExitPlanMode for approval.');
} else if (cmd === 'restore') {
  if (!existing) { console.log('Probe mode is not active for this session; no snapshot to restore.'); process.exit(0); }
  console.log(restore(existing, argv.includes('--force')));
} else if (cmd === 'stop') {
  if (existing) { existing.phase = 'off'; writeState(sid, existing); }
  console.log(`Probe mode OFF. Snapshots kept; ${CMD} restore still works this session.`);
} else if (cmd === 'setup') {
  setupStatusline();
} else {
  if (!existing) { console.log(`Probe mode: OFF${statuslineNudge()}`); process.exit(0); }
  const rounds = normalizeRounds(existing);
  const next = PHASE_HINT[existing.phase] || '';
  console.log(`Probe mode: ${existing.phase} (round ${existing.round || rounds.length || 1})
Sandbox:  ${existing.sandbox}
Project:  ${existing.cwd}
Started:  ${existing.startedAt}
Rounds:`);
  if (rounds.length) {
    rounds.forEach((r) => console.log(fmtRound(r, refExists(roundRef(sid, r.n)) ? 'ok' : '!!')));
  } else {
    console.log('  none (not a git repository — restore is unavailable)');
  }
  if (existing.undo) console.log(`Undo point: ${String(existing.undo.ref).slice(0, 12)} (${existing.undo.at})`);
  console.log(`\n${next}${statuslineNudge()}`);
}
