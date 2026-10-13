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
 * The working tree (tracked + untracked, not ignored) as a tree object, built
 * through a throwaway index so the real index and worktree are never touched.
 */
function worktreeTree(cwd, sessionId, head) {
  const idx = path.join(os.tmpdir(), `probe-index-${sessionId}-${process.pid}-${Date.now()}`);
  try { fs.unlinkSync(idx); } catch {}
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    git(cwd, head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
    git(cwd, ['add', '-A'], { env });
    return git(cwd, ['write-tree'], { env });
  } finally {
    try { fs.unlinkSync(idx); } catch {}
  }
}

/** Tree of what is staged right now, or null when nothing is (or it is unmerged). */
function stagedTree(cwd, head) {
  try {
    const tree = git(cwd, ['write-tree']);
    const base = head ? git(cwd, ['rev-parse', `${head}^{tree}`]) : EMPTY_TREE;
    return tree === base ? null : tree;
  } catch {
    return null;
  }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const INDEX_MARK = 'probe index';

/**
 * Commit the current working tree (including untracked files) without touching
 * the real index or worktree, and pin it to `ref` so gc cannot collect it.
 * Returns null in a non-git directory — the caller reports "no snapshot".
 *
 * When something is staged, the staged tree rides along as an extra parent
 * commit ("probe index …"), so restore can put the index back exactly as it was
 * and gc cannot collect it. With nothing staged the topology is unchanged.
 */
export function snapshot({ cwd, sessionId, ref }) {
  if (!isRepo(cwd)) return null;
  const head = headOf(cwd);
  const sym = symbolicHead(cwd);
  const branch = sym ? sym.replace(/^refs\/heads\//, '') : 'HEAD';
  const tree = worktreeTree(cwd, sessionId, head);
  const parents = head ? ['-p', head] : [];
  const staged = stagedTree(cwd, head);
  if (staged) {
    const indexCommit = git(cwd, ['commit-tree', staged, ...(head ? ['-p', head] : []), '-m', `${INDEX_MARK} ${sessionId} ${ref}`]);
    parents.push('-p', indexCommit);
  }
  const commit = git(cwd, ['commit-tree', tree, ...parents, '-m', `probe snapshot ${sessionId} ${ref}`]);
  git(cwd, ['update-ref', ref, commit]); // pin against gc
  return { head, branch, ref: commit, at: new Date().toISOString() };
}

/** The staged tree a snapshot recorded, or null when nothing was staged. */
function recordedIndex(cwd, snapRef) {
  try {
    const parents = git(cwd, ['rev-list', '--parents', '-n1', snapRef]).split(' ').slice(1);
    for (const p of parents) {
      if (git(cwd, ['log', '-1', '--format=%s', p]).startsWith(INDEX_MARK)) return git(cwd, ['rev-parse', `${p}^{tree}`]);
    }
  } catch {}
  return null;
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
  reversible: 'and `probe-ctl.mjs restore --undo` puts it back.',
  confirm: 'Ask the user to confirm, then re-run the same command with --force',
};

/**
 * Restore the working tree to a target snapshot.
 * With `force === false` this returns a preview and changes nothing at all.
 * With `force === true` it snapshots the current state first (undo point),
 * then resets the branch, worktree and index to the snapshot.
 *
 * It always acts on the repository the session was armed in (`state.cwd`),
 * never on wherever the caller happens to be, and only on the branch the
 * snapshot was taken on — moving some other branch back would silently drop
 * commits the snapshot knows nothing about.
 */
export function restore({ cwd, sessionId, stateDir, state, argv, force, wording = {} }) {
  const words = { ...CLAUDE_WORDING, ...wording };
  const target = resolveTarget({ state, argv });
  if (target.error) return { text: target.error, changed: false };
  const snap = target.snap;
  const refuse = (why) => ({ text: `${why}\nNothing was changed.`, changed: false });

  const armed = state.cwd || cwd;
  if (!fs.existsSync(armed) || !isRepo(armed)) {
    return refuse(`The project this session was armed in (${armed}) is gone or no longer a git repository.`);
  }
  const top = git(armed, ['rev-parse', '--show-toplevel']);
  const has = (rev) => { try { git(top, ['cat-file', '-e', `${rev}^{commit}`]); return true; } catch { return false; } };
  if (!has(snap.ref) || (snap.head && !has(snap.head))) {
    return refuse(`Snapshot ${String(snap.ref).slice(0, 12)} is not in the repository at ${top}.`);
  }

  const sym = symbolicHead(top);
  const current = sym ? sym.replace(/^refs\/heads\//, '') : 'HEAD';
  if (current !== snap.branch) {
    const where = snap.branch === 'HEAD' ? `a detached HEAD at ${headLabel(snap.head)}` : `branch ${snap.branch}`;
    const fix = snap.branch === 'HEAD' ? `git switch --detach ${headLabel(snap.head)}` : `git switch ${snap.branch}`;
    return refuse(
      `This snapshot was taken on ${where}, but ${current === 'HEAD' ? 'HEAD is detached' : `you are on ${current}`} now.\n` +
      `Restoring here would move the wrong branch. Switch back first (${fix}), then restore again.`,
    );
  }

  const rounds = normalizeRounds(state);
  // A snapshot taken before the first commit has no head: going back to it
  // empties the branch, so every commit on it is rolled back.
  const emptyRef = snap.head ? null : `refs/heads/${snap.branch}`;
  const commits = (() => {
    if (!snap.head && !refExists(top, emptyRef)) return [];
    try { return git(top, ['log', '--oneline', snap.head ? `${snap.head}..HEAD` : emptyRef]).split('\n').filter(Boolean); }
    catch { return []; }
  })();

  if (!force) {
    // Diff against the whole current tree, untracked files included: those are
    // what the restore removes (the undo point keeps them).
    const changed = (() => {
      try { return git(top, ['diff', '--stat', snap.ref, worktreeTree(top, sessionId, headOf(top))]).split('\n').filter(Boolean); }
      catch { return []; }
    })();
    const out = ['RESTORE PREVIEW — nothing has been changed yet.', ''];
    out.push(`Repository: ${top}`);
    out.push(`Target: ${target.label}`);
    out.push(`  ${current} would go back to ${headLabel(snap.head)}`);
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
        : `${commits.length} commit(s) WOULD BE ROLLED BACK — the snapshot predates the first commit, so ${snap.branch} goes back to an empty history:`);
      commits.forEach((c) => out.push(`  ${c}`));
    } else {
      out.push('No commits would be rolled back.');
    }
    out.push('');
    if (changed.length) {
      out.push('Working tree changes that would be undone (untracked files included):');
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

  // Snapshot where we are now, so the restore itself can be undone. If that
  // fails, stop before anything is touched.
  let undo;
  try {
    undo = snapshot({ cwd: top, sessionId, ref: undoRef(sessionId) });
  } catch (err) {
    return refuse(`Could not save an undo point (${String(err?.stderr || err?.message || err).trim().split('\n')[0]}).`);
  }
  state.undo = undo;
  // Persist the undo point before touching anything, so a restore that fails
  // halfway can still be reversed.
  writeState(stateDir, sessionId, state);
  lines.push(words.undoSaved);

  // Untracked files the snapshot may not have: the undo point above holds them.
  // A path git cannot remove (a directory some process is standing in, on
  // Windows) is reported, not fatal.
  try {
    git(top, ['clean', '-fdq']);
  } catch (err) {
    const left = String(err?.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (left.length) lines.push(`Could not remove (left in place): ${left.join('; ')}`);
  }
  try {
    if (snap.head) {
      git(top, ['reset', '--hard', '--quiet', snap.head]);  // branch tip back where it was
    } else if (refExists(top, emptyRef)) {
      git(top, ['update-ref', '-d', emptyRef]);              // unborn again
    }
    git(top, ['read-tree', '-u', '--reset', snap.ref]);     // worktree + index == snapshot
    const index = recordedIndex(top, snap.ref);
    if (index) git(top, ['read-tree', index]);              // staged state as it was
    else git(top, ['reset', '--quiet']);                     // nothing was staged
  } catch (err) {
    lines.push(`Restore FAILED partway: ${String(err?.stderr || err?.message || err).trim().split('\n')[0]}`);
    lines.push(`Put everything back with: ${words.undoSaved.replace(/^.*?:\s*/, '')}`);
    return { text: lines.join('\n'), changed: true };
  }
  lines.push(`Restored to ${target.label}.`);
  lines.push(`${current} is at ${headLabel(snap.head)} in ${top}`);
  if (commits.length) lines.push(`${commits.length} commit(s) rolled back — also in git reflog.`);
  lines.push(`Sandbox kept at ${state.sandbox} — delete it yourself if you want it gone.`);
  return { text: lines.join('\n'), changed: true };
}

/**
 * What changed since a round's snapshot: committed and uncommitted work, with
 * untracked files included. Read-only — the comparison tree is built through a
 * throwaway index. Same targeting flags as restore (--round N, --all, --undo).
 */
export function diffSince({ cwd, sessionId, state, argv }) {
  const target = resolveTarget({ state, argv });
  if (target.error) return target.error;
  const repo = state.cwd || cwd;
  if (!fs.existsSync(repo) || !isRepo(repo)) return `The project this session was armed in (${repo}) is gone or no longer a git repository.`;
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  try { git(top, ['cat-file', '-e', `${target.snap.ref}^{commit}`]); }
  catch { return `Snapshot ${String(target.snap.ref).slice(0, 12)} is not in the repository at ${top}.`; }

  const now = worktreeTree(top, sessionId, headOf(top));
  const mode = argv.includes('--patch') ? ['--patch', '--stat'] : ['--stat'];
  const out = git(top, ['diff', ...mode, '--no-color', target.snap.ref, now]);
  const commits = target.snap.head
    ? (() => { try { return git(top, ['log', '--oneline', `${target.snap.head}..HEAD`]); } catch { return ''; } })()
    : (() => { try { return git(top, ['log', '--oneline', 'HEAD']); } catch { return ''; } })();
  const lines = [`Changes since ${target.label} (${String(target.snap.ref).slice(0, 12)}), untracked files included:`, ''];
  lines.push(out || 'No changes.');
  if (commits) lines.push('', 'Commits since then:', ...commits.split('\n').map((c) => `  ${c}`));
  if (!argv.includes('--patch') && out) lines.push('', 'Add --patch for the full diff.');
  return lines.join('\n');
}
