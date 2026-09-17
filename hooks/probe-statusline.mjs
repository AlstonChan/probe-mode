#!/usr/bin/env node
// Status line row for probe mode. Prints nothing at all when probe mode is off,
// so it stays invisible until you actually run /probe.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CONFIG_DIR, 'probe-state');
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
  process.stdout.write(`${C.red}${C.bold}⏸ probe mode: STATE UNREADABLE${C.reset}${C.dim} — writes denied; run /probe status${C.reset}`);
  process.exit(0);
}
if (!state || state.phase === 'off') process.exit(0);

const LOOK = {
  probe:        { c: C.amber, label: '⏸ probe mode on',  note: 'research only · writes blocked outside sandbox' },
  planning:     { c: C.cyan,  label: '⏸ probe: planning', note: 'awaiting plan approval · writes still blocked' },
  implementing: { c: C.green, label: '⏵⏵ probe: unlocked', note: 'plan approved · writes allowed' },
};
const look = LOOK[state.phase];
if (!look) process.exit(0);

const restore = state.snapshot
  ? '⟲ /probe restore'
  : `${C.red}no snapshot (not a git repo)${C.reset}${C.dim}`;

process.stdout.write(
  `${look.c}${C.bold}${look.label}${C.reset}` +
  `${C.dim} · ${look.note} · ${restore}${C.reset}`
);
