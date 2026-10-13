#!/usr/bin/env node
// probe-ctl: start / status / implement / restore / stop / setup
//
// Rounds: the loop is research -> plan -> implement, then either keep executing
// or start another research round. Each round takes its own snapshot pinned to
// its own git ref, so going back to research never destroys an earlier restore
// point. Round 1 keeps the original flat ref name for backward compatibility.
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_DIR, STATE_DIR, inspectState, denialSummary, writeState, normalizeRounds, roundRef, CMD,
  parseRefreshFlag, DEFAULT_REFRESH_INTERVAL, MIN_REFRESH_INTERVAL, MAX_REFRESH_INTERVAL,
} from './probe-lib.mjs';
import {
  trySnapshot, diffSince, listRounds, pruneRounds, restore as gitRestore, refExists as gitRefExists, CLAUDE_WORDING,
} from '../shared/git.mjs';
import { checkReport } from '../shared/shell.mjs';

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

const refExists = (ref) => gitRefExists(cwd, ref);

/** Snapshot the working tree (incl. untracked) onto `ref`. Never throws:
 *  `{ snap, error }`, with `snap` null outside a repo or when it failed. */
const snapshot = (ref) => trySnapshot({ cwd, sessionId: sid, ref });

/** What to print when a round has no restore point. */
const noSnapshot = (error) => error
  ? `NONE — snapshot failed (${error}), so ${CMD} restore cannot roll this round back`
  : `NONE — not a git repository, so ${CMD} restore cannot roll anything back`;

const fmtRound = (r, mark) =>
  `  ${mark} round ${r.n}  ${r.at}  ${String(r.ref || '').slice(0, 12)}  (${roundRef(sid, r.n)})`;

/** Preview (or, with --force, apply) a restore. All git mechanics live in
 *  shared/git.mjs; this stays Claude-specific only in its wording. */
