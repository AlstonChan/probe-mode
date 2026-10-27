#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const fail = (msg) => { console.error(`promote-trace: ${msg}`); process.exit(1); };

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
  else pos.push(args[i]);
}
const [tracePath, lineArg, name] = pos;
if (!tracePath || !lineArg || !name) {
  fail('usage: promote-trace.mjs <trace.jsonl> <line> <name> [--host-version <v>] [--phase <p>] [--sandbox <path>] [--out-dir <dir>]');
}
if (!/^[\w.-]+$/.test(name)) fail(`invalid name: ${name}`);
const line = Number(lineArg);
if (!Number.isInteger(line) || line < 1) fail(`invalid line: ${lineArg}`);

let text;
try { text = fs.readFileSync(tracePath, 'utf8'); } catch (e) { fail(`cannot read ${tracePath}: ${e.message}`); }
const raw = text.split(/\r?\n/)[line - 1];
if (raw === undefined || raw.trim() === '') fail(`line ${line} not found in ${tracePath}`);
let entry;
try { entry = JSON.parse(raw); } catch { fail(`line ${line} is not valid JSON`); }
if (!entry || typeof entry !== 'object' || !entry.host || !entry.hook) fail(`line ${line} is not a trace entry`);

const outDir = flags['out-dir'] ?? path.join(import.meta.dirname, '..', 'test', 'fixtures');
if (typeof entry.host !== 'string' || !/^[\w-]+$/.test(entry.host)) fail(`invalid host in trace entry: ${JSON.stringify(entry.host)}`);
const file = path.join(outDir, entry.host, `${name}.json`);
if (fs.existsSync(file)) fail(`fixture already exists: ${file}`);

let setup = {};
if (entry.sessionId) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(tracePath)), `${entry.sessionId}.json`), 'utf8'));
    for (const k of ['phase', 'sandbox', 'cwd']) if (st && st[k] !== undefined) setup[k] = st[k];
  } catch {
    console.error(`promote-trace: no readable state file for ${entry.sessionId}; pass --phase/--sandbox`);
  }
}
if (flags.phase) setup.phase = flags.phase;
if (flags.sandbox) setup.sandbox = flags.sandbox;

const fixture = {
  host: entry.host,
  hostVersion: flags['host-version'] ?? 'unknown',
  capturedAt: entry.at ?? new Date().toISOString(),
  scenario: name,
  hook: entry.hook,
  ...(Object.keys(setup).length ? { setup } : {}),
  input: entry.input,
  expected: entry.decision,
};
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx' });
console.log(file);
console.error('promote-trace: review before committing: the fixture contains payload text and absolute paths. `expected` is what the hook did; for a bug, edit it to the correct decision first and watch the test fail.');
