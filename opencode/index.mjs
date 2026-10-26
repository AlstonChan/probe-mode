// probe-mode for OpenCode — a research-only mode: it explores, benchmarks and
// proves ideas freely, and nothing touches the project until you approve a plan.
//
// This is the OpenCode half of a dual-host plugin. Claude Code's half lives in
// ../hooks (PreToolUse guard, prompt contract, control script); both share
// ../shared, so the state shape, rounds, restore refs, retention sweep, shell
// analysis and the contract text cannot drift between hosts.
//
// How the mode is enforced here — deliberately without depending on any single
// mechanism:
//
//   * `probe` phase     session permission rules DENY every edit outside the
//                       sandbox and plan directory. Config-enforced: the server
//                       applies it even if this plugin is dead.
//   * `planning` phase  the same rules but `edit` resolves to `ask`, so the
//                       first implementation write raises a real permission
//                       dialog. Approving that dialog (or answering the plan
//                       question, or running `/probe approve`) is the only
//                       thing that unlocks writes.
//   * shell             rules park every mutating command at `ask`; a
//                       permission hook then re-runs the same path analysis
//                       Claude's guard does and turns it into `deny` (target
//                       outside the sandbox) or lets it through (target inside).
//   * contract          re-injected on every model request, so it survives
//                       compaction with no per-prompt hook.
//
// Tampering cannot unlock a session: the rules live in OpenCode's database, not
// in the state file, and there is no model-facing tool that can clear them.
//
// This file only wires the pieces together:
//   session.mjs         ancestry, rule application, the one unlock
//   lifecycle.mjs       arming and per-round snapshots
//   commands.mjs        the /probe command
//   agent.mjs           the `probe` agent
//   context-hook.mjs    contract injection
//   permission-hook.mjs edit / shell decisions
//   tool-hook.mjs       error rewriting, `question` approval
//   approval-events.mjs permission-dialog approval
import path from 'node:path';
import os from 'node:os';
import { readState, pruneStateDir } from '../shared/state.mjs';
import { createSession } from './session.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { registerCommands } from './commands.mjs';
import { registerAgent } from './agent.mjs';
import { registerContextHook } from './context-hook.mjs';
import { registerPermissionHook } from './permission-hook.mjs';
import { registerToolHook } from './tool-hook.mjs';
import { watchApprovals } from './approval-events.mjs';

const HOME = os.homedir();
/** Where armed-state and sandboxes live. `PROBE_STATE_DIR` overrides it (tests
 *  and people who keep scratch out of $HOME). Claude Code keeps its own copy
 *  under ~/.claude/probe-state — sessions never collide between hosts. */
const DEFAULT_STATE_DIR = path.join(HOME, '.probe-mode');
/** OpenCode's plan directory (the built-in plan agent writes here too), so
 *  plan files are writable in every phase on both hosts. */
const PLANS_DIR = path.join(HOME, '.opencode', 'plan');
/** Claude also treats this as a writable root; kept for parity so artifacts can
 *  live next to the code instead of under $HOME. */
const inProjectSandbox = (locationDir) => path.join(locationDir, '.probe-sandbox');
/** The user's own allow/deny command patterns (shared/shell.mjs explains the format). */
const USER_POLICY = path.join(HOME, '.probe-mode', 'probe.json');

export default {
  id: 'probe-mode',

  async setup(ctx) {
    const stateDir = process.env.PROBE_STATE_DIR || DEFAULT_STATE_DIR;
    const locationDir = ctx.location.directory;
    const extraRoots = [inProjectSandbox(locationDir)];

    try { pruneStateDir(stateDir); } catch {}

    const env = {
      ctx,
      stateDir,
      plansDir: PLANS_DIR,
      locationDir,
      extraRoots,
      userPolicy: USER_POLICY,
      stateOf: (sessionID) => readState(stateDir, sessionID),
      rootsFor: (state) => [state.sandbox, ...extraRoots].filter(Boolean),
    };

    const session = createSession(env);
    const lifecycle = createLifecycle(env, session);

    await registerAgent(env);
    await registerCommands(env, session, lifecycle);
    await registerContextHook(env, session);
    await registerPermissionHook(env, session);
    await registerToolHook(env, session);
    return watchApprovals(env, session);
  },
};
