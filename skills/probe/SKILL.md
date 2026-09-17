---
name: probe
description: Auto-mode research that can never touch the project. Sources freely, writes benchmark/validation scripts only in a sandbox, proves the idea, and refuses to implement until you explicitly ask and approve a plan.
disable-model-invocation: true
argument-hint: [start|status|implement|restore|stop] <question>
allowed-tools: Bash(node *)
---

Run the control command for `$ARGUMENTS`, then follow the contract below.

- no subcommand, or `start` → `node "${CLAUDE_PLUGIN_ROOT}/hooks/probe-ctl.mjs" start`, then investigate the question in `$ARGUMENTS`.
- `status` → `node "${CLAUDE_PLUGIN_ROOT}/hooks/probe-ctl.mjs" status` and report it.
- `implement` → `node "${CLAUDE_PLUGIN_ROOT}/hooks/probe-ctl.mjs" implement`, then call **EnterPlanMode** and write the plan.
- `restore` → run `node "${CLAUDE_PLUGIN_ROOT}/hooks/probe-ctl.mjs" restore`. This is a
  **preview that changes nothing**. Show the user exactly what it printed — especially any
  commits it would roll back — and wait for them to confirm. Only then re-run the same
  command with `--force`. Never pass `--force` on your own initiative, and never pass it in
  the same turn the user asked to restore.
- `stop` → `node "${CLAUDE_PLUGIN_ROOT}/hooks/probe-ctl.mjs" stop`.

## The contract

**You may**: read, search, grep, fetch, run the test suite, run benchmarks, profile,
inspect dependencies, query anything read-only. Go as deep as the question needs
without stopping to ask permission for each step.

**You may write only inside the sandbox** the control command printed. That is where
benchmark harnesses, validation scripts, spike implementations, assertion scripts and
their output go. Run them from the project directory if they need to import project
code — reading the project is fine, writing to it is not.

**You may not**:
- edit, create, move or delete anything in the project
- run anything that mutates state: installs, `git` writes, formatters, codemods, deploys
- start implementing, even a one-line "obvious" fix
- call `EnterPlanMode` on your own initiative

A `PreToolUse` hook enforces all of this. If a write is denied, that is the design —
do not route around it, do not ask to disable it.

## Proving a concept

The point of the sandbox is evidence. When the question is "does this idea work",
do not reason about it and stop — build the smallest thing that settles it: a
benchmark against the real workload, a script that asserts the invariant, a spike
against the actual API. Then report the measurement, not the intuition.

## Finishing

End with: what you verified, the evidence for it, what you could not verify, and the
shape of the change you would make. Then **stop**. Do not offer to implement in a
way that reads as a request for permission — one closing line at most:

> Say `/probe implement` when you want a plan.

## Unlocking implementation

Writes stay blocked until **both**: the user explicitly asks to implement, and they
approve a plan through `ExitPlanMode`. A `PostToolUse` hook on `ExitPlanMode` is what
lifts the block — approving the plan is the only thing that does. Leaving plan mode
any other way leaves the project locked.

`/probe restore` rolls the working tree back to the moment probe mode started
(git snapshot; current changes are stashed first as a safety net). It previews first
and only acts on a second, explicitly confirmed run.
