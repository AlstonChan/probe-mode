import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const STATE_DIR = path.join(CONFIG_DIR, 'probe-state');
export const PLANS_DIR = path.join(CONFIG_DIR, 'plans');

export function statePath(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`);
}

export function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(sessionId, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(sessionId), JSON.stringify(state, null, 2));
}

export function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

const BACKSLASH = String.fromCharCode(92);
const norm = (p) => path.resolve(p).split(BACKSLASH).join('/').toLowerCase();

/** Directories that stay writable while probe mode is active. */
export function sandboxRoots(input, state) {
  const roots = [
    path.join(STATE_DIR, input.session_id || 'none'),
    STATE_DIR,
  ];
  if (input.scratchpad_dir) roots.push(input.scratchpad_dir);
  if (state?.sandbox) roots.push(state.sandbox);
  if (input.cwd) roots.push(path.join(input.cwd, '.probe-sandbox'));
  return roots.map(norm);
}

export function inSandbox(target, input, state) {
  if (!target) return false;
  const t = norm(path.isAbsolute(target) ? target : path.join(input.cwd || '.', target));
  return sandboxRoots(input, state).some((r) => t === r || t.startsWith(r + '/'));
}

export function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

export function pass() {
  process.exit(0);
}
