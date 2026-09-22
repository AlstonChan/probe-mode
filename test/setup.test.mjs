// The `setup` subcommand and the `status` staleness nudge, plus a small direct
// regression guard on probe-statusline.mjs's --cmd= override.
//
//   node --test test/setup.test.mjs
//
// Drives the real probe-ctl.mjs / probe-statusline.mjs as subprocesses, with
// CLAUDE_CONFIG_DIR pointed at a temp directory so nothing touches your real config.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SID = 'setup-test-session';
const STATUSLINE = path.join(import.meta.dirname, '..', 'hooks', 'probe-statusline.mjs');

// This repo checkout always has .claude-plugin/ next to hooks/ (it's the plugin's own
// manifest), so running the real files in place always looks like a plugin install.
// Copy the files under test into an isolated dir, with or without that sibling, to
// exercise the standalone branch deterministically. Mirrors the identical helper in
// test/rounds.test.mjs.
function withIsolatedHooks(pluginLike, files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-iso-setup-'));
  const hooksDir = path.join(dir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(import.meta.dirname, '..', 'hooks', f), path.join(hooksDir, f));
  }
  if (pluginLike) fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  try {
    return fn(path.join(hooksDir, 'probe-ctl.mjs'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HOOK_FILES = ['probe-ctl.mjs', 'probe-lib.mjs', 'probe-statusline.mjs'];

function freshCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'probe-setup-cfg-'));
}

function ctlAt(ctlPath, cfg, ...args) {
  return execFileSync(process.execPath, [ctlPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: SID },
  });
}

const settingsPath = (cfg) => path.join(cfg, 'settings.json');
const stableStatuslinePath = (cfg) => path.join(cfg, 'probe-state', 'probe-statusline.mjs');

/** Writes a minimal armed-session state file directly — no git/snapshot needed for
 *  these tests, which only care about status text, not restore mechanics. */
function armSession(cfg) {
  const dir = path.join(cfg, 'probe-state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({
    phase: 'probe', sandbox: path.join(dir, SID, 'sandbox'), cwd: '/tmp', startedAt: new Date().toISOString(),
    snapshot: { ref: 'deadbeef', head: 'deadbeef', branch: 'main', at: new Date().toISOString() },
  }));
}

// ---------------------------------------------------------------------------

