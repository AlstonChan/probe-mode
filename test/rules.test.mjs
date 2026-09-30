// Policy parity + rule-shape suite.
//
//   node --test
//
// Two jobs:
//
//   1. PARITY. The same command matrix is judged by the REAL Claude guard
//      (hooks/probe-guard.mjs, run as a subprocess with a synthetic
//      PreToolUse payload) and by shared/shell.mjs — the analysis OpenCode's
//      permission hook runs. If they ever disagree, the two hosts have stopped
//      enforcing the same contract, which is the whole point of sharing
//      state/rules/contract in shared/.
//
//   2. RULE SHAPE. OpenCode's session rules are checked with the same
//      last-match-wins evaluator its server uses: broad deny first, writable
//      roots after it, implementing phase empty.
//
// Nothing touches your real config: CLAUDE_CONFIG_DIR points at a temp dir.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sessionRules, matchEffect, resourcePath, shellDenied, SHELL_DENY_PATTERNS, wildcardMatch,
} from '../shared/rules.mjs';
import { analyzeCommand, MUTATORS } from '../shared/shell.mjs';

const GUARD = path.join(import.meta.dirname, '..', 'hooks', 'probe-guard.mjs');
const SID = 'parity';

let CFG, STATE_DIR, SANDBOX, PROJECT, PROJECT_SANDBOX, PLANS;

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-rules-'));
  STATE_DIR = path.join(CFG, 'probe-state');
  SANDBOX = path.join(STATE_DIR, SID, 'sandbox');
  PROJECT = path.join(CFG, 'project');
  PROJECT_SANDBOX = path.join(PROJECT, '.probe-sandbox');
  PLANS = path.join(CFG, 'plans');
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(PROJECT_SANDBOX, { recursive: true });
  fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });
  fs.mkdirSync(PLANS, { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'src', 'main.py'), 'x = 1\n');
  fs.writeFileSync(path.join(PROJECT, 'notes.md'), '# notes\n');
  fs.writeFileSync(path.join(SANDBOX, 'out.txt'), 'prior run\n');
  fs.writeFileSync(path.join(PROJECT_SANDBOX, 'bench.js'), '// scratch\n');
  fs.writeFileSync(
    path.join(STATE_DIR, `${SID}.json`),
    JSON.stringify({ phase: 'probe', sandbox: SANDBOX, cwd: PROJECT }),
  );
});

after(() => {
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {}
});

/** Runs the real guard and returns "allow" or "deny". */
function guard(toolName, toolInput) {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: SID, cwd: PROJECT, tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });
  if (!out.trim()) return 'allow';
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

/** What OpenCode's hook would decide: shared/shell.mjs over the same roots the
 *  plugin passes (sandbox + in-project sandbox — deliberately NOT the state
 *  directory, which OpenCode keeps read-only while Claude's guard allows it). */
function analyzer(command) {
  const verdict = analyzeCommand(command, { cwd: PROJECT, roots: [SANDBOX, PROJECT_SANDBOX] });
  return verdict ? 'deny' : 'allow';
}

// Each entry is a policy decision BOTH hosts must reach. `why` documents the
// rule being pinned; it shows up in the test name when someone breaks it.
const MATRIX = [
  // --- research is never blocked ------------------------------------------
  ['node --version', 'allow', 'running a binary is the point of research'],
  ['git status', 'allow', 'inspection'],
  ['git diff --stat', 'allow', 'inspection'],
  ['git log --oneline -5', 'allow', 'inspection'],
  ['ls -la src', 'allow', 'inspection'],
  ['cat notes.md', 'allow', 'inspection'],
  ['grep -r TODO src', 'allow', 'inspection'],
  ['python -m pytest -q', 'allow', 'the test suite must run'],
  ['npm test', 'allow', 'npm verbs outside the mutating list stay runnable'],
  ['terraform plan', 'allow', 'plan reads, apply writes'],
  ['make', 'allow', 'bare make builds so tests can run'],
  ['echo hello', 'allow', 'no redirect, no mutation'],
  ['cat src/main.py | grep x', 'allow', 'pipelines of readers'],
  ['cd src && ls', 'allow', 'cd plus a reader'],

  // --- mutations are blocked ----------------------------------------------
  ['git commit -m wip', 'deny', 'git writes'],
  ['git add -A', 'deny', 'staging changes the index'],
  ['git push origin main', 'deny', 'reaches other people'],
  ['npm install left-pad', 'deny', 'installs'],
  ['pip install requests', 'deny', 'installs'],
  ['rm -rf src', 'deny', 'deletes project files'],
  ['mv notes.md src/', 'deny', 'moves project files'],
  ['sed -i s/a/b/ notes.md', 'deny', 'in-place edit'],
  ['python -m black .', 'deny', 'formatter reached through an interpreter'],
  ['prettier --write src/main.py', 'deny', 'formatter with --write'],
  ['eslint --fix src/main.py', 'deny', 'formatter with --fix'],
  ['terraform apply', 'deny', 'infrastructure mutation'],
  ['kubectl apply -f x.yaml', 'deny', 'cluster mutation'],
  ['docker compose down', 'deny', 'environment mutation'],
  ['python manage.py migrate', 'deny', 'migrations'],
  ['echo hi > notes.md', 'deny', 'redirect into the project'],
  ['wget https://example.com/x.tgz', 'deny', 'downloads write files'],
  ['bash -c "rm -rf src"', 'deny', 'a mutator behind an interpreter'],
  ['cd /tmp && rm -rf .', 'deny', 'cd does not launder the next segment'],
  ['SB=/tmp; echo x > "$SB/f"', 'deny', 'an unresolvable target denies'],
];

