# probe-mode

A research-only mode for Claude Code. It sources freely, proves ideas with real
benchmarks in a sandbox, and **cannot touch your project** until you explicitly ask
and approve a plan.

Plan mode blocks edits but can't write the benchmark that would settle the question.
Auto mode can write the benchmark but will happily start implementing. probe-mode is
the combination: full freedom to investigate, a sandbox to prove things in, and a hard
block on everything else.

```
/probe does batching actually help our throughput?
   → git snapshot taken, sandbox created
   → reads, greps, runs the test suite, writes a benchmark IN THE SANDBOX, runs it
   → reports the measurement, then stops
you: "ok, implement it"
/probe implement          → plan mode, writes the plan, asks for approval
you approve the plan      → writes unlock
/probe restore            → working tree back to the moment probe started
```

## Why it holds

This is not a prompt asking Claude nicely. Two mechanics do the work:

- **`PreToolUse` hooks run before any permission-mode check, in every mode.** A `deny`
  holds even under `bypassPermissions`. That's the write block.
- **`PostToolUse` on `ExitPlanMode` only fires when the tool succeeded** — i.e. when
  *you* approved the plan. That's the only thing that unlocks writes. Leaving plan mode
  any other way keeps the project locked.

A `UserPromptSubmit` hook re-injects the contract every turn, so it survives compaction.

Two things that were verified rather than assumed:

- **Subagents are covered.** A subagent shares its parent session_id and the guard runs on
  its tool calls, so "spawn an agent to write the file" does not get around the block.
- **Resume stays locked.** Resuming preserves the session_id, so `SessionEnd` deliberately
  does not delete a locked state — otherwise a resumed session would come back unlocked.
  It also keeps `implementing` state, because that is what backs `/probe restore`.
  The only automatic cleanup is a 30-day prune. Sandboxes are yours to delete; they get
  large once a build runs in one.

## Install

### Option A — plugin (recommended)

```
/plugin marketplace add AlstonChan/probe-mode
/plugin install probe-mode@alstonchan
```

Works with any git host, including self-hosted — pass a full URL instead of the
`owner/repo` shorthand. Pin to a release with `AlstonChan/probe-mode@v1.0.0`.

The skill becomes `/probe-mode:probe`, since plugin skills are always namespaced.
Installing with `install.sh` instead keeps it as plain `/probe`.

