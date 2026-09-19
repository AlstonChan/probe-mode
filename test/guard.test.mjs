// Regression suite for the probe-mode guard.
//
//   node --test test/
//
// Runs the real hook as a subprocess against synthetic PreToolUse payloads and
// asserts allow/deny. Every case here is a rule someone could break by editing
// probe-guard.mjs; two of them are bugs that actually shipped.
//
// Nothing touches your real config: CLAUDE_CONFIG_DIR points at a temp dir.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GUARD = path.join(import.meta.dirname, '..', 'hooks', 'probe-guard.mjs');
const SID = 'test-session';

let CFG, SANDBOX, PLANS, PROJECT;

before(() => {
  // Deliberately under the home directory, not tmpdir, so that `~` expansion can
  // be tested against a real sandbox path. Removed again in after().
  CFG = fs.mkdtempSync(path.join(os.homedir(), '.probe-test-'));
  SANDBOX = path.join(CFG, 'probe-state', SID, 'sandbox');
  PLANS = path.join(CFG, 'plans');
  PROJECT = path.join(CFG, 'project');
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(PLANS, { recursive: true });
  fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(PLANS, 'existing.md'), '# plan\n');
  fs.writeFileSync(path.join(PROJECT, 'src', 'main.py'), 'x = 1\n');
  fs.writeFileSync(path.join(PROJECT, 'README.md'), '# readme\n');
});

after(() => {
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {}
});

function setPhase(phase) {
  fs.writeFileSync(
    path.join(CFG, 'probe-state', `${SID}.json`),
    JSON.stringify({ phase, sandbox: SANDBOX, cwd: PROJECT }),
  );
}

/** Runs the guard and returns "allow" or "deny". */
function decide(toolName, toolInput, sessionId = SID) {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd: PROJECT,
    tool_name: toolName,
    tool_input: toolInput,
  });
  const out = execFileSync(process.execPath, [GUARD], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });
  if (!out.trim()) return 'allow';
  const parsed = JSON.parse(out);
  return parsed.hookSpecificOutput.permissionDecision;
}

const sh = (command) => decide('Bash', { command });
const write = (file_path) => decide('Write', { file_path });

