// `export`: one markdown file with what a research round produced, written
// outside the project so it survives the sandbox's retention prune.
//
// Contents: the session's rounds and restore points, the sandbox listing, any
// findings file the model kept there (findings.md / FINDINGS.md / notes.md),
// what changed since the round's snapshot, and the denials logged so far.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRounds, readDenials } from './state.mjs';
import { diffSince } from './git.mjs';

const FINDINGS = ['findings.md', 'FINDINGS.md', 'notes.md', 'NOTES.md'];
const MAX_LISTED = 200;
const MAX_FINDINGS_BYTES = 200 * 1024;

/** Sandbox files, depth-first, relative paths with sizes; capped. */
function listing(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_LISTED) return;
      const abs = path.join(dir, e.name);
      if (e.name === '.git' || e.name === 'node_modules') { out.push(`${path.relative(root, abs)}/ (skipped)`); continue; }
      if (e.isDirectory()) walk(abs);
      else {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch {}
        out.push(`${path.relative(root, abs).split(path.sep).join('/')}  (${size} B)`);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Write the export and return its path.
 * @param {{cwd: string, sessionId: string, stateDir: string, state: object, outDir: string, argv?: string[]}} o
 */
export function exportRound({ cwd, sessionId, stateDir, state, outDir, argv = [] }) {
  const rounds = normalizeRounds(state);
  const round = state.round || (rounds.length ? rounds[rounds.length - 1].n : 1);
  const lines = [
    `# Probe findings — session ${sessionId}, round ${round}`,
    '',
    `- Project: \`${state.cwd || cwd}\``,
    `- Phase: ${state.phase}`,
    `- Started: ${state.startedAt || 'unknown'}`,
    `- Exported: ${new Date().toISOString()}`,
    '',
    '## Rounds',
    '',
  ];
  if (rounds.length) {
    lines.push('| Round | Taken | Snapshot | Branch |', '|---|---|---|---|');
    for (const r of rounds) lines.push(`| ${r.n}${r.n === round ? ' (current)' : ''} | ${r.at} | \`${String(r.ref).slice(0, 12)}\` | ${r.branch} |`);
  } else {
    lines.push(state.snapshotError ? `No snapshot (failed: ${state.snapshotError}).` : 'No snapshot (not a git repository).');
  }

  const sandbox = state.sandbox;
  const findings = sandbox ? FINDINGS.map((f) => path.join(sandbox, f)).find((f) => fs.existsSync(f)) : null;
  lines.push('', '## Findings', '');
  if (findings) {
    const text = fs.readFileSync(findings, 'utf8');
    lines.push(`From \`${path.basename(findings)}\` in the sandbox:`, '', text.length > MAX_FINDINGS_BYTES ? `${text.slice(0, MAX_FINDINGS_BYTES)}\n\n…(truncated)` : text);
  } else {
    lines.push(`No findings file in the sandbox (looked for ${FINDINGS.join(', ')}).`);
  }

  lines.push('', '## Sandbox', '', `\`${sandbox}\``, '');
  const files = sandbox && fs.existsSync(sandbox) ? listing(sandbox) : [];
  if (files.length) {
    lines.push('```', ...files, '```');
    if (files.length >= MAX_LISTED) lines.push(`(first ${MAX_LISTED} entries)`);
  } else {
    lines.push('Empty or gone.');
  }

  if (rounds.length) {
    lines.push('', '## Changes since the round started', '', '```');
    try { lines.push(diffSince({ cwd, sessionId, state, argv })); } catch (err) { lines.push(`(unavailable: ${err && err.message})`); }
    lines.push('```');
  }

  const denials = readDenials(stateDir, sessionId);
  lines.push('', `## Denials (${denials.length})`, '');
  if (denials.length) {
    lines.push('| When | Tool | What |', '|---|---|---|');
    for (const d of denials.slice(-50)) lines.push(`| ${d.at} | ${d.tool} | \`${String(d.what).replace(/\|/g, '\\|').replace(/`/g, "'").slice(0, 120)}\` |`);
    if (denials.length > 50) lines.push(`(last 50 of ${denials.length})`);
  } else {
    lines.push('None.');
  }

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${sessionId}-r${round}.md`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
