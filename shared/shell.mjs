// Host-agnostic shell analysis: does this command mutate state outside the
// writable roots?
//
// Both hosts run this module: Claude's guard (hooks/probe-guard.mjs) loads it
// with a dynamic import that denies if it fails, and OpenCode's permission hook
// imports it directly. One implementation, so the two cannot drift.
//
// How it judges a command:
//   1. lex() turns the raw text into words, operators and redirects, honouring
//      quotes, escapes, comments, heredocs (the body is data; the opener line is
//      still code) and the bash / PowerShell / cmd differences that matter.
//   2. Each simple command is classified by its COMMAND WORD — never by a regex
//      over the raw text, so `grep "rm"` or `cat src/cp.js` are reads. Wrappers
//      (sudo, env, xargs, npx, python -m, …) are peeled; `bash -c`, `pwsh
//      -Command`, `cmd /c`, `eval` and `$(…)` are analysed recursively.
//   3. A mutating command names what it writes: specific paths, the directory
//      it runs in, or state outside any directory (a global install, a deploy).
//      Paths are resolved against every directory the command could be running
//      in, through realpath of the deepest existing ancestor, so a junction or
//      symlink out of the sandbox is judged by where it really lands.
//
// The verdict never guesses an allow: a target that cannot be pinned down
// (unknown variable, `cd -`, input from xargs) is "unresolved", which denies.
// It is still a deny-list — an interpreter running inline code it cannot read
// (`python -c …`) is not caught here; the git snapshot is the real backstop.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BACKSLASH = String.fromCharCode(92);
const IS_WIN = process.platform === 'win32';
const CASE_FOLD = IS_WIN || process.platform === 'darwin';
const MAX_DEPTH = 6;

// ===================================================================== lexer
//
// A word is a list of parts so that variable expansion can happen later, in
// command order: { lit } | { var, simple } | { sub } (command substitution).

const BASH_ESCAPABLE = new Set(' \t\n"\'\\$`;&|<>(){}*?[]#~!'.split(''));

/**
 * @param {string} src
 * @param {'bash'|'powershell'|'cmd'} shell
 * @returns {Array<{t:'word', parts:object[], quoted:boolean} | {t:'op', v:string} |
 *                 {t:'redir', op:string, fd:string, target:object|null}>}
 */
export function lex(src, shell = 'bash') {
  const s = String(src);
  const out = [];
  const pwsh = shell === 'powershell';
  const bash = shell === 'bash';
  let i = 0;
  let parts = null;
  let quoted = false;
  const pendingHeredocs = [];

  const lit = (v) => {
    if (!parts) parts = [];
    const last = parts[parts.length - 1];
    if (last && last.lit !== undefined) last.lit += v; else parts.push({ lit: v });
  };
  const endWord = () => {
    if (parts) out.push({ t: 'word', parts, quoted });
    parts = null;
    quoted = false;
  };
  const wordIsFd = () => parts && parts.length === 1 && parts[0].lit !== undefined && /^\d+$/.test(parts[0].lit);

  /** Read a balanced `(…)` starting after the opening paren; returns [text, nextIndex]. */
  const balanced = (start, open = '(', close = ')') => {
    let depth = 1;
    let j = start;
    let q = null;
    while (j < s.length) {
      const c = s[j];
      if (q) {
        if (c === q) q = null;
        else if (c === BACKSLASH && q === '"') j++;
      } else if (c === '"' || c === "'") q = c;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return [s.slice(start, j), j + 1];
      j++;
    }
    return [s.slice(start), s.length];
  };

  /** `$…` at s[i]; pushes a part and returns the next index. */
  const dollar = (j, inDouble) => {
    const n = s[j + 1];
    if (n === '(' && s[j + 2] === '(') {
      const [, next] = balanced(j + 3);
      parts.push({ var: '((arith))', simple: false });
      return s[next] === ')' ? next + 1 : next;
    }
    if (n === '(') {
      const [text, next] = balanced(j + 2);
      parts.push({ sub: text, shell });
      return next;
    }
    if (n === '{') {
      const end = s.indexOf('}', j + 2);
      const body = end === -1 ? s.slice(j + 2) : s.slice(j + 2, end);
      const m = body.match(/^(?:env:)?([A-Za-z_]\w*)$/);
      if (m) parts.push({ var: m[1], env: /^env:/i.test(body), simple: true });
      else parts.push({ var: body, simple: false });
      return end === -1 ? s.length : end + 1;
    }
    if (pwsh) {
      const m = s.slice(j + 1).match(/^(env:)?([A-Za-z_][\w]*)/i);
      if (m) {
        parts.push({ var: m[2], env: Boolean(m[1]), simple: true });
        return j + 1 + m[0].length;
      }
    } else {
      const m = s.slice(j + 1).match(/^[A-Za-z_]\w*/);
      if (m) {
        parts.push({ var: m[0], simple: true });
        return j + 1 + m[0].length;
      }
      if (n && /[0-9@*#?$!-]/.test(n)) {
        parts.push({ var: n, simple: false });
        return j + 2;
      }
    }
    if (!inDouble && bash && n === "'") return j + 1; // $'…' handled by the caller
    lit('$');
    return j + 1;
  };

  const skipHeredocBodies = () => {
    // At the start of a line: consume each pending heredoc body in order.
    while (pendingHeredocs.length) {
      const { delim, tabs } = pendingHeredocs.shift();
      while (i < s.length) {
        const nl = s.indexOf('\n', i);
        const line = (nl === -1 ? s.slice(i) : s.slice(i, nl)).replace(/\r$/, '');
        i = nl === -1 ? s.length : nl + 1;
        if ((tabs ? line.replace(/^\t+/, '') : line) === delim) break;
      }
    }
  };

  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];

    // PowerShell here-strings @'…'@ / @"…"@: data, like a heredoc body.
    if (pwsh && !parts && c === '@' && (n === "'" || n === '"') && /\r?\n/.test(s.slice(i + 2, i + 4))) {
      const close = `\n${n}@`;
      const end = s.indexOf(close, i + 2);
      lit(end === -1 ? s.slice(i + 2) : s.slice(i + 2, end));
      quoted = true;
      i = end === -1 ? s.length : end + close.length;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }

    if (c === '\n') {
      endWord();
      out.push({ t: 'op', v: '\n' });
      i++;
      skipHeredocBodies();
      continue;
    }

    if (c === '#' && !parts && shell !== 'cmd') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }

    if (c === "'") {
      quoted = true;
      if (!parts) parts = [];
      let j = i + 1;
      let buf = '';
      while (j < s.length) {
        if (s[j] === "'") {
          if (pwsh && s[j + 1] === "'") { buf += "'"; j += 2; continue; }
          break;
        }
        buf += s[j++];
      }
      lit(buf);
      i = j + 1;
      continue;
    }

    if (bash && c === '$' && n === "'") {
      quoted = true;
      if (!parts) parts = [];
      let j = i + 2;
      let buf = '';
      while (j < s.length && s[j] !== "'") {
        if (s[j] === BACKSLASH && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
        buf += s[j++];
      }
      lit(buf);
      i = j + 1;
      continue;
    }

    if (c === '"') {
      quoted = true;
      if (!parts) parts = [];
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        const d = s[j];
        if (bash && d === BACKSLASH && '$`"\\\n'.includes(s[j + 1])) { lit(s[j + 1]); j += 2; continue; }
        if (pwsh && d === '`' && j + 1 < s.length) { lit(s[j + 1]); j += 2; continue; }
        if (d === '$' && shell !== 'cmd') { j = dollar(j, true); continue; }
        if (bash && d === '`') {
          const end = s.indexOf('`', j + 1);
          parts.push({ sub: end === -1 ? s.slice(j + 1) : s.slice(j + 1, end), shell });
          j = end === -1 ? s.length : end + 1;
          continue;
        }
        lit(d);
        j++;
      }
      i = j + 1;
      continue;
    }

    if (bash && c === BACKSLASH) {
      if (n === '\n') { i += 2; continue; }
      if (n !== undefined && BASH_ESCAPABLE.has(n)) { lit(n); quoted = true; i += 2; continue; }
      lit(BACKSLASH);
      i++;
      continue;
    }
    if (pwsh && c === '`') {
      if (n === '\n' || (n === '\r' && s[i + 2] === '\n')) { i += n === '\r' ? 3 : 2; continue; }
      if (n !== undefined) { lit(n); i += 2; continue; }
      i++;
      continue;
    }
    if (shell === 'cmd' && c === '^' && n !== undefined) { lit(n); i += 2; continue; }

    if (c === '$' && shell !== 'cmd') {
      if (!parts) parts = [];
      i = dollar(i, false);
      continue;
    }
    if (bash && c === '`') {
      if (!parts) parts = [];
      const end = s.indexOf('`', i + 1);
      parts.push({ sub: end === -1 ? s.slice(i + 1) : s.slice(i + 1, end), shell });
      i = end === -1 ? s.length : end + 1;
      continue;
    }

    // Process substitution <(…) / >(…): the inner command runs.
    if ((c === '<' || c === '>') && n === '(' && bash) {
      if (!parts) parts = [];
      const [text, next] = balanced(i + 2);
      parts.push({ sub: text, shell });
      i = next;
      continue;
    }

    // Redirects.
    if (c === '>' || c === '<' || (c === '&' && n === '>') || (pwsh && c === '*' && n === '>' && !parts)) {
      let fd = '';
      if (c === '&' || c === '*') { fd = 'all'; i++; }
      else if (wordIsFd()) { fd = parts[0].lit; parts = null; quoted = false; }
      else endWord();
      let op = s[i];
      i++;
      if (op === '>') {
        if (s[i] === '>') { op = '>>'; i++; } else if (s[i] === '|') { op = '>|'; i++; } else if (s[i] === '&') { op = '>&'; i++; }
      } else if (op === '<') {
        if (s.startsWith('<<-', i - 1) && bash) { op = '<<-'; i += 2; }
        else if (s[i] === '<' && s[i + 1] === '<') { op = '<<<'; i += 2; }
        else if (s[i] === '<') { op = '<<'; i++; }
        else if (s[i] === '>') { op = '<>'; i++; }
        else if (s[i] === '&') { op = '<&'; i++; }
      }
      while (s[i] === ' ' || s[i] === '\t') i++;
      // The target is exactly one following word, lexed by the same rules.
      const span = readWordSpan(s, i, shell);
      const target = lex(span, shell).find((x) => x.t === 'word') || null;
      i += span.length;
      if (op === '<<' || op === '<<-') {
        const delim = target ? target.parts.map((p) => p.lit ?? '').join('') : '';
        if (delim) pendingHeredocs.push({ delim, tabs: op === '<<-' });
        out.push({ t: 'redir', op, fd, target: null });
      } else {
        out.push({ t: 'redir', op, fd, target });
      }
      continue;
    }

    // Operators.
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || (pwsh && (c === '{' || c === '}'))) {
      endWord();
      if ((c === '&' && n === '&') || (c === '|' && n === '|') || (c === ';' && n === ';')) { out.push({ t: 'op', v: c + n }); i += 2; continue; }
      if (c === '|' && n === '&') { out.push({ t: 'op', v: '|' }); i += 2; continue; }
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }

    lit(c);
    i++;
  }
  endWord();
  return out;
}

