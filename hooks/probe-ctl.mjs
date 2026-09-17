#!/usr/bin/env node
// probe-ctl: start / status / implement / restore / stop
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { STATE_DIR, statePath, readState, writeState } from './probe-lib.mjs';

const sid = process.env.CLAUDE_CODE_SESSION_ID;
if (!sid) { console.error('CLAUDE_CODE_SESSION_ID not set; run this from inside a Claude Code session.'); process.exit(1); }

const cmd = process.argv[2] || 'status';
const cwd = process.cwd();
const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

const isRepo = () => { try { return git(['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; } };

function snapshot() {
  if (!isRepo()) return null;
  const head = git(['rev-parse', 'HEAD']);
  const branch = (() => { try { return git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return 'HEAD'; } })();
  const idx = path.join(os.tmpdir(), `probe-index-${sid}`);
  try { fs.unlinkSync(idx); } catch {}
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  git(['read-tree', 'HEAD'], { env });
  git(['add', '-A'], { env });
  const tree = git(['write-tree'], { env });
  const ref = git(['commit-tree', tree, '-p', head, '-m', `probe snapshot ${sid}`]);
  git(['update-ref', `refs/probe/${sid}`, ref]);      // pin against gc
  try { fs.unlinkSync(idx); } catch {}
  return { head, branch, ref, at: new Date().toISOString() };
}

/** What restore would throw away. Computed without touching anything. */
function restorePreview(state) {
  const snap = state.snapshot;
  const commits = (() => {
    try { return git(['log', '--oneline', `${snap.head}..HEAD`]).split('\n').filter(Boolean); }
    catch { return []; }
  })();
  const changed = (() => {
    try { return git(['diff', '--stat', snap.ref]).split('\n').filter(Boolean); }
    catch { return []; }
  })();
  const branch = (() => {
    try { return git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return snap.branch; }
  })();
  return { commits, changed, branch };
}

function restore(state, force) {
  const snap = state.snapshot;
  if (!snap) return 'No snapshot: this directory is not a git repository. Nothing was restored.';

  const { commits, changed, branch } = restorePreview(state);

  if (!force) {
    const out = [`RESTORE PREVIEW — nothing has been changed yet.`, ''];
    out.push(`Rolling back to the state at probe start (${snap.at}).`);
    out.push(`  HEAD would go from ${branch} back to ${snap.head.slice(0, 12)} on ${snap.branch}`);
    out.push('');
    if (commits.length) {
      out.push(`${commits.length} commit(s) made since probe start WOULD BE ROLLED BACK:`);
      commits.forEach((c) => out.push(`  ${c}`));
      out.push('  (recoverable afterwards via git reflog)');
    } else {
      out.push('No commits have been made since probe start.');
    }
    out.push('');
    if (changed.length) {
      out.push('Working tree changes that would be undone:');
      changed.slice(-12).forEach((c) => out.push(`  ${c}`));
    } else {
      out.push('Working tree already matches the snapshot; nothing to undo.');
    }
    out.push('');
    out.push('Uncommitted changes are stashed first as a safety net.');
    out.push('Ask the user to confirm, then re-run:  probe-ctl.mjs restore --force');
    return out.join('\n');
  }

  const lines = [];
  if (git(['status', '--porcelain']).length > 0) {
    git(['stash', 'push', '-u', '-m', `probe-discard ${new Date().toISOString()}`]);
    lines.push('Current changes stashed as a safety net (git stash list).');
  }
  git(['reset', '--hard', snap.head]);           // branch tip back where it was
  git(['read-tree', '-u', '--reset', snap.ref]); // worktree + index == snapshot
  git(['reset', '--quiet']);                     // unstage, keep worktree
  lines.push(`Working tree restored to the state at probe start (${snap.at}).`);
  lines.push(`HEAD: ${snap.head.slice(0, 12)} on ${snap.branch}`);
  if (commits.length) {
    lines.push(`${commits.length} commit(s) rolled back — recover with: git reflog`);
  }
  lines.push(`Sandbox kept at ${state.sandbox} — delete it yourself if you want it gone.`);
  return lines.join('\n');
}

const existing = readState(sid);

if (cmd === 'start') {
  const sandbox = path.join(STATE_DIR, sid, 'sandbox');
  fs.mkdirSync(sandbox, { recursive: true });
  const snap = snapshot();
  const state = { phase: 'probe', sandbox, cwd, startedAt: new Date().toISOString(), snapshot: snap };
  writeState(sid, state);
  console.log(`PROBE MODE ON (phase: probe)
Sandbox (only writable path): ${sandbox}
Project: ${cwd}
Snapshot: ${snap ? `${snap.ref.slice(0, 12)} (restorable via /probe restore)` : 'NONE — not a git repository, so /probe restore cannot roll anything back'}
Writes outside the sandbox are denied by hook until a plan is approved.`);
} else if (cmd === 'implement') {
  if (!existing) { console.log('Probe mode is not active.'); process.exit(0); }
  existing.phase = 'planning';
  writeState(sid, existing);
  console.log('Phase -> planning. Writes are STILL blocked. Call EnterPlanMode, write the plan, then ExitPlanMode for approval.');
} else if (cmd === 'restore') {
  if (!existing) { console.log('Probe mode is not active for this session; no snapshot to restore.'); process.exit(0); }
  const force = process.argv.includes('--force');
  console.log(restore(existing, force));
} else if (cmd === 'stop') {
  if (existing) { existing.phase = 'off'; writeState(sid, existing); }
  console.log('Probe mode OFF. Snapshot ref kept; /probe restore still works this session.');
} else {
  if (!existing) { console.log('Probe mode: OFF'); process.exit(0); }
  console.log(`Probe mode: ${existing.phase}
Sandbox:  ${existing.sandbox}
Project:  ${existing.cwd}
Started:  ${existing.startedAt}
Snapshot: ${existing.snapshot ? existing.snapshot.ref : 'none (not a git repo)'}`);
}
