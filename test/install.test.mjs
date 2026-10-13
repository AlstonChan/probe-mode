// install.sh touches only probe-mode's own hooks and files.
//
//   node --test test/install.test.mjs
//
// Runs the real installer with CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME and HOME all
// pointed into a temp directory. Skipped where bash is unavailable.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INSTALL = path.join(import.meta.dirname, '..', 'install.sh');
const hasBash = spawnSync('bash', ['--version']).status === 0;
let ROOT;

const run = (cfg, ...args) => execFileSync('bash', [INSTALL, ...args], {
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, XDG_CONFIG_HOME: path.join(cfg, '..', 'xdg'), HOME: path.join(cfg, '..') },
});
const settings = (cfg) => JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
const commands = (s) => Object.values(s.hooks || {}).flat().flatMap((g) => g.hooks.map((h) => h.command));

function home(name, initial) {
  const cfg = path.join(ROOT, name, '.claude');
  fs.mkdirSync(cfg, { recursive: true });
  if (initial) fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(initial, null, 2));
  return cfg;
}

const USER_HOOKS = {
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/my-probe-logger.sh' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'node ~/tools/cpu-probe-report.js' }] }],
  },
};

before(() => { ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-install-')); });
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

describe('install.sh', { skip: !hasBash && 'bash not available' }, () => {
  test("install and re-install keep the user's own probe-named hooks", () => {
    const cfg = home('user-hooks', USER_HOOKS);
    run(cfg);
    run(cfg);
    const cmds = commands(settings(cfg));
    assert.ok(cmds.includes('~/bin/my-probe-logger.sh'));
    assert.ok(cmds.includes('node ~/tools/cpu-probe-report.js'));
    assert.equal(cmds.filter((c) => /probe-guard\.mjs/.test(c)).length, 1, 'ours exactly once after a re-run');
  });

  test("uninstall removes ours and keeps theirs, plus probe-state unless --purge", () => {
    const cfg = home('user-hooks');
    fs.mkdirSync(path.join(cfg, 'probe-state'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'probe-state', 'live.json'), '{"phase":"probe"}');
    run(cfg, '--uninstall');
    const s = settings(cfg);
    assert.deepEqual(commands(s).sort(), ['node ~/tools/cpu-probe-report.js', '~/bin/my-probe-logger.sh']);
    assert.equal(s.statusLine, undefined);
    assert.ok(fs.existsSync(path.join(cfg, 'probe-state', 'live.json')), 'a locked session stays locked');

    run(cfg, '--uninstall', '--purge');
    assert.equal(fs.existsSync(path.join(cfg, 'probe-state')), false);
  });

  test('a matcher group shared with a user hook loses only our entry', () => {
    const cfg = home('shared-group');
    run(cfg);
    const s = settings(cfg);
    s.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'echo mine' });
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(s));
    run(cfg, '--uninstall');
    assert.deepEqual(commands(settings(cfg)), ['echo mine']);
  });

  test('an & in the install path does not corrupt the skill', () => {
    const cfg = home('R&D home');
    run(cfg);
    const skill = fs.readFileSync(path.join(cfg, 'skills', 'probe', 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /CLAUDE_PLUGIN_ROOT/);
    assert.match(skill, /R&D home\/\.claude\/hooks\/probe-ctl\.mjs/);
  });

  test('backups are unique and only the newest 5 are kept', () => {
    const cfg = home('backups', {});
    for (let i = 0; i < 7; i++) run(cfg);
    const backups = fs.readdirSync(cfg).filter((f) => f.startsWith('settings.json.probe-backup-'));
    assert.equal(backups.length, 5);
    assert.equal(new Set(backups).size, 5);
  });

  test('--uninstall --opencode-only removes just the shim', () => {
    const cfg = home('oc');
    run(cfg, '--opencode');
    const shim = path.join(cfg, '..', 'xdg', 'opencode', 'plugins', 'probe');
    assert.ok(fs.existsSync(shim));
    run(cfg, '--uninstall', '--opencode-only');
    assert.equal(fs.existsSync(shim), false);
    assert.ok(fs.existsSync(path.join(cfg, 'hooks', 'probe-guard.mjs')), 'Claude install untouched');
  });

  test('--purge without --uninstall is refused', () => {
    const cfg = home('purge-misuse');
    assert.throws(() => run(cfg, '--purge'), /only apply to --uninstall/);
  });
});
