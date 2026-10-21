// Is there a plan, written during THIS planning phase, behind an ExitPlanMode?
//
// probe-guard.mjs (PreToolUse) and probe-promote.mjs (PostToolUse) both ask, so a
// plan-less approval is refused before the user sees a prompt, and an approval
// that slips through anyway still cannot unlock writes. The incident behind it:
// the plan Write and ExitPlanMode went out in one parallel batch, another hook
// denied the Write, ExitPlanMode still ran, and an empty plan was approved.
//
// Node builtins only, no other imports: the guard loads this with a dynamic
// import inside its fail-closed try, and anything this file pulled in would
// widen what can break there.
//
// What Claude Code passes, from recorded transcripts: when a plan file exists,
// ExitPlanMode's input is { plan, planFilePath } and its response
// { plan, filePath }; when none exists, the input is {}. All three shapes below
// are handled, so a payload that changes shape fails closed rather than open.
import fs from 'node:fs';
import path from 'node:path';

const BACKSLASH = String.fromCharCode(92);

/** The instruction every refusal ends with. */
export const PLAN_STEPS =
  'Write the plan to the plan file, wait until that Write has succeeded, then call ' +
  'ExitPlanMode in a separate turn. Never send the Write and ExitPlanMode in the same batch.';

const norm = (p) => path.resolve(p).split(BACKSLASH).join('/').toLowerCase();
const text = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();

/**
 * @returns {{ ok: true, file: string } | { ok: false, reason: string }}
 *   Never throws: anything unexpected is a refusal.
 */
export function planCheck({ input, state, plansDir, cmd }) {
  try {
    const since = Date.parse(state?.planningAt);
    if (!Number.isFinite(since)) {
      return { ok: false, reason: `this planning phase has no start time (it began before plan tracking); the user can re-run ${cmd} implement` };
    }

    const root = norm(plansDir);
    const fresh = (file) => {
      try {
        const st = fs.statSync(file);
        return st.isFile() && st.mtimeMs > since ? text(fs.readFileSync(file, 'utf8')) : null;
      } catch { return null; }
    };

    const ti = input?.tool_input || {};
    const tr = input?.tool_response || {};
    const named = ti.planFilePath || tr.filePath;
    const plan = text(ti.plan ?? tr.plan);

    // 1. The payload names the file: that file, and only that one, must be fresh.
    if (named) {
      const t = norm(named);
      if (t !== root && !t.startsWith(root + '/')) {
        return { ok: false, reason: `the plan file ${named} is outside ${plansDir}` };
      }
      const body = fresh(named);
      if (!body) return { ok: false, reason: `no non-empty plan file at ${named} written since planning began (${state.planningAt})` };
      return { ok: true, file: named };
    }

    // 2/3. Search the plans directory. With plan text in hand the file must match
    // it, so an older plan whose text Claude Code filled in cannot pass.
    let names = [];
    try { names = fs.readdirSync(plansDir).filter((n) => n.toLowerCase().endsWith('.md')); } catch {}
    for (const n of names) {
      const file = path.join(plansDir, n);
      const body = fresh(file);
      if (body && (!plan || body === plan)) return { ok: true, file };
    }
    return {
      ok: false,
      reason: plan
        ? `the plan given matches no file in ${plansDir} written since planning began (${state.planningAt})`
        : `no plan was written: nothing in ${plansDir} changed since planning began (${state.planningAt})`,
    };
  } catch (err) {
    return { ok: false, reason: `could not check for a plan (${err && err.message})` };
  }
}