describe('the guard and shared/shell.mjs reach the same verdict', () => {
  for (const [command, expected, why] of MATRIX) {
    test(`${expected === 'deny' ? 'blocks' : 'allows'}: ${command}`, () => {
      assert.equal(guard('Bash', { command }), expected, `guard: ${why}`);
      assert.equal(analyzer(command), expected, `shared analysis: ${why}`);
    });
  }
});

describe('sandbox writes are allowed by both hosts', () => {
  const cases = [
    [`rm -rf ${SANDBOX}/out.txt`, 'deleting inside the sandbox'],
    [`mkdir ${SANDBOX}/run-2`, 'creating inside the sandbox'],
    [`echo x > ${SANDBOX}/out.txt`, 'redirecting into the sandbox'],
    [`node ${PROJECT_SANDBOX}/bench.js`, 'running the benchmark harness'],
  ];
  for (const [command, why] of cases) {
    test(why, () => {
      assert.equal(guard('Bash', { command }), 'allow', `guard: ${why}`);
      assert.equal(analyzer(command), 'allow', `shared analysis: ${why}`);
    });
  }
});

describe('file tools', () => {
  test('project writes are denied while armed', () => {
    assert.equal(guard('Write', { file_path: path.join(PROJECT, 'src', 'main.py') }), 'deny');
    assert.equal(guard('Edit', { file_path: path.join(PROJECT, 'notes.md') }), 'deny');
  });

  test('sandbox writes are allowed while armed', () => {
    assert.equal(guard('Write', { file_path: path.join(SANDBOX, 'bench.py') }), 'allow');
    assert.equal(guard('Write', { file_path: path.join(PROJECT_SANDBOX, 'bench.js') }), 'allow');
  });

  test('the plan directory stays writable (both hosts)', () => {
    assert.equal(guard('Write', { file_path: path.join(PLANS, 'plan.md') }), 'allow');
  });

  test('implementing phase unlocks everything, in both hosts', () => {
    fs.writeFileSync(
      path.join(STATE_DIR, `${SID}.json`),
      JSON.stringify({ phase: 'implementing', sandbox: SANDBOX, cwd: PROJECT }),
    );
    assert.equal(guard('Write', { file_path: path.join(PROJECT, 'src', 'main.py') }), 'allow');
    // OpenCode reaches the same place by clearing the session rules entirely,
    // and its permission hook stops analyzing shell once the phase is
    // implementing — asserted above in `implementing and off phases install no
    // rules at all`.
    assert.deepEqual(rulesFor('implementing'), []);
    fs.writeFileSync(
      path.join(STATE_DIR, `${SID}.json`),
      JSON.stringify({ phase: 'probe', sandbox: SANDBOX, cwd: PROJECT }),
    );
  });
});

// -------------------------------------------------------------- rule shape

const LOCATION = path.join(CFG, 'project');
const rulesFor = (phase) =>
  sessionRules({
    phase,
    sandbox: SANDBOX,
    plansDir: PLANS,
    stateDir: STATE_DIR,
    locationDir: LOCATION,
    extraRoots: [path.join(LOCATION, '.probe-sandbox')],
  });

