# Dev Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One enforced test command, an opt-in trace logger that captures real host payloads, a promote-to-fixture script, and two targeted test groups from the council review.

**Architecture:** `PROBE_RECORD` turns on JSONL logging in the OpenCode plugin handlers and the Claude `probe-guard` / `probe-promote` hooks. A script promotes a logged entry into `test/fixtures/<host>/<name>.json`. A small harness replays fixtures: Claude through the real hook subprocess, OpenCode through the real plugin with a stub ctx.

**Tech Stack:** Node built-ins only (`node:test`, `node:fs`, `node:child_process`).

**Spec:** `docs/superpowers/specs/2026-10-27-dev-feedback-loop-design.md`

## Global Constraints

- Pure JavaScript ESM (`.mjs`), no build step, no runtime dependencies, `node --test` only.
- `hooks/probe-guard.mjs` must not import from `shared/` or `probe-lib.mjs`. Its logging is an inlined function.
- Logging must never throw, never change a decision, and is off unless `PROBE_RECORD` is set.
- Logged strings longer than 2000 chars are truncated.
- Tests must not touch the real `~/.claude` or `~/.probe-mode`: use `CLAUDE_CONFIG_DIR` and `PROBE_STATE_DIR` pointed at temp dirs.
- Windows development environment: use `path.join`.

## Review Focus

1. `PROBE_RECORD` unset → no trace file is created and the decision is identical.
2. Trace file path unwritable (read-only or missing parent) → the hook still returns its normal decision.
3. Payload with circular structure or non-JSON values → logging is skipped, the decision is unaffected.
4. Very large payload (file contents in `tool_input`) → entry is truncated, not written whole.
5. Promote script given a line number beyond the file, or malformed JSON on that line → exits non-zero with a clear message and writes nothing.

---

### Task 1: Inner loop

**Files:**
- Create: `package.json`, `AGENTS.md`

**Interfaces:**
- Produces: `npm test` runs the whole suite.

- [ ] **Step 1: Baseline.** Run `node --version`, then `node --test`. Expected: all suites pass (about 491 tests). If bare discovery finds fewer files than the README claims, use an explicit file list in Step 2.
- [ ] **Step 2: Create `package.json`** with `"private": true`, `"type": "module"`, and `"scripts": { "test": "node --test" }` (explicit file list only if Step 1 showed gaps). No dependencies.
- [ ] **Step 3: Verify.** Run `npm test`. Expected: same pass count as Step 1.
- [ ] **Step 4: Create `AGENTS.md`** (under 30 lines): run `npm test` after every code change; a bug fix starts with a failing test; `probe-guard.mjs` must not import `shared/` or `probe-lib.mjs`; link to the spec. Add the 5-step smoke checklist section as a placeholder heading, filled in Task 6.
- [ ] **Step 5: Commit.**

```bash
git add package.json AGENTS.md
git commit -m "chore: add npm test script and agent rules"
```

---

### Task 2: Shared trace logger

**Files:**
- Create: `shared/trace.mjs`, `shared/test/trace.test.mjs`

**Interfaces:**
- Produces: `trace(stateDir: string, entry: { host: 'claude-code' | 'opencode', hook: string, sessionId?: string, input: unknown, decision?: unknown }): void`. Does nothing unless `process.env.PROBE_RECORD` is set. Appends one JSON line `{ at, host, hook, sessionId, input, decision }` to `path.join(stateDir, 'trace.jsonl')`, creating the directory if needed. Truncates every string value over 2000 chars (suffix `…[truncated]`). Never throws.

- [ ] **Step 1: Write failing tests** in `trace.test.mjs`, each using a temp `stateDir`:
  - `PROBE_RECORD` unset → no `trace.jsonl` exists (Review Focus 1).
  - set → one line parses to an object with all six fields.
  - a 5000-char string in `input` is truncated to 2000 chars plus the suffix (Review Focus 4).
  - a payload with a circular reference → returns without throwing and writes nothing (Review Focus 3).
  - `stateDir` is a path whose parent is a regular file → returns without throwing (Review Focus 2).
- [ ] **Step 2: Run** `node --test shared/test/trace.test.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `trace` in `shared/trace.mjs`.** Wrap the whole body in try/catch. Truncate with a recursive walk, not a regex on the serialized string.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add shared/trace.mjs shared/test/trace.test.mjs
git commit -m "feat: add opt-in trace logger for real host payloads"
```

---

### Task 3: Wire the logger into both hosts

**Files:**
- Modify: `hooks/probe-guard.mjs`, `hooks/probe-promote.mjs`, `opencode/permission-hook.mjs`, `opencode/tool-hook.mjs`, `opencode/approval-events.mjs`
- Test: `hooks/test/trace-wiring.test.mjs`, `opencode/test/trace-wiring.test.mjs`

**Interfaces:**
- Consumes: `trace` from Task 2.
- Produces: with `PROBE_RECORD=1`, each of these writes one entry per invocation with `hook` set to `guard`, `promote`, `permission.evaluate`, `tool.execute.after`, or `approval.event`, and `decision` set to what it decided (`allow`/`deny`, the final `event.effect`, or the unlock source).

- [ ] **Step 1: Write failing tests.**
  - Claude: run the real guard as a subprocess (pattern in `hooks/test/guard.test.mjs`) with `PROBE_RECORD=1` and a temp `CLAUDE_CONFIG_DIR`; assert `trace.jsonl` under `<CONFIG>/probe-state/` has one entry whose `decision` is `deny` for a `Write` outside the sandbox. A second case with `PROBE_RECORD` unset asserts the same `deny` and no trace file.
  - Claude: with the trace path made unwritable, the guard still prints the same deny (Review Focus 2).
  - OpenCode: using the stub-ctx pattern from `opencode/test/opencode-approval.test.mjs`, call `evaluate` for an out-of-sandbox edit and assert one entry with `hook: 'permission.evaluate'` and `decision: 'deny'`.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Instrument `probe-guard.mjs`** with an inlined `trace` function (same behavior as Task 2, copied, with a comment saying why it is not imported). Call it once, immediately before emitting the decision, inside try/catch.
