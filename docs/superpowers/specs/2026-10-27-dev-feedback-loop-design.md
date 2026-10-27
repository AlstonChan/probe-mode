# Dev Feedback Loop for probe-mode

Date: 2026-10-27
Status: Revised after council review (replaces the first fixtures-only draft)

## Intent

Bugs in probe-mode are mostly found by the owner's real usage, which is slow. The
existing ~491 tests cover decision logic with hand-written payloads, and nobody
prompts the AI to run them. Two things are missing: a cheap enforced test loop, and
a way to turn real host payloads into regression tests without a hand-built recorder.

## What this does NOT fix

The owner's biggest complaint is that on OpenCode the model often codes directly
instead of following research → plan → execute. That is model behavior under prompt
steering and permission design. Recorded payloads replay deterministic handler code,
so no fixture can detect it. A green suite does not mean the OpenCode flow works.
That problem needs its own design pass (see Follow-up).

## Goals

- One command (`npm test`) runs the suite, and the AI is told to run it after every change.
- Real host payloads and decisions are captured during normal use by an opt-in
  logger, then promoted to fixtures when a bug appears.
- The OpenCode `question`-tool approval gate is tested against near-miss answers.
- The Claude Code guard is tested against a list of known write-capable tools, and
  `hooks.json` is checked to match that list.
- A short manual smoke checklist runs on host updates.

## Non-goals

- Headless real-session tests, CI setup.
- Hand-recording many scenarios up front. Fixtures grow one per real bug.
- Redesigning the OpenCode flow (separate follow-up).

## Anti-goals

- Treating green fixtures as evidence the OpenCode flow works.
- Fixtures that encode our own assumptions. They come from logged real payloads.
- A logger that can change a hook's decision, slow it noticeably, or leak data by default.

## Constraints

- Pure JavaScript ESM, no build step, no runtime dependencies, `node --test` only.
- `hooks/probe-guard.mjs` imports nothing from `shared/` or `probe-lib.mjs`
  (fail-closed design, see the header of `hooks/probe-lib.mjs`). Any logging there
  must be inlined and wrapped so it can never throw or alter the decision.
- `probe-statusline.mjs` is relocated by `probe-ctl setup` and also cannot import.
  It is not instrumented.
- Windows development environment.
- Logged payloads contain prompts and file contents. The logger is off by default,
  truncates long strings, and writes only to local disk.

## Approaches

1. **Opt-in runtime logger + promote-to-fixture (chosen, from council).** Set
   `PROBE_RECORD=1` and every hook and plugin handler appends its real input and
   decision to a JSONL file. One command copies a logged entry into a fixture.
   Fixtures accumulate from real use and each bug leaves a regression test.
2. Throwaway recorder wrapper plus a hand-recorded corpus (the first draft).
   Rejected: manual, done once and left to go stale, and the OpenCode wrapper
   depends on in-process internals.
3. Do only `npm test` and fix OpenCode by design. Close, but it leaves no path from
   a real-usage bug to a regression test. Kept as the follow-up, not the whole answer.

## Design

### 1. Inner loop
Root `package.json` with `npm test`, and `AGENTS.md` rules: run the suite after every
change, and every bug fix starts with a failing test.

### 2. Trace logger
- Enabled only when `PROBE_RECORD` is set. Each entry is one JSON line:
  `{ at, host, hook, sessionId, input, decision }`. Strings over 2000 chars are truncated.
- Written to `<stateDir>/trace.jsonl`. `<stateDir>` is the existing Claude state dir
  or the OpenCode `PROBE_STATE_DIR` / `~/.probe-mode`.
- Shared implementation in `shared/trace.mjs` for the OpenCode plugin and the
  non-guard Claude hooks. `probe-guard.mjs` gets a small inlined copy.
- Logging failures are swallowed. It must never change a decision.

### 3. Promote-to-fixture
`scripts/promote-trace.mjs <trace.jsonl> <line> <name> [--host-version <v>]` writes
`test/fixtures/<host>/<name>.json` with `host`, `hostVersion`, `capturedAt`,
`scenario`, `input`, `expected`. The harness replays it: Claude fixtures through the
real hook subprocess, OpenCode fixtures through the real plugin with a stub ctx (the
pattern in `opencode/test/opencode-approval.test.mjs`).

### 4. Targeted tests from the council
- OpenCode: near-miss `question` answers must not unlock: `APPROVE ` (case and
  whitespace are accepted by the code today and stay accepted), `Approve.`,
  `Approve!`, `Approved`, and an empty answer. Exact behavior is pinned by the test.
- Claude Code: a hand-maintained list of write-capable tool names (`Edit`, `Write`,
  `MultiEdit`, `NotebookEdit`, `Bash`, `PowerShell`, and any others) is each denied
  while armed outside the sandbox, and each appears in the `hooks.json` matcher.
  The host cannot be enumerated automatically, so the list is updated by hand when a
  host adds a tool.

### 5. Smoke checklist
About 5 steps on both hosts, run only after a host update. It lives in `AGENTS.md`.
Drift found becomes a logged-then-promoted fixture.

## Follow-up (separate design)
Make the OpenCode flow structural: a plugin-owned approval path so the unlock does not
depend on the model phrasing a `question` option, and deny-by-default until approval.
This is the real fix for "the model just codes directly".

## Known limitations
- Fixtures cannot see the host runtime, and cannot test model compliance.
- Fixtures reflect the host version they were logged from. The version is stored in each fixture.
- Instrumentation skips `probe-statusline.mjs`.

## Left to the builder
Exact JSONL field names beyond those listed, and how `hostVersion` is obtained when
the promote script is given none.
