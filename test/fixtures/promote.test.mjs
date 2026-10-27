import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFixture, replayClaude, replayOpencode, createOpencodeHarness } from './harness.mjs';

const REPO = path.join(import.meta.dirname, '..', '..');
const PROMOTE = path.join(REPO, 'scripts', 'promote-trace.mjs');
const GUARD = path.join(REPO, 'hooks', 'probe-guard.mjs');
let TMP;

before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-promote-')); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const mk = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };

function promote(trace, line, name, out, extra = []) {
  return spawnSync(process.execPath, [PROMOTE, trace, String(line), name, '--out-dir', out, ...extra], { encoding: 'utf8' });
}

const e1 = { at: 't1', host: 'claude-code', hook: 'guard', sessionId: 'a', input: { n: 1 }, decision: 'allow' };
const e2 = { at: 't2', host: 'opencode', hook: 'permission.evaluate', sessionId: 'b', input: { n: 2 }, decision: 'deny' };

function sampleTrace(dir) {
  const f = path.join(dir, 'trace.jsonl');
  fs.writeFileSync(f, JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
  return f;
}

test('promotes line 2 into <host>/<name>.json', () => {
  const dir = mk('p1'); const out = mk('p1out');
  const r = promote(sampleTrace(dir), 2, 'my-case', out, ['--host-version', '1.2.3']);
  assert.equal(r.status, 0, r.stderr);
  const fx = JSON.parse(fs.readFileSync(path.join(out, 'opencode', 'my-case.json'), 'utf8'));
  assert.equal(fx.host, 'opencode');
  assert.equal(fx.hostVersion, '1.2.3');
  assert.equal(fx.scenario, 'my-case');
  assert.equal(fx.hook, 'permission.evaluate');
  assert.deepEqual(fx.input, e2.input);
  assert.equal(fx.expected, 'deny');
  assert.ok(fx.capturedAt);
  assert.equal('setup' in fx, false);
});

test('hostVersion defaults to unknown', () => {
  const dir = mk('p2'); const out = mk('p2out');
  assert.equal(promote(sampleTrace(dir), 1, 'x', out).status, 0);
  assert.equal(loadFixture('claude-code', 'x', out).hostVersion, 'unknown');
});

test('line past EOF exits non-zero and writes nothing', () => {
  const dir = mk('p3'); const out = mk('p3out');
  const r = promote(sampleTrace(dir), 9, 'x', out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /line 9/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('malformed JSON line exits non-zero and writes nothing', () => {
  const dir = mk('p4'); const out = mk('p4out');
  const f = path.join(dir, 'trace.jsonl');
  fs.writeFileSync(f, JSON.stringify(e1) + '\n{not json\n');
  const r = promote(f, 2, 'x', out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not valid JSON/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('refuses to overwrite an existing fixture', () => {
  const dir = mk('p5'); const out = mk('p5out');
  const f = sampleTrace(dir);
  assert.equal(promote(f, 1, 'dup', out).status, 0);
  const before = fs.readFileSync(path.join(out, 'claude-code', 'dup.json'), 'utf8');
  const r = promote(f, 1, 'dup', out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exists/);
  assert.equal(fs.readFileSync(path.join(out, 'claude-code', 'dup.json'), 'utf8'), before);
});

test('loadFixture throws naming a missing key', () => {
  const out = mk('p6out');
  fs.mkdirSync(path.join(out, 'claude-code'));
  const fx = { host: 'claude-code', capturedAt: 't', scenario: 's', hook: 'guard', input: {}, expected: 'deny' };
  fs.writeFileSync(path.join(out, 'claude-code', 'bad.json'), JSON.stringify(fx));
  assert.throws(() => loadFixture('claude-code', 'bad', out), /hostVersion/);
});

test('setup is read from the sibling state file; --phase overrides', () => {
  const dir = mk('p7'); const out = mk('p7out');
  const f = sampleTrace(dir);
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ phase: 'probe', sandbox: '/sb', cwd: '/c', other: 1 }));
  assert.equal(promote(f, 2, 'auto', out).status, 0);
  assert.deepEqual(loadFixture('opencode', 'auto', out).setup, { phase: 'probe', sandbox: '/sb', cwd: '/c' });
  assert.equal(promote(f, 2, 'over', out, ['--phase', 'planning', '--sandbox', '/other']).status, 0);
  assert.deepEqual(loadFixture('opencode', 'over', out).setup, { phase: 'planning', sandbox: '/other', cwd: '/c' });
});

test('replay throws when fixture has no setup state', async () => {
  const fx = { host: 'claude-code', hostVersion: 'u', capturedAt: 't', scenario: 's', hook: 'guard', input: { session_id: 'z' }, expected: 'deny' };
  assert.throws(() => replayClaude(fx, { configDir: mk('r1') }), /fixture has no setup state/);
  const h = await createOpencodeHarness();
  try {
    await assert.rejects(() => replayOpencode({ ...fx, host: 'opencode', hook: 'permission.evaluate', input: { sessionID: 'z' } }, h), /fixture has no setup state/);
  } finally { h.close(); }
});

test('replayClaude rejects the promote hook', () => {
  const fx = { hook: 'promote', input: { session_id: 'z' }, setup: { phase: 'probe' } };
  assert.throws(() => replayClaude(fx, { configDir: mk('r2') }), /unsupported hook: promote/);
});

test('replayOpencode rejects unsupported hooks', async () => {
  const h = await createOpencodeHarness();
  try {
    await assert.rejects(() => replayOpencode({ hook: 'tool.execute.after', input: {}, setup: {} }, h), /unsupported hook: tool.execute.after/);
  } finally { h.close(); }
});

test('round trip claude: real guard trace -> promote -> replay', () => {
  const cfg = mk('c1'); const out = mk('c1out');
  const state = path.join(cfg, 'probe-state');
  const sid = 'rt-claude';
  const sandbox = path.join(state, sid, 'sandbox');
  const project = path.join(cfg, 'project');
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(state, `${sid}.json`), JSON.stringify({ phase: 'probe', sandbox, cwd: project }));
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: sid, cwd: project, tool_name: 'Write', tool_input: { file_path: path.join(project, 'src', 'main.py'), content: 'x' } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, PROBE_RECORD: '1' },
  });
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const r = promote(path.join(state, 'trace.jsonl'), 1, 'rt', out);
  assert.equal(r.status, 0, r.stderr);
  const fx = loadFixture('claude-code', 'rt', out);
  assert.equal(fx.expected, 'deny');
  assert.equal(fx.setup.phase, 'probe');
  assert.equal(replayClaude(fx, { configDir: mk('c1replay') }), fx.expected);
});

test('round trip opencode: stub-ctx evaluate trace -> promote -> replay', async () => {
  const live = await createOpencodeHarness({ record: true });
  let traceFile;
  try {
    const sid = 'rt-oc';
    fs.writeFileSync(path.join(live.stateDir, `${sid}.json`), JSON.stringify({ phase: 'probe', sandbox: path.join(live.stateDir, 'sb'), cwd: live.repo }));
    const ev = { sessionID: sid, action: 'edit', effect: 'ask', resources: ['src/app.js'] };
    await live.evaluate(ev);
    assert.equal(ev.effect, 'deny');
    traceFile = path.join(live.stateDir, 'trace.jsonl');
    const out = mk('o1out');
    const r = promote(traceFile, 1, 'rt', out);
    assert.equal(r.status, 0, r.stderr);
    const fx = loadFixture('opencode', 'rt', out);
    assert.equal(fx.expected, 'deny');
    const replayer = await createOpencodeHarness();
    try {
      assert.equal(await replayOpencode(fx, replayer), fx.expected);
    } finally { replayer.close(); }
  } finally { live.close(); }
});
