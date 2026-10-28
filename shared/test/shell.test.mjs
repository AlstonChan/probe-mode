// Shell analysis: bypasses that must deny and read-only commands that must not.
//
//   node --test shared/test/shell.test.mjs
//
// Every case below was a real gap found by an adversarial review of the old
// regex analysis. They run against shared/shell.mjs directly (what OpenCode
// uses); a sample also goes through the real Claude guard as a subprocess.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeCommand, analyzeSegments, describeCommand } from '../../shared/shell.mjs';

const GUARD = path.join(import.meta.dirname, '..', '..', 'hooks', 'probe-guard.mjs');
const SID = 'shell-test';
let CFG, SANDBOX, PROJECT;

const verdict = (command, shell = 'bash') =>
  (analyzeCommand(command, { cwd: PROJECT, roots: [SANDBOX], shell }) ? 'deny' : 'allow');
const fill = (s) => s.replaceAll('{S}', SANDBOX.split(path.sep).join('/')).replaceAll('{P}', PROJECT.split(path.sep).join('/'));

before(() => {
  CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-shell-'));
  SANDBOX = path.join(CFG, 'probe-state', SID, 'sandbox');
  PROJECT = path.join(CFG, 'project');
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'README.md'), '# readme\n');
  fs.writeFileSync(path.join(PROJECT, 'src', 'cp.js'), '');
  fs.writeFileSync(path.join(CFG, 'probe-state', `${SID}.json`), JSON.stringify({ phase: 'probe', sandbox: SANDBOX, cwd: PROJECT }));
});
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch {} });

const BYPASSES = [
  ['heredoc hiding its redirect', 'cat <<EOF > README.md\nhello\nEOF'],
  ['quoted heredoc delimiter', "cat <<'EOF' >README.md\n$x\nEOF"],
  ['fd-numbered redirect', 'echo hi 1>README.md'],
  ['stderr redirect', 'echo hi 2>README.md'],
  ['>& to a file', 'echo hi >& README.md'],
  ['clobber redirect', 'echo hi >| README.md'],
  ['&> redirect', 'echo hi &> README.md'],
  ['read-write redirect', 'exec 3<>README.md'],
  ['cd that fails keeps the old directory', 'cd {S}/nope; echo hi > README.md'],
  ['cd - is unknown', 'cd {S} && cd -; echo hi > README.md'],
  ['popd is unknown', 'pushd {S} && popd; echo hi > README.md'],
  ['variables expand in order', 'F=README.md; echo hi > $F; F={S}/x'],
  ['git -C before the subcommand', 'git -C . checkout -- README.md'],
  ['git --no-pager before the subcommand', 'git --no-pager reset --hard'],
  ['git -c before the subcommand', 'git -c core.x=y commit -m wip'],
  ['git pull', 'git pull'],
  ['git fetch', 'git fetch origin'],
  ['git update-ref', 'git update-ref -d refs/heads/main'],
  ['git branch -D', 'git branch -D feature'],
  ['git format-patch writes files', 'git format-patch -1'],
  ['sed -i after other flags', 'sed -E -i s/x/y/ README.md'],
  ['sed -i after the script', 'sed -e s/x/y/ -i README.md'],
  ['sed -i clustered', 'sed -Ei s/x/y/ README.md'],
  ['perl -i after -p', 'perl -p -i -e s/x/y/ README.md'],
  ['perl -pi -e', "perl -pi -e 's/x/y/' README.md"],
  ['find -delete', 'find . -name README.md -delete'],
  ['find -exec rm', 'find . -name "*.md" -exec rm {} \\;'],
  ['sort -o', 'sort -o README.md README.md'],
  ['tee in a pipeline', 'echo x | tee -a README.md'],
  ['dd of=', 'dd if=/dev/zero of=README.md count=1'],
  ['command substitution runs', 'echo $(rm -rf src)'],
  ['backticks run', 'echo `rm README.md`'],
  ['bash -c', 'bash -c "rm -rf src"'],
  ['sh -lc clustered', "sh -lc 'echo x > README.md'"],
  ['eval', 'eval "rm README.md"'],
  ['xargs feeding rm', 'ls | xargs rm'],
  ['env wrapper', 'env FOO=1 rm README.md'],
  ['sudo wrapper', 'sudo rm README.md'],
  ['npx formatter', 'npx prettier --write .'],
  ['python -m formatter', 'python -m black .'],
  ['mklink junction', 'cmd //c mklink //J {S}/j {P}'],
  ['hard link to a project file', 'ln {P}/README.md {S}/r'],
  ['.. out of the sandbox', 'echo hi > {S}/../../../project/README.md'],
  ['sandbox sibling', 'echo hi > {S}-evil/x'],
  ['home directory', 'echo hi > ~/x'],
  ['unknown variable', 'rm -rf "$UNKNOWN/x"'],
  ['curl -o', 'curl -sSLo README.md https://example.com'],
  ['wget', 'wget https://example.com/x'],
  ['global npm install', 'npm install -g left-pad'],
];

