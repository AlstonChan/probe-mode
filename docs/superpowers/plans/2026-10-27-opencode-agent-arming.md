# OpenCode Agent Arming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session whose active agent is `probe` is armed (or hard-blocked) however the agent was selected, not only via `/probe`.

**Architecture:** `lifecycle.arm()` gets a shared in-flight guard. The `context` hook arms lazily when `event.agent === 'probe'` and the lineage is unarmed. The permission hook denies edit/shell for an unarmed `probe`-agent session as a fail-closed fallback.

**Tech Stack:** Pure ESM `.mjs`, `node --test`, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-opencode-agent-arming-design.md`

## Global Constraints

- Run `node --test <explicit file path>` while iterating; full `npm test` (~80 s) before committing.
- Failing test first. Tests use temp `PROBE_STATE_DIR` via `createOpencodeHarness()`; never touch real `~/.probe-mode` or `~/.claude`.
- Logging never throws and never changes a decision.
- Conventional Commits, no Co-Authored-By or "Generated with" trailers.
- `hooks/probe-guard.mjs` is untouched.

## Review Focus

- Two concurrent `context` events for one unarmed `probe` session: arm once, one state file, round stays 1.
- `arm()` throws (e.g. state dir unwritable): hook swallows it, model request still proceeds, permission hook denies writes.
- Agent other than `probe` and unarmed: nothing changes (no arming, no denial).
- Already armed session on `probe` agent: no re-arm, round not incremented.
- Subagent session (child of an armed lineage) with `agent: 'probe'`: treated as armed via ancestry, not re-armed.

---

### Task 1: Harness exposes the context hook

**Files:**
- Modify: `test/fixtures/harness.mjs` (`createOpencodeHarness`)
- Test: `opencode/test/agent-arming.test.mjs` (new; created in Task 2)

**Interfaces:**
- Produces: `h.context` (async fn taking an event `{ sessionID, agent, system: [] }`), captured from `ctx.session.hook('context', fn)`. The stub `session.hook` stores `fn` when `name === 'context'`. The stub `session.update`/`switchAgent` calls are recorded in `h.calls` as `{ fn: 'update'|'switchAgent', input }` so tests can assert arming happened.

- [ ] **Step 1:** In `createOpencodeHarness`, add `context: null, calls: []` to `h`; make `session.hook` set `h.context` for the `'context'` name; make `update` and `switchAgent` push to `h.calls`.
- [ ] **Step 2:** Run `node --test opencode/test/opencode-approval.test.mjs opencode/test/trace-wiring.test.mjs` — Expected: PASS (no behavior change).

### Task 2: Lazy arming on the context hook

**Files:**
- Modify: `opencode/lifecycle.mjs` (in-flight guard), `opencode/context-hook.mjs`, `opencode/index.mjs` (pass `lifecycle` to `registerContextHook`)
- Test: `opencode/test/agent-arming.test.mjs` (new)

**Interfaces:**
- Consumes: `createLifecycle(env, session).arm(sessionID, question)`; `session.armedFor(sessionID)`.
- Produces: `lifecycle.ensureArmed(sessionID): Promise<boolean>` — arms with no question if `armedFor` is null, sharing one in-flight promise per session; resolves `true` if armed afterwards, `false` if arming threw (error swallowed). `registerContextHook(env, session, lifecycle)`.

- [ ] **Step 1: Write failing tests** in `agent-arming.test.mjs` (each uses `createOpencodeHarness()` with `h.close()` in `finally`):
  - `'probe agent, unarmed: first context event arms the session'` — `await h.context({ sessionID: 's1', agent: 'probe', system: [] })`; assert `fs.existsSync(path.join(h.stateDir, 's1.json'))`, state `phase === 'probe'`, `round === 1`, and `event.system` has one text part containing the contract.
  - `'two concurrent context events arm once'` — `Promise.all` of two events; state `round === 1`; `h.calls.filter(c => c.fn === 'update').length === 1`.
  - `'other agent, unarmed: nothing happens'` — agent `'build'`; no state file; `event.system` empty.
  - `'already armed: no re-arm'` — pre-write state file (phase `probe`, round 1); fire event; round still 1.
  - `'arm failure is swallowed'` — make `h.stateDir` unwritable by replacing it with a file path before the event; `await h.context(...)` does not reject.
- [ ] **Step 2:** Run `node --test opencode/test/agent-arming.test.mjs` — Expected: FAIL (no arming).
- [ ] **Step 3:** Implement `ensureArmed` in `lifecycle.mjs` (Map of in-flight promises, deleted in `finally`; try/catch returns false). In `context-hook.mjs`, before the existing `armedFor` check: `if (event.agent === 'probe') await lifecycle.ensureArmed(event.sessionID)`. Wire `lifecycle` through `index.mjs`.
- [ ] **Step 4:** Run the same file — Expected: PASS. Then `node --test opencode/test/opencode.test.mjs opencode/test/opencode-approval.test.mjs`.
- [ ] **Step 5:** Commit `feat(opencode): arm when the probe agent is selected`.

### Task 3: Fail-closed permission fallback

**Files:**
- Modify: `opencode/permission-hook.mjs`
- Test: `opencode/test/agent-arming.test.mjs`

**Interfaces:**
- Consumes: `event.agent`, `session.armedFor`. Produces: `deny` effect with a message naming `CMD` (`/probe`).

- [ ] **Step 1: Write failing tests:**
  - `'probe agent, unarmed: edit is denied'` — `evaluate({ sessionID:'s2', agent:'probe', action:'edit', resources:['C:/x/package.json'], effect:'allow' })` → `effect === 'deny'`, `message` includes `/probe`.
  - `'probe agent, unarmed: shell is denied'` — action `'shell'`, resources `['npm install']`.
  - `'probe agent, unarmed: read is untouched'` — action `'read'` → effect stays `'allow'`.
  - `'build agent, unarmed: edit is untouched'`.
- [ ] **Step 2:** Run `node --test opencode/test/agent-arming.test.mjs` — Expected: the four new tests FAIL.
- [ ] **Step 3:** In the `evaluate` hook, in the `!armed` branch: if `event.agent === 'probe'` and action is `edit` or `shell`, set `event.effect = 'deny'` and `event.message`, trace it (`hook: 'permission.evaluate'`, decision `'deny'`), return.
- [ ] **Step 4:** Run the file — Expected: PASS.
- [ ] **Step 5:** Run full `npm test` — Expected: all pass. Commit `feat(opencode): deny writes on the probe agent while unarmed`.

### Task 4: Docs and manual verification

**Files:**
- Modify: `README.md` (OpenCode section: selecting the Probe agent now arms the session), `AGENTS.md` smoke checklist step 1.
- [ ] **Step 1:** Update the two docs in one or two lines each.
- [ ] **Step 2:** Re-run `install.sh --opencode`, open OpenCode, Shift+Tab to Probe, ask for a `package.json` edit; expect it denied and `~/.probe-mode/<session>.json` present. Needs the owner.
- [ ] **Step 3:** Commit `docs: note that the probe agent arms the session`.
