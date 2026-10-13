// Host-agnostic git snapshot / restore for probe-mode.
//
// A snapshot commits the current working tree (including untracked files)
// through a THROWAWAY index, so the real index and worktree are never touched,
// and pins the commit to `refs/probe/<session>[-rN]` so `git gc` cannot collect
// it. That ref is what `/probe restore` rewinds to — the snapshot, not the
// shell deny-list, is the real backstop for "nothing outside the sandbox
// changed".
//
// On an unborn branch (a repo with no commits yet) the snapshot is a parentless
// commit and its `head` is null; restoring it takes the branch back to an empty
// history.
//
// Restore previews first and changes nothing until `force`. Before applying it
// snapshots where we are (to `refs/probe/<session>-undo`) and stashes any
// current changes, so the restore itself is undoable.
//
// Output strings are supplied by the caller (`wording`) because each host
// names its own command; the defaults are Claude Code's original wording, so a
// Claude install prints exactly what it printed before this module existed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { writeState, normalizeRounds, roundRef, undoRef } from './state.mjs';

const git = (cwd, args, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

export const isRepo = (cwd) => {
  try { return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
};

export const refExists = (cwd, ref) => {
  try { git(cwd, ['rev-parse', '--verify', '--quiet', ref]); return true; } catch { return false; }
};

/** The commit HEAD points at, or null on an unborn branch (no commits yet). */
const headOf = (cwd) => {
  try { return git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); } catch { return null; }
};

/** The ref HEAD is attached to (also on an unborn branch), or null when detached. */
const symbolicHead = (cwd) => {
  try { return git(cwd, ['symbolic-ref', '-q', 'HEAD']); } catch { return null; }
};

/** Short label for a snapshot's HEAD, which is null on an unborn branch. */
const headLabel = (head) => (head ? head.slice(0, 12) : 'an empty history (no commits)');

/**
 * Commit the current working tree (including untracked files) without touching
 * the real index or worktree, and pin it to `ref` so gc cannot collect it.
 * Returns null in a non-git directory — the caller reports "no snapshot".
 */
export function snapshot({ cwd, sessionId, ref }) {
  if (!isRepo(cwd)) return null;
  const head = headOf(cwd);
  const sym = symbolicHead(cwd);
  const branch = sym ? sym.replace(/^refs\/heads\//, '') : 'HEAD';
  const idx = path.join(os.tmpdir(), `probe-index-${sessionId}-${Date.now()}`);
  try { fs.unlinkSync(idx); } catch {}
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    git(cwd, head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
    git(cwd, ['add', '-A'], { env });
    const tree = git(cwd, ['write-tree'], { env });
    const parent = head ? ['-p', head] : [];
    const commit = git(cwd, ['commit-tree', tree, ...parent, '-m', `probe snapshot ${sessionId} ${ref}`]);
    git(cwd, ['update-ref', ref, commit]); // pin against gc
    return { head, branch, ref: commit, at: new Date().toISOString() };
  } finally {
    try { fs.unlinkSync(idx); } catch {}
  }
}

/**
 * snapshot() that never throws, so arming never depends on it. Returns
 * `{ snap, error }`; `snap` null with no error means "not a git repository".
 */
export function trySnapshot(opts) {
  try {
    return { snap: snapshot(opts), error: null };
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).split('\n').map((l) => l.trim()).find(Boolean);
    return { snap: null, error: msg || 'unknown error' };
  }
}

/** Resolve which snapshot a restore should target, from the CLI flags. */
export function resolveTarget({ state, argv }) {
  const rounds = normalizeRounds(state);
  if (!rounds.length) {
    return { error: state.snapshotError
      ? `No snapshot: snapshotting failed when probe mode started (${state.snapshotError}). Nothing to restore.`
      : 'No snapshot: this directory is not a git repository. Nothing to restore.' };
  }

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

export const fmtRound = (sessionId, r, mark) =>
  `  ${mark} round ${r.n}  ${r.at}  ${String(r.ref || '').slice(0, 12)}  (${roundRef(sessionId, r.n)})`;

/** Claude Code's original wording; OpenCode passes its own command names. */
export const CLAUDE_WORDING = {
  undoSaved: 'Undo point saved — reverse this with: probe-ctl.mjs restore --undo --force',
  reversible: 'and `probe-ctl.mjs restore --undo` puts it back. Changes are also stashed.',
  confirm: 'Ask the user to confirm, then re-run the same command with --force',
};

/**
 * Restore the working tree to a target snapshot.
 * With `force === false` this returns a preview and changes nothing at all.
 * With `force === true` it snapshots the current state first (undo point),
 * stashes any current changes, then resets the branch and worktree.
 */
export function restore({ cwd, sessionId, stateDir, state, argv, force, wording = {} }) {
  const words = { ...CLAUDE_WORDING, ...wording };
  const target = resolveTarget({ state, argv });
  if (target.error) return { text: target.error, changed: false };

  const snap = target.snap;
  const rounds = normalizeRounds(state);
  // A snapshot taken before the first commit has no head: going back to it
  // empties the branch, so every commit on it is rolled back. That branch is
  // the one HEAD is on now, or the snapshot's own if HEAD has been detached.
  const emptyRef = snap.head ? null : (symbolicHead(cwd) || `refs/heads/${snap.branch}`);
  const commits = (() => {
    const range = snap.head ? `${snap.head}..HEAD` : emptyRef;
    if (!snap.head && !refExists(cwd, emptyRef)) return [];
    try { return git(cwd, ['log', '--oneline', range]).split('\n').filter(Boolean); }
    catch { return []; }
  })();
  const changed = (() => {
    try { return git(cwd, ['diff', '--stat', snap.ref]).split('\n').filter(Boolean); }
    catch { return []; }
  })();
  const branch = (() => { const s = symbolicHead(cwd); return s ? s.replace(/^refs\/heads\//, '') : 'HEAD'; })();

  if (!force) {
    const out = ['RESTORE PREVIEW — nothing has been changed yet.', ''];
    out.push(`Target: ${target.label}`);
    out.push(`  HEAD would go from ${branch} back to ${headLabel(snap.head)} on ${snap.branch}`);
    out.push('');
    if (!target.isUndo && rounds.length > 1) {
      out.push('Rounds in this session:');
      rounds.forEach((r) => out.push(fmtRound(sessionId, r, r.n === target.round ? '->' : '  ')));
      out.push('  Use --round N for a specific round, or --all for the very beginning.');
      out.push('');
    }
    if (commits.length) {
      out.push(snap.head
        ? `${commits.length} commit(s) WOULD BE ROLLED BACK:`
        : `${commits.length} commit(s) WOULD BE ROLLED BACK — the snapshot predates the first commit, so ${emptyRef.replace(/^refs\/heads\//, '')} goes back to an empty history:`);
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
    out.push(words.reversible);
    out.push(words.confirm);
    return { text: out.join('\n'), changed: false };
  }

  const lines = [];

  // Snapshot where we are now, so the restore itself can be undone.
  const undo = snapshot({ cwd, sessionId, ref: undoRef(sessionId) });
  if (undo) {
    state.undo = undo;
    lines.push(words.undoSaved);
  }
  if (git(cwd, ['status', '--porcelain']).length > 0) {
    if (headOf(cwd)) {
      git(cwd, ['stash', 'push', '-u', '-m', `probe-discard ${new Date().toISOString()}`]);
      lines.push('Current changes also stashed (git stash list).');
    } else {
      // No commit to stash against. Clear what `stash -u` would have taken
      // (untracked, not ignored); the undo point above already holds it.
      git(cwd, ['clean', '-fdq']);
    }
  }

  if (snap.head) {
    git(cwd, ['reset', '--hard', snap.head]);         // branch tip back where it was
  } else {
    git(cwd, ['symbolic-ref', 'HEAD', emptyRef]);     // attach (no-op unless detached)
    if (refExists(cwd, emptyRef)) git(cwd, ['update-ref', '-d', emptyRef]); // unborn again
  }
  git(cwd, ['read-tree', '-u', '--reset', snap.ref]); // worktree + index == snapshot
  git(cwd, ['reset', '--quiet']);                     // unstage, keep worktree

  writeState(stateDir, sessionId, state);
  lines.push(`Restored to ${target.label}.`);
  lines.push(`HEAD: ${headLabel(snap.head)} on ${snap.branch}`);
  if (commits.length) lines.push(`${commits.length} commit(s) rolled back — also in git reflog.`);
  lines.push(`Sandbox kept at ${state.sandbox} — delete it yourself if you want it gone.`);
  return { text: lines.join('\n'), changed: true };
}