describe('probe-statusline.mjs --cmd= override', () => {
  function run(cfg, extraArgs = []) {
    return execFileSync(process.execPath, [STATUSLINE, ...extraArgs], {
      input: JSON.stringify({ session_id: SID }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
    });
  }

  test('uses the flagged command name when --cmd= is present', () => {
    const cfg = freshCfg();
    armSession(cfg);
    const out = run(cfg, ['--cmd=probe-mode:probe']);
    assert.match(out, /\/probe-mode:probe restore/);
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  test('falls back to structural/env detection when the flag is absent', () => {
    const cfg = freshCfg();
    armSession(cfg);
    const out = run(cfg);
    // Spawned from its real repo path, which always has .claude-plugin/ nearby.
    assert.match(out, /\/probe-mode:probe restore/);
    fs.rmSync(cfg, { recursive: true, force: true });
  });
});

describe('setup: standalone layout', () => {
  test('no-ops: nothing written or copied', () => {
    withIsolatedHooks(false, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      const out = ctlAt(ctlPath, cfg, 'setup');
      assert.match(out, /nothing to do/);
      assert.equal(fs.existsSync(settingsPath(cfg)), false);
      assert.equal(fs.existsSync(stableStatuslinePath(cfg)), false);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });
});

describe('setup: plugin layout', () => {
  test('fresh settings.json: creates it, no backup file', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      ctlAt(ctlPath, cfg, 'setup');

      assert.equal(fs.existsSync(stableStatuslinePath(cfg)), true);
      const settings = JSON.parse(fs.readFileSync(settingsPath(cfg), 'utf8'));
      assert.equal(settings.statusLine.type, 'command');
      assert.match(settings.statusLine.command, /--cmd=probe-mode:probe/);
      assert.match(settings.statusLine.command, /probe-statusline\.mjs/);

      const backups = fs.readdirSync(cfg).filter((f) => f.includes('.probe-backup-'));
      assert.equal(backups.length, 0);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('existing settings.json with unrelated keys: survives untouched, backed up', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      fs.writeFileSync(settingsPath(cfg), JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [] } }));
      ctlAt(ctlPath, cfg, 'setup');

      const settings = JSON.parse(fs.readFileSync(settingsPath(cfg), 'utf8'));
      assert.equal(settings.model, 'sonnet');
      assert.deepEqual(settings.hooks, { PreToolUse: [] });
      assert.ok(settings.statusLine);

      const backups = fs.readdirSync(cfg).filter((f) => f.includes('.probe-backup-'));
      assert.equal(backups.length, 1);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('existing foreign statusLine: left untouched, warns', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      const foreignLine = { type: 'command', command: 'node ~/my-own-line.js' };
      fs.writeFileSync(settingsPath(cfg), JSON.stringify({ statusLine: foreignLine }));
      const out = ctlAt(ctlPath, cfg, 'setup');

      assert.match(out, /already have a statusLine/);
      const settings = JSON.parse(fs.readFileSync(settingsPath(cfg), 'utf8'));
      assert.deepEqual(settings.statusLine, foreignLine);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('run twice: idempotent, one statusLine key, identical command', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      ctlAt(ctlPath, cfg, 'setup');
      const first = JSON.parse(fs.readFileSync(settingsPath(cfg), 'utf8')).statusLine.command;
      ctlAt(ctlPath, cfg, 'setup');
      const settings = JSON.parse(fs.readFileSync(settingsPath(cfg), 'utf8'));
      assert.equal(settings.statusLine.command, first);
      assert.equal(Object.keys(settings).length, 1);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('invalid existing JSON: backed up, clean error, nothing else written', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      fs.writeFileSync(settingsPath(cfg), 'not json {{{');
      const out = ctlAt(ctlPath, cfg, 'setup');

      assert.match(out, /not valid JSON/);
      const backups = fs.readdirSync(cfg).filter((f) => f.includes('.probe-backup-'));
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(settingsPath(cfg), 'utf8'), 'not json {{{');
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });
});

describe('status: statusline nudge', () => {
  test('plugin, no session armed, no stable copy: nudges', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      const out = ctlAt(ctlPath, cfg, 'status');
      assert.match(out, /Probe mode: OFF/);
      assert.match(out, /Run `\/probe-mode:probe setup` once/);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('plugin, session armed, no stable copy: nudges alongside phase output', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      armSession(cfg);
      const out = ctlAt(ctlPath, cfg, 'status');
      assert.match(out, /Probe mode: probe/);
      assert.match(out, /Run `\/probe-mode:probe setup` once/);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('plugin, stable copy matches: silent', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      ctlAt(ctlPath, cfg, 'setup');
      const out = ctlAt(ctlPath, cfg, 'status');
      assert.doesNotMatch(out, /setup/);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('plugin, stable copy stale: nudges to re-run setup', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      ctlAt(ctlPath, cfg, 'setup');
      fs.appendFileSync(stableStatuslinePath(cfg), '\n// changed upstream\n');
      const out = ctlAt(ctlPath, cfg, 'status');
      assert.match(out, /changed since you last ran `\/probe-mode:probe setup`/);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('standalone: never nudges, even if a file happens to exist at the analogous path', () => {
    withIsolatedHooks(false, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      fs.mkdirSync(path.join(cfg, 'probe-state'), { recursive: true });
      fs.writeFileSync(stableStatuslinePath(cfg), '// decoy');
      const out = ctlAt(ctlPath, cfg, 'status');
      assert.doesNotMatch(out, /setup/);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------

describe('setup: refreshInterval', () => {
  const lineOf = (cfg) => JSON.parse(fs.readFileSync(settingsPath(cfg), 'utf8')).statusLine;

  test('default is at least 10 seconds', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      ctlAt(ctlPath, cfg, 'setup');
      // A 2s tick costs a four-process chain per tick per session on Windows
      // (~524 process creations/minute across 5 sessions). Do not regress this.
      assert.ok(lineOf(cfg).refreshInterval >= 10);
      assert.equal(lineOf(cfg).refreshInterval, 10);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  for (const args of [['--refresh=30'], ['--refresh', '30']]) {
    test(`honors ${args.join(' ')}`, () => {
      withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
        const cfg = freshCfg();
        ctlAt(ctlPath, cfg, 'setup', ...args);
        assert.equal(lineOf(cfg).refreshInterval, 30);
        fs.rmSync(cfg, { recursive: true, force: true });
      });
    });
  }

  const BAD = ['--refresh=0', '--refresh=abc', '--refresh=-5', '--refresh=1.5', '--refresh=9999', '--refresh'];
  for (const bad of BAD) {
    test(`rejects ${bad} without touching anything`, () => {
      withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
        const cfg = freshCfg();
        // assert.throws() returns undefined, so capture the error by hand: we need
        // its .status and .stdout, which execFileSync attaches on a non-zero exit.
        let err = null;
        try { ctlAt(ctlPath, cfg, 'setup', ...bad.split(' ')); } catch (e) { err = e; }
        assert.ok(err, `setup ${bad} should have exited non-zero`);
        assert.equal(err.status, 1);
        assert.match(String(err.stdout), /--refresh must be|--refresh needs a value/);
        // Validation happens BEFORE any filesystem side effect.
        assert.equal(fs.existsSync(settingsPath(cfg)), false);
        assert.equal(fs.existsSync(stableStatuslinePath(cfg)), false);
        fs.rmSync(cfg, { recursive: true, force: true });
      });
    });
  }

  test('re-running setup keeps a customized interval instead of clobbering it', () => {
    // status nudges you to re-run setup after every plugin update, so a re-run that
    // reset a deliberate 45 back to the default would be user-hostile.
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      ctlAt(ctlPath, cfg, 'setup', '--refresh=45');
      const out = ctlAt(ctlPath, cfg, 'setup');
      assert.equal(lineOf(cfg).refreshInterval, 45);
      assert.match(out, /Kept your existing refresh interval of 45s/);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('an explicit --refresh still overrides a customized interval', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      ctlAt(ctlPath, cfg, 'setup', '--refresh=45');
      ctlAt(ctlPath, cfg, 'setup', '--refresh=12');
      assert.equal(lineOf(cfg).refreshInterval, 12);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });

  test('a foreign statusLine is still never touched, --refresh or not', () => {
    withIsolatedHooks(true, HOOK_FILES, (ctlPath) => {
      const cfg = freshCfg();
      fs.writeFileSync(settingsPath(cfg), JSON.stringify({
        statusLine: { type: 'command', command: 'node my-own-statusline.js', refreshInterval: 3 },
      }));
      ctlAt(ctlPath, cfg, 'setup', '--refresh=60');
      const sl = lineOf(cfg);
      assert.match(sl.command, /my-own-statusline/);
      assert.equal(sl.refreshInterval, 3);
      fs.rmSync(cfg, { recursive: true, force: true });
    });
  });
});

describe('install.sh keeps the same interval contract', () => {
  // Static assertions: they run everywhere, with no bash required, and they are the
  // part that actually stops the default being regressed in the second installer.
  const SH = fs.readFileSync(path.join(import.meta.dirname, '..', 'install.sh'), 'utf8');

  test('declares a default of at least 10', () => {
    const m = SH.match(/^REFRESH_DEFAULT=(\d+)$/m);
    assert.ok(m, 'install.sh must declare REFRESH_DEFAULT');
    assert.ok(Number(m[1]) >= 10, `REFRESH_DEFAULT is ${m[1]}; a 2s tick is what caused the spawn storm`);
  });

  test('does not hardcode refreshInterval in its inline node script', () => {
    assert.doesNotMatch(SH, /refreshInterval:\s*\d/,
      'the interval must be interpolated, never a literal, or the two installers drift');
  });

  test('accepts --refresh', () => {
    assert.match(SH, /--refresh/);
  });
});
