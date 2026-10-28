# Agent rules for probe-mode

- Spec (binding): docs/superpowers/specs/2026-10-27-dev-feedback-loop-design.md
- Run `npm test` after every code change. The full suite takes ~80 s: while iterating run a single file (explicit paths, e.g. `node --test hooks/test/guard.test.mjs`; `node --test <dir>` breaks on Node 24) and run the full suite before committing.
- A bug fix starts with a failing test that reproduces the bug.
- `hooks/probe-guard.mjs` has no static imports of `shared/` or `hooks/probe-lib.mjs`; dynamic imports only inside try -> deny. It is fail-closed by design; keep its logging inlined.
- Logging never throws, never changes a decision, and is off unless `PROBE_RECORD` is set.
- Tests must not touch the real `~/.claude` or `~/.probe-mode`. Point `CLAUDE_CONFIG_DIR` and `PROBE_STATE_DIR` at temp dirs.
- Pure ESM `.mjs`, no build step, no runtime dependencies, `node --test` only.
- Commits: Conventional Commits, no Co-Authored-By or "Generated with" trailers.

## Smoke checklist

Run only after a host (Claude Code / OpenCode) update. Turn any drift into a promoted fixture plus a failing test.

1. **Arm.** `/probe <question>` (plain `/probe` on a standalone Claude install, `/probe-mode:probe` on the plugin).
   - Claude Code: git snapshot taken, sandbox created, `/probe status` shows phase `probe`.
   - OpenCode: same, via the `probe` agent; session rules `edit * -> deny` outside sandbox and plan dir are installed. Also try Shift+Tab to the Probe agent with no `/probe`: it should arm on the first message.
2. **Edit outside the sandbox is denied.** Ask the model to edit a project file, and run `/probe check 'rm x'`.
   - Claude Code: the PreToolUse guard denies `Edit`/`Write` with a reason; `check` reports deny.
   - OpenCode: the edit is rejected by the session `deny` rule; `check` reports deny. The model must report "Blocked by probe mode …", not a bare "Permission denied: edit" (that means the rewrite in `opencode/tool-hook.mjs` no longer matches the host's error shape). The model may refuse to try; tell it you want to see the error.
   - Sandbox writes succeed on both hosts.
3. **`/probe implement`, then approve.** Writes stay blocked while planning.
   - Claude Code: plan mode, plan written to `~/.claude/plans/`; approving `ExitPlanMode` unlocks (`implementing`). Denying or leaving plan mode otherwise stays locked.
   - OpenCode: phase `planning`; the first project write raises OpenCode's own permission dialog, allowing it (or answering the `Probe plan approval` question) unlocks. Needs a human; `--auto` approves it for you.
4. **`/probe approve` from a locked state** (phase `probe`, no plan).
   - Claude Code: no such command (OpenCode only); expect it to be unknown or refused. README is silent on exact wording, so note what you see.
   - OpenCode: README says it unlocks without writing anything; it does not say whether a locked `probe` phase (no `implement`) is refused. Record the observed result and check `/probe status`.
5. **Reporting subcommands do not start a model turn** (OpenCode only). Run `/probe status`, then `/probe restore`.
   - Each shows one notice with the full multi-line output; nothing appears as a user message and the model does not reply.
   - Then ask the model "what phase are we in?": it should answer from the notice.
6. **Subagent edit while armed is denied.** Ask the model to spawn a subagent to write a project file.
   - Claude Code: subagent shares the parent session_id; the guard denies its write.
   - OpenCode: child inherits the session rules and ancestry state; the write is denied.

## Capturing a bug

1. Start the host with `PROBE_RECORD=1` (PowerShell: `$env:PROBE_RECORD = '1'`, then launch the host from that same shell session; a variable set in another window records nothing) and reproduce. Logging is off otherwise.
2. Find the entry in `trace.jsonl`:
   - Claude: `<CLAUDE_CONFIG_DIR or ~/.claude>/probe-state/trace.jsonl`
   - OpenCode: `<PROBE_STATE_DIR or ~/.probe-mode>/trace.jsonl`
   - Line numbers are 1-based; strings over 2000 chars are truncated.
3. Promote it: `node scripts/promote-trace.mjs <file> <line> <name> --host-version <v>`. Writes `test/fixtures/<host>/<name>.json`; refuses to overwrite. Optional: `--phase <p>`, `--sandbox <path>`, `--out-dir <dir>`.
4. Write the failing test: `loadFixture` then `replayClaude` or `replayOpencode` from `test/fixtures/harness.mjs`, and assert the result equals `expected`. `expected` is what the hook did; for a bug, edit it to the correct decision first and watch the test fail. `replayOpencode` needs a harness from `createOpencodeHarness()`, with `h.close()` in a `finally`. `replayClaude` supports only the `guard` hook; `replayOpencode` only `permission.evaluate`; other hooks throw `unsupported hook`.

`setup` (phase, sandbox, cwd) is read at promote time from the sibling `<sessionId>.json` state file, not from the trace: promote soon after reproducing, or pass `--phase`/`--sandbox`.

Privacy: traces contain prompts and file contents. Local only, off by default; never commit trace files. Promoted fixtures are derived from traces (payload text, `cwd`, `transcript_path`, `session_id`, absolute paths): review and redact them before committing.

## Known gaps

- Fixtures cannot test model compliance (e.g. the OpenCode model coding directly instead of following research -> plan -> execute).
- The Claude guard allows tool names it does not know. A new host write tool must be added to the `hooks/hooks.json` PreToolUse matcher, its copy in `install.sh` (a test checks they match), `hooks/probe-guard.mjs`, and the tool list in `hooks/test/write-tools.test.mjs`.
- With `PROBE_RECORD` set, every Edit/Write/Bash in every Claude session is recorded, armed or not. `trace.jsonl` is never pruned and grows unbounded: delete it periodically.
- Replay fidelity: temp config dirs are used; OpenCode replay ignores `setup.cwd`; `plansDir`/`probe.json` come from the real home; strings over 2000 chars are truncated, so a long command may not reproduce a deny; a missing-state-file `allow` cannot be replayed.
- `Date`/`Map`/`Set`/`Error` values in payloads are logged as `{}`.
- `replayClaude` treats empty stdout as `allow` and does not check the process exit status, so a guard that fails to start would pass `allow` fixtures.
- `setup` is read at promote time and may be newer than the recorded moment.
