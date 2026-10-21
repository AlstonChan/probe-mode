# probe-mode

A research-only mode for **Claude Code and OpenCode**. It sources freely, proves ideas
with real benchmarks in a sandbox, and **cannot touch your project** until you explicitly
ask and approve a plan.

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

## One repository, two hosts

Claude Code runs `hooks/` (a `PreToolUse` guard plus plan-mode approval); OpenCode runs
`opencode/` (a `probe` agent plus session-scoped permission rules). Both read `shared/`,
so the state shape, rounds, restore refs, retention sweep, shell path analysis and the
research contract are the same code on both sides — `test/rules.test.mjs` drives the real
Claude guard and the shared analysis over one command matrix and fails if they ever
disagree.

## Why it holds

This is not a prompt asking Claude nicely. Two mechanics do the work:

- **`PreToolUse` hooks run before any permission-mode check, in every mode.** A `deny`
  holds even under `bypassPermissions`. That's the write block.
- **`PostToolUse` on `ExitPlanMode` only fires when the tool succeeded** — i.e. when
  *you* approved the plan. That's the only thing that unlocks writes. Leaving plan mode
  any other way keeps the project locked.
- **An approval needs a plan behind it.** `implement` records when planning began; the
  guard denies `ExitPlanMode` until a plan file written after that exists, and the
  promote hook checks again before unlocking. A plan `Write` sent in the same batch as
  `ExitPlanMode` (and denied by some other hook) can no longer unlock on an empty plan,
  and neither can a stale plan from an earlier round.

A `UserPromptSubmit` hook re-injects the contract every turn, so it survives compaction.

Two things that were verified rather than assumed:

- **Subagents are covered.** A subagent shares its parent session_id and the guard runs on
  its tool calls, so "spawn an agent to write the file" does not get around the block.
- **Resume stays locked.** Resuming preserves the session_id, so `SessionEnd` deliberately
  does not delete a locked state — otherwise a resumed session would come back unlocked.
  It also keeps `implementing` state, because that is what backs `/probe restore`.
- **Pruning is phase-aware, and the already-unlocked states are the ones pruned early.**
  A `probe` or `planning` state is kept 30 days: deleting one would make a resumed
  session come back silently unlocked, which is a safety regression. An `implementing`
  or `off` state is already unlocked, so deleting it costs only restore history — those
  go after 7 days of not being used. An unreadable state file is never pruned at all,
  because the guard denies on one. `UserPromptSubmit` heartbeats the state file, so
  "7 days" means "not used in 7 days", not "approved 7 days ago". A sandbox is deleted
  with its own state file rather than on its own mtime, and orphaned sandboxes go after
  7 days.

### OpenCode's version of the same contract

OpenCode has no `PreToolUse` and no `ExitPlanMode`; its enforcement surface is
**permission rules**:

- **Session rules are evaluated after the agent's rules, and an explicit `deny` is
  final** — nothing, including a plugin permission hook, can soften it. An armed session
  installs `edit * → deny` outside the sandbox and plan directory, so the block holds even
  if the plugin is dead.
- **The approval is a real permission dialog.** In `planning` the same rule resolves to
  `ask`, so the first implementation write raises OpenCode's own dialog, and allowing it
  is what clears the rules. `/probe approve`, and answering the plan question the model
  asks with the `question` tool (header `Probe plan approval`), do the same thing.
- **The rules live in OpenCode's database, not in a state file** — rewriting the state
  cannot unlock a session. Subagents inherit the rules at creation, and the plugin
  resolves state through the session's ancestry so a child still gets the contract and
  the same shell analysis.
- The contract is re-injected on **every model request** (`session.hook("context")`), so
  it survives compaction with no per-prompt bookkeeping.