const PWSH_BYPASSES = [
  ['del alias', 'del README.md'],
  ['ni alias', 'ni src/new.txt'],
  ['Tee-Object', "'x' | Tee-Object -FilePath README.md"],
  ['.NET WriteAllText', "[IO.File]::WriteAllText('{P}/README.md','x')"],
  ['.NET System.IO Delete', "[System.IO.File]::Delete('README.md')"],
  ['Clear-Content', 'Clear-Content README.md'],
  ['Set-Content positional', "Set-Content README.md 'x'"],
  ['Remove-Item in a scriptblock', 'Get-ChildItem | ForEach-Object { Remove-Item $_ }'],
  ['*> redirect', 'git status *> README.md'],
  ['Invoke-Expression', 'iex "Remove-Item README.md"'],
  ['pwsh -Command', 'pwsh -NoProfile -Command "Remove-Item README.md"'],
  ['pwsh -EncodedCommand', `pwsh -EncodedCommand ${Buffer.from('Remove-Item README.md', 'utf16le').toString('base64')}`],
  ['Invoke-WebRequest -OutFile', 'iwr https://x -OutFile README.md'],
];

const READS = [
  ['/dev/null sink', 'git log --oneline > /dev/null'],
  ['NUL sink', 'ls src > NUL'],
  ['fd duplication', 'node --test test/a.test.mjs 2>&1'],
  ['quoted >', 'grep -rn "=>" src'],
  ['quoted verb', 'grep -rn "rm" .'],
  ['echo with quoted >', 'echo "a > b"'],
  ['verb inside a file name', 'cat src/cp.js'],
  ['patch in a file name', 'cat fix.patch'],
  ['git show --patch', 'git show --patch HEAD'],
  ['git config --get', 'git config --get user.name'],
  ['git config one key', 'git config user.name'],
  ['git stash list', 'git stash list'],
  ['git tag (list)', 'git tag'],
  ['git tag -l', 'git tag -l "v1.*"'],
  ['git branch (list)', 'git branch -a'],
  ['git merge-base', 'git merge-base main HEAD'],
  ['git -C log', 'git -C . log --oneline -3'],
  ['git apply --check', 'git apply --check x.patch'],
  ['sed without -i', "sed -n '1,5p' README.md"],
  ['comment containing a redirect', 'ls # > README.md'],
  ['heredoc body is data', 'cat <<EOF\nrm -rf / > README.md\nEOF'],
  ['curl to stdout', 'curl -s https://example.com'],
  ['find without actions', 'find . -name "*.md"'],
  ['npm test', 'npm test'],
  ['python script', 'python bench.py'],
  ['xargs grep', 'ls | xargs grep x'],
  ['writes inside the sandbox', 'echo hi > {S}/out.txt'],
  ['MSYS path into the sandbox', 'echo hi > /c/ignored'], // replaced below on Windows
  ['deep mkdir inside the sandbox', 'mkdir -p {S}/a/b/c'],
  ['cd into the sandbox; then write', 'cd {S}; echo hi > out.txt'],
  ['cp from the project into the sandbox', 'cp README.md {S}/'],
  ['git clone into the sandbox', 'git clone https://x/y.git {S}/y'],
  ['git commit inside a sandbox repo', 'cd {S} && git init -q r && cd r && git commit -m x'],
];