**Caveat:** a plugin cannot ship a `statusLine` — plugin `settings.json` only accepts
`agent` and `subagentStatusLine`. To get the status indicator, add this to
`~/.claude/settings.json` yourself:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<plugin-dir>/hooks/probe-statusline.mjs\"",
    "padding": 0,
    "refreshInterval": 2
  }
}
```

`refreshInterval` is not optional in practice. The phase changes when a hook writes a
file, and no status-line trigger fires on that — the row only re-runs on a new assistant
message, a permission-mode change, session start, `/compact`, a vim toggle, or this
timer. Approving a plan races the permission-mode refresh against the `PostToolUse` hook
that writes `implementing`, so without the timer the row can sit on cyan "planning" after
the plan was already approved. Two seconds makes it self-healing; raise it if you mind the
process spawn.

### Option B — installer script

```bash
git clone <your-git-url> probe-mode && cd probe-mode
./install.sh
```

Installs into `~/.claude`, wires the status line, and keeps the skill as plain `/probe`.
It backs up `settings.json` first, merges rather than overwrites, and won't clobber a
`statusLine` you already have. Requires `node`; works on macOS, Linux, and Git Bash.

Restart Claude Code after either option.

## Commands

| | |
|---|---|
| `/probe <question>` | Arm the mode and start investigating |
| `/probe status` | Current phase, sandbox path, snapshot ref |
| `/probe implement` | Move to plan mode (writes stay blocked until you approve) |
| `/probe restore` | Preview the rollback, then apply it after you confirm |
| `/probe stop` | Disarm without restoring |

`/probe` is `disable-model-invocation: true` — Claude cannot arm or disarm it, only you can.

## What's allowed while armed

**Allowed:** reads, greps, fetches, the test suite, benchmarks, profilers, `git status`
and `git diff`, and writing/running anything inside the sandbox. Sandbox scripts can be
run from the project directory, so they can import project code — reading the project is
fine, writing to it is not.

**Denied:** `Edit`/`Write` outside the sandbox, `git commit`, `npm install`, `rm`,
`sed -i`, redirects and `tee` into the project, formatters, codemods, `kubectl apply`,
PowerShell `Set-Content`.

The sandbox is `~/.claude/probe-state/<session-id>/sandbox/`, plus `.probe-sandbox/` in
the working directory if you prefer keeping artifacts next to the code.

### The plan directory

`~/.claude/plans/` is writable by the **Edit and Write tools in every phase**. Plan mode
writes the plan there, so blocking it would break `/probe implement` at the exact moment
it is supposed to work.

It is deliberately **not** shell-writable. Nothing legitimately touches plan files from
bash, and treating it as a shell-writable root would permit `rm -rf` on your entire plan
history. Reading plans from the shell (`cat`, `ls`) is fine. The rest of `~/.claude` —
`settings.json`, `hooks/`, `skills/` — stays sealed in every phase.

## Restore

`/probe start` takes a git snapshot using a temporary index, so it captures both
uncommitted changes and untracked files without touching your real index or working
tree. `/probe restore` stashes whatever is current (safety net — nothing is destroyed),
resets to the original commit, then restores the snapshot exactly. Your branch is left
where it was.

**In a non-git directory there is no snapshot.** `/probe start` says so in red, and the
status line keeps saying so, because restore cannot save you there.

## Testing

```bash
node --test test/guard.test.mjs
```

71 assertions covering the allow/deny matrix: sandbox and plan-directory writes, config
sealing, path traversal, the shell deny-list, and fail-closed behavior. It runs the real
hook as a subprocess against synthetic payloads and points `CLAUDE_CONFIG_DIR` at a temp
directory, so it never touches your real config. Run it before publishing a change.

## Known limits

- **`Edit`/`Write` blocking is airtight; Bash blocking is best-effort.** The hook sees
  `python bench.py`, not what that process writes. The git snapshot is the backstop.
  For a hard boundary, pair this with a worktree or the OS sandbox.
- **It cannot join the `Shift+Tab` cycle.** `chat:cycleMode` walks a hardcoded list of
  built-in permission modes, and no keybinding action can run a slash command, so there
  is no way to bind a key to it either.
- **Configuring any `statusLine` suppresses some footer hints** (`esc to interrupt`,
  `? for shortcuts`). That's Claude Code behavior for any status line, not this one.
- `cp project/file sandbox/` is denied even though the source is only read. Use
  Read-then-Write, or loosen the rule in `hooks/probe-guard.mjs`.
- **The shell rules are a deny-list, so they are fail-open for anything unlisted.** They
  cover package managers, migrations, deploys, publishing and downloads, but a build tool
  nobody thought of will pass. Treat the git snapshot, not the deny-list, as the real
  guarantee.

## Files

```
.claude-plugin/plugin.json       plugin manifest
.claude-plugin/marketplace.json  single-plugin marketplace catalog
hooks/hooks.json                 hook registration (plugin form)
hooks/probe-guard.mjs            PreToolUse — the enforcement
hooks/probe-promote.mjs          PostToolUse on ExitPlanMode — the only unlock
hooks/probe-context.mjs          UserPromptSubmit — re-injects the contract
hooks/probe-cleanup.mjs          SessionEnd — age-prunes only; never unlocks
hooks/probe-ctl.mjs              start/status/implement/restore/stop + snapshots
hooks/probe-statusline.mjs       status line row (invisible when off)
hooks/probe-lib.mjs              shared helpers
skills/probe/SKILL.md            the /probe command and its contract
LICENSE                          MIT
test/guard.test.mjs              regression suite (node --test)
install.sh                       standalone installer / uninstaller
```

`hooks/probe-lib.mjs` is shared by everything except `probe-guard.mjs`, which is
deliberately self-contained: an import that failed to parse would let writes through.

## Uninstall

```bash
./install.sh --uninstall          # installer version
/plugin uninstall probe-mode      # plugin version
```

The installer removes only its own entries and backs up `settings.json` first.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Alston Chan.
