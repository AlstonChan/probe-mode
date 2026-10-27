#!/usr/bin/env bash
# probe-mode standalone installer.
#
#   ./install.sh                 install into ~/.claude
#   ./install.sh --opencode      also wire the OpenCode host
#   ./install.sh --refresh=30    install, status line ticks every 30s
#   ./install.sh --uninstall     remove it again (session state is kept)
#   ./install.sh --uninstall --purge          ...and delete probe-state/ too
#   ./install.sh --uninstall --opencode-only  remove only the OpenCode shim
#
# Works on macOS, Linux, and Windows via Git Bash. Requires node (Claude Code
# already needs a JS runtime, so you almost certainly have it).
#
# Everything it touches:
#   ~/.claude/hooks/probe-*.mjs                        created / removed
#   ~/.claude/shared/*.mjs                             created / removed
#   ~/.claude/skills/probe/                            created / removed
#   ~/.claude/settings.json                            hooks + statusLine merged
#   ~/.claude/settings.json.probe-backup-<timestamp>   written before any edit (last 5 kept)
#   ~/.config/opencode/plugins/probe/                  with --opencode
#
# It never overwrites unrelated settings — only hook entries whose command runs one
# of probe-mode's own hook scripts are ever replaced or removed — and it refuses to
# clobber a statusLine you already have. The OpenCode side is a two-line shim per entry point that
# re-exports this checkout, so opencode.json(c) is never edited.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HOOKS_DIR="$CLAUDE_DIR/hooks"
SHARED_DIR="$CLAUDE_DIR/shared"
SKILL_DIR="$CLAUDE_DIR/skills/probe"
SETTINGS="$CLAUDE_DIR/settings.json"
OPENCODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_SHIM="$OPENCODE_DIR/plugins/probe"

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✔%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
die()  { printf '%s✘%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node not found on PATH. Install Node.js, then re-run."

# ------------------------------------------------------------------ options
# Keep REFRESH_DEFAULT in sync with DEFAULT_REFRESH_INTERVAL in hooks/probe-lib.mjs.
# The two installers are independent implementations by design, so the default is
# duplicated; change it in both.
REFRESH_DEFAULT=10
REFRESH=""
UNINSTALL=0
OPENCODE=0
PURGE=0
OPENCODE_ONLY=0

usage() {
  say "Usage: ./install.sh [--opencode] [--refresh=N] [--uninstall [--purge] [--opencode-only]]"
  say "  --opencode    also wire the OpenCode host (writes a plugin shim, never edits opencode.json)"
  say "  --refresh=N   status-line refresh in seconds (default ${REFRESH_DEFAULT}, 1-3600)"
  say "  --uninstall   remove probe-mode again (keeps probe-state/, which a plugin install may share)"
  say "  --purge       with --uninstall: also delete probe-state/ (session state and sandboxes)"
  say "  --opencode-only  with --uninstall: remove only the OpenCode plugin shim"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall)  UNINSTALL=1 ;;
    --opencode)   OPENCODE=1 ;;
    --purge)      PURGE=1 ;;
    --opencode-only) OPENCODE_ONLY=1 ;;
    --refresh=*)  REFRESH="${1#--refresh=}" ;;
    # The explicit arity check matters: a bare trailing --refresh would otherwise
    # shift an empty stack, which under `set -e` exits with no message at all.
    --refresh)    [ $# -ge 2 ] || die "--refresh needs a value, e.g. --refresh=30"
                  shift; REFRESH="$1" ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

if [ "$UNINSTALL" = "0" ] && { [ "$PURGE" = "1" ] || [ "$OPENCODE_ONLY" = "1" ]; }; then
  die "--purge and --opencode-only only apply to --uninstall"
fi

if [ -n "$REFRESH" ]; then
  case "$REFRESH" in
    ''|*[!0-9]*) die "--refresh must be a whole number of seconds (got: $REFRESH)" ;;
  esac
  { [ "$REFRESH" -ge 1 ] && [ "$REFRESH" -le 3600 ]; }     || die "--refresh must be between 1 and 3600 seconds (got: $REFRESH)"
  [ "$UNINSTALL" = "0" ] || warn "--refresh has no effect with --uninstall; ignoring it."
fi

