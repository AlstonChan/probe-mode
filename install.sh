#!/usr/bin/env bash
# probe-mode standalone installer.
#
#   ./install.sh              install into ~/.claude
#   ./install.sh --uninstall  remove it again
#
# Works on macOS, Linux, and Windows via Git Bash. Requires node (Claude Code
# already needs a JS runtime, so you almost certainly have it).
#
# Everything it touches:
#   ~/.claude/hooks/probe-*.mjs                        created / removed
#   ~/.claude/skills/probe/                            created / removed
#   ~/.claude/settings.json                            hooks + statusLine merged
#   ~/.claude/settings.json.probe-backup-<timestamp>   written before any edit
#
# It never overwrites unrelated settings, and it refuses to clobber a statusLine
# you already have.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HOOKS_DIR="$CLAUDE_DIR/hooks"
SKILL_DIR="$CLAUDE_DIR/skills/probe"
SETTINGS="$CLAUDE_DIR/settings.json"

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✔%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
die()  { printf '%s✘%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node not found on PATH. Install Node.js, then re-run."

# Node needs a native path; Git Bash paths like /c/Users/... are not one.
topath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

backup_settings() {
  [ -f "$SETTINGS" ] || return 0
  local b="$SETTINGS.probe-backup-$(date +%Y%m%d-%H%M%S)"
  cp "$SETTINGS" "$b"
  say "${DIM}  backup: $b${OFF}"
}

# ---------------------------------------------------------------- uninstall
if [ "${1:-}" = "--uninstall" ]; then
  say "Uninstalling probe-mode..."
  backup_settings
  if [ -f "$SETTINGS" ]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      let n = 0;
      for (const evt of Object.keys(s.hooks || {})) {
        const before = s.hooks[evt].length;
        s.hooks[evt] = s.hooks[evt].filter((e) => !JSON.stringify(e).includes("probe-"));
        n += before - s.hooks[evt].length;
        if (!s.hooks[evt].length) delete s.hooks[evt];
      }
      if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
      if (s.statusLine && String(s.statusLine.command).includes("probe-statusline")) {
        delete s.statusLine;
        n++;
      }
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
      console.error(`  removed ${n} settings entr${n === 1 ? "y" : "ies"}`);
    ' "$(topath "$SETTINGS")"
  fi
  rm -f "$HOOKS_DIR"/probe-*.mjs
  rm -rf "$SKILL_DIR" "$CLAUDE_DIR/probe-state"
  ok "Uninstalled. Restart Claude Code."
  exit 0
fi

# ------------------------------------------------------------------ install
say "Installing probe-mode into $CLAUDE_DIR"
mkdir -p "$HOOKS_DIR" "$SKILL_DIR"

cp "$SRC"/hooks/probe-*.mjs "$HOOKS_DIR"/
ok "hooks    -> $HOOKS_DIR/probe-*.mjs"

# The shipped SKILL.md is written for plugin form. Rewrite the plugin-root
# placeholder to the standalone location. Must be a native path: node given a
# Git Bash path like /c/Users/... resolves it to C:\c\Users\... and fails.
sed 's|${CLAUDE_PLUGIN_ROOT}/hooks|'"$(topath "$CLAUDE_DIR")"'/hooks|g' \
  "$SRC/skills/probe/SKILL.md" > "$SKILL_DIR/SKILL.md"
ok "skill    -> $SKILL_DIR/SKILL.md"

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
backup_settings

# Prints KEPT_EXISTING on stdout if it declined to touch an existing statusLine.
NOTE="$(node -e '
  const fs = require("fs");
  const [p, dir] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  const cmd = (n) => `node "${dir}/hooks/${n}.mjs"`;

  s.hooks = s.hooks || {};
  const put = (evt, entry) => {
    s.hooks[evt] = (s.hooks[evt] || []).filter((e) => !JSON.stringify(e).includes("probe-"));
    s.hooks[evt].push(entry);
  };
  put("PreToolUse", {
    matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell",
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
  const foreign = s.statusLine && !String(s.statusLine.command).includes("probe-statusline");
  if (!foreign) {
    s.statusLine = { type: "command", command: cmd("probe-statusline"), padding: 0, refreshInterval: 2 };
  }

  fs.writeFileSync(p, JSON.stringify(s, null, 2));
  process.stdout.write(foreign ? "KEPT_EXISTING" : "");
' "$(topath "$SETTINGS")" "$(topath "$CLAUDE_DIR")")"

ok "settings -> $SETTINGS (hooks + statusLine merged)"

if [ "$NOTE" = "KEPT_EXISTING" ]; then
  warn "You already have a statusLine configured, so it was left untouched."
  warn "For the probe indicator, point statusLine at:"
  warn "  node \"$CLAUDE_DIR/hooks/probe-statusline.mjs\""
fi

say ""
ok "Done. Restart Claude Code, then run:  /probe <a question worth investigating>"
say "${DIM}Uninstall: $SRC/install.sh --uninstall${OFF}"
