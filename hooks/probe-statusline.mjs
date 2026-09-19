#!/usr/bin/env node
// Status line row for probe mode. Prints nothing at all when probe mode is off,
// so it stays invisible until you actually run /probe.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'probe-state');

// `probe-ctl.mjs setup` relocates a copy of this file to a stable, update-proof path
// outside the plugin cache (~/.claude/probe-state/), so it can survive `claude plugin
// update` deleting the versioned cache dir this file originally shipped in. But that
// relocation breaks the structural check below, which only works from the file's
// ORIGINAL location next to .claude-plugin/ — a relocated copy would permanently and
// incorrectly resolve isPlugin = false. `setup` already knows the right answer for
// certain at copy time, so it bakes it in as a CLI flag instead of relying on this file
// to re-derive something it structurally can't anymore.
// The flag value omits the leading "/" deliberately: on a machine with Git Bash, the
// MSYS layer treats a leading-slash argv token as a POSIX path and silently rewrites it
// (confirmed: a bare --cmd=/probe was mangled into a Windows Git-install path during
// testing). Dropping the slash sidesteps that path-conversion heuristic entirely; it's
// added back below.
const cmdFlag = process.argv.find((a) => a.startsWith('--cmd='));
let CMD = cmdFlag && `/${cmdFlag.slice('--cmd='.length)}`;
if (!CMD) {
  const isPlugin = fs.existsSync(path.join(path.dirname(import.meta.dirname), '.claude-plugin'))
    || Boolean(process.env.CLAUDE_PLUGIN_ROOT);
  CMD = isPlugin ? '/probe-mode:probe' : '/probe';
}
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  amber: '\x1b[33m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m',
};

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }

const file = path.join(STATE_DIR, `${input.session_id}.json`);
if (!fs.existsSync(file)) process.exit(0);

let state;
try {
  state = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  process.stdout.write(`${C.red}${C.bold}⏸ probe mode: STATE UNREADABLE${C.reset}${C.dim} — writes denied; run ${CMD} status${C.reset}`);
  process.exit(0);
}
if (!state || state.phase === 'off') process.exit(0);

const r = state.round && state.round > 1 ? ` r${state.round}` : '';
const LOOK = {
  probe:        { c: C.amber, label: `⏸ probe${r} mode on`,   note: 'research only · writes blocked outside sandbox' },
  planning:     { c: C.cyan,  label: `⏸ probe${r}: planning`, note: 'awaiting plan approval · writes still blocked' },
  implementing: { c: C.green, label: `⏵⏵ probe${r}: unlocked`, note: 'plan approved · writes allowed' },
};
const look = LOOK[state.phase];
if (!look) process.exit(0);

const restore = state.snapshot
  ? `⟲ ${CMD} restore`
  : `${C.red}no snapshot (not a git repo)${C.reset}${C.dim}`;

process.stdout.write(
  `${look.c}${C.bold}${look.label}${C.reset}` +
  `${C.dim} · ${look.note} · ${restore}${C.reset}`
);