# Node needs a native path; Git Bash paths like /c/Users/... are not one.
topath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# Unique even for two runs in the same second, and only the newest few are kept.
backup_settings() {
  [ -f "$SETTINGS" ] || return 0
  local stamp b n=0
  stamp="$(date +%Y%m%d-%H%M%S)"
  b="$SETTINGS.probe-backup-$stamp"
  while [ -e "$b" ]; do n=$((n + 1)); b="$SETTINGS.probe-backup-$stamp-$n"; done
  cp "$SETTINGS" "$b"
  say "${DIM}  backup: $b${OFF}"
  # Names sort chronologically; drop all but the newest 5. In node: head -n -N
  # is GNU-only and macOS ships BSD head.
  node -e "
    const fs = require(\"fs\"), path = require(\"path\");
    const p = process.argv[1], dir = path.dirname(p), base = path.basename(p) + \".probe-backup-\";
    const all = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
    for (const f of all.slice(0, -5)) fs.unlinkSync(path.join(dir, f));
  " "$(topath "$SETTINGS")"
}

# Shared by install and uninstall: a hook command is ours only when it runs one
# of probe-mode's own hook scripts. Matching any "probe-" substring used to
# delete a user's own "my-probe-logger.sh". Only our entries leave a matcher
# group; a group is dropped only once nothing else is left in it.
OURS_JS='
  const OURS = /[\\/]hooks[\\/]probe-(guard|promote|context|cleanup)\.mjs\b/;
  const stripOurs = (s) => {
    let n = 0;
    for (const evt of Object.keys(s.hooks || {})) {
      if (!Array.isArray(s.hooks[evt])) continue;
      s.hooks[evt] = s.hooks[evt].map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const kept = group.hooks.filter((h) => !OURS.test(String(h && h.command)));
        n += group.hooks.length - kept.length;
        return kept.length ? { ...group, hooks: kept } : null;
      }).filter(Boolean);
      if (!s.hooks[evt].length) delete s.hooks[evt];
    }
    if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
    return n;
  };
  const isOurStatusLine = (s) => Boolean(s.statusLine) && /probe-statusline\.mjs/.test(String(s.statusLine.command));
'

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = "1" ]; then
  if [ "$OPENCODE_ONLY" = "1" ]; then
    if [ -d "$OPENCODE_SHIM" ]; then rm -rf "$OPENCODE_SHIM"; ok "Removed $OPENCODE_SHIM. Restart OpenCode."
    else say "No OpenCode shim at $OPENCODE_SHIM; nothing to remove."; fi
    exit 0
  fi
  say "Uninstalling probe-mode..."
  backup_settings
  if [ -f "$SETTINGS" ]; then
    node -e "$OURS_JS"'
      const fs = require("fs");
      const p = process.argv[1];
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      let n = stripOurs(s);
      if (isOurStatusLine(s)) {
        delete s.statusLine;
        n++;
      }
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
      console.error(`  removed ${n} settings entr${n === 1 ? "y" : "ies"}`);
    ' "$(topath "$SETTINGS")"
  fi
  rm -f "$HOOKS_DIR"/probe-*.mjs
  rm -f "$SHARED_DIR"/state.mjs "$SHARED_DIR"/git.mjs "$SHARED_DIR"/contract.mjs \
        "$SHARED_DIR"/rules.mjs "$SHARED_DIR"/shell.mjs "$SHARED_DIR"/export.mjs "$SHARED_DIR"/trace.mjs
  # Only removes it when empty: a pre-existing ~/.claude/shared of your own
  # must survive an uninstall.
  rmdir "$SHARED_DIR" 2>/dev/null || true
  rm -rf "$SKILL_DIR"
  # probe-state/ is shared with a plugin install of probe-mode: deleting a locked
  # session's state there would silently unlock it. Only --purge removes it.
  if [ "$PURGE" = "1" ]; then
    rm -rf "$CLAUDE_DIR/probe-state"
    say "${DIM}  removed $CLAUDE_DIR/probe-state${OFF}"
  elif [ -d "$CLAUDE_DIR/probe-state" ]; then
    say "${DIM}  kept $CLAUDE_DIR/probe-state (session state; --purge removes it)${OFF}"
  fi
  if [ -d "$OPENCODE_SHIM" ]; then
    rm -rf "$OPENCODE_SHIM"
    say "${DIM}  removed $OPENCODE_SHIM${OFF}"
  fi
  ok "Uninstalled. Restart Claude Code (and OpenCode, if you used --opencode)."
  exit 0
fi

# ------------------------------------------------------------------ install
say "Installing probe-mode into $CLAUDE_DIR"
mkdir -p "$HOOKS_DIR" "$SHARED_DIR" "$SKILL_DIR"

cp "$SRC"/hooks/probe-*.mjs "$HOOKS_DIR"/
ok "hooks    -> $HOOKS_DIR/probe-*.mjs"

