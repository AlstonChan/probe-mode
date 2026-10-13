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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readState, writeState, statePath, normalizeRounds, roundRef, pruneStateDir, logDenial, denialSummary,
} from '../shared/state.mjs';
import { trySnapshot, diffSince, listRounds, pruneRounds, restore, refExists } from '../shared/git.mjs';
import { sessionRules, matchEffect, shellDenied, shellDenyMessage, approvalAskMessage } from '../shared/rules.mjs';
import { analyzeSegments, checkReport, loadPolicy, matchPolicy } from '../shared/shell.mjs';
import { contractText, implementRefusal } from '../shared/contract.mjs';
import { exportRound } from '../shared/export.mjs';
import {
  CMD, parseInvocation, statusText, armPrompt, implementPrompt, approvePrompt,
  restoreRelay, stopPrompt, RESTORE_WORDING, PRUNE_WORDING, sandboxFor, deniedMessageFor,
} from './lib.mjs';

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
/** What to tell the model when a round has no restore point. */
const noSnapshot = (error) => error
  ? `NONE — snapshot failed (${error}), so ${CMD} restore cannot roll this round back`
  : `NONE — not a git repository, so ${CMD} restore cannot roll anything back`;

export default {
  id: 'probe-mode',

  async setup(ctx) {
    const stateDir = process.env.PROBE_STATE_DIR || DEFAULT_STATE_DIR;
    const plansDir = PLANS_DIR;
    const locationDir = ctx.location.directory;
    const extraRoots = [inProjectSandbox(locationDir)];

    try { pruneStateDir(stateDir); } catch {}

    const stateOf = (sessionID) => readState(stateDir, sessionID);
    const rootsFor = (state) => [state.sandbox, ...extraRoots].filter(Boolean);

    // ---------------------------------------------------------- ancestry
    // A subagent inherits this session's permission rules but gets its own
    // sessionID. Looking only at the child would leave it without the contract
    // and without the shell path analysis, even though the block still applies
    // — Claude Code's hooks see the parent's id instead, so this is how the
    // two hosts end up behaving the same. State resolution therefore walks up
    // to the armed ancestor; the parent chain is cached because it cannot
    // change after creation.
    const parentCache = new Map();
    const parentOf = async (sessionID) => {
      if (parentCache.has(sessionID)) return parentCache.get(sessionID);
      let parent;
      try {
        parent = (await ctx.session.get({ sessionID }))?.parentID;
      } catch {
        parent = undefined;
      }
      parentCache.set(sessionID, parent);
      return parent;
    };

    /** Nearest session at-or-above `sessionID` that has probe state, else
     *  `sessionID` itself (so `armedFor` returns null for unarmed lineages). */
    const ownerOf = async (sessionID) => {
      let current = sessionID;
      for (let depth = 0; depth < 10; depth++) {
        if (readState(stateDir, current)) return current;
        const parent = await parentOf(current);
        if (!parent) return sessionID;
        current = parent;
      }
      return sessionID;
    };

    /** `{ owner, state }` for an armed lineage (state lives on `owner`), or
     *  null when neither the session nor any ancestor is armed. */
    const armedFor = async (sessionID) => {
      const owner = await ownerOf(sessionID);
      const state = stateOf(owner);
      return state ? { owner, state } : null;
    };

    /** Install (or clear) this session's permission rules for a phase. */
    const applyRules = (sessionID, phase, state) =>
      ctx.session.update({
        sessionID,
        permissions: sessionRules({
          phase,
          sandbox: state?.sandbox,
          plansDir,
          stateDir,
          locationDir,
          extraRoots,
        }),
      });

    /** Rules are per-session, so an armed lineage gets every member updated:
     *  the owner holds the state, and the session that asked keeps matching it
     *  (existing children already carry a copy from creation time). */
    const applyRulesFor = async (sessionID, phase, state) => {
      const owner = await ownerOf(sessionID);
      await applyRules(owner, phase, state);
      if (owner !== sessionID) await applyRules(sessionID, phase, state);
    };

    /** The one and only unlock: approved plan -> free execution. A dialog or
     *  question answer only counts while a plan is actually awaiting approval;
     *  the user's own `approve` command is accepted from research too. */
    const unlock = async (sessionID, source) => {
      const owner = await ownerOf(sessionID);
      const state = stateOf(owner);
      if (!state || state.phase === 'off') return false;
      if (source !== 'command' && state.phase !== 'planning' && state.phase !== 'implementing') return false;
      if (state.phase !== 'implementing') {
        state.phase = 'implementing';
        state.approvedAt = new Date().toISOString();
        state.approvedBy = source;
        writeState(stateDir, owner, state);
      }
      await applyRulesFor(sessionID, 'implementing', state);
      return true;
    };

    // ------------------------------------------------------------ the agent
    // OpenCode's equivalent of a permission mode is an agent, and a primary
    // agent joins the Shift+Tab cycle automatically. Registered here rather
    // than shipped as a config file so installing the plugin IS installing the
    // mode; a user's own `agents.probe` (config or .opencode/agents/probe.md)
    // wins if it already exists when we load.
    await ctx.agent.transform((editor) => {
      if (editor.get('probe')) return;
      editor.update('probe', (agent) => {
        agent.name = 'Probe';
        agent.description =
          'Research-only mode: explores, benchmarks and proves ideas in a sandbox; writes stay blocked until a plan is approved.';
        agent.mode = 'primary';
        agent.color = '#4ea1ff';
        agent.permissions.push({ action: 'question', resource: '*', effect: 'allow' });
      });
    });

    // ------------------------------------------------------------ lifecycle
    const arm = async (sessionID, question) => {
      const sandbox = sandboxFor(stateDir, sessionID);
      fs.mkdirSync(sandbox, { recursive: true });
      const existing = stateOf(sessionID);
      let state;
      let snapshotLine;

      if (!existing) {
        // Arm even if the snapshot failed: writes must be blocked either way.
        const { snap, error } = trySnapshot({ cwd: locationDir, sessionId: sessionID, ref: roundRef(sessionID, 1) });
        state = {
          phase: 'probe',
          round: 1,
          rounds: snap ? [{ n: 1, at: snap.at, ref: snap.ref, head: snap.head, branch: snap.branch }] : [],
          snapshot: snap,
          ...(error ? { snapshotError: error } : {}),
          sandbox,
          cwd: locationDir,
          startedAt: new Date().toISOString(),
          sessionID,
          host: 'opencode',
        };
        writeState(stateDir, sessionID, state);
        snapshotLine = snap ? `${snap.ref.slice(0, 12)} (restorable via ${CMD} restore)` : noSnapshot(error);
      } else {
        const rounds = normalizeRounds(existing);
        const n = Math.max(rounds[rounds.length - 1]?.n || 0, existing.round || 0) + 1; // a round without a snapshot still counts
        const { snap, error } = trySnapshot({ cwd: locationDir, sessionId: sessionID, ref: roundRef(sessionID, n) });
        existing.phase = 'probe';
        existing.round = n;
        existing.rounds = snap
          ? [...rounds, { n, at: snap.at, ref: snap.ref, head: snap.head, branch: snap.branch }]
          : rounds;
        existing.sandbox = sandbox;
        if (error) existing.snapshotError = error; else delete existing.snapshotError;
        existing.sessionID = sessionID;
        existing.host = 'opencode';
        writeState(stateDir, sessionID, existing);
        state = existing;
        snapshotLine = snap ? `${snap.ref.slice(0, 12)} pinned at ${roundRef(sessionID, n)}` : noSnapshot(error);
      }

      await applyRules(sessionID, 'probe', state);
      // Selecting the mode is what makes it visible: the agent shows in the
      // agent switcher and carries the description the model reads.
      await ctx.session.switchAgent({ sessionID, agent: 'probe' });
      return armPrompt({ state, question, snapshotLine });
    };

    const plansFileFor = (sessionID) => path.join(plansDir, `probe-${sessionID}.md`);

    const runCommand = async ({ sessionID, prompt, delivery }) => {
      const { sub, args, question, rest } = parseInvocation(prompt?.text);
      const armed = await armedFor(sessionID);
      const owner = armed?.owner ?? sessionID;
      const state = armed?.state ?? null;
      const say = (text) =>
        ctx.session.prompt({ sessionID, text, delivery, ...(prompt?.files ? { files: prompt.files } : {}) });

      if (sub === 'start') {
        return say(await arm(sessionID, question));
      }

      if (sub === 'export') {
        if (!state) return say('Probe mode is not active for this session; nothing to export.');
        const file = exportRound({ cwd: locationDir, sessionId: owner, stateDir, state, outDir: path.join(stateDir, 'exports') }); // never swept: no sandbox/ inside
        return say(`Report this to the user as-is: Exported to ${file}`);
      }

      if (sub === 'rounds') {
        if (!state) return say('Probe mode is not active for this session.');
        const text = args[0] === 'prune'
          ? pruneRounds({ cwd: locationDir, sessionId: owner, stateDir, state, force: args.includes('--force'), wording: PRUNE_WORDING })
          : listRounds({ cwd: locationDir, sessionId: owner, state });
        return say(`Report this to the user as-is (never add --force yourself):\n\n${text}`);
      }

      if (sub === 'diff') {
        if (!state) return say('Probe mode is not active for this session; no snapshot to compare against.');
        const text = diffSince({ cwd: locationDir, sessionId: owner, state, argv: args });
        return say(`Report this to the user as-is:${String.fromCharCode(10).repeat(2)}${text}`);
      }

      if (sub === 'check') {
        const text = checkReport(rest || '', {
          cwd: locationDir,
          roots: state ? rootsFor(state) : [],
          phase: state ? state.phase : 'probe',
          policy: loadPolicy({ userFile: USER_POLICY, projectDir: locationDir }),
        });
        const note = state ? '' : 'Probe mode is not active, so nothing is blocked. As if it were:\n';
        return say(`Report this to the user as-is:\n\n${note}${text}`);
      }

      if (sub === 'status') {
        const status = statusText(state, { sessionId: owner, refExists: (ref) => refExists(locationDir, ref) });
        const text = state ? `${status}\n${denialSummary(stateDir, owner)}` : status;
        return say(
          `Report this probe status to the user as-is (no extra commentary):\n\n${text}`,
        );
      }

      if (sub === 'implement') {
        if (!state) return say('Probe mode is not active.');
        const refusal = implementRefusal(state.phase, CMD);
        if (refusal) return say(`Report this to the user as-is, and do not start planning:\n\n${refusal}`);
        state.phase = 'planning';
        writeState(stateDir, owner, state);
        await applyRulesFor(sessionID, 'planning', state);
        return say(implementPrompt({ plansFile: plansFileFor(owner) }));
      }

      if (sub === 'approve') {
        const unlocked = await unlock(sessionID, 'command');
        return say(unlocked ? approvePrompt() : 'Probe mode is not active; nothing to approve.');
      }

      if (sub === 'restore') {
        if (!state) return say('Probe mode is not active for this session; no snapshot to restore.');
        const force = args.includes('--force');
        const result = restore({
          cwd: locationDir,
          sessionId: owner,
          stateDir,
          state,
          argv: args,
          force,
          wording: RESTORE_WORDING,
        });
        return say(restoreRelay({ text: result.text, force }));
      }

      if (sub === 'stop') {
        if (state) {
          state.phase = 'off';
          writeState(stateDir, owner, state);
          await applyRulesFor(sessionID, 'off', state);
        }
        return say(stopPrompt());
      }
    };

    await ctx.command.transform((editor) => {
      editor.add({
        name: 'probe',
        description:
          'research-only mode: [question | status | implement | approve | restore [--force] | stop | check <cmd> | diff [--round N] [--patch] | rounds [prune [--force]] | export]',
        execute: runCommand,
      });
    });

    // ------------------------------------------------------------- contract
    // Runs on every model request (not just each prompt), so the contract
    // survives compaction, steering, and subagent continuations for free.
    await ctx.session.hook('context', async (event) => {
      const armed = await armedFor(event.sessionID);
      if (!armed || armed.state.phase === 'off') return;
      const { owner, state } = armed;

      // Liveness heartbeat: the retention sweep prunes by mtime, so touching the
      // file here means "age" is "not used since" rather than "phase-changed
      // since". Only after the phase check, so an `off` state is never
      // resurrected.
      try {
        const now = new Date();
        fs.utimesSync(statePath(stateDir, owner), now, now);
      } catch {}

      event.system.push({
        type: 'text',
        text: contractText({
          phase: state.phase,
          round: state.round || 1,
          sandbox: state.sandbox,
          cmd: CMD,
          host: 'opencode',
        }),
      });
    });

    // ---------------------------------------------------------- permissions
    await ctx.permission.hook('evaluate', async (event) => {
      const armed = await armedFor(event.sessionID);
      if (!armed) return;
      const state = armed.state;
      if (state.phase === 'off' || state.phase === 'implementing') return;

      // Edits are judged against the OWNER's current phase, not whatever rules
      // this session happens to carry: a child created while unlocked keeps its
      // empty rule set into the next round, and a user's own `edit: ask` config
      // would otherwise turn a research-phase write into an approval dialog.
      if (event.action === 'edit') {
        const rules = sessionRules({
          phase: state.phase, sandbox: state.sandbox, plansDir, stateDir, locationDir, extraRoots,
        });
        const effects = (event.resources ?? []).map((r) => matchEffect(rules, 'edit', String(r)));
        if (effects.includes('deny')) {
          event.effect = 'deny';
          logDenial(stateDir, armed.owner, { tool: 'edit', what: (event.resources ?? []).join(', ').slice(0, 500), reason: 'edit outside the sandbox' });
          return;
        }
        // The approval moment. An `edit` that resolves to `ask` while planning
        // is a write outside the sandbox, so the dialog the user is looking at
        // IS the plan approval. Only the planning phase has one.
        if (effects.includes('ask')) {
          event.effect = 'ask';
          event.message = approvalAskMessage({ sandbox: state.sandbox, cmd: CMD });
          return;
        }
        if (effects.length > 0 && event.effect !== 'deny') event.effect = 'allow';
        return;
      }

      // Shell: the rules park every mutating command at `ask`; here we decide
      // it with the same path analysis Claude's guard uses.
      //   target outside the sandbox  -> deny, with a reason
      //   target inside the sandbox    -> allow (the sandbox is the model's)
      //   not a mutating command       -> leave the effect alone, so a user's
      //                                   own ask/allow still applies
      if (event.action === 'shell') {
        if (event.effect === 'deny') return;
        const policy = loadPolicy({ userFile: USER_POLICY, projectDir: locationDir });
        const rule = matchPolicy(event.resources.join(' && '), policy);
        if (rule && rule.effect === 'allow') { event.effect = 'allow'; return; }
        if (rule && rule.effect === 'deny') {
          event.effect = 'deny';
          event.message = shellDenyMessage({ phase: state.phase, command: event.resources.join(' && '), sandbox: state.sandbox, cmd: CMD });
          logDenial(stateDir, armed.owner, { tool: 'shell', what: event.resources.join(' && ').slice(0, 500), reason: `deny pattern "${rule.pattern}"` });
          return;
        }
        const verdict = analyzeSegments(event.resources, {
          cwd: locationDir,
          roots: rootsFor(state),
        });
        if (!verdict.sawMutation) {
          // The fallback patterns are coarse (`git tag *` also matches a listing).
          // When the analysis finds no write, an `ask` that only our own pattern
          // raised is a false alarm, not a decision for the user.
          if (event.effect === 'ask' && event.resources.some((r) => shellDenied(String(r)))) event.effect = 'allow';
          return;
        }
        if (verdict.offenders.length > 0 || verdict.unresolved.length > 0) {
          event.effect = 'deny';
          logDenial(stateDir, armed.owner, {
            tool: 'shell',
            what: event.resources.join(' && ').slice(0, 500),
            reason: [...verdict.offenders, ...verdict.unresolved][0] ?? 'mutates outside the sandbox',
          });
          event.message = shellDenyMessage({
            phase: state.phase,
            command: event.resources.join(' && '),
            sandbox: state.sandbox,
            cmd: CMD,
          });
          return;
        }
        event.effect = 'allow';
      }
    });

    // Give blocked calls a reason that names the mode instead of a rules dump
    // (this is what Claude's guard messages do on the other host).
    await ctx.tool.hook('execute.after', async (event) => {
      const armed = await armedFor(event.sessionID);
      if (!armed) return;
      const state = armed.state;
      if (state.phase === 'off') return;

      if (event.status === 'error') {
        const replacement = deniedMessageFor({
          tool: event.tool,
          message: event.error?.message,
          input: toolInput(event),
          phase: state.phase,
          sandbox: state.sandbox,
          cmd: CMD,
        });
        if (!replacement) return;
        try {
          event.error.message = replacement;
        } catch {
          // The host owns the error object; if it refuses mutation the model
          // keeps the generic message. Enforcement is unaffected either way.
        }
        return;
      }

      // Plan approval answered through the `question` tool: the model presents
      // the plan and asks; the user's own answer is what unlocks writes.
      if (event.tool === 'question' && state.phase === 'planning') {
        const payload = toolInput(event);
        const questions = Array.isArray(payload.questions) ? payload.questions : [];
        const index = questions.findIndex((q) => /probe plan approval/i.test(String(q?.header ?? '')));
        if (index === -1) return;
        // The answers arrive structured either in `output` or, when `output` is
        // the human-readable summary string, in `metadata`.
        const out = event.result?.output;
        const output = (out && typeof out === 'object') ? out : (event.result?.metadata ?? {});
        const answers = Array.isArray(output.answers) ? output.answers : [];
        const answer = String((answers[index] ?? [])[0] ?? '');
        // Exact label: the model writes the options, so a prefix match would let
        // "Approve later — keep researching" unlock.
        if (answer.trim().toLowerCase() === 'approve') await unlock(event.sessionID, 'question');
      }
    });

    // ------------------------------------------------------------- approval
    // The permission-dialog path: track `edit` requests raised while planning,
    // and treat the user's Allow as the approval. `asked` carries the action,
    // which is what keeps an unrelated approval (a .env read, an external
    // directory) from unlocking anything.
    const approvalDialogs = new Map();
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (event.type === 'permission.asked') {
            const data = event.data;
            if (data.action !== 'edit') continue;
            // Only a dialog raised while a plan awaits approval is an approval.
            const armed = await armedFor(data.sessionID);
            if (armed?.state.phase !== 'planning') continue;
            approvalDialogs.set(data.id, data.sessionID);
            // Unbounded growth would need a clock we do not have here; a lost
            // entry only means the user runs `/probe approve` instead — the
            // failure direction is staying locked.
            if (approvalDialogs.size > 500) approvalDialogs.clear();
          } else if (event.type === 'permission.replied') {
            const data = event.data;
            if (data.reply === 'reject' || !approvalDialogs.has(data.requestID)) continue;
            approvalDialogs.delete(data.requestID);
            await unlock(data.sessionID, 'permission');
          }
        }
      } catch {
        // Stream closed or plugin unloading: stop watching.
      }
    })();

    return () => abort.abort();
  },
};

/** `event.input` arrives as `unknown`; narrow it once. */
function toolInput(event) {
  return event.input && typeof event.input === 'object' ? event.input : {};
}