// Same isolation technique as test/rounds.test.mjs: this repo checkout always has
// .claude-plugin/ next to hooks/ (it's the plugin's own manifest), so the standalone
// branch can only be exercised by copying probe-guard.mjs into a dir without one.
function withIsolatedGuard(pluginLike, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-iso-guard-'));
  const hooksDir = path.join(dir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(GUARD, path.join(hooksDir, 'probe-guard.mjs'));
  if (pluginLike) fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  try {
    return fn(path.join(hooksDir, 'probe-guard.mjs'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function decideAt(guardPath, toolName, toolInput) {
  const payload = JSON.stringify({
    session_id: SID, cwd: PROJECT, tool_name: toolName, tool_input: toolInput,
  });
  const out = execFileSync(process.execPath, [guardPath], {
    input: payload, encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
  });
  return JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
}

// ---------------------------------------------------------------------------

describe('inert when probe mode is off', () => {
  test('no state file means the hook does not interfere', () => {
    assert.equal(decide('Write', { file_path: path.join(PROJECT, 'src/main.py') }, 'no-such-session'), 'allow');
  });

  test('phase off allows project writes', () => {
    setPhase('off');
    assert.equal(write(path.join(PROJECT, 'src/main.py')), 'allow');
  });

  test('phase implementing allows project writes', () => {
    setPhase('implementing');
    assert.equal(write(path.join(PROJECT, 'src/main.py')), 'allow');
  });
});

describe('file tools while locked', () => {
  before(() => setPhase('probe'));

  test('denies writing a project file', () => {
    assert.equal(write(path.join(PROJECT, 'src/main.py')), 'deny');
  });

  test('denies editing a project file', () => {
    assert.equal(decide('Edit', { file_path: path.join(PROJECT, 'README.md') }), 'deny');
  });

  test('denies NotebookEdit outside the sandbox', () => {
    assert.equal(decide('NotebookEdit', { notebook_path: path.join(PROJECT, 'a.ipynb') }), 'deny');
  });

  test('allows writing into the sandbox', () => {
    assert.equal(write(path.join(SANDBOX, 'bench.py')), 'allow');
  });

  test('does not touch read-only tools', () => {
    assert.equal(decide('Read', { file_path: path.join(PROJECT, 'src/main.py') }), 'allow');
  });
});

describe('the plan directory', () => {
  // Regression: plan mode writes the plan here. Denying it broke /probe
  // implement at the exact moment it was supposed to work.
  for (const phase of ['probe', 'planning', 'implementing']) {
    test(`allows writing a plan file in phase ${phase}`, () => {
      setPhase(phase);
      assert.equal(write(path.join(PLANS, 'new-plan.md')), 'allow');
    });
  }

  test('allows editing an existing plan', () => {
    setPhase('planning');
    assert.equal(decide('Edit', { file_path: path.join(PLANS, 'existing.md') }), 'allow');
  });

  // Regression: making the plan dir a general writable root let `rm -rf` wipe
  // the user's entire plan history.
  test('denies rm -rf of the plans directory', () => {
    setPhase('probe');
    assert.equal(sh(`rm -rf ${PLANS}`), 'deny');
  });

  test('denies deleting a single plan from the shell', () => {
    assert.equal(sh(`rm ${PLANS}/existing.md`), 'deny');
  });

  test('allows reading plans from the shell', () => {
    assert.equal(sh(`cat ${PLANS}/existing.md`), 'allow');
  });
});

describe('the rest of the config directory stays sealed', () => {
  before(() => setPhase('probe'));

  test('denies writing settings.json', () => {
    assert.equal(write(path.join(CFG, 'settings.json')), 'deny');
  });

  test('denies writing a hook script', () => {
    assert.equal(write(path.join(CFG, 'hooks', 'probe-guard.mjs')), 'deny');
  });

  test('denies path traversal out of the plans directory', () => {
    assert.equal(write(path.join(PLANS, '..', 'settings.json')), 'deny');
  });
});

describe('shell: investigation is allowed', () => {
  before(() => setPhase('probe'));

  for (const cmd of [
    'pytest -q tests/',
    'npm test',
    'mvn test',
    'gradle test',
    'make',
    'make test',
    'grep -rn foo src/',
    'git status --porcelain',
    'git diff HEAD~1',
    'git log --oneline -20',
  ]) {
    test(`allows: ${cmd}`, () => assert.equal(sh(cmd), 'allow'));
  }

  test('allows running a sandbox script from the project directory', () => {
    assert.equal(sh(`python ${SANDBOX}/bench.py`), 'allow');
  });
});

describe('shell: mutation is denied', () => {
  before(() => setPhase('probe'));

  for (const cmd of [
    'git commit -am wip',
    'git push origin main',
    'git checkout -- .',
    'npm install lodash',
    'pip install requests',
    'rm -rf src/',
    'sed -i "s/a/b/" README.md',
    'bundle install',
    'composer require foo/bar',
    'mvn install',
    'gem install rails',
    'apt-get install curl',
    'brew install jq',
    'make install',
    'make clean',
    'rake db:migrate',
    'alembic upgrade head',
    'prisma migrate dev',
    'flyway migrate',
    'manage.py migrate',
    'artisan migrate',
    'helm upgrade myrel ./chart',
    'ansible-playbook site.yml',
    'serverless deploy',
    'vercel deploy --prod',
    'aws s3 rm s3://bucket/key',
    'gcloud run deploy svc',
    'terraform apply',
    'kubectl apply -f k8s/',
    'cargo publish',
    'twine upload dist/*',
    'gh pr create --fill',
    'gh release create v1.0.0',
    'wget https://example.com/x.tar.gz',
    'curl -o out.bin https://example.com/x',
  ]) {
    test(`denies: ${cmd}`, () => assert.equal(sh(cmd), 'deny'));
  }
});

describe('shell: the sandbox is writable', () => {
  before(() => setPhase('probe'));

  test('allows mkdir inside the sandbox', () => {
    assert.equal(sh(`mkdir -p ${SANDBOX}/results`), 'allow');
  });

  test('allows redirecting into the sandbox', () => {
    assert.equal(sh(`echo hi > ${SANDBOX}/out.txt`), 'allow');
  });

  test('allows tee into the sandbox', () => {
    assert.equal(sh(`python ${SANDBOX}/bench.py | tee ${SANDBOX}/run.log`), 'allow');
  });

  test('allows downloading into the sandbox', () => {
    assert.equal(sh(`wget -O ${SANDBOX}/data.tar.gz https://example.com/d.tar.gz`), 'allow');
  });

  test('denies redirecting into the project', () => {
    assert.equal(sh('echo hi > notes.txt'), 'deny');
  });

  test('denies tee into the project', () => {
    assert.equal(sh(`python ${SANDBOX}/bench.py | tee bench.log`), 'deny');
  });
});

describe('shell parsing: legitimate sandbox scripting is allowed', () => {
  // Every case here was falsely denied before the guard became shell-aware.
  // They are the shapes a research round actually produces.
  before(() => setPhase('probe'));

  test('expands a $VAR assigned in the same command', () => {
    assert.equal(sh(`SB=${SANDBOX}; echo hi > "$SB/out.txt"`), 'allow');
  });

  test('expands ${VAR} braces', () => {
    assert.equal(sh(`SB=${SANDBOX}; echo hi > "\${SB}/out.txt"`), 'allow');
  });

  test('expands ~ to the home directory', () => {
    const tildePath = `~/${path.basename(CFG)}/probe-state/${SID}/sandbox/o.txt`;
    assert.equal(sh(`echo hi > ${tildePath}`), 'allow');
  });

  test('a heredoc body is data, not a set of paths', () => {
    assert.equal(sh(`cat > ${SANDBOX}/s.sh <<'EOF'\nrm -rf /etc\nsrc/main.py\nEOF`), 'allow');
  });

  test('a non-mutating segment is not scanned: read project, then clean sandbox', () => {
    assert.equal(sh(`cat ${PROJECT}/README.md; rm -f ${SANDBOX}/tmp.json`), 'allow');
  });

  test('running a project file then cleaning the sandbox', () => {
    assert.equal(sh(`node ${PROJECT}/src/main.py; rm -f ${SANDBOX}/tmp.json`), 'allow');
  });

  test('grep the project, then write results to the sandbox', () => {
    assert.equal(sh(`grep -rn x ${PROJECT}; echo done > ${SANDBOX}/o.txt`), 'allow');
  });

  test('a word in a quoted message cannot become a path', () => {
    // `src` is a real directory in PROJECT; as prose it must not be a target.
    assert.equal(sh(`rm -f ${SANDBOX}/x.json && echo "src cleaned up"`), 'allow');
  });

  test('a quoted path with a space still resolves', () => {
    assert.equal(sh(`rm -f "${SANDBOX}/a file.txt"`), 'allow');
  });
});

describe('shell parsing: multi-segment commands still deny correctly', () => {
  // The per-segment rewrite must not let anything escape. `cd` state has to be
  // carried between segments or the first case below silently passes.
  before(() => setPhase('probe'));

  test('cd into the sandbox then escaping upward is denied', () => {
    assert.equal(sh(`cd ${SANDBOX} && rm -rf ../../../../${path.basename(PROJECT)}`), 'deny');
  });

  test('a sandbox write followed by a project rm is denied', () => {
    assert.equal(sh(`echo x > ${SANDBOX}/a.txt && rm -rf ${PROJECT}/src`), 'deny');
  });

  test('cd into the project then rm is denied', () => {
    assert.equal(sh(`cd ${PROJECT} && rm -rf src`), 'deny');
  });

  test('cd into the sandbox then write is allowed', () => {
    assert.equal(sh(`cd ${SANDBOX} && echo hi > out.txt`), 'allow');
  });

  test('a mutator with an unexpandable variable is denied', () => {
    assert.equal(sh('rm -rf "$UNKNOWN_DIR/stuff"'), 'deny');
  });

  test('git commit hidden behind a harmless first segment is denied', () => {
    assert.equal(sh(`cat ${PROJECT}/README.md && git commit -am wip`), 'deny');
  });
});

describe('fails closed', () => {
  // A broken guard must never become an open door.
  test('denies when the state file exists but is unreadable', () => {
    fs.writeFileSync(path.join(CFG, 'probe-state', `${SID}.json`), 'not json {{{');
    assert.equal(write(path.join(PROJECT, 'src/main.py')), 'deny');
  });
});

describe('deny messages name the right command for the install layout', () => {
  before(() => setPhase('probe'));

  test('standalone layout (no .claude-plugin sibling) hints at plain /probe', () => {
    const reason = withIsolatedGuard(false, (guardPath) =>
      decideAt(guardPath, 'Write', { file_path: path.join(PROJECT, 'src/main.py') }));
    assert.match(reason, /\/probe implement/);
    assert.doesNotMatch(reason, /probe-mode:probe/);
  });

  test('plugin layout (.claude-plugin sibling present) hints at /probe-mode:probe', () => {
    const reason = withIsolatedGuard(true, (guardPath) =>
      decideAt(guardPath, 'Write', { file_path: path.join(PROJECT, 'src/main.py') }));
    assert.match(reason, /\/probe-mode:probe implement/);
  });
});