# probe-ctl/probe-lib/probe-context import ../shared/*, which resolves to
# ~/.claude/shared in this layout — the same relative path they use in the
# checkout, so no per-install rewriting is needed.
cp "$SRC"/shared/*.mjs "$SHARED_DIR"/
ok "shared   -> $SHARED_DIR/*.mjs"

# The shipped SKILL.md is written for plugin form. Rewrite the plugin-root
# placeholder to the standalone location. Must be a native path: node given a
# Git Bash path like /c/Users/... resolves it to C:\c\Users\... and fails.
# Done in node, not sed: a "&" or "|" in the install path is special in a sed
# replacement and silently corrupted every command in the skill.
node -e '
  const fs = require("fs");
  const [src, dest, dir] = process.argv.slice(1);
  const text = fs.readFileSync(src, "utf8").split("${CLAUDE_PLUGIN_ROOT}/hooks").join(dir + "/hooks");
  fs.writeFileSync(dest, text);
' "$(topath "$SRC/skills/probe/SKILL.md")" "$(topath "$SKILL_DIR/SKILL.md")" "$(topath "$CLAUDE_DIR")"
ok "skill    -> $SKILL_DIR/SKILL.md"

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
backup_settings

# Prints KEPT_EXISTING on stdout if it declined to touch an existing statusLine.
NOTE="$(node -e "$OURS_JS"'
  const fs = require("fs");
  const [p, dir, refreshArg, defRefresh] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  const cmd = (n) => `node "${dir}/hooks/${n}.mjs"`;

  stripOurs(s);
  s.hooks = s.hooks || {};
  const put = (evt, entry) => {
    s.hooks[evt] = s.hooks[evt] || [];
    s.hooks[evt].push(entry);
  };
  put("PreToolUse", {
    matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|ExitPlanMode",
    hooks: [{ type: "command", command: cmd("probe-guard"), timeout: 20, statusMessage: "probe mode: checking" }],
  });
  put("PostToolUse", {
    matcher: "ExitPlanMode",
    hooks: [{ type: "command", command: cmd("probe-promote"), timeout: 20 }],
  });
  put("UserPromptSubmit", { hooks: [{ type: "command", command: cmd("probe-context"), timeout: 15 }] });
  put("SessionEnd",       { hooks: [{ type: "command", command: cmd("probe-cleanup"), timeout: 15 }] });

  // refreshInterval matters: the phase changes when a hook writes a file, and
  // no status-line trigger fires on that. Without a timer the row can sit stale
  // (cyan "planning" after a plan was already approved) until the next
  // assistant message happens to re-run the command.
  //
  // It is not free either. Claude Code runs the statusLine command through bash,
  // so on Windows every tick is a four-process chain. Hence a 10s default you can
  // override with --refresh=N. An ours-but-customized value is preserved on
  // re-install: only an explicit --refresh overwrites it.
  const DEFAULT_REFRESH = Number(defRefresh) || 10;
  const override = /^[0-9]+$/.test(refreshArg || "") ? Number(refreshArg) : null;
  const foreign = Boolean(s.statusLine) && !isOurStatusLine(s);
  let chosen = null;
  if (!foreign) {
    const prev = Number(s.statusLine && s.statusLine.refreshInterval);
    const kept = Number.isInteger(prev) && prev >= 1 && prev <= 3600 ? prev : null;
    chosen = override != null ? override : (kept != null ? kept : DEFAULT_REFRESH);
    s.statusLine = { type: "command", command: cmd("probe-statusline"), padding: 0, refreshInterval: chosen };
  }

  fs.writeFileSync(p, JSON.stringify(s, null, 2));
  process.stdout.write(foreign ? "KEPT_EXISTING" : `REFRESH=${chosen}`);
' "$(topath "$SETTINGS")" "$(topath "$CLAUDE_DIR")" "${REFRESH:-}" "$REFRESH_DEFAULT")"

ok "settings -> $SETTINGS (hooks + statusLine merged)"

case "$NOTE" in
  REFRESH=*) say "${DIM}  status-line refresh: ${NOTE#REFRESH=}s (change with --refresh=N)${OFF}" ;;
esac

if [ "$NOTE" = "KEPT_EXISTING" ]; then
  warn "You already have a statusLine configured, so it was left untouched."
  warn "For the probe indicator, point statusLine at:"
  warn "  node \"$CLAUDE_DIR/hooks/probe-statusline.mjs\""
fi

if [ "$OPENCODE" = "1" ]; then
  mkdir -p "$OPENCODE_SHIM"
  # Two re-export shims (server entry + TUI entry) pointing back at this
  # checkout, so OpenCode picks the plugin up from its global config directory
  # and always runs the code you have on disk. opencode.json(c) is never
  # touched, and an update is just a git pull.
  node -e '
    const fs = require("fs");
    const path = require("path");
    const { pathToFileURL } = require("url");
    const [dir, src] = process.argv.slice(1);
    const shim = (name) => {
      const target = pathToFileURL(path.join(src, "opencode", name)).href;
      fs.writeFileSync(path.join(dir, name === "index.mjs" ? "index.mjs" : "tui.tsx"),
        `export { default } from ${JSON.stringify(target)};\n`);
    };
    shim("index.mjs");
    shim("tui.tsx");
  ' "$(topath "$OPENCODE_SHIM")" "$(topath "$SRC")"
  ok "opencode -> $OPENCODE_SHIM (plugin shim)"
fi

say ""
ok "Done. Restart Claude Code, then run:  /probe <a question worth investigating>"
say "${DIM}Uninstall: $SRC/install.sh --uninstall${OFF}"