- Shell commands are parked at `ask` by the rules and then decided by a permission hook
  running the same path analysis as Claude's guard: target outside the sandbox → `deny`
  with a reason, target inside it → `allow`.

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
`agent` and `subagentStatusLine`. Run `/probe-mode:probe setup` once to get the status
indicator: it copies `probe-statusline.mjs` to a stable path outside the versioned plugin
cache (so `claude plugin update` deleting that directory doesn't break it) and wires
`~/.claude/settings.json` to point there, backing up your existing settings first and
never touching an existing `statusLine` that isn't already ours. Safe to re-run any time
— re-run it after this plugin updates to pick up statusline changes, since the copy is a
point-in-time snapshot (`/probe-mode:probe status` nudges you when it's gone stale).

Prefer to do it by hand, or already have a foreign `statusLine` to merge around yourself?
Add this to `~/.claude/settings.json`, replacing `<plugin-dir>` with this plugin's actual
install path (`claude plugin list` or check `~/.claude/plugins/installed_plugins.json`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<plugin-dir>/hooks/probe-statusline.mjs\"",
    "padding": 0,
    "refreshInterval": 10
  }
}
```

`refreshInterval` is not optional in practice. The phase changes when a hook writes a
file, and no status-line trigger fires on that — the row only re-runs on a new assistant
message, a permission-mode change, session start, `/compact`, a vim toggle, or this
timer. Approving a plan races the permission-mode refresh against the `PostToolUse` hook
that writes `implementing`, so without the timer the row can sit on cyan "planning" after
the plan was already approved. Ten seconds makes it self-healing without much churn.

It is not free, which is why the default is no longer 2. Claude Code runs the
statusLine command through bash, so on Windows every tick is a four-process chain —
two `bash.exe`, a `conhost.exe` and a `node.exe`. At the old two-second default that
measured about 524 process creations per minute across five open sessions, roughly
31,400 an hour. Ten seconds costs a fifth of that, and bounds the worst case to a row
that is at most ten seconds stale after an approval.

Pick your own: `/probe-mode:probe setup --refresh=5` for a snappier row, or
`./install.sh --refresh=60` if you want the churn gone. Re-running setup keeps
whatever value you chose — only an explicit `--refresh` overwrites it.

### Option B — installer script

```bash
git clone https://github.com/AlstonChan/probe-mode.git && cd probe-mode
./install.sh              # or: ./install.sh --refresh=30
./install.sh --opencode   # also wire the OpenCode host
```

Installs into `~/.claude`, wires the status line, and keeps the skill as plain `/probe`.
It backs up `settings.json` first, merges rather than overwrites, and won't clobber a
`statusLine` you already have. Requires `node`; works on macOS, Linux, and Git Bash.

Restart Claude Code after either option.

### OpenCode

`--opencode` writes two re-export shims into `<global-config>/plugins/probe/` (usually
`~/.config/opencode/plugins/probe/`) that point back at this checkout. OpenCode picks
them up automatically, your `opencode.json(c)` is never edited, and an update is a
`git pull`. Uninstall removes the shims.

Prefer to configure it yourself? Either works:

```jsonc
// opencode.json(c) — project or global
{ "plugins": ["D:/path/to/probe-mode/opencode"] }
```

or copy `opencode/` into `<global-config>/plugins/probe/`. Restart OpenCode, then check
`opencode plugin list` and `/agents` — the mode is a `probe` agent, so it appears in the
normal agent switcher (`Shift+Tab`) alongside Build and Plan.

## Commands

`/probe-mode:probe …` on a Claude plugin install; plain `/probe` otherwise. Both hosts
have the same subcommands except the two marked.

| | |
|---|---|
| `/probe <question>` | Arm the mode, or open a new research round if already armed |
| `/probe status` | Phase, round, sandbox, every round’s restore point, recent denials |
| `/probe implement` | Move to plan mode (writes stay blocked until you approve). Refuses when probe mode is off or writes are already unlocked, instead of re-locking them |
| `/probe approve` | **OpenCode only**: unlock without writing anything — the permission dialog and the plan question do the same thing |
| `/probe restore` | Preview the rollback, then apply it after you confirm (`--undo` reverses it) |
| `/probe diff [--round N] [--patch]` | What changed since a round’s snapshot, untracked files included. Read-only |
| `/probe check <command>` | Dry-run the guard: would this command be allowed right now, and why (`--shell=powershell` on Claude for a PowerShell command) |
| `/probe rounds [prune]` | List every round’s restore point; `prune` previews deleting all but the current one, `--force` applies it |
| `/probe export` | Write the round’s findings to one markdown file outside the project (see below) |
| `/probe stop` | Disarm without restoring. Only you can: the model running it on its own is denied |
| `/probe setup [--refresh=N]` | **Claude plugin installs only**: wire up the status-line indicator (no-op on standalone). `--refresh` sets the tick in seconds, default 10 |

`export` writes `~/.claude/probe-exports/<session>-r<N>.md` on Claude Code and
`~/.probe-mode/exports/` on OpenCode: the rounds, the sandbox listing, `findings.md` from
the sandbox if the model kept one, the changes since the round started, and the
denials. The sandbox itself is pruned after 7 days unused; the export is not.

`/probe` is `disable-model-invocation: true` in Claude Code — Claude cannot arm or
disarm it, only you can. OpenCode has no model-facing command tool, so the same holds
there: the model cannot run `/probe …`, only you can.

## What's allowed while armed

**Allowed:** reads, greps, fetches, the test suite, benchmarks, profilers, `git status`
and `git diff`, and writing/running anything inside the sandbox. Sandbox scripts can be
run from the project directory, so they can import project code — reading the project is
fine, writing to it is not.

**Denied:** `Edit`/`Write` outside the sandbox, `git commit`, `npm install`, `rm`,
`sed -i`, redirects and `tee` into the project, formatters, codemods, `kubectl apply`,
PowerShell `Set-Content` and `del`.

The shell analysis reads a command the way a shell would: quotes, heredocs, `$(…)`,
`bash -c`, `cd` between commands, git's global options, PowerShell aliases. It judges
each command by its command word, so `grep "rm"` or `cat src/cp.js` are reads, and a
write is judged by where it really lands, through symlinks and junctions. Writes to
`/dev/null`, `NUL` and `$null` are fine. When it cannot tell where a write lands, it
denies. `/probe check '<command>'` shows the verdict and the reason.

Every denial is logged to `<session>.denials.jsonl` next to the session's state, where
the model cannot write. `status` shows the latest ones.

### Your own allow and deny patterns

For the commands the analysis gets wrong in your codebase, list wildcard patterns (`*`
spans anything, `?` is one character, whole command line, case-insensitive):

```json
{ "allow": ["make lint-fix"], "deny": ["./scripts/seed*"] }
```

- **User file:** `~/.claude/probe.json` on Claude Code, `~/.probe-mode/probe.json` on
  OpenCode. It may allow and deny.
- **Project file:** `.probe.json` at the project root. It may only **deny**: it travels
  with the repository, so an allow there would let anything you clone loosen the lock.
- **Precedence:** a deny always wins.
- **Allow patterns only cover one plain command.** `make *` allows `make lint`, never
  `make x && rm -rf src`, a redirect, or a command substitution.
- **Patterns that are nothing but wildcards are ignored.**

The sandbox is `~/.claude/probe-state/<session-id>/sandbox/` on Claude Code and
`~/.probe-mode/<session-id>/sandbox/` on OpenCode (override the OpenCode root with
`PROBE_STATE_DIR`), plus `.probe-sandbox/` in the working directory if you prefer
keeping artifacts next to the code.

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
tree, and it records what was staged. `/probe restore` first snapshots whatever is
current as an undo point (nothing is destroyed — `--undo` puts it back), then resets
the branch to the target commit and restores the worktree and index exactly.

It always acts on the repository the session was armed in, wherever you run it from,
and only on the branch the snapshot was taken on: if a different branch is checked
out it refuses and tells you to switch back, rather than moving the wrong branch.

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
node --test
```

477 tests across 24 files. (Run it as bare `node --test` from the repo root, or
`node --test test/*.test.mjs` — Node's auto-discovery finds `test/*.test.mjs`.
`node --test test/` does **not** work on Node 24: it treats the argument as a module
entry point rather than a directory.) `guard.test.mjs` covers the allow/deny matrix — sandbox and plan-directory
writes, config sealing, path traversal, the shell deny-list, shell parsing, fail-closed
behavior, and that deny messages name the right command for the install layout.
`hooks-stdin.test.mjs` is the leak regression: every hook must exit when Claude Code
holds its stdin pipe open and never closes it. It is the one suite that cannot use
`execFileSync({ input })` like the others, because that closes stdin — which is exactly
why the hang survived the original 120 assertions. `cleanup.test.mjs` covers the
phase-aware retention matrix, sandbox pairing, and the heartbeat.
`rounds.test.mjs` drives the real `probe-ctl` against a throwaway git repo to cover round
creation, snapshot durability under `git gc`, restore targeting, `--undo`, loading state
files written before rounds existed, and that `/probe` vs `/probe-mode:probe` resolves
correctly from the install layout. `setup.test.mjs` covers the `setup` subcommand's
settings.json merge (backup, idempotency, foreign-statusLine preservation, invalid-JSON
handling) and the `status` staleness nudge.

Three suites cover the shared core and the OpenCode host:

- `rules.test.mjs` is the **cross-host contract**: it runs the real Claude guard as a
  subprocess over a command matrix (research commands, mutations, sandbox writes,
  redirects, `cd` laundering, interpreter-mediated mutators) and asserts that
  `shared/shell.mjs` — the analysis OpenCode's permission hook runs — reaches the same
  verdict, then checks the OpenCode rule shapes (phase → effect, writable roots, the
  state file staying unwritable, the shell fallback patterns).
- `contract.test.mjs` runs the real `probe-context.mjs` and asserts its output is
  byte-identical to `shared/contract.mjs`, and that the two hosts' contracts differ only
  in the lines naming their mechanism.
- `opencode.test.mjs` covers command parsing, status/prompt text, the phase → rules
  lifecycle, the blocked-call message rewrite, and the retention sweep.
  `opencode-approval.test.mjs` drives the real plugin with a stub host: only an explicit
  approval of a plan unlocks, and a child session can never carry stale rules into a
  new round.

The rest, one per behaviour:
- `shell.test.mjs`: every bypass and false denial an adversarial review found.
- `promote.test.mjs`, `stop-intent.test.mjs`: the only unlock, and the user-only stop.
- `restore.test.mjs`, `unborn.test.mjs`: restore acts on the right repo and branch,
  including repos with no commits yet.
- `state.test.mjs`: atomic writes and recovery from a corrupted state file.
- `statusline.test.mjs`, `denials.test.mjs`, `policy.test.mjs`: the status line,
  the denial log, and the allow/deny patterns.
- `check`, `diff`, `rounds-prune`, `export`, `implement`: one suite per subcommand.
- `install.test.mjs`: runs the real `install.sh`.

Everything Claude-side runs as a subprocess with `CLAUDE_CONFIG_DIR` pointed at a temp
directory, so nothing touches your real config. Run them before publishing a change — the
deny cases are the security contract.

## Known limits

- **`Edit`/`Write` blocking is airtight; Bash blocking is best-effort.** The hook sees
  `python bench.py`, not what that process writes. The git snapshot is the backstop.
  For a hard boundary, pair this with a worktree or the OS sandbox.
- **It cannot join Claude Code's `Shift+Tab` cycle.** `chat:cycleMode` walks a hardcoded
  list of built-in permission modes, and no keybinding action can run a slash command, so
  there is no way to bind a key to it either. On OpenCode it can: the mode *is* an agent,
  so `probe` shows up in `/agents` and cycles with `Shift+Tab` like Build and Plan.
- **Configuring any `statusLine` suppresses some footer hints** (`esc to interrupt`,
  `? for shortcuts`). That's Claude Code behavior for any status line, not this one.
- **The shell rules are a deny-list, so they are fail-open for anything unlisted.** They
  cover file verbs, git, package managers, formatters, migrations, deploys, publishing
  and downloads, but a build tool nobody thought of will pass, and an interpreter running
  inline code (`python -c "open('f','w')…"`, `node -e …`) is not read at all. Add a deny
  pattern for anything that matters in your codebase. Treat the git snapshot, not the
  deny-list, as the real guarantee.
- **Shell parsing is good, not complete.** `$VAR` expands only when assigned earlier in
  the same command (or for a few safe environment variables like `HOME`); anything else
  makes a write deny rather than guess. `cd -`, `pushd`/`popd` and input from `xargs`
  make later writes unknowable, so they deny too. The failure direction is friction,
  never a silent allow.
- **Your user `probe.json` can loosen the lock, and during `implementing` the model can
  write to it.** It can equally rewrite the hooks themselves in that phase, since
  everything is unlocked then. A project `.probe.json` can never loosen it.
- **`/probe setup` has no uninstall counterpart.** If the plugin is later removed with
  `claude plugin uninstall`, the stable `probe-statusline.mjs` copy and the `statusLine`
  entry in `settings.json` both survive as orphans — the indicator keeps rendering with no
  guard hook actually installed to back its claims up. Remove `~/.claude/probe-state/` and
  the `statusLine` entry by hand if you uninstall.
- **OpenCode's approval dialogs need a human, so they are covered by rule-shape tests,
  not a headless run.** The `planning` permission dialog and the `question`-tool answer
  only appear in an interactive TUI; what the automated run verified was everything around
  them — arming, the hard `deny`, `approve`, both restore steps, a second round, and
  `stop`.
- **On OpenCode the wildcard shell fallback misses `echo x>file`** (no space around the
  `>` — whole-value wildcards cannot match it). The permission hook's analysis still
  denies it, so this only matters if the hook is not running.
- **`opencode --auto` approves the planning dialog for you.** It auto-approves `ask`
  decisions, which is exactly what the approval moment is; configured `deny`s are still
  enforced, so the `probe`-phase block holds.
- **On OpenCode the footer row is a plugin component reading the state file.** It is not
  under test (the TUI cannot run headlessly) and, if your server is remote, the row only
  renders where the state file lives.
- **`/probe restore` is two commands you type.** OpenCode models cannot invoke slash
  commands, so unlike Claude there is no model-side "confirm then re-run" loop: the
  preview tells you to run `/probe restore --force` yourself.

## Files

```
.claude-plugin/plugin.json       plugin manifest
.claude-plugin/marketplace.json  single-plugin marketplace catalog
hooks/hooks.json                 hook registration (plugin form)
hooks/probe-guard.mjs            PreToolUse — the enforcement
hooks/probe-promote.mjs          PostToolUse on ExitPlanMode — the only unlock
hooks/probe-plan.mjs             was a plan written this planning phase? (guard + promote)
hooks/probe-context.mjs          UserPromptSubmit — re-injects the contract
hooks/probe-cleanup.mjs          SessionEnd — age-prunes only; never unlocks
hooks/probe-ctl.mjs              every subcommand; rounds & snapshots
hooks/probe-statusline.mjs       status line row (invisible when off)
hooks/probe-lib.mjs              shared helpers (Claude wiring: config dir, command name, stdin)
skills/probe/SKILL.md            the /probe command and its contract (Claude Code)
shared/state.mjs                 state shape, atomic writes, rounds/refs, heartbeat, retention, denial log
shared/git.mjs                   snapshot, restore preview/apply, diff, rounds (both hosts)
shared/contract.mjs              the research contract, incl. the host-specific mechanism lines
shared/rules.mjs                 OpenCode session rules, shell fallback patterns, messages
shared/shell.mjs                 shell analysis, check, allow/deny patterns (both hosts)
shared/export.mjs                the export subcommand
opencode/index.mjs               OpenCode server plugin: agent, commands, hooks, approval
opencode/lib.mjs                 command parsing, status text, prompts (pure, unit-tested)
opencode/tui.tsx                 OpenCode footer status row (invisible when off)
opencode/package.json            plugin entry points
LICENSE                          MIT
test/guard.test.mjs              guard allow/deny matrix (node --test)
test/hooks-stdin.test.mjs        every hook must exit on a never-closed stdin pipe
test/cleanup.test.mjs            phase-aware pruning + the liveness heartbeat
test/rounds.test.mjs             rounds, snapshots, restore targeting
test/setup.test.mjs              setup subcommand, settings.json merge, status nudge
test/rules.test.mjs              cross-host parity: real guard vs shared analysis, rule shapes
test/contract.test.mjs           Claude hook output == shared contract (host lines only)
test/opencode.test.mjs           parsing, prompts, lifecycle, message rewrite, retention
test/*.test.mjs                  one suite per behaviour (see Testing)
install.sh                       standalone installer / uninstaller (--opencode for OpenCode)
```

`hooks/probe-lib.mjs` is shared by everything except `probe-guard.mjs`, which has no
static imports: one that failed to load would crash it before its fail-closed handlers
exist, and Claude Code runs the tool when a PreToolUse hook exits non-zero. It loads
`shared/shell.mjs` and `hooks/probe-plan.mjs` with dynamic imports inside a `try`, so a
broken module denies.
Both hosts run that one analysis, and `test/rules.test.mjs` still checks the real guard
and the module reach the same verdict.

## Uninstall

```bash
./install.sh --uninstall                  # installer version (also removes the OpenCode shims)
./install.sh --uninstall --purge          # ...and delete probe-state/ (sessions, sandboxes)
./install.sh --uninstall --opencode-only  # remove only the OpenCode shims
/plugin uninstall probe-mode              # plugin version
```

The installer removes only its own hook entries — matched by the exact script they
run, so a hook of yours that merely has "probe" in its name is left alone — and backs
up `settings.json` first (the newest five backups are kept). It keeps
`~/.claude/probe-state/` unless you pass `--purge`: a plugin install shares that
directory, and deleting a locked session's state would silently unlock it. For a
hand-configured OpenCode install, delete the `plugins` entry from `opencode.json(c)` or
the copied `plugins/probe/` directory.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Alston Chan.
