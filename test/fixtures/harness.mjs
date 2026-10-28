import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.join(import.meta.dirname, '..', '..');
const DEFAULT_ROOT = import.meta.dirname;
const REQUIRED = ['host', 'hostVersion', 'capturedAt', 'scenario', 'hook', 'input', 'expected'];
const CLAUDE_HOOKS = { guard: 'probe-guard.mjs' };

export function loadFixture(host, name, root = DEFAULT_ROOT) {
  const file = path.join(root, host, `${name}.json`);
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of REQUIRED) {
    if (!(key in fx)) throw new Error(`fixture ${host}/${name} is missing key: ${key}`);
  }
  return fx;
}

function requireSetup(fixture) {
  if (!fixture.setup) throw new Error('fixture has no setup state');
  return fixture.setup;
}

export function replayClaude(fixture, { configDir }) {
  const file = CLAUDE_HOOKS[fixture.hook];
  if (!file) throw new Error(`unsupported hook: ${fixture.hook}`);
  const setup = requireSetup(fixture);
  const stateDir = path.join(configDir, 'probe-state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${fixture.input.session_id}.json`), JSON.stringify(setup));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.PROBE_RECORD;
  const res = spawnSync(process.execPath, [path.join(REPO, 'hooks', file)], {
    input: JSON.stringify(fixture.input),
    encoding: 'utf8',
    env,
  });
  if (!res.stdout.trim()) return 'allow';
  return JSON.parse(res.stdout).hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
}

/** Loads the real OpenCode plugin against a stub ctx and a temp state dir. */
export async function createOpencodeHarness({ record = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-harness-'));
  const stateDir = path.join(root, 'state');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  const prev = { dir: process.env.PROBE_STATE_DIR, rec: process.env.PROBE_RECORD };
  process.env.PROBE_STATE_DIR = stateDir;
  if (record) process.env.PROBE_RECORD = '1'; else delete process.env.PROBE_RECORD;
  const h = { stateDir, repo, evaluate: null, context: null, run: null, afterTool: null, calls: [], failUpdate: false };
  async function* stream() { await new Promise(() => {}); }
  const { default: plugin } = await import(new URL('../../opencode/index.mjs', import.meta.url));
  await plugin.setup({
    location: { directory: repo },
    session: {
      get: async () => ({}),
      update: async (input) => { if (h.failUpdate) throw new Error('update failed'); h.calls.push({ fn: 'update', input }); },
      switchAgent: async (input) => { h.calls.push({ fn: 'switchAgent', input }); },
      prompt: async (input) => { h.calls.push({ fn: 'prompt', input }); },
      synthetic: async (input) => { h.calls.push({ fn: 'synthetic', input }); },
      hook: async (name, fn) => { if (name === 'context') h.context = fn; },
    },
    agent: { transform: async () => {} },
    command: { transform: async (fn) => fn({ add: (c) => { h.run = c.execute; } }) },
    permission: { hook: async (_n, fn) => { h.evaluate = fn; } },
    tool: { hook: async (name, fn) => { if (name === 'execute.after') h.afterTool = fn; } },
    event: { subscribe: () => stream() },
  });
  h.close = () => {
    if (prev.dir === undefined) delete process.env.PROBE_STATE_DIR; else process.env.PROBE_STATE_DIR = prev.dir;
    if (prev.rec === undefined) delete process.env.PROBE_RECORD; else process.env.PROBE_RECORD = prev.rec;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  };
  return h;
}

export async function replayOpencode(fixture, harness) {
  if (fixture.hook !== 'permission.evaluate') throw new Error(`unsupported hook: ${fixture.hook}`);
  const setup = requireSetup(fixture);
  fs.writeFileSync(path.join(harness.stateDir, `${fixture.input.sessionID}.json`), JSON.stringify(setup));
  const event = { ...fixture.input };
  await harness.evaluate(event);
  return event.effect;
}
