// Host-agnostic shell analysis: does this command mutate state outside the
// writable roots?
//
// This is a faithful port of the shell branch of Claude Code's guard
// (hooks/probe-guard.mjs), which stays self-contained on purpose and keeps its
// own copy — an import that failed to parse would let writes through. The two
// are kept honest by test/rules.test.mjs, which drives the REAL guard and this
// module over the same command matrix and fails if they disagree.
//
// Why port instead of share outright: OpenCode hands us a command already
// split into per-segment resources by its shell scanner, while Claude hands us
// the raw command string. Both end up in the same place — judge each segment
// on its own, carrying `cd` between them — so the analysis lives here as
// `analyzeSegments(segments, roots)` and the guard keeps inlining the version
// that splits raw text itself.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BACKSLASH = String.fromCharCode(92);

const unquote = (t) => t.replace(/^["']|["']$/g, '');

/**
 * Split a raw command on `;`, `&&`, `||`, `|`, `&` and newlines, respecting
 * quotes. OpenCode's scanner already does this job, so its callers pass the
 * segments straight in; Claude callers use this to get there.
 */
export function splitSegments(s) {
  const parts = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '\n') { parts.push(cur); cur = ''; continue; }
    if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) {
      parts.push(cur); cur = ''; i++; continue;
    }
    if (c === '|' || c === '&') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.filter((p) => p.trim());
}

/** Heredoc bodies are data, not paths. Drop them before anything else. */
export const stripHeredocs = (s) =>
  s.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?^\s*\2\s*$/gm, '<<HEREDOC');

const HOME = os.homedir().split(BACKSLASH).join('/');
/** `~` only where a shell would expand it: start, or after a separator/quote. */
export const expandTilde = (s) => s.replace(/(^|[\s"'=:>])~(?=[/\\]|$)/g, `$1${HOME}`);

/** Variables assigned earlier in the SAME command, e.g. `SB=/x; echo > "$SB/y"`. */
export function collectVars(s) {
  const vars = {};
  for (const m of s.matchAll(/(?:^|[;&|\n]|\s)([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]*))/g)) {
    vars[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return vars;
}

export function expandVars(s, vars) {
  return s.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (full, a, b) => {
    const k = a || b;
    return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : full;
  });
}

/** Tokenize one segment, keeping a quoted string as a SINGLE token so that
 *  `echo "test state cleaned"` cannot yield a bare `test` that matches a
 *  real directory. */
export function tokensOf(seg) {
  const out = [];
  let cur = '';
  let q = null;
  let had = false;
  for (const c of seg) {
    if (q) { if (c === q) { q = null; } else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; had = true; continue; }
    if (/\s/.test(c)) { if (cur || had) out.push(cur); cur = ''; had = false; continue; }
    cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}

/** A token counts as a path only if it exists on disk, or it carries a separator
 *  and its parent exists. Without the separator clause, bare words like `mkdir`
 *  resolve against cwd and look like paths; with it, `sed`'s `s/a/b/` still does
 *  not, because no `s/a` directory exists. */
export function looksLikePath(tok, base) {
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
}

export function redirectTargets(seg) {
  const out = [];
  for (const m of seg.matchAll(/(?<![0-9&])>>?\s*("[^"]*"|'[^']*'|[^\s|;&<>]+)/g)) out.push(unquote(m[1]));
  for (const m of seg.matchAll(/\btee\s+(?:-a\s+)?("[^"]*"|'[^']*'|[^\s|;&<>]+)/g)) out.push(unquote(m[1]));
  return out;
}

/** The mutating verbs probe mode blocks, exactly as Claude's guard spells
 *  them. Kept as one list so test/rules.test.mjs can assert the guard still
 *  agrees with this copy. */
export const MUTATORS = [
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
  /\bbundle\s+(install|update|add|remove)\b/,
  /\bcomposer\s+(install|update|require|remove)\b/,
  /\bmvn\s+(install|deploy)\b/, /\bgradle\s+(publish|publishToMavenLocal)\b/,
  /\bgem\s+(install|uninstall)\b/, /\bapt(-get)?\s+(install|remove|purge|upgrade)\b/,
  /\b(brew|choco|winget|scoop)\s+(install|uninstall|remove|upgrade)\b/,
  /\bmake\s+(install|uninstall|clean|distclean)\b/,
  // Database migrations. Unambiguously state-changing and often irreversible.
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
  // Downloads write files. wget writes by default; curl needs -o/-O.
  /\bwget\b/, /\bcurl\b[^|;&]*\s-[oO]\b/,
];

/** Prepare a raw command the way the guard does: heredocs dropped, same-command
 *  variables and `~` expanded. */
export function prepare(rawCommand) {
  const pre = stripHeredocs(String(rawCommand));
  return expandVars(expandTilde(pre), collectVars(pre));
}

/**
 * Judge already-split segments in order, carrying `cd` between them.
 *
 * @param {string[]} segments   one entry per command segment, in order
 * @param {object}   options
 * @param {string}   options.cwd        where relative paths resolve
 * @param {string[]} options.roots      directories that may be written
 * @returns {{sawMutation: boolean, offenders: string[], unresolved: string[]}}
 *          `offenders` are resolved targets outside every root;
 *          `unresolved` are mutating segments whose target could not be pinned
 *          down. Either non-empty means DENY — never guess an allow.
 */
export function analyzeSegments(segments, { cwd, roots }) {
  const norm = (p) => path.resolve(p).split(BACKSLASH).join('/').toLowerCase();
  const rootSet = roots.filter(Boolean).map(norm);

  const within = (target, list) => {
    if (!target) return false;
    const t = norm(path.isAbsolute(target) ? target : path.join(cwd || '.', target));
    return list.some((r) => t === r || t.startsWith(r + '/'));
  };

  let base = cwd || process.cwd();
  const offenders = [];
  const unresolved = [];
  let sawMutation = false;

  for (const seg of segments) {
    // `cd` changes where every LATER segment resolves. Dropping this would let
    // `cd <sandbox> && rm -rf ../../project` escape.
    const cdOnly = seg.trim().match(/^cd\s*(?:"([^"]*)"|'([^']*)'|(\S+))?$/);
    if (cdOnly) {
      const t = cdOnly[1] ?? cdOnly[2] ?? cdOnly[3];
      base = t ? path.resolve(base, unquote(t)) : os.homedir();
      continue;
    }

    const redirs = redirectTargets(seg);
    const mutator = MUTATORS.find((re) => re.test(seg));
    if (!mutator && redirs.length === 0) continue;
    sawMutation = true;

    const targets = [...redirs, ...tokensOf(seg).filter((t) => looksLikePath(t, base))];
    if (targets.length === 0) { unresolved.push(seg.trim()); continue; }

    for (const t of targets) {
      // A variable we could not expand means we cannot know where this lands.
      if (t.includes('$')) { unresolved.push(`${seg.trim()} (unexpanded variable)`); continue; }
      const abs = path.resolve(base, unquote(t));
      if (!within(abs, rootSet)) offenders.push(abs);
    }
  }

  return { sawMutation, offenders: [...new Set(offenders)], unresolved };
}

/** The guard's shell verdict in one call: `null` means pass, a reason means deny. */
export function analyzeCommand(rawCommand, { cwd, roots }) {
  const prepared = prepare(rawCommand);
  const result = analyzeSegments(splitSegments(prepared), { cwd, roots });
  if (!result.sawMutation) return null;
  if (result.offenders.length === 0 && result.unresolved.length === 0) return null;
  return result;
}