function restore(state, force) {
  return gitRestore({
    cwd, sessionId: sid, stateDir: STATE_DIR, state, argv, force, wording: CLAUDE_WORDING,
  }).text;
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
function setupStatusline(argv) {
  // Validate BEFORE any filesystem side effect — this function otherwise mkdirs,
  // copies the statusline and writes a settings backup before it could fail.
  const flag = parseRefreshFlag(argv);
  if (flag.error) {
    console.log(`${flag.error}\nNothing was changed.`);
    process.exitCode = 1;
    return;
  }

  if (CMD === '/probe') {
    console.log('Standalone install — install.sh already wired up the status line; nothing to do here.'
      + (flag.value ? `\nTo change the refresh interval, re-run: ./install.sh --refresh=${flag.value}` : ''));
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

  // An ours-but-customized interval is a different case from a foreign statusLine.
  // setup is advertised as safe to re-run, and `status` actively nudges you to re-run
  // it after every plugin update — so clobbering a deliberate 30 back to the default
  // on every update would be user-hostile. An explicit --refresh always wins;
  // otherwise an existing valid value is preserved and the new default only offered.
  const prev = Number(settings.statusLine && settings.statusLine.refreshInterval);
  const kept = Number.isInteger(prev)
    && prev >= MIN_REFRESH_INTERVAL && prev <= MAX_REFRESH_INTERVAL
    && prev !== DEFAULT_REFRESH_INTERVAL ? prev : null;
  const refreshInterval = flag.value ?? kept ?? DEFAULT_REFRESH_INTERVAL;

  settings.statusLine = { type: 'command', command, padding: 0, refreshInterval };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`Status line wired up.
Copied the current probe-statusline.mjs to: ${statuslineStable}
${existed ? 'Backed up your previous settings.json first.' : 'Created settings.json.'}
${flag.value
    ? `Refresh interval: ${refreshInterval}s (from --refresh).`
    : kept
      ? `Kept your existing refresh interval of ${kept}s. The default is now ${DEFAULT_REFRESH_INTERVAL}s — pass --refresh=${DEFAULT_REFRESH_INTERVAL} to adopt it.`
      : `Refresh interval: ${refreshInterval}s. Every tick spawns a process (four of them on Windows), so raise it with --refresh=N if you mind the churn, or lower it for a snappier row.`}
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

const inspected = inspectState(sid);
const existing = inspected.status === 'ok' ? inspected.state : null;
const stopIntentFile = path.join(STATE_DIR, `${sid}.stop-intent`);

/** The first round number at or after `n` whose ref is free, so a snapshot can
 *  never overwrite an existing restore point (e.g. after a lost state file). */
const freeRound = (n) => {
  let k = Math.max(1, n);
  while (refExists(roundRef(sid, k))) k++;
  return k;
};

// The guard denies everything while the state file is unusable, so ctl must say
// so instead of reporting "off", and `stop` is the way out.
if (inspected.status === 'unreadable' && cmd !== 'setup') {
  if (cmd === 'stop') {
    writeState(sid, {
      phase: 'off', cwd, startedAt: new Date().toISOString(), rounds: [], snapshot: null,
      recovered: `state file was unreadable (${inspected.error})`,
    });
    try { fs.unlinkSync(stopIntentFile); } catch {}
    console.log(`Probe mode OFF. The state file was unreadable (${inspected.error}) and has been reset.
Earlier snapshots are still in git as refs/probe/${sid}* — inspect them with:
  git for-each-ref refs/probe/${sid}*`);
  } else {
    console.log(`Probe mode: STATE FILE UNREADABLE (${inspected.error})
Writes stay blocked while it is. The user can run ${CMD} stop to reset it; earlier
snapshots stay in git as refs/probe/${sid}*.`);
  }
  process.exit(0);
}

if (cmd === 'start') {
  const sandbox = path.join(STATE_DIR, sid, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });

  if (!existing) {
    // Arm even if the snapshot failed: writes must be blocked either way.
    const n = freeRound(1);
    const { snap, error } = snapshot(roundRef(sid, n));
    writeState(sid, {
      phase: 'probe', sandbox, cwd, startedAt: new Date().toISOString(),
      snapshot: n === 1 ? snap : null, round: n, ...(error ? { snapshotError: error } : {}),
      rounds: snap ? [{ n, at: snap.at, ref: snap.ref, head: snap.head, branch: snap.branch }] : [],
    });
    const snapLine = snap ? `${snap.ref.slice(0, 12)} (restorable via ${CMD} restore)` : noSnapshot(error);
    console.log(`PROBE MODE ON (round ${n}, phase: probe)
Sandbox (only writable path): ${sandbox}
Project: ${cwd}
Snapshot: ${snapLine}
Writes outside the sandbox are denied by hook until a plan is approved.`);
    console.log(`\n${PHASE_HINT.probe}`);
  } else {
    // Already armed: begin a NEW round. Earlier snapshots are never overwritten.
    const rounds = normalizeRounds(existing);
    // A round without a snapshot still counts, and an existing ref is never reused.
    const n = freeRound(Math.max(rounds[rounds.length - 1]?.n || 0, existing.round || 0) + 1);
    const { snap, error } = snapshot(roundRef(sid, n));
    const was = existing.phase;
    existing.phase = 'probe';
    existing.round = n;
    existing.rounds = snap
      ? [...rounds, { n, at: snap.at, ref: snap.ref, head: snap.head, branch: snap.branch }]
      : rounds;
    existing.sandbox = sandbox;
    if (error) existing.snapshotError = error; else delete existing.snapshotError;
    writeState(sid, existing);
    console.log(`NEW RESEARCH ROUND ${n} (was: ${was}, now phase: probe)
Sandbox (only writable path): ${sandbox}
Project: ${cwd}
Snapshot: ${snap ? `${snap.ref.slice(0, 12)} pinned at ${roundRef(sid, n)}` : noSnapshot(error)}
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
  if (existing) { existing.phase = 'off'; delete existing.stopIntent; writeState(sid, existing); }
  try { fs.unlinkSync(stopIntentFile); } catch {}
  console.log(`Probe mode OFF. Snapshots kept; ${CMD} restore still works this session.`);
} else if (cmd === 'rounds') {
  if (!existing) { console.log('Probe mode is not active for this session.'); process.exit(0); }
  console.log(argv[0] === 'prune'
    ? pruneRounds({ cwd, sessionId: sid, stateDir: STATE_DIR, state: existing, force: argv.includes('--force') })
    : listRounds({ cwd, sessionId: sid, state: existing }));
} else if (cmd === 'diff') {
  if (!existing) { console.log('Probe mode is not active for this session; no snapshot to compare against.'); process.exit(0); }
  console.log(diffSince({ cwd, sessionId: sid, state: existing, argv }));
} else if (cmd === 'check') {
  const shellFlag = argv.find((a) => a.startsWith('--shell='));
  const shell = shellFlag && /^--shell=(powershell|pwsh)$/i.test(shellFlag) ? 'powershell' : 'bash';
  const command = argv.filter((a) => a !== shellFlag).join(' ');
  const roots = existing ? [existing.sandbox, path.join(existing.cwd || cwd, '.probe-sandbox')] : [];
  if (!existing) console.log('Probe mode is not active, so nothing is blocked. As if it were:');
  console.log(checkReport(command, { cwd, roots, shell, phase: existing ? existing.phase : 'probe' }));
} else if (cmd === 'setup') {
  setupStatusline(argv);
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
    console.log(existing.snapshotError
      ? `  none (snapshot failed: ${existing.snapshotError} — restore is unavailable)`
      : '  none (not a git repository — restore is unavailable)');
  }
  if (existing.undo) console.log(`Undo point: ${String(existing.undo.ref).slice(0, 12)} (${existing.undo.at})`);
  console.log(denialSummary(sid));
  console.log(`\n${next}${statuslineNudge()}`);
}