const PWSH_READS = [
  ['$null sink', 'git status > $null'],
  ['Get-Content', 'Get-Content README.md'],
  ['Out-Null', 'git status | Out-Null'],
  ['Remove-Item -WhatIf', 'Remove-Item README.md -WhatIf'],
  ['Set-Content into the sandbox', "Set-Content -Path '{S}/x.txt' -Value 'x'"],
];

describe('bypasses deny (bash)', () => {
  for (const [why, cmd] of BYPASSES) test(why, () => assert.equal(verdict(fill(cmd)), 'deny', cmd));
});

describe('bypasses deny (PowerShell)', () => {
  for (const [why, cmd] of PWSH_BYPASSES) test(why, () => assert.equal(verdict(fill(cmd), 'powershell'), 'deny', cmd));
});

describe('read-only commands allow (bash)', () => {
  for (const [why, cmd] of READS) {
    test(why, () => {
      let c = fill(cmd);
      if (why.startsWith('MSYS')) {
        if (process.platform !== 'win32') return;
        const s = SANDBOX.split(path.sep).join('/');
        c = `echo hi > /${s[0].toLowerCase()}${s.slice(2)}/msys.txt`;
      }
      assert.equal(verdict(c), 'allow', c);
    });
  }
});

describe('read-only commands allow (PowerShell)', () => {
  for (const [why, cmd] of PWSH_READS) test(why, () => assert.equal(verdict(fill(cmd), 'powershell'), 'allow', cmd));
});

describe('links are judged by where they really land', () => {
  test('a write through a junction from the sandbox into the project denies', () => {
    const link = path.join(SANDBOX, 'j');
    fs.symlinkSync(PROJECT, link, 'junction');
    try {
      assert.equal(verdict(fill('echo hi > {S}/j/README.md')), 'deny');
      assert.equal(verdict(fill('mkdir -p {S}/j/new/dir')), 'deny');
    } finally {
      fs.rmSync(link, { force: true, recursive: false });
    }
  });
});

describe('OpenCode segments', () => {
  test('a failed cd in an earlier segment keeps the project possible', () => {
    const r = analyzeSegments([fill('cd {S}/nope'), 'echo hi > README.md'], { cwd: PROJECT, roots: [SANDBOX] });
    assert.ok(r.offenders.length > 0);
  });
  test('reads across segments stay allowed', () => {
    const r = analyzeSegments(['git status', 'ls src'], { cwd: PROJECT, roots: [SANDBOX] });
    assert.equal(r.sawMutation, false);
  });
});

describe('describeCommand', () => {
  test('names the mutation', () => {
    assert.deepEqual(describeCommand('git push'), { kind: 'mutate', label: 'git push' });
    assert.deepEqual(describeCommand('cat x'), { kind: 'none' });
  });
});

describe('the real guard agrees', () => {
  const guard = (tool, command) => {
    const out = execFileSync(process.execPath, [GUARD], {
      input: JSON.stringify({ session_id: SID, cwd: PROJECT, tool_name: tool, tool_input: { command } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
    });
    return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
  };
  test('heredoc redirect denies', () => assert.equal(guard('Bash', 'cat <<EOF > README.md\nx\nEOF'), 'deny'));
  test('PowerShell del denies', () => assert.equal(guard('PowerShell', 'del README.md'), 'deny'));
  test('$null sink allows under PowerShell', () => assert.equal(guard('PowerShell', 'git status > $null'), 'allow'));
  test('quoted verb allows', () => assert.equal(guard('Bash', 'grep -rn "rm" .'), 'allow'));
});
