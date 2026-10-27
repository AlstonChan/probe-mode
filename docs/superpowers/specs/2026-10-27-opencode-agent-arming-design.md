# OpenCode: arm when the Probe agent is selected

## Why

Selecting the `probe` agent (Shift+Tab) registers nothing: no snapshot, no state file, no deny rules. The mode looks on but nothing is enforced, so the model edits files directly. Only `/probe <question>` arms the session (`lifecycle.arm()`). Found in a manual capture on 2026-10-27; confirmed by the absence of `~/.probe-mode` after a Shift+Tab-only session.

## Goals

- Any session whose active agent is `probe` is armed (phase `probe`, round 1) before it can write, however the agent was selected.
- Fail closed: if arming did not happen, edits and mutating shell commands on the `probe` agent are denied.

## Non-goals

- Changing `/probe`, `/probe implement`, approval paths or rounds.
- Disarming when the user switches away from the `probe` agent.
- A new UI.

## Approaches considered

1. Arm on first model request (context hook).
2. Deny-only in the permission hook, no arming.
3. Both (chosen): arm lazily, and deny if the session is still unarmed.

## Design

- `context` hook (`context-hook.mjs`): if `event.agent === 'probe'` and `session.armedFor(sessionID)` is null, call `lifecycle.arm(sessionID)` (no question) before the existing contract injection, so the contract lands on that same request.
- A per-session in-flight map makes concurrent calls share one arm.
- `permission.evaluate` (`permission-hook.mjs`): if `event.agent === 'probe'`, `edit` or `shell`, and the lineage is unarmed, set `effect = 'deny'` with a message telling the user to run `/probe`. Also trace it.
- The arm prompt returned by `arm()` is not delivered for lazy arming; the injected contract is enough.
- Any arming error is caught and logged; the permission-hook deny keeps the session blocked.

## Left to the builder

- Where the in-flight guard lives (`lifecycle.mjs` is the natural place).
- Exact deny wording (reuse `shellDenyMessage` style from `shared/rules.mjs`).
- Tests: failing test first (AGENTS.md), using `createOpencodeHarness()` with temp `PROBE_STATE_DIR`.
