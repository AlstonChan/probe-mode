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
   → ask follow-ups, test more, as many rounds of back-and-forth as it takes
you: "ok, implement it"
/probe implement          → plan mode, writes the plan, asks for approval
you approve the plan      → writes unlock, implementation proceeds
                          → keep executing directly, OR
/probe <next question>    → round 2: writes blocked again, research resumes
/probe restore            → rewind; every round keeps its own restore point
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
git clone https://github.com/AlstonChan/probe-mode.git && cd probe-mode
./install.sh
```

Installs into `~/.claude`, wires the status line, and keeps the skill as plain `/probe`.
It backs up `settings.json` first, merges rather than overwrites, and won't clobber a
`statusLine` you already have. Requires `node`; works on macOS, Linux, and Git Bash.

Restart Claude Code after either option.

## Commands

| | |
|---|---|
| `/probe <question>` | Arm the mode, or open a new research round if already armed |
| `/probe status` | Phase, round, sandbox, every round’s restore point |
| `/probe implement` | Move to plan mode (writes stay blocked until you approve) |
| `/probe restore` | Preview the rollback, then apply it after you confirm (`--undo` reverses it) |
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

If you use the in-project option, add `.probe-sandbox/` to that project's `.gitignore`.
It is a real directory inside your repo, so without the ignore rule your scratch scripts
and benchmark output show up as untracked files and eventually get committed by accident.

### The plan directory

`~/.claude/plans/` is writable by the **Edit and Write tools in every phase**. Plan mode
writes the plan there, so blocking it would break `/probe implement` at the exact moment
it is supposed to work.

It is deliberately **not** shell-writable. Nothing legitimately touches plan files from
bash, and treating it as a shell-writable root would permit `rm -rf` on your entire plan
history. Reading plans from the shell (`cat`, `ls`) is fine. The rest of `~/.claude` —
`settings.json`, `hooks/`, `skills/` — stays sealed in every phase.

## Rounds

The loop is meant to repeat:

```
round 1:  research ... research ... research  →  plan  →  implement
          then either keep executing directly,
          or /probe <question> again  →  round 2: research → plan → implement
```

Running `/probe <question>` while already armed opens a **new research round**: writes are
blocked again and a fresh snapshot is taken. Round 3 is as normal as round 1.

Each round keeps its own restore point, pinned to its own git ref — round 1 at
`refs/probe/<session>`, later rounds at `refs/probe/<session>-r<N>`. Going back to research
never costs you the ability to undo earlier work.

## Restore

`/probe start` takes a git snapshot using a temporary index, so it captures both
uncommitted changes and untracked files without touching your real index or working
tree. `/probe restore` stashes whatever is current (safety net — nothing is destroyed),
resets to the target commit, then restores the snapshot exactly. Your branch is left
where it was.

| | |
|---|---|
| `restore` | start of the **current** round (the default) |
| `restore --round N` | start of a specific round |
| `restore --all` | the very beginning, round 1 |
| `restore --undo` | reverse the last restore |

It previews first and changes nothing until you re-run with `--force`. Before applying, it
snapshots where you are, so **the restore itself is undoable** — and rolled-back commits
stay in `git reflog` on top of that.

**In a non-git directory there is no snapshot.** `/probe start` says so in red, and the
status line keeps saying so, because restore cannot save you there.

## Testing

```bash
node --test test/guard.test.mjs test/rounds.test.mjs
```

107 assertions. `guard.test.mjs` covers the allow/deny matrix — sandbox and plan-directory
writes, config sealing, path traversal, the shell deny-list, shell parsing, fail-closed
behavior, and that deny messages name the right command for the install layout.
`rounds.test.mjs` drives the real `probe-ctl` against a throwaway git repo to cover round
creation, snapshot durability under `git gc`, restore targeting, `--undo`, loading state
files written before rounds existed, and that `/probe` vs `/probe-mode:probe` resolves
correctly from the install layout.

Both run the real hooks as subprocesses and point `CLAUDE_CONFIG_DIR` at a temp directory,
so they never touch your real config. Run them before publishing a change — the deny cases
are the security contract.

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
- **Shell parsing is good, not complete.** `$VAR` expands only when assigned in the same
  command; an environment variable the guard cannot see makes the command deny rather than
  guess. Command substitution (`` $(...) ``) and `pushd`/`popd` are not tracked. Denying on
  the unknown is deliberate — the failure direction is friction, never a silent allow.

## Files

```
.claude-plugin/plugin.json       plugin manifest
.claude-plugin/marketplace.json  single-plugin marketplace catalog
hooks/hooks.json                 hook registration (plugin form)
hooks/probe-guard.mjs            PreToolUse — the enforcement
hooks/probe-promote.mjs          PostToolUse on ExitPlanMode — the only unlock
hooks/probe-context.mjs          UserPromptSubmit — re-injects the contract
hooks/probe-cleanup.mjs          SessionEnd — age-prunes only; never unlocks
hooks/probe-ctl.mjs              start/status/implement/restore/stop + rounds & snapshots
hooks/probe-statusline.mjs       status line row (invisible when off)
hooks/probe-lib.mjs              shared helpers
skills/probe/SKILL.md            the /probe command and its contract
LICENSE                          MIT
test/guard.test.mjs              guard allow/deny matrix (node --test)
test/rounds.test.mjs             rounds, snapshots, restore targeting
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
