#!/usr/bin/env node
// probe-ctl: start / status / implement / restore / stop
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
  STATE_DIR, readState, writeState, normalizeRounds, roundRef, undoRef,
} from './probe-lib.mjs';

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
    console.log(`PROBE MODE ON (round 1, phase: probe)
Sandbox (only writable path): ${sandbox}
Project: ${cwd}
Snapshot: ${snap ? `${snap.ref.slice(0, 12)} (restorable via /probe restore)` : 'NONE — not a git repository, so /probe restore cannot roll anything back'}
Writes outside the sandbox are denied by hook until a plan is approved.`);
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
  console.log('Probe mode OFF. Snapshots kept; /probe restore still works this session.');
} else {
  if (!existing) { console.log('Probe mode: OFF'); process.exit(0); }
  const rounds = normalizeRounds(existing);
  const next = {
    probe: 'Investigating. Say `/probe implement` when you want a plan.',
    planning: 'Plan not approved yet. Writes stay blocked until ExitPlanMode is approved.',
    implementing: 'Writes unlocked. `/probe <question>` starts another research round; `/probe restore` rewinds.',
    off: 'Disarmed. `/probe <question>` arms a new round.',
  }[existing.phase] || '';
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
  console.log(`\n${next}`);
}