describe('OpenCode session rules', () => {
  test('probe phase: hard deny outside the sandbox, allow inside it', () => {
    const rules = rulesFor('probe');
    assert.equal(matchEffect(rules, 'edit', 'src/main.py'), 'deny');
    assert.equal(matchEffect(rules, 'edit', 'notes.md'), 'deny');
    // In-project sandbox is reported location-relative, the plan directory and
    // the real sandbox as absolute paths — both spellings must be allowed.
    assert.equal(matchEffect(rules, 'edit', '.probe-sandbox/bench.js'), 'allow');
    assert.equal(matchEffect(rules, 'edit', `${SANDBOX.replaceAll('\\', '/')}/bench.py`), 'allow');
    assert.equal(matchEffect(rules, 'edit', `${PLANS.replaceAll('\\', '/')}/plan.md`), 'allow');
    // The state file itself must stay unwritable: tampering cannot unlock.
    assert.equal(matchEffect(rules, 'edit', `${STATE_DIR.replaceAll('\\', '/')}/${SID}.json`), 'deny');
  });

  test('planning phase: the same paths, but outside writes ASK (the dialog)', () => {
    const rules = rulesFor('planning');
    assert.equal(matchEffect(rules, 'edit', 'src/main.py'), 'ask');
    assert.equal(matchEffect(rules, 'edit', `${SANDBOX.replaceAll('\\', '/')}/bench.py`), 'allow');
    assert.equal(matchEffect(rules, 'edit', `${PLANS.replaceAll('\\', '/')}/plan.md`), 'allow');
  });

  test('implementing and off phases install no rules at all', () => {
    assert.deepEqual(rulesFor('implementing'), []);
    assert.deepEqual(rulesFor('off'), []);
  });

  test('the directory boundary is granted for the sandbox and plan directory', () => {
    const rules = rulesFor('probe');
    assert.equal(matchEffect(rules, 'external_directory', `${STATE_DIR.replaceAll('\\', '/')}/x/*`), 'allow');
    assert.equal(matchEffect(rules, 'external_directory', `${PLANS.replaceAll('\\', '/')}/x`), 'allow');
    assert.equal(matchEffect(rules, 'external_directory', '/elsewhere/*'), 'ask');
  });

  test('question stays usable (it is how the model asks for approval)', () => {
    assert.equal(matchEffect(rulesFor('planning'), 'question', '*'), 'allow');
  });

  test('mutating shell commands park at ask, never silently allowed', () => {
    const rules = rulesFor('probe');
    for (const command of ['git commit -m x', 'npm install x', 'rm -rf src', 'echo hi > notes.md']) {
      assert.equal(matchEffect(rules, 'shell', command), 'ask', command);
    }
    // Benign commands are NOT caught by the fallback patterns: they must keep
    // their normal policy (the agent's base allow) instead of prompting on
    // every research command.
    for (const command of ['git status', 'npm test', 'node --version', 'python -m pytest -q']) {
      assert.equal(shellDenied(command), false, command);
      const matched = rules.filter(
        (rule) => rule.action === 'shell' && wildcardMatch(command, rule.resource),
      );
      assert.deepEqual(matched, [], `${command} must not match any probe rule`);
    }
  });

  test('the mutator list the hook uses is the one the guard inlines', () => {
    // Both copies are deliberate (the guard cannot import), so pin the shapes
    // that matter: a family the guard lost would silently unblock a host.
    const sources = MUTATORS.map((re) => re.source);
    assert.ok(sources.some((s) => s.includes('git\\s+(add|commit')), 'git writes family present');
    assert.ok(sources.some((s) => s.includes('npm|pnpm|yarn|bun')), 'package managers present');
    assert.ok(sources.some((s) => s.includes('terraform')), 'terraform present');
    assert.ok(sources.some((s) => s.includes('manage\\.py')), 'migrations present');
    assert.ok(SHELL_DENY_PATTERNS.length > 100, 'the shell fallback covers the same families');
  });

  test('resourcePath picks the spelling OpenCode reports', () => {
    assert.equal(resourcePath(path.join(LOCATION, 'src', 'main.py'), LOCATION), 'src/main.py');
    assert.equal(resourcePath(SANDBOX, LOCATION), SANDBOX.replaceAll('\\', '/'));
    assert.equal(resourcePath(LOCATION, LOCATION), '.');
  });
});