- [ ] **Step 4: Instrument the other four files** by importing `trace` from `shared/trace.mjs`. Call it after the decision is made, not before.
- [ ] **Step 5: Run** both test files, then `npm test`. Expected: all pass, and no existing guard test changes behavior.
- [ ] **Step 6: Commit.**

```bash
git add hooks opencode
git commit -m "feat: log real hook and handler payloads when PROBE_RECORD is set"
```

---

### Task 4: Promote script and fixture replay

**Files:**
- Create: `scripts/promote-trace.mjs`, `test/fixtures/harness.mjs`, `test/fixtures/promote.test.mjs`

**Interfaces:**
- Produces:
  - CLI `node scripts/promote-trace.mjs <trace.jsonl> <line> <name> [--host-version <v>]`. `<line>` is 1-based. Writes `test/fixtures/<host>/<name>.json` with `{ host, hostVersion, capturedAt, scenario: name, hook, input, expected: decision }`. `hostVersion` defaults to `"unknown"`. Exits non-zero with a message and writes nothing when the line is missing or not valid JSON (Review Focus 5). Refuses to overwrite an existing fixture.
  - `loadFixture(host, name): Fixture` (throws naming the missing key).
  - `replayClaude(fixture, { configDir }): 'allow' | 'deny'`, running the real hook named by `fixture.hook` as a subprocess.
  - `replayOpencode(fixture, harness): unknown`, driving the real plugin through the stub ctx and returning the final `effect` or phase.

- [ ] **Step 1: Write failing tests** in `promote.test.mjs`: a sample trace file with two entries; promoting line 2 writes the expected JSON; line 9 exits non-zero and writes nothing; a malformed line exits non-zero; promoting the same name twice refuses the second; `loadFixture` on a file missing `hostVersion` throws naming it.
- [ ] **Step 2: Run** `node --test test/fixtures/promote.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the script and the three harness functions. The OpenCode stub ctx follows the pattern in `opencode/test/opencode-approval.test.mjs` (copy the shape, do not refactor that file).
- [ ] **Step 4: Add one round-trip test per host:** generate a trace entry with `PROBE_RECORD=1` (Task 3 tests' approach), promote it into a temp fixtures dir, replay it, and assert the replayed decision equals `expected`.
- [ ] **Step 5: Run** `npm test`. Expected: all pass.
- [ ] **Step 6: Commit.**

```bash
git add scripts test/fixtures
git commit -m "feat: add promote-trace script and fixture replay harness"
```

---

### Task 5: Council-driven targeted tests

**Files:**
- Test: `opencode/test/opencode-approval-nearmiss.test.mjs`, `hooks/test/write-tools.test.mjs`

**Interfaces:**
- Consumes: the stub-ctx pattern from `opencode/test/opencode-approval.test.mjs`; the guard subprocess pattern from `hooks/test/guard.test.mjs`.

- [ ] **Step 1: OpenCode near-miss answers.** In `opencode-approval-nearmiss.test.mjs`, with phase `planning`, answer the `Probe plan approval` question with each of `Approve.`, `Approve!`, `Approved`, `Approve it`, and `''`. Assert the phase stays `planning` for each. Add `'  APPROVE  '` and assert it unlocks (today's code trims and lowercases; this test pins it).
- [ ] **Step 2: Claude write-tool coverage.** In `write-tools.test.mjs`, define `WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']` and `SHELL_TOOLS = ['Bash', 'PowerShell']`. With phase `probe`, assert the guard denies each write tool targeting a path outside the sandbox, and each shell tool running a command that mutates outside it. Also assert every name in both lists appears in the `matcher` string of the `PreToolUse` entry in `hooks/hooks.json`. Add an unknown tool name `FutureWriteTool` with a `file_path` and assert the actual behavior, then record it in a comment (Review Focus on unknown tools: if the guard allows it while armed, report that to the owner instead of changing the test to pass).
- [ ] **Step 3: Run** both files. Expected: PASS, except a deliberate finding on unknown tools which must be reported.
- [ ] **Step 4: Commit.**

```bash
git add opencode/test hooks/test
git commit -m "test: pin approval near-misses and write-tool coverage"
```

---

### Task 6: Smoke checklist and usage notes

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Fill the smoke checklist** (about 5 steps, each with expected Claude Code and OpenCode behavior): arm probe; edit outside the sandbox is denied; `/probe implement` then approve unlocks; `/probe approve` from a locked state; a subagent edit while armed is denied.
- [ ] **Step 2: Add a "Capturing a bug" section** with the three commands: run with `PROBE_RECORD=1`, find the line in `trace.jsonl`, run `node scripts/promote-trace.mjs <file> <line> <name> --host-version <v>`, then write the failing test.
- [ ] **Step 3: Commit.**

```bash
git add AGENTS.md
git commit -m "docs: add smoke checklist and trace capture workflow"
```

---

## Self-Review

- Spec coverage: inner loop (Task 1), logger (Tasks 2, 3), promote and replay (Task 4), near-miss and write-tool tests (Task 5), smoke checklist (Task 6). The OpenCode redesign is a separate design pass.
- Review Focus 1–4 are pinned in Task 2 and Task 3, item 5 in Task 4.
- Names match across tasks: `trace`, `loadFixture`, `replayClaude`, `replayOpencode`, `PROBE_RECORD`.
- Open point: Task 5 may surface that an unknown tool name is allowed while armed. That is a finding to report, not to hide.