/** The raw span of the next shell word starting at `j` (for redirect targets). */
function readWordSpan(s, j, shell) {
  let k = j;
  let q = null;
  while (k < s.length) {
    const c = s[k];
    if (q) {
      if (c === q) q = null;
      else if (c === BACKSLASH && q === '"' && shell === 'bash') k++;
      k++;
      continue;
    }
    if (c === '"' || c === "'") { q = c; k++; continue; }
    if (shell === 'bash' && c === BACKSLASH) { k += 2; continue; }
    if (/[\s;&|<>()]/.test(c)) break;
    if (shell === 'powershell' && (c === '{' || c === '}')) break;
    k++;
  }
  return s.slice(j, k);
}

// ============================================================ expansion

const SINKS = new Set(['/dev/null', 'nul', 'nul:', '\\\\.\\nul', '/dev/stdout', '/dev/stderr', '/dev/tty', 'con']);
const SINK = Symbol('sink');

/** Env vars it is safe to read from the hook's own environment. */
const ENV_ALLOW = new Set(['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA']);

/**
 * Expand one word with the variables known at this point in the command.
 * Returns { value: string|null (null = cannot know), glob: boolean, subs: string[] }.
 */
function expandWord(word, ctx, shell) {
  // PowerShell's `$null` is the discard sink only as a whole word; inside a
  // larger word it expands to nothing.
  if (shell === 'powershell' && word.parts.length === 1 && word.parts[0].simple
    && !word.parts[0].env && word.parts[0].var.toLowerCase() === 'null') {
    return { value: SINK, glob: false, subs: [] };
  }
  let value = '';
  let dynamic = false;
  let glob = false;
  const subs = [];
  word.parts.forEach((p, idx) => {
    if (p.lit !== undefined) {
      let v = p.lit;
      if (idx === 0 && !word.quoted && (v === '~' || v.startsWith('~/') || v.startsWith('~\\'))) {
        v = os.homedir() + v.slice(1);
      }
      if (!word.quoted && /[*?[]/.test(v)) glob = true;
      if (shell === 'cmd' && /%[^%\s]+%/.test(v)) dynamic = true;
      value += v;
      return;
    }
    if (p.sub !== undefined) { subs.push({ text: p.sub, shell: p.shell }); dynamic = true; return; }
    if (!p.simple) { dynamic = true; return; }
    const name = p.var;
    if (shell === 'powershell' && !p.env && name.toLowerCase() === 'null') return;
    if (!p.env && Object.prototype.hasOwnProperty.call(ctx.vars, name)) {
      const v = ctx.vars[name];
      if (v === null) dynamic = true; else value += v;
      return;
    }
    if (!p.env && (name === 'PWD' || (shell === 'powershell' && name.toLowerCase() === 'pwd'))) {
      if (ctx.bases && ctx.bases.length === 1) { value += ctx.bases[0]; return; }
      dynamic = true;
      return;
    }
    if (shell === 'powershell' && !p.env && name.toLowerCase() === 'home') { value += os.homedir(); return; }
    const key = IS_WIN ? Object.keys(process.env).find((k) => k.toUpperCase() === name.toUpperCase()) : name;
    const allowed = p.env || ENV_ALLOW.has(name.toUpperCase());
    if (allowed && key && process.env[key] !== undefined) { value += process.env[key]; return; }
    dynamic = true;
  });
  return { value: dynamic ? null : value, glob, subs };
}

// ================================================================== paths

const slashes = (p) => p.split(BACKSLASH).join('/');
const fold = (p) => (CASE_FOLD ? p.toLowerCase() : p);

/** Git Bash spells C:\x as /c/x; translate before path.resolve sees it. */
function nativePath(p) {
  let v = p;
  if (v.startsWith('\\\\?\\') || v.startsWith('//?/')) v = v.slice(4);
  if (IS_WIN) {
    const m = v.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (m) v = `${m[1].toUpperCase()}:${m[2] || '/'}`;
  }
  return v;
}

/** Absolute, symlink/junction-resolved spelling used for every root comparison.
 *  Only the deepest EXISTING ancestor is realpath'd, so a path that does not
 *  exist yet still resolves through any link above it. */
export function canonical(p) {
  const abs = path.resolve(nativePath(p));
  let cur = abs;
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return fold(slashes(path.join(real, ...rest.reverse())));
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return fold(slashes(abs));
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** For a glob, the directory it can expand within. */
function globBase(v) {
  const segs = slashes(v).split('/');
  const keep = [];
  for (const seg of segs) {
    if (/[*?[]/.test(seg)) break;
    keep.push(seg);
  }
  return keep.join('/') || '.';
}

// ========================================================== classification

/** Command word -> canonical name: basename, lower-case, no .exe/.cmd suffix. */
function commandName(v) {
  const base = slashes(String(v)).split('/').pop();
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

const isFlag = (v) => typeof v === 'string' && v.length > 1 && v.startsWith('-');
const isCmdFlag = (v) => typeof v === 'string' && /^\/\/?[A-Za-z?]{1,2}$/.test(v);

/** Split POSIX-style args into positionals, skipping flags (and the values of
 *  flags listed in `withValue`). `--` ends flags. Returns { pos, flags, values }. */
function posix(args, withValue = []) {
  const pos = [];
  const flags = [];
  const values = {};
  let ended = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const v = a.value;
    if (!ended && v === '--') { ended = true; continue; }
    if (!ended && isFlag(v)) {
      const eq = v.indexOf('=');
      const name = eq === -1 ? v : v.slice(0, eq);
      flags.push(name);
      if (eq !== -1) values[name] = { ...a, value: v.slice(eq + 1) };
      else if (withValue.includes(name) && k + 1 < args.length) values[name] = args[++k];
      continue;
    }
    pos.push(a);
  }
  return { pos, flags, values };
}

const PWSH_SWITCHES = new Set([
  'force', 'recurse', 'confirm', 'whatif', 'nonewline', 'passthru', 'append', 'noclobber', 'verbose',
  'debug', 'raw', 'wait', 'noprofile', 'asbytestream', 'container', 'notypeinformation', 'usebasicparsing',
  'skipcertificatecheck', 'erroraction', 'update',
]);
const PWSH_PATH_PARAMS = new Set([
  'path', 'literalpath', 'lp', 'pspath', 'destination', 'filepath', 'outfile', 'destinationpath', 'target',
]);

/** PowerShell-style args: -Name value pairs (switches take no value) + positionals. */
function pwshArgs(args) {
  const params = {};
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value;
    if (typeof v === 'string' && /^-[A-Za-z]/.test(v)) {
      const [rawName, inline] = v.slice(1).split(':');
      const name = rawName.toLowerCase();
      if (inline !== undefined) { params[name] = { ...args[k], value: inline }; continue; }
      if (PWSH_SWITCHES.has(name) || k + 1 >= args.length) { params[name] = true; continue; }
      params[name] = args[++k];
      continue;
    }
    pos.push(args[k]);
  }
  const pathParams = Object.entries(params)
    .filter(([name, val]) => val !== true && [...PWSH_PATH_PARAMS].some((p) => p === name || (name.length >= 2 && p.startsWith(name) && name !== 'p')))
    .map(([, val]) => val);
  return { params, pos, pathParams };
}

const BASE = Symbol('base');      // writes the directory the command runs in
const GLOBAL = Symbol('global');  // writes state outside any directory

/** Families of tools whose subcommand decides. `target` is BASE or GLOBAL. */
const FAMILIES = [
  { cmds: ['npm', 'pnpm', 'yarn', 'bun'], subs: ['i', 'install', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'link', 'ln', 'unlink', 'ci', 'dedupe', 'prune', 'version', 'init', 'create', 'patch'], target: BASE, globalFlags: ['-g', '--global', '--location=global'] },
  { cmds: ['npm', 'pnpm', 'yarn', 'bun'], subs: ['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'login', 'logout', 'adduser'], target: GLOBAL },
  { cmds: ['pip', 'pip3', 'pipx', 'conda', 'mamba'], subs: ['install', 'uninstall', 'remove', 'create', 'update', 'upgrade', 'inject'], target: GLOBAL },
  { cmds: ['poetry'], subs: ['add', 'remove', 'install', 'sync', 'lock', 'update', 'init', 'new'], target: BASE },
  { cmds: ['poetry'], subs: ['publish'], target: GLOBAL },
  { cmds: ['uv'], subs: ['add', 'remove', 'sync', 'lock', 'init', 'venv'], target: BASE },
  { cmds: ['uv'], subs: ['pip', 'tool', 'publish'], target: GLOBAL },
  { cmds: ['cargo'], subs: ['add', 'remove', 'fix', 'update', 'new', 'init', 'generate-lockfile', 'vendor'], target: BASE },
  { cmds: ['cargo'], subs: ['install', 'uninstall', 'publish', 'login', 'yank', 'owner'], target: GLOBAL },
  { cmds: ['go'], subs: ['get', 'mod', 'generate', 'fmt', 'work'], target: BASE, readOnly: (a) => a[0] === 'mod' && ['graph', 'why', 'verify', 'download'].includes(a[1]) },
  { cmds: ['go'], subs: ['install'], target: GLOBAL },
  { cmds: ['dotnet'], subs: ['add', 'remove', 'restore', 'new', 'publish', 'format', 'sln'], target: BASE, readOnly: (a) => a[0] === 'format' && a.includes('--verify-no-changes') },
  { cmds: ['dotnet'], subs: ['tool', 'nuget', 'workload', 'ef'], target: GLOBAL, readOnly: (a) => a[0] === 'tool' && a[1] === 'list' },
  { cmds: ['gem'], subs: ['install', 'uninstall', 'update', 'push', 'yank'], target: GLOBAL },
  { cmds: ['bundle', 'bundler'], subs: ['install', 'update', 'add', 'remove', 'lock'], target: BASE },
  { cmds: ['composer'], subs: ['install', 'update', 'require', 'remove', 'dump-autoload', 'create-project'], target: BASE },
  { cmds: ['composer'], subs: ['global'], target: GLOBAL },
  { cmds: ['mvn', 'mvnw'], subs: ['install', 'deploy', 'release:perform'], target: GLOBAL },
  { cmds: ['mvn', 'mvnw'], subs: ['clean'], target: BASE },
  { cmds: ['gradle', 'gradlew'], subs: ['publish', 'publishtomavenlocal'], target: GLOBAL, ci: true },
  { cmds: ['gradle', 'gradlew'], subs: ['clean'], target: BASE },
  { cmds: ['apt', 'apt-get', 'yum', 'dnf', 'pacman', 'zypper', 'apk'], subs: ['install', 'remove', 'purge', 'upgrade', 'update', '-s', '-r', '-u', '-syu', 'add', 'del'], target: GLOBAL },
  { cmds: ['brew', 'choco', 'winget', 'scoop', 'snap', 'flatpak'], subs: ['install', 'uninstall', 'remove', 'upgrade', 'update', 'reinstall', 'link', 'unlink', 'tap'], target: GLOBAL },
  { cmds: ['make', 'gmake'], subs: ['install', 'uninstall'], target: GLOBAL, anyArg: true },
  { cmds: ['make', 'gmake'], subs: ['clean', 'distclean', 'mrproper'], target: BASE, anyArg: true },
  { cmds: ['terraform', 'tofu'], subs: ['apply', 'destroy', 'import', 'state', 'taint', 'untaint', 'workspace', 'force-unlock'], target: GLOBAL, readOnly: (a) => (a[0] === 'state' && ['list', 'show', 'pull'].includes(a[1])) || (a[0] === 'workspace' && ['list', 'show', 'select'].includes(a[1])) },
  { cmds: ['terraform', 'tofu'], subs: ['init', 'get'], target: BASE },
  { cmds: ['kubectl', 'oc'], subs: ['apply', 'delete', 'create', 'patch', 'edit', 'scale', 'replace', 'rollout', 'label', 'annotate', 'set', 'expose', 'run', 'drain', 'cordon', 'uncordon', 'taint', 'cp', 'autoscale'], target: GLOBAL, readOnly: (a) => a[0] === 'rollout' && ['status', 'history'].includes(a[1]) },
  { cmds: ['docker', 'podman'], subs: ['run', 'build', 'rm', 'rmi', 'compose', 'push', 'pull', 'tag', 'exec', 'start', 'stop', 'restart', 'kill', 'create', 'commit', 'cp', 'load', 'import', 'prune', 'volume', 'network', 'system', 'image', 'container', 'buildx', 'swarm', 'service', 'stack', 'login', 'logout', 'save', 'rename', 'update', 'pause', 'unpause'], target: GLOBAL, readOnly: (a) => (a[0] === 'compose' && ['ps', 'logs', 'config', 'ls', 'images', 'top', 'version'].includes(a[1])) || (['image', 'container', 'volume', 'network'].includes(a[0]) && ['ls', 'list', 'inspect', 'history'].includes(a[1])) || (a[0] === 'system' && ['df', 'info', 'events'].includes(a[1])) },
  { cmds: ['helm'], subs: ['install', 'upgrade', 'uninstall', 'rollback', 'delete', 'push', 'repo', 'plugin'], target: GLOBAL, readOnly: (a) => (a[0] === 'repo' && a[1] === 'list') || (a[0] === 'plugin' && a[1] === 'list') },
  { cmds: ['ansible', 'ansible-playbook', 'ansible-galaxy'], subs: null, target: GLOBAL },
  { cmds: ['serverless', 'sls'], subs: ['deploy', 'remove'], target: GLOBAL },
  { cmds: ['vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'railway', 'firebase', 'wrangler', 'amplify', 'supabase', 'sam', 'cdk', 'pulumi'], subs: ['deploy', 'publish', 'destroy', 'rm', 'remove', 'delete', '--prod', 'up', 'link', 'env', 'secret', 'secrets', 'bootstrap', 'db', 'releases'], target: GLOBAL, anyArg: true },
  { cmds: ['cargo'], subs: ['publish'], target: GLOBAL },
  { cmds: ['twine'], subs: ['upload'], target: GLOBAL },
  // Database migrations: unambiguously state-changing and often irreversible.
  { cmds: ['rake', 'rails'], subs: null, target: GLOBAL, match: (a) => a.some((x) => /^db:/.test(x)) },
  { cmds: ['alembic'], subs: ['upgrade', 'downgrade', 'stamp'], target: GLOBAL },
  { cmds: ['alembic'], subs: ['revision'], target: BASE },
  { cmds: ['prisma'], subs: ['migrate', 'db'], target: GLOBAL, readOnly: (a) => a[0] === 'migrate' && a[1] === 'status' },
  { cmds: ['flyway', 'liquibase'], subs: ['migrate', 'clean', 'undo', 'repair', 'baseline', 'update', 'rollback', 'drop-all'], target: GLOBAL },
  { cmds: ['knex', 'sequelize', 'sequelize-cli'], subs: null, target: GLOBAL, match: (a) => a.some((x) => /^(migrate|seed|db):/.test(x)) },
  { cmds: ['manage.py'], subs: ['migrate', 'flush', 'loaddata', 'createsuperuser', 'sqlflush'], target: GLOBAL },
  { cmds: ['manage.py'], subs: ['makemigrations', 'startapp', 'collectstatic'], target: BASE },
  { cmds: ['artisan'], subs: null, target: GLOBAL, match: (a) => a.some((x) => /^(migrate|db:)/.test(x)) },
  { cmds: ['diesel'], subs: ['migration', 'database'], target: GLOBAL, readOnly: (a) => a[1] === 'list' },
  // Cloud CLIs: any mutating verb anywhere in the args.
  { cmds: ['aws'], subs: null, target: GLOBAL, match: (a) => a.slice(1).some((x) => /^(create|delete|put|update|remove|sync|cp|mv|rm|mb|rb|terminate|run|start|stop|reboot|modify|attach|detach|associate|disassociate|register|deregister|tag|untag|invoke|publish|send|set|import|restore|enable|disable|replace|reset|upload|deploy)/.test(x)) },
  { cmds: ['gcloud', 'gsutil'], subs: null, target: GLOBAL, match: (a) => a.some((x) => /^(create|delete|deploy|update|set|add|remove|import|patch|resize|start|stop|reset|enable|disable|cp|mv|rm|rsync)$/.test(x)) },
  { cmds: ['az'], subs: null, target: GLOBAL, match: (a) => a.some((x) => /^(create|delete|update|set|add|remove|start|stop|restart|deploy|import|purge|upload)$/.test(x)) },
  { cmds: ['gh'], subs: null, target: GLOBAL, match: (a) => (['release', 'pr', 'issue', 'repo', 'gist', 'secret', 'variable', 'label', 'workflow', 'run', 'cache', 'ruleset'].includes(a[0]) && /^(create|merge|edit|delete|close|reopen|comment|review|ready|lock|unlock|transfer|pin|unpin|upload|fork|rename|archive|unarchive|set|remove|enable|disable|cancel|rerun|sync)$/.test(a[1] || '')) || (a[0] === 'api' && a.some((x) => /^(-X|--method)$/.test(x) || /^(-f|-F|--field|--raw-field|--input)$/.test(x))) },
  { cmds: ['gh'], subs: null, target: BASE, match: (a) => (a[0] === 'pr' && a[1] === 'checkout') || (a[0] === 'repo' && a[1] === 'clone') },
];

/** Formatters: write their path args (or the whole directory) unless checking. */
const FORMATTERS = {
  prettier: { when: (f) => f.includes('--write') || f.includes('-w') },
  eslint: { when: (f) => f.some((x) => x.startsWith('--fix')) },
  stylelint: { when: (f) => f.includes('--fix') },
  black: { when: (f) => !f.includes('--check') && !f.includes('--diff') },
  isort: { when: (f) => !f.includes('--check-only') && !f.includes('--check') && !f.includes('--diff') },
  autopep8: { when: (f) => f.includes('-i') || f.includes('--in-place') },
  gofmt: { when: (f) => f.includes('-w') },
  goimports: { when: (f) => f.includes('-w') },
  rustfmt: { when: (f) => !f.includes('--check') },
  'clang-format': { when: (f) => f.includes('-i') },
  shfmt: { when: (f) => f.includes('-w') },
  yapf: { when: (f) => f.includes('-i') || f.includes('--in-place') },
};

/** Subcommand-driven formatters: tool -> sub -> predicate on flags. */
const SUB_FORMATTERS = {
  ruff: (sub, f) => (sub === 'format' && !f.includes('--check') && !f.includes('--diff')) || f.includes('--fix'),
  biome: (sub, f) => ['format', 'check', 'lint'].includes(sub) && (f.includes('--write') || f.includes('--apply') || f.includes('--fix')),
  deno: (sub, f) => (sub === 'fmt' && !f.includes('--check')) || (sub === 'lint' && f.includes('--fix')),
  dprint: (sub) => sub === 'fmt',
  terraform: (sub, f) => sub === 'fmt' && !f.includes('-check'),
  tofu: (sub, f) => sub === 'fmt' && !f.includes('-check'),
  cargo: (sub, f) => (sub === 'fmt' && !f.includes('--check')) || (sub === 'clippy' && f.includes('--fix')),
  mix: (sub, f) => sub === 'format' && !f.includes('--check-formatted'),
};

// git ------------------------------------------------------------------

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
const GIT_READ = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'annotate', 'grep', 'ls-files', 'ls-tree', 'ls-remote', 'rev-parse',
  'rev-list', 'describe', 'cat-file', 'for-each-ref', 'show-ref', 'merge-base', 'name-rev', 'shortlog',
  'whatchanged', 'cherry', 'count-objects', 'fsck', 'verify-commit', 'verify-tag', 'verify-pack', 'check-ignore',
  'check-attr', 'check-ref-format', 'check-mailmap', 'var', 'help', 'version', 'range-diff', 'diff-tree',
  'diff-files', 'diff-index', 'show-branch', 'get-tar-commit-id', 'interpret-trailers', 'column', 'hash-object',
  'mktree', 'patch-id', 'request-pull', 'fmt-merge-msg', 'difftool',
]);

/** Classify a git invocation. Returns { mutates, dir (BASE or a word), targets }. */
function classifyGit(args) {
  let k = 0;
  let dir = BASE;
  while (k < args.length) {
    const v = args[k].value;
    if (v === null) return { unknown: true };
    if (!isFlag(v)) break;
    const [name] = v.split('=');
    if (GIT_VALUE_OPTS.has(name) && !v.includes('=')) {
      if (name === '-C') dir = args[k + 1] ?? null;
      k += 2;
      continue;
    }
    if (name === '--git-dir' || name === '--work-tree') { if (v.includes('=')) dir = { ...args[k], value: v.split('=')[1] }; }
    if (name === '--version' || name === '--help' || name === '--exec-path' || name === '--html-path' || name === '--man-path') return { mutates: false };
    k++;
  }
  const sub = args[k]?.value;
  const rest = args.slice(k + 1).map((a) => a.value);
  if (sub === undefined) return { mutates: false };
  if (sub === null) return { unknown: true };
  const restFlags = rest.filter((x) => typeof x === 'string' && x.startsWith('-'));
  const restPos = rest.filter((x) => typeof x === 'string' && !x.startsWith('-'));
  const has = (...f) => rest.some((x) => f.includes(x) || f.some((g) => g.endsWith('=') && String(x).startsWith(g)));

  if (GIT_READ.has(sub)) {
    if (sub === 'diff' && has('--output=')) return { mutates: true, dir };
    return { mutates: false };
  }
  const readIf = {
    config: () => has('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool')
      || (restPos.length <= 1 && !has('--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section')),
    stash: () => ['list', 'show'].includes(rest[0]),
    tag: () => rest.length === 0 || has('-l', '--list', '-v', '--verify', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged') || restFlags.some((f) => /^-n\d*$/.test(f)),
    branch: () => !has('-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--set-upstream-to=', '--unset-upstream', '--edit-description', '--track', '-t')
      && (restPos.length === 0 || has('-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at')),
    remote: () => rest.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(rest[0]),
    notes: () => rest.length === 0 || ['list', 'show'].includes(rest[0]),
    worktree: () => rest[0] === 'list',
    submodule: () => rest.length === 0 || ['status', 'summary'].includes(rest[0]),
    reflog: () => rest.length === 0 || ['show', 'exists'].includes(rest[0]) || String(rest[0]).startsWith('-'),
    'symbolic-ref': () => restPos.length <= 1 && !has('-d', '--delete'),
    'sparse-checkout': () => rest[0] === 'list',
    lfs: () => ['ls-files', 'status', 'env', 'version', 'logs'].includes(rest[0]),
    bisect: () => ['log', 'view', 'visualize'].includes(rest[0]),
    apply: () => has('--check', '--stat', '--numstat', '--summary') && !has('--apply'),
    'format-patch': () => has('--stdout'),
    archive: () => !has('-o', '--output', '--output='),
  };
  if (readIf[sub]) {
    if (readIf[sub]()) return { mutates: false };
    if (sub === 'format-patch') {
      const o = posix(args.slice(k + 1), ['-o', '--output-directory']).values;
      return { mutates: true, dir, targets: [o['-o'] || o['--output-directory'] || BASE] };
    }
    if (sub === 'archive') {
      const o = posix(args.slice(k + 1), ['-o', '--output']).values;
      return { mutates: true, dir, targets: [o['-o'] || o['--output'] || null] };
    }
    return { mutates: true, dir };
  }
  if (sub === 'clone') {
    const { pos } = posix(args.slice(k + 1), ['-b', '--branch', '-o', '--origin', '--depth', '--reference', '--separate-git-dir', '-c', '--config', '--template', '-u', '--upload-pack', '--filter', '-j', '--jobs']);
    return { mutates: true, dir, targets: [pos[1] ?? BASE] };
  }
  if (sub === 'init') {
    const { pos } = posix(args.slice(k + 1), ['--template', '--separate-git-dir', '-b', '--initial-branch', '--object-format']);
    return { mutates: true, dir, targets: [pos[0] ?? BASE] };
  }
  // Everything else writes the repository: add, commit, checkout, reset, pull,
  // fetch, gc, update-ref, push, … — and anything unknown, which fails closed.
  return { mutates: true, dir };
}

// ============================================================== the walk

/**
 * Classify one simple command.
 * Returns one of:
 *   { kind: 'none' }
 *   { kind: 'cd', target }                     target: word value or null (unknown)
 *   { kind: 'mutate', targets, label }         targets: (word | BASE | GLOBAL | null)[]
 *   { kind: 'recurse', script, shell }
 *   { kind: 'multi', items: [...] }
 */
function classify(words, shell, depth) {
  if (words.length === 0) return { kind: 'none' };
  const first = words[0].value;
  if (first === null) return { kind: 'mutate', targets: [null], label: 'a command whose name is not known until it runs' };
  const name = commandName(first);
  const args = words.slice(1);
  const vals = args.map((a) => a.value);

  // --- keywords and no-ops ------------------------------------------------
  if (['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time', 'esac', 'in'].includes(name)) {
    return classify(args, shell, depth);
  }
  if (['for', 'case', 'select', 'function', 'foreach'].includes(name)) return { kind: 'none' };

  // --- directory changes --------------------------------------------------
  if (['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'].includes(name)) {
    const p = name.includes('-') || name === 'sl' ? pwshArgs(args) : null;
    const t = p ? (p.pathParams[0] ?? p.pos[0]) : posix(args).pos[0];
    if (!t) return { kind: 'cd', target: { value: name === 'pushd' || name === 'push-location' ? null : os.homedir() } };
    if (t.value === '-') return { kind: 'cd', target: { value: null } };
    return { kind: 'cd', target: t };
  }
  if (['popd', 'pop-location'].includes(name)) return { kind: 'cd', target: { value: null } };

  // --- wrappers -----------------------------------------------------------
  if (['sudo', 'doas'].includes(name)) {
    let k = 0;
    while (k < args.length && isFlag(args[k].value)) k += ['-u', '-g', '-C', '-p', '-h'].includes(args[k].value) ? 2 : 1;
    return classify(args.slice(k), shell, depth);
  }
  if (name === 'env') {
    let k = 0;
    while (k < args.length && (isFlag(args[k].value) || /^[A-Za-z_]\w*=/.test(args[k].value ?? ''))) {
      k += ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(args[k].value) ? 2 : 1;
    }
    return classify(args.slice(k), shell, depth);
  }
  if (['nohup', 'builtin', 'exec', 'chronic', 'unbuffer', 'caffeinate'].includes(name)) return classify(args, shell, depth);
  if (name === 'command') {
    if (vals[0] === '-v' || vals[0] === '-V') return { kind: 'none' };
    return classify(vals[0] === '-p' ? args.slice(1) : args, shell, depth);
  }
  if (['nice', 'ionice', 'stdbuf', 'timeout', 'watch'].includes(name)) {
    let k = 0;
    while (k < args.length && isFlag(args[k].value)) k += /^-(n|c|o|e|i|s|k|-signal|-kill-after)$/.test(args[k].value) ? 2 : 1;
    if (name === 'timeout' && k < args.length) k++; // the duration
    return classify(args.slice(k), shell, depth);
  }
  if (['npx', 'bunx', 'pnpx'].includes(name) || (['pnpm', 'yarn', 'npm', 'bun'].includes(name) && ['exec', 'dlx', 'x'].includes(vals[0]))) {
    let k = ['npx', 'bunx', 'pnpx'].includes(name) ? 0 : 1;
    while (k < args.length && (isFlag(args[k].value) || args[k].value === '--')) k += ['-p', '--package', '-c', '--call'].includes(args[k].value) ? 2 : 1;
    return classify(args.slice(k), shell, depth);
  }
  if (['uv', 'poetry', 'pipx', 'pdm', 'hatch', 'rye'].includes(name) && vals[0] === 'run') {
    let k = 1;
    while (k < args.length && isFlag(args[k].value)) k++;
    return classify(args.slice(k), shell, depth);
  }
  if (['python', 'python3', 'py', 'pypy', 'pypy3'].includes(name) || /^python3\.\d+$/.test(name)) {
    let k = 0;
    while (k < args.length && isFlag(args[k].value) && args[k].value !== '-m' && args[k].value !== '-c') k++;
    if (vals[k] === '-m' && k + 1 < args.length) return classify(args.slice(k + 1), shell, depth);
    if (vals[k] !== null && vals[k] !== undefined && commandName(vals[k]) === 'manage.py') return classify(args.slice(k), shell, depth);
    return { kind: 'none' };
  }
  if (name === 'php' && vals[0] !== null && commandName(vals[0] ?? '') === 'artisan') return classify(args, shell, depth);
  if (name === 'xargs') {
    let k = 0;
    while (k < args.length && isFlag(args[k].value)) k += /^-[nILPdsEa]$/.test(args[k].value) ? 2 : 1;
    const inner = classify(args.slice(k), shell, depth);
    if (inner.kind === 'none') return inner;
    // The inner command's real arguments arrive on stdin: unknowable here.
    return { kind: 'mutate', targets: [null], label: 'xargs feeding a mutating command' };
  }

  // --- nested shells --------------------------------------------------------
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'].includes(name)) {
    const k = args.findIndex((a) => typeof a.value === 'string' && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.value));
    if (k !== -1 && k + 1 < args.length) return { kind: 'recurse', script: args[k + 1].value, shell: 'bash' };
    return { kind: 'none' }; // running a script file is research
  }
  if (name === 'eval') return { kind: 'recurse', script: vals.some((v) => v === null) ? null : vals.join(' '), shell };
  if (['pwsh', 'powershell'].includes(name)) {
    const k = args.findIndex((a) => typeof a.value === 'string' && /^-(c|command|e|ec|encodedcommand)$/i.test(a.value));
    if (k === -1) return { kind: 'none' };
    const flag = args[k].value.toLowerCase();
    const rest = args.slice(k + 1).map((a) => a.value);
    if (rest.some((v) => v === null)) return { kind: 'recurse', script: null, shell: 'powershell' };
    if (flag === '-e' || flag === '-ec' || flag === '-encodedcommand') {
      try { return { kind: 'recurse', script: Buffer.from(rest[0] || '', 'base64').toString('utf16le'), shell: 'powershell' }; }
      catch { return { kind: 'recurse', script: null, shell: 'powershell' }; }
    }
    return { kind: 'recurse', script: rest.join(' '), shell: 'powershell' };
  }
  if (['iex', 'invoke-expression'].includes(name)) {
    const p = pwshArgs(args);
    const cmd = p.params.command ?? p.pos[0];
    return { kind: 'recurse', script: cmd && cmd !== true ? cmd.value : null, shell: 'powershell' };
  }
  if (name === 'cmd') {
    const k = args.findIndex((a) => typeof a.value === 'string' && /^\/\/?[ck]$/i.test(a.value));
    if (k === -1) return { kind: 'none' };
    const rest = args.slice(k + 1).map((a) => a.value);
    return { kind: 'recurse', script: rest.some((v) => v === null) ? null : rest.join(' '), shell: 'cmd' };
  }
  if (['start-process', 'saps', 'start'].includes(name)) {
    return { kind: 'mutate', targets: [null], label: 'a process launched with arguments that cannot be analysed' };
  }

  // --- git ------------------------------------------------------------------
  if (name === 'git') {
    const g = classifyGit(args);
    if (g.unknown) return { kind: 'mutate', targets: [null], label: 'git with an argument that is not known until it runs' };
    if (!g.mutates) return { kind: 'none' };
    return { kind: 'mutate', targets: g.targets ?? [g.dir], label: `git ${vals.find((v, idx) => idx >= 0 && v && !v.startsWith('-')) ?? ''}`.trim() };
  }

  // --- file verbs -------------------------------------------------------------
  const cmdStyle = (a) => a.filter((x) => !isCmdFlag(x.value));
  switch (name) {
    case 'rm': case 'unlink': case 'shred': case 'rmdir': case 'touch': case 'mkdir': {
      const { pos } = posix(args, ['-d', '-t', '-r', '-m', '--mode', '--date', '--reference', '-n', '--iterations', '-s', '--size']);
      return { kind: 'mutate', targets: pos.length ? pos : [null], label: name };
    }
    case 'truncate': {
      const { pos } = posix(args, ['-s', '--size', '-r', '--reference']);
      return { kind: 'mutate', targets: pos.length ? pos : [null], label: name };
    }
    case 'chmod': case 'chown': case 'chgrp': {
      const { pos, values } = posix(args, ['--reference']);
      const t = values['--reference'] ? pos : pos.slice(1);
      return { kind: 'mutate', targets: t.length ? t : [null], label: name };
    }
    case 'mv': {
      const { pos, values } = posix(args, ['-t', '--target-directory', '-S', '--suffix']);
      const t = [...pos, values['-t'] || values['--target-directory']].filter(Boolean);
      return { kind: 'mutate', targets: t.length ? t : [null], label: name };
    }
    case 'cp': case 'install': case 'rsync': case 'scp': {
      const { pos, values } = posix(args, ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '-e', '--rsh', '-i', '-P', '--exclude', '--include', '--filter', '-f']);
      const dest = values['-t'] || values['--target-directory'] || pos[pos.length - 1];
      if (!dest) return { kind: 'mutate', targets: [null], label: name };
      if (['rsync', 'scp'].includes(name) && typeof dest.value === 'string' && /^[^/\\]{2,}:/.test(dest.value)) {
        return { kind: 'mutate', targets: [GLOBAL], label: `${name} to a remote host` };
      }
      return { kind: 'mutate', targets: [dest], label: name };
    }
    case 'ln': case 'mklink': {
      // Every operand: a hard link to a project file makes a sandbox write land
      // in the project, which no realpath can see.
      const t = posix(cmdStyle(args), ['-t', '--target-directory', '-S', '--suffix']).pos;
      if (name === 'ln' && t.length === 1) t.push(BASE);
      return { kind: 'mutate', targets: t.length ? t : [null], label: name };
    }
    case 'patch': {
      const { pos, flags, values } = posix(args, ['-p', '-d', '--directory', '-i', '--input', '-o', '--output', '-B', '-r', '-F', '-D', '-V', '-z']);
      if (flags.includes('--dry-run') || flags.includes('-C') || flags.includes('--check')) return { kind: 'none' };
      const t = values['-o'] || values['--output'] ? [values['-o'] || values['--output']]
        : pos.length ? [pos[0]] : [values['-d'] || values['--directory'] || BASE];
      return { kind: 'mutate', targets: t, label: name };
    }
    case 'dd': {
      const of = args.find((a) => typeof a.value === 'string' && a.value.startsWith('of='));
      if (!of) return { kind: 'none' };
      return { kind: 'mutate', targets: [{ ...of, value: of.value.slice(3) }], label: name };
    }
    case 'tee': {
      const { pos } = posix(args);
      return pos.length ? { kind: 'mutate', targets: pos, label: name } : { kind: 'none' };
    }
    case 'sort': {
      const { values } = posix(args, ['-o', '--output', '-k', '-t', '-S', '-T', '--key', '--field-separator', '--buffer-size', '--temporary-directory']);
      const o = values['-o'] || values['--output'];
      return o ? { kind: 'mutate', targets: [o], label: name } : { kind: 'none' };
    }
    case 'sed': {
      const { pos, flags, values } = posix(args, ['-e', '--expression', '-f', '--file', '-l', '--line-length']);
      const inPlace = flags.some((f) => f === '--in-place' || /^-[a-zA-Z]*i/.test(f));
      if (!inPlace) return { kind: 'none' };
      const files = values['-e'] || values['--expression'] || values['-f'] || values['--file'] ? pos : pos.slice(1);
      return { kind: 'mutate', targets: files.length ? files : [null], label: 'sed -i' };
    }
    case 'perl': {
      const flags = vals.filter((v) => typeof v === 'string' && /^-[a-zA-Z]/.test(v));
      if (!flags.some((f) => /^-[a-zA-Z]*i/.test(f))) return { kind: 'none' };
      const files = [];
      for (let k = 0; k < args.length; k++) {
        const v = args[k].value;
        if (typeof v === 'string' && /^-[a-zA-Z.]*[eE]$/.test(v)) { k++; continue; }
        if (isFlag(v)) continue;
        files.push(args[k]);
      }
      return { kind: 'mutate', targets: files.length ? files : [null], label: 'perl -i' };
    }
    case 'find': {
      let k = 0;
      const starts = [];
      while (k < args.length && !(typeof args[k].value === 'string' && /^[-(!]/.test(args[k].value))) starts.push(args[k++]);
      const roots = starts.length ? starts : [BASE];
      const targets = [];
      for (; k < args.length; k++) {
        const v = args[k].value;
        if (v === '-delete') targets.push(...roots);
        else if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(v) && args[k + 1]) targets.push(args[k + 1]);
        else if (['-exec', '-execdir', '-ok', '-okdir'].includes(v)) {
          const inner = [];
          k++;
          while (k < args.length && args[k].value !== ';' && args[k].value !== '+') inner.push(args[k++]);
          const verdict = classify(inner, shell, depth);
          if (verdict.kind !== 'none' && verdict.kind !== 'cd') targets.push(...roots);
        }
      }
      return targets.length ? { kind: 'mutate', targets, label: 'find' } : { kind: 'none' };
    }
    case 'curl': {
      const targets = [];
      for (let k = 0; k < args.length; k++) {
        const v = args[k].value;
        if (typeof v !== 'string') continue;
        if (v === '--output' || v === '--dump-header' || v === '--cookie-jar' || v === '--output-dir') { if (args[k + 1]) targets.push(args[++k]); continue; }
        if (/^--(output|dump-header|cookie-jar|output-dir)=/.test(v)) { targets.push({ ...args[k], value: v.split('=').slice(1).join('=') }); continue; }
        if (v === '--remote-name' || v === '--remote-name-all') { targets.push(BASE); continue; }
        if (/^-[a-zA-Z]+$/.test(v)) {
          if (v.includes('O')) targets.push(BASE);
          const last = v[v.length - 1];
          if ('ocD'.includes(last) && args[k + 1]) targets.push(args[++k]);
        }
      }
      const real = targets.filter((t) => t === BASE || t.value !== '-');
      return real.length ? { kind: 'mutate', targets: real, label: 'curl' } : { kind: 'none' };
    }
    case 'wget': {
      if (vals.includes('--spider')) return { kind: 'none' };
      let t = BASE;
      for (let k = 0; k < args.length; k++) {
        const v = args[k].value;
        if (typeof v !== 'string') continue;
        let m;
        if ((v === '-O' || v === '--output-document' || v === '-P' || v === '--directory-prefix') && args[k + 1]) { t = args[++k]; continue; }
        if ((m = v.match(/^--(?:output-document|directory-prefix)=(.*)$/))) { t = { ...args[k], value: m[1] }; continue; }
        if ((m = v.match(/^-[a-zA-Z]*[OP](.+)$/))) { t = { ...args[k], value: m[1] }; continue; }
        if (/^-[a-zA-Z]*[OP]$/.test(v) && args[k + 1]) { t = args[++k]; continue; }
      }
      if (t !== BASE && t.value === '-') return { kind: 'none' };
      return { kind: 'mutate', targets: [t], label: 'wget' };
    }
    case 'tar': {
      const first = vals[0] ?? '';
      const cluster = typeof first === 'string' && !first.startsWith('-') ? first : '';
      const flags = vals.filter((v) => typeof v === 'string' && v.startsWith('-')).join(' ') + ' ' + cluster;
      const extract = /(^|\s)(-[a-zA-Z]*x|--extract|--get)|^x|\sx/.test(flags) || cluster.includes('x');
      const create = /(^|\s)(-[a-zA-Z]*[cru]|--create|--append|--update)/.test(flags) || /[cru]/.test(cluster);
      const { values } = posix(args, ['-C', '--directory', '-f', '--file']);
      const fileArg = values['-f'] || values['--file'] || (cluster.includes('f') ? args[1] : null);
      if (extract) return { kind: 'mutate', targets: [values['-C'] || values['--directory'] || BASE], label: 'tar -x' };
      if (create && fileArg && fileArg.value !== '-') return { kind: 'mutate', targets: [fileArg], label: 'tar -c' };
      return { kind: 'none' };
    }
    case 'unzip': {
      if (vals.includes('-l') || vals.includes('-t') || vals.includes('-Z')) return { kind: 'none' };
      const { values } = posix(args, ['-d', '-x']);
      return { kind: 'mutate', targets: [values['-d'] || BASE], label: 'unzip' };
    }
    case 'del': case 'erase': case 'rd': case 'md': case 'copy': case 'move': case 'ren': case 'rename': case 'xcopy': case 'robocopy': {
      const pos = cmdStyle(args).filter((a) => !isFlag(a.value));
      const t = ['copy', 'xcopy', 'robocopy'].includes(name) ? pos.slice(name === 'copy' ? -1 : 1, name === 'copy' ? undefined : 2) : pos;
      return { kind: 'mutate', targets: t.length ? t : [null], label: name };
    }
    default: break;
  }

  // --- PowerShell cmdlets and aliases ------------------------------------------
  const PS = {
    'remove-item': 'all', ri: 'all', 'clear-content': 'all', clc: 'all', 'set-item': 'all', si: 'all',
    'remove-itemproperty': 'all', rp: 'all', 'rename-item': 'all', rni: 'all', 'move-item': 'all', mi: 'all',
    'new-item': 'first', ni: 'first', 'set-content': 'first', sc: 'first', 'add-content': 'first', ac: 'first',
    'out-file': 'first', 'tee-object': 'first', 'export-csv': 'first', 'export-clixml': 'first',
    'set-itemproperty': 'first', sp: 'first', 'new-itemproperty': 'first',
    'copy-item': 'dest', cpi: 'dest', 'compress-archive': 'dest', 'expand-archive': 'dest',
  };
  if (PS[name]) {
    const p = pwshArgs(args);
    if (p.params.whatif === true) return { kind: 'none' };
    let t;
    if (PS[name] === 'all') t = [...p.pathParams, ...p.pos];
    else if (PS[name] === 'first') t = p.pathParams.length ? p.pathParams : p.pos.slice(0, 1);
    else {
      const dest = p.params.destination ?? p.params.destinationpath;
      t = dest && dest !== true ? [dest] : p.pos.length > 1 ? [p.pos[1]] : name === 'expand-archive' ? [BASE] : [];
    }
    if (name === 'tee-object' && p.params.variable) return { kind: 'none' };
    return { kind: 'mutate', targets: t.length ? t : [null], label: name };
  }
  if (['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer'].includes(name)) {
    const p = pwshArgs(args);
    const out = p.params.outfile ?? p.params.destination;
    return out && out !== true ? { kind: 'mutate', targets: [out], label: name } : { kind: 'none' };
  }

  // --- formatters ---------------------------------------------------------------
  if (FORMATTERS[name]) {
    const { pos, flags } = posix(args, ['--config', '-c', '--ignore-path', '--stdin-filepath', '--parser', '--line-length', '-l']);
    if (!FORMATTERS[name].when(flags)) return { kind: 'none' };
    return { kind: 'mutate', targets: pos.length ? pos : [BASE], label: `${name} (rewrites files)` };
  }
  if (SUB_FORMATTERS[name]) {
    const { pos, flags } = posix(args, ['--config', '-c']);
    const sub = pos[0]?.value;
    if (SUB_FORMATTERS[name](sub, flags)) {
      const files = pos.slice(1);
      return { kind: 'mutate', targets: files.length ? files : [BASE], label: `${name} ${sub ?? ''} (rewrites files)`.trim() };
    }
  }

  // --- tool families ------------------------------------------------------------------
  const strs = vals.map((v) => (v === null ? '\0' : v));
  for (const fam of FAMILIES) {
    if (!fam.cmds.includes(name)) continue;
    const positional = strs.filter((v) => !String(v).startsWith('-') || fam.subs?.includes(String(v).toLowerCase()));
    const sub = String(positional[0] ?? '').toLowerCase();
    let hit;
    if (fam.match) hit = fam.match(strs);
    else if (fam.subs === null) hit = true;
    else if (fam.anyArg) hit = strs.some((v) => fam.subs.includes(String(v).toLowerCase()));
    else if (name === 'yarn' && strs.length === 0 && fam.target === BASE) hit = true;
    else hit = fam.subs.includes(sub);
    if (!hit) continue;
    if (fam.readOnly && fam.readOnly(positional.map(String))) return { kind: 'none' };
    const global = fam.globalFlags && strs.some((v) => fam.globalFlags.includes(v));
    return { kind: 'mutate', targets: [global ? GLOBAL : fam.target], label: `${name} ${sub}`.trim() };
  }

  return { kind: 'none' };
}

/** .NET file APIs in PowerShell, which no command word reveals. */
function dotnetWrites(raw) {
  const out = [];
  const re = /\[\s*(?:System\.)?IO\.(?:File|Directory|FileInfo|DirectoryInfo)\s*\]\s*::\s*(\w+)\s*\(\s*(?:(['"])(.*?)\2)?/gi;
  for (const m of raw.matchAll(re)) {
    if (/^(Read|Exists|Get|Enumerate|OpenRead|OpenText)/i.test(m[1])) continue;
    out.push({ label: `[IO]::${m[1]}`, target: m[2] ? m[3] : null });
  }
  if (/\[\s*(?:System\.)?IO\.(?:StreamWriter|FileStream)\s*\]\s*::\s*new|New-Object\s+(?:System\.)?IO\.(?:StreamWriter|FileStream)/i.test(raw)) {
    out.push({ label: 'a .NET file writer', target: null });
  }
  return out;
}

/** Split lexed items into simple commands, each with the operator after it. */
function commandsOf(items) {
  const cmds = [];
  let cur = { words: [], redirs: [] };
  for (const it of items) {
    if (it.t === 'op') {
      cur.next = it.v;
      cmds.push(cur);
      cur = { words: [], redirs: [] };
    } else if (it.t === 'redir') cur.redirs.push(it);
    else cur.words.push(it);
  }
  cmds.push(cur);
  return cmds.filter((c) => c.words.length || c.redirs.length);
}

function analyze(raw, ctx, shell, depth) {
  if (depth > MAX_DEPTH) {
    ctx.sawMutation = true;
    ctx.unresolved.push(`${String(raw).trim()} (nested too deeply to analyse)`);
    return;
  }

  for (const w of dotnetWrites(raw)) {
    ctx.sawMutation = true;
    judge(w.target === null ? null : { value: w.target, glob: false }, ctx, w.label);
  }

  for (const cmd of commandsOf(lex(raw, shell))) {
    // Expand words in order. Command substitutions run, so analyse them first.
    // The `$null` sink only means something as a redirect target.
    const words = cmd.words.map((w) => {
      const e = expandWord(w, ctx, shell);
      return e.value === SINK ? { ...e, value: '$null' } : e;
    });
    for (const w of words) for (const sub of w.subs) analyze(sub.text, childCtx(ctx), sub.shell, depth + 1);

    // Leading assignments: on their own they set shell variables for what follows.
    let k = 0;
    const assigns = [];
    while (k < words.length) {
      const v = cmd.words[k];
      const lead = v.parts[0]?.lit;
      const m = typeof lead === 'string' && lead.match(/^([A-Za-z_]\w*)=/);
      if (!m) break;
      const value = words[k].value === null ? null : String(words[k].value).slice(m[0].length);
      assigns.push([m[1], value]);
      k++;
    }
    // PowerShell `$x = 'value'` and `export X=…` / `local X=…` forms.
    if (shell === 'powershell' && cmd.words.length >= 2 && cmd.words[0].parts.length === 1 && cmd.words[0].parts[0].simple
      && words[1].value === '=') {
      ctx.vars[cmd.words[0].parts[0].var] = cmd.words.length === 3 ? words[2].value : null;
      continue;
    }
    if (['export', 'local', 'declare', 'readonly', 'typeset'].includes(words[0]?.value) && words.length > 1) {
      for (const w of words.slice(1)) {
        const m = typeof w.value === 'string' && w.value.match(/^([A-Za-z_]\w*)=(.*)$/s);
        if (m) ctx.vars[m[1]] = m[2];
      }
      continue;
    }
    if (words[0]?.value === 'unset') { for (const w of words.slice(1)) if (w.value) delete ctx.vars[w.value]; continue; }
    if (k === words.length && cmd.redirs.length === 0) {
      for (const [name, value] of assigns) ctx.vars[name] = value;
      continue;
    }

    // Redirects that write a file.
    for (const r of cmd.redirs) {
      if (!['>', '>>', '>|', '<>', '>&'].includes(r.op)) continue;
      if (!r.target) { ctx.sawMutation = true; ctx.unresolved.push('a redirect with no target'); continue; }
      const t = expandWord(r.target, ctx, shell);
      for (const sub of t.subs) analyze(sub.text, childCtx(ctx), sub.shell, depth + 1);
      if (t.value === SINK) continue;
      if (r.op === '>&' && typeof t.value === 'string' && /^(\d+|-)$/.test(t.value)) continue; // fd duplication
      if (typeof t.value === 'string' && SINKS.has(t.value.toLowerCase())) continue;
      ctx.sawMutation = true;
      judge(t, ctx, `redirect ${r.op}`);
    }

    const verdict = classify(words.slice(k), shell, depth);
    apply(verdict, cmd, ctx, depth);
  }
}

function childCtx(ctx) {
  return {
    ...ctx,
    bases: ctx.bases ? [...ctx.bases] : null,
    vars: { ...ctx.vars },
    // Results are shared with the parent: findings anywhere deny the command.
    offenders: ctx.offenders,
    unresolved: ctx.unresolved,
    get sawMutation() { return ctx.sawMutation; },
    set sawMutation(v) { ctx.sawMutation = v; },
  };
}

function apply(verdict, cmd, ctx, depth) {
  if (verdict.kind === 'none') return;

  if (verdict.kind === 'cd') {
    const t = verdict.target;
    let next = null;
    if (t && typeof t.value === 'string' && ctx.bases) {
      next = ctx.bases.map((b) => path.resolve(b, nativePath(t.value)));
    }
    // A cd that will certainly succeed moves the base. One that might fail
    // (target missing, unknown) leaves the old base possible too, unless `&&`
    // guarantees nothing after it runs on failure.
    const certain = next && next.every((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    if (next === null) ctx.bases = null;
    else if (certain || cmd.next === '&&') ctx.bases = next;
    else ctx.bases = [...new Set([...(ctx.bases || []), ...next])];
    return;
  }

  if (verdict.kind === 'recurse') {
    if (verdict.script === null) {
      ctx.sawMutation = true;
      ctx.unresolved.push('a nested command that is not known until it runs');
      return;
    }
    analyze(verdict.script, childCtx(ctx), verdict.shell, depth + 1);
    return;
  }

  if (verdict.kind === 'mutate') {
    ctx.sawMutation = true;
    for (const t of verdict.targets) judge(t, ctx, verdict.label);
  }
}

/** Decide one write target against every directory the command could run in. */
function judge(t, ctx, label) {
  if (t === GLOBAL) {
    ctx.unresolved.push(`${label} (changes state outside any directory)`);
    return;
  }
  if (t === null || (t !== BASE && t.value === null)) {
    ctx.unresolved.push(`${label} (target not known until it runs)`);
    return;
  }
  if (t !== BASE && typeof t.value === 'string' && t.value === '') return;
  const rel = t === BASE ? '.' : (t.glob ? globBase(t.value) : t.value);
  const native = nativePath(rel);
  if (!ctx.bases && !path.isAbsolute(native)) {
    ctx.unresolved.push(`${label} (working directory not known after cd)`);
    return;
  }
  const bases = path.isAbsolute(native) ? [native] : ctx.bases;
  for (const b of bases) {
    const abs = path.resolve(b, native);
    const c = canonical(abs);
    if (!ctx.roots.some((r) => c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`))) ctx.offenders.push(abs);
  }
}

// ================================================================= public API

/**
 * Judge a raw command.
 * @param {string} rawCommand
 * @param {{cwd: string, roots: string[], shell?: 'bash'|'powershell'|'cmd'}} options
 * @returns {{sawMutation: boolean, offenders: string[], unresolved: string[]}}
 *   `offenders` are resolved write targets outside every root; `unresolved` are
 *   writes that could not be pinned down. Either non-empty means DENY.
 */
export function analyzeShell(rawCommand, { cwd, roots, shell = 'bash' }) {
  const ctx = {
    bases: [cwd || process.cwd()],
    vars: {},
    roots: roots.filter(Boolean).map(canonical),
    offenders: [],
    unresolved: [],
    sawMutation: false,
  };
  analyze(String(rawCommand ?? ''), ctx, shell, 0);
  return { sawMutation: ctx.sawMutation, offenders: [...new Set(ctx.offenders)], unresolved: [...new Set(ctx.unresolved)] };
}

/** The guard's shell verdict in one call: `null` means pass, a result means deny. */
export function analyzeCommand(rawCommand, options) {
  const result = analyzeShell(rawCommand, options);
  const rule = matchPolicy(rawCommand, options.policy);
  // A deny pattern always wins; an allow pattern overrides the analysis.
  if (rule && rule.effect === 'deny') {
    return { ...result, sawMutation: true, unresolved: [...result.unresolved, `matches deny pattern "${rule.pattern}" (${rule.source})`] };
  }
  if (rule && rule.effect === 'allow') return null;
  if (!result.sawMutation) return null;
  if (result.offenders.length === 0 && result.unresolved.length === 0) return null;
  return result;
}

// ================================================================== policy
//
// Per-user and per-project command patterns, for the cases the analysis gets
// wrong in a particular codebase. A pattern is a wildcard over the whole command
// line: `*` spans anything, `?` is one character, case-insensitive.
//
//   user file    { "allow": ["make lint-fix"], "deny": ["./scripts/seed*"] }
//   project file { "deny": ["npm run migrate*"] }
//
// A project file may only DENY: it travels with the repository, so an allow there
// would let anything you clone loosen the lock. An allow that is nothing but
// wildcards is ignored for the same reason.

const wildcard = (pattern) => new RegExp(
  `^${String(pattern).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  'is',
);

/**
 * Load the user's and the project's patterns. Never throws: an unreadable file
 * contributes nothing and is named in `errors`.
 * @returns {{allow: {pattern, source}[], deny: {pattern, source}[], errors: string[]}}
 */
export function loadPolicy({ userFile, projectDir }) {
  const policy = { allow: [], deny: [], errors: [] };
  const read = (file) => {
    try {
      if (!file || !fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      policy.errors.push(`${file}: ${err && err.message}`);
      return null;
    }
  };
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

  const user = read(userFile);
  if (user) {
    for (const p of strings(user.allow)) {
      if (/^[\s*?]*$/.test(p)) { policy.errors.push(`${userFile}: ignored allow "${p}" (matches everything)`); continue; }
      policy.allow.push({ pattern: p, source: userFile });
    }
    for (const p of strings(user.deny)) policy.deny.push({ pattern: p, source: userFile });
  }
  const projectFile = projectDir ? path.join(projectDir, '.probe.json') : null;
  const project = read(projectFile);
  if (project) {
    if (strings(project.allow).length) policy.errors.push(`${projectFile}: "allow" is ignored in a project file (only "deny" is honoured)`);
    for (const p of strings(project.deny)) policy.deny.push({ pattern: p, source: projectFile });
  }
  return policy;
}

/** The first matching rule, deny before allow; null when nothing matches. */
export function matchPolicy(rawCommand, policy) {
  if (!policy) return null;
  const cmd = String(rawCommand ?? '').trim();
  for (const r of policy.deny || []) if (wildcard(r.pattern).test(cmd)) return { effect: 'deny', ...r };
  // An allow only covers one simple command: `make *` must not also wave through
  // `make x && rm -rf .`, and nothing hidden in a substitution or redirect.
  const items = lex(cmd, 'bash');
  const single = items.every((it) => it.t === 'word' && it.parts.every((p) => p.sub === undefined));
  if (!single) return null;
  for (const r of policy.allow || []) if (wildcard(r.pattern).test(cmd)) return { effect: 'allow', ...r };
  return null;
}

/**
 * OpenCode hands over a command already split into segments by its own scanner,
 * without the operators between them. Joined by newlines they are judged in
 * order, and a `cd` that might fail keeps the old directory possible too.
 */
export function analyzeSegments(segments, options) {
  return analyzeShell(segments.map(String).join('\n'), options);
}

/** For tests and the `check` subcommand: what one command word is classified as. */
export function describeCommand(rawCommand, shell = 'bash') {
  const words = commandsOf(lex(rawCommand, shell))[0]?.words.map((w) => expandWord(w, { vars: {}, bases: [process.cwd()] }, shell)) ?? [];
  const v = classify(words, shell, 0);
  return v.kind === 'mutate' ? { kind: v.kind, label: v.label } : { kind: v.kind };
}

/**
 * The `check` subcommand: would probe mode let this command run right now, and
 * why. Same analysis the guard runs, so the answer is the guard's answer.
 */
export function checkReport(rawCommand, { cwd, roots, shell = 'bash', phase = 'probe', policy = null }) {
  if (!String(rawCommand || '').trim()) return 'Usage: check "<command>" [--shell=powershell]';
  const r = analyzeShell(rawCommand, { cwd, roots, shell });
  const lines = [`Command: ${rawCommand}`, `Shell:   ${shell}`];
  for (const e of policy?.errors || []) lines.push(`Note: ${e}`);
  if (phase === 'implementing' || phase === 'off') {
    lines.push(`Verdict: ALLOW — writes are not blocked in the ${phase} phase.`);
    return lines.join('\n');
  }
  const rule = matchPolicy(rawCommand, policy);
  if (rule) {
    lines.push(`Verdict: ${rule.effect.toUpperCase()} — matches ${rule.effect} pattern "${rule.pattern}" in ${rule.source}`);
    return lines.join('\n');
  }
  if (!r.sawMutation) {
    lines.push('Verdict: ALLOW — it does not write anything.');
  } else if (!r.offenders.length && !r.unresolved.length) {
    lines.push('Verdict: ALLOW — every write lands inside the sandbox.');
  } else {
    lines.push('Verdict: DENY');
    for (const o of r.offenders) lines.push(`  writes outside the sandbox: ${o}`);
    for (const u of r.unresolved) lines.push(`  cannot pin down: ${u}`);
  }
  lines.push(`Writable roots: ${roots.filter(Boolean).join(', ') || 'none'}`);
  return lines.join('\n');
}
