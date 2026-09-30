// Host-agnostic probe-mode POLICY: which paths are writable, which shell
// commands are denied, and the messages the model sees when it hits a wall.
//
// Claude Code consumes this as text (its guard, hooks/probe-guard.mjs, is
// deliberately self-contained and inlines its own copy of the path rules — an
// import that failed to parse would let writes through). OpenCode consumes the
// rules directly as session-scoped permission rules, which its server enforces
// independent of any plugin being alive. test/rules.test.mjs keeps the two
// honest: it drives the real guard AND this module over the same command and
// path matrix and fails if they disagree.
//
// Rule shape: { action, resource, effect }. Last match wins (OpenCode appends
// session rules after agent rules, and rules are evaluated in array order), so
// every broad rule below is followed by the exceptions it needs.

const slash = (value) => String(value).replaceAll('\\', '/');

/** Path as OpenCode reports it: location-relative inside the workspace,
 *  absolute outside. Both forms are matched by the same wildcard rules
 *  because Wildcard.match normalizes backslashes and, on Windows, folds case. */
export function resourcePath(absolutePath, locationDir) {
  const abs = slash(absolutePath);
  const root = slash(locationDir).replace(/\/+$/, '');
  if (abs === root) return '.';
  if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  return abs;
}

// ------------------------------------------------------------------- shell
//
// OpenCode's shell scanner splits a command into segments and checks each
// segment's text as one resource (`git commit -m x`, `rm -rf out`), so a prefix
// pattern like `git commit *` matches the command with or without arguments.
// A compound command produces several resources and ANY denial denies the run —
// so `cd /tmp && rm -rf x` is caught by `rm *`.
//
// Wildcard matching is literal-plus-`*`: `a * b` needs a SPACE between `a` and
// whatever follows, so `sed -i` and `sed -i *` are separate patterns from
// `sed * -i *`. Every family below therefore lists both the direct form
// (`aws cp ...`) and the interpreter-embedded form (`python -m black ...`).
//
// These mirror Claude's MUTATORS families: installs, git writes, formatters,
// migrations, deploys, publishing, downloads. Deliberately a DENY-LIST (fail
// open for anything unlisted, exactly like Claude): a build tool nobody thought
// of passes, and the git snapshot — not this list — is the real guarantee. A
// mutator reached through an interpreter (`bash -c "rm x"`, `python -c ...`) is
// likewise unlisted; call it directly and it is caught.
const PACKAGEMANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
const PACKAGE_VERBS = ['i', 'install', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'link', 'publish'];
const GIT_WRITES = [
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'merge', 'rebase', 'cherry-pick',
  'revert', 'stash', 'clean', 'apply', 'am', 'push', 'rm', 'mv', 'tag', 'config', 'worktree',
];
const FILE_MUTATORS = [
  'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'truncate', 'dd', 'shred', 'unlink', 'patch',
];
const MIGRATIONS = [
  'alembic upgrade', 'alembic downgrade', 'alembic stamp', 'alembic revision',
  'prisma migrate', 'prisma db push', 'flyway migrate', 'flyway clean', 'flyway undo',
  'knex migrate', 'manage.py migrate', 'artisan migrate', 'dotnet ef database update',
];
const CLOUD_CLI = ['aws', 'gcloud', 'az'];
const CLOUD_VERBS = ['create', 'delete', 'put', 'update', 'remove', 'sync', 'cp', 'mv', 'rm'];
const DEPLOY_TARGETS = ['vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'railway'];
const GH_KINDS = ['release', 'pr', 'issue', 'repo'];
const GH_MUTATIONS = ['create', 'merge', 'edit', 'delete', 'close'];

/** `X verb*` + `X * verb*`: the direct form and the "something between" form
 *  (`aws s3 cp`, `docker compose`, `python -m black`). `verb*` (no trailing
 *  space) also catches hyphenated siblings Claude's `\bverb\b` catches:
 *  `aws s3 create-bucket`. */
const both = (name, verb) => [`${name} ${verb}*`, `${name} * ${verb}*`];

/** Every mutating command family probe mode blocks while armed. */
export const SHELL_DENY_FAMILIES = {
  fileMutators: FILE_MUTATORS.map((verb) => [`${verb} *`]),
  // In-place editors only: `sed s/a/b/` and `perl -pe` read, `sed -i` and
  // `perl -i` write.
  inPlace: [['sed -i *'], ['sed * -i *'], ['perl -i *'], ['perl * -i *']],
  git: GIT_WRITES.map((verb) => [`git ${verb} *`]),
  packages: PACKAGEMANAGERS.flatMap((pm) => PACKAGE_VERBS.map((verb) => [`${pm} ${verb} *`])),
  interpreters: [
    ['pip install *'], ['pip3 install *'], ['pip uninstall *'], ['pip3 uninstall *'],
    ['poetry add *'], ['poetry remove *'], ['poetry install *'], ['poetry sync *'], ['poetry lock *'],
    ['uv add *'], ['uv remove *'], ['uv sync *'], ['uv lock *'], ['uv pip install *'],
    ['cargo add *'], ['cargo remove *'], ['cargo install *'], ['cargo fix *'],
    ['go get *'], ['go install *'], ['go mod tidy *'],
    ['dotnet add *'], ['dotnet remove *'], ['dotnet restore *'], ['dotnet new *'], ['dotnet publish *'],
    ['bundle install *'], ['bundle update *'], ['bundle add *'], ['bundle remove *'],
    ['composer install *'], ['composer update *'], ['composer require *'], ['composer remove *'],
    ['mvn install *'], ['mvn deploy *'], ['gradle publish *'],
    ['gem install *'], ['gem uninstall *'],
    ['apt install *'], ['apt-get install *'], ['apt remove *'], ['apt-get remove *'],
    ['apt purge *'], ['apt-get purge *'], ['apt upgrade *'], ['apt-get upgrade *'],
    ['brew install *'], ['brew uninstall *'], ['choco install *'], ['winget install *'],
    ['scoop install *'], ['make install *'], ['make uninstall *'], ['make clean *'],
  ],
  // Formatters mutate in place. Both spellings matter: `prettier --write .` and
  // `npx prettier --write .` are different shell resources.
  formatters: [
    ['prettier --write *'], ['prettier -w *'], ['* prettier --write *'],
    ['eslint --fix *'], ['* eslint --fix *'],
    both('black', ''),
    ['ruff format *'], ['* ruff format *'],
    ['gofmt -w *'], ['* gofmt -w *'],
  ].filter((entry) => entry.every(Boolean)),
  migrations: MIGRATIONS.flatMap((entry) => [`${entry} *`, `* ${entry} *`]),
  db: [
    ['rake db:migrate *'], ['rake db:rollback *'], ['rake db:seed *'],
    ['sequelize db:migrate *'], ['sequelize db:seed *'],
    ['psql -c *'], ['psql * -c *'],
  ],
  infrastructure: [
    ...['apply', 'delete', 'create', 'patch', 'edit', 'scale'].flatMap((verb) => both('kubectl', verb)),
    ...['run', 'build', 'rm', 'rmi', 'compose'].flatMap((verb) => both('docker', verb)),
    ...['apply', 'destroy', 'import'].flatMap((verb) => both('terraform', verb)),
    ...CLOUD_CLI.flatMap((cli) => CLOUD_VERBS.flatMap((verb) => both(cli, verb))),
  ],
  deploys: [
    ['helm install *'], ['helm upgrade *'], ['helm uninstall *'], ['helm rollback *'], ['helm delete *'],
    ['ansible *'], ['ansible-playbook *'], ['* ansible *'], ['* ansible-playbook *'],
    ['serverless deploy *'], ['sls deploy *'], ['* serverless deploy *'],
    ...DEPLOY_TARGETS.flatMap((target) => [
      [`${target} deploy *`], [`${target} * deploy *`], [`* ${target} deploy *`],
    ]),
    ['vercel --prod *'],
  ],
  publishing: [
    ['cargo publish *'], ['twine upload *'],
    ...GH_KINDS.flatMap((kind) => GH_MUTATIONS.flatMap((verb) => both(`gh ${kind}`, verb))),
  ],
  downloads: [
    // wget writes a file by default; curl needs -o/-O (both direct and
    // mid-command forms: `curl -o f u` has nothing between the name and flag).
    ['wget *'], ['curl -o *'], ['curl -O *'], ['curl * -o *'], ['curl * -O *'],
  ],
  shellEscapes: [
    ['New-Item *'], ['Set-Content *'], ['Add-Content *'], ['Out-File *'], ['Remove-Item *'],
    ['Move-Item *'], ['Copy-Item *'], ['Rename-Item *'], ['Set-ItemProperty *'], ['New-ItemProperty *'],
    ['* New-Item *'], ['* Set-Content *'], ['* Remove-Item *'], ['* Out-File *'],
    // Host control surfaces. The session's rules live in OpenCode's database,
    // not in a file the model can edit — but the CLI that patches them over
    // HTTP has no business inside a research pass, and the Claude-only control
    // script is not this host's unlock path at all.
    ['opencode api *'], ['*probe-ctl*'],
  ],
  redirects: [
    // Bash/PowerShell both write on `>` and `>>`. Only the spaced form is
    // matchable with whole-value wildcards; `echo x>file` slips through, which
    // is one more reason the git snapshot is the guarantee here.
    ['* > *'], ['* >> *'], ['tee *'], ['* tee *'],
  ],
};

/** Flat list of shell patterns denied while armed. */
export const SHELL_DENY_PATTERNS = Object.values(SHELL_DENY_FAMILIES)
  .flat()
  .flat();

/** Does this shell resource match the deny list? For OUR rules only: nothing
 *  below re-allows a shell pattern, so order is irrelevant. */
export const shellDenied = (resource) => SHELL_DENY_PATTERNS.some((pattern) => wildcardMatch(resource, pattern));

/** Minimal copy of OpenCode's Wildcard.match, so tests and this module agree
 *  with the server without importing it: backslashes normalize to slashes,
 *  `*` spans anything (including /), `?` is one char, case folds on Windows,
 *  and a trailing ` *` also matches the bare command. */
export function wildcardMatch(input, pattern) {
  const normalized = String(input).replaceAll('\\', '/');
  const escaped = String(pattern)
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const ready = escaped.endsWith(' .*') ? `${escaped.slice(0, -3)}( .*)?` : escaped;
  return new RegExp(`^${ready}$`, process.platform === 'win32' ? 'si' : 's').test(normalized);
}

// ------------------------------------------------------------------- rules

/**
 * Session-scoped permission rules for one armed phase. OpenCode evaluates these
 * AFTER the agent's rules and takes the last match, so they are the whole story
 * while they are installed.
 *
 *  probe         edit denied outside the sandbox and the plan directory;
 *                mutating shell commands denied. Hard deny: no dialog and no
 *                plugin hook required — the server enforces it from the rules.
 *  planning      the same, except `edit` outside the writable roots resolves to
 *                `ask`, so the first implementation write raises a permission
 *                dialog. Approving it is what unlocks writes.
 *  implementing  [] — the session's rules are cleared and the agent's own
 *                (normal) policy applies.
 *
 * `locationDir` is the session's workspace root: edit resources are relative
 * there and absolute outside it, so it decides which spelling each root needs.
 */
export function sessionRules({ phase, sandbox, plansDir, stateDir, locationDir, extraRoots = [] }) {
  if (phase === 'implementing' || phase === 'off') return [];

  const roots = [sandbox, ...extraRoots, plansDir].filter(Boolean);
  const writable = roots.map((dir) => resourcePath(dir, locationDir));
  const external = [stateDir, plansDir].filter(Boolean).map((dir) => `${slash(dir)}/*`);

  return [
    // Broad first: everything is blocked, then the writable roots are
    // re-allowed below (last match wins). `ask` in planning is the approval
    // dialog; `deny` in probe is the hard block.
    { action: 'edit', resource: '*', effect: phase === 'planning' ? 'ask' : 'deny' },
    ...writable.map((root) => ({ action: 'edit', resource: `${root}/*`, effect: 'allow' })),
    // The plan directory and the sandbox live outside the workspace, so reads
    // and writes there need the directory boundary approved too. This does NOT
    // make the state file writable — `edit` above still denies it, which is why
    // tampering with state cannot unlock a session: the rules live in OpenCode's
    // database, not in the state file.
    ...external.map((root) => ({ action: 'external_directory', resource: root, effect: 'allow' })),
    // Shell: every mutating command is parked at `ask`, not `deny`. The
    // permission hook then re-runs the same path analysis Claude's guard does
    // and turns it into `deny` (target outside the sandbox), `allow` (target
    // inside it), or leaves it alone (not our kind of command). `ask` is the
    // FALLBACK for the case where that hook is not running: the user gets a
    // dialog naming the command instead of a silent pass — the failure
    // direction Claude's PreToolUse hook cannot guarantee when it dies.
    ...SHELL_DENY_PATTERNS.map((resource) => ({ action: 'shell', resource, effect: 'ask' })),
    // Keep `question` usable: it is how the model asks for plan approval.
    { action: 'question', resource: '*', effect: 'allow' },
  ];
}

// ---------------------------------------------------------------- messages

/** Mirrors OpenCode's evaluator for OUR rules: the last matching rule wins,
 *  and an unmatched action falls through to `ask` (its documented default).
 *  The server has its own copy; this one exists so tests and the plugin can
 *  reason about a rule set without importing OpenCode. */
export function matchEffect(rules, action, resource) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) return rule.effect;
  }
  return 'ask';
}

const PHASE_LABEL = {
  probe: 'probe mode (research only)',
  planning: 'probe mode (planning — plan not approved yet)',
};

/** Why an edit was blocked. Installed as the tool failure message so the model
 *  reads a reason instead of a raw rules dump (the job Claude's guard message
 *  does on the other host). */
export function denyMessage({ phase, sandbox, cmd = '/probe', target }) {
  const label = PHASE_LABEL[phase] || PHASE_LABEL.probe;
  return [
    `Blocked by ${label}: no writes outside the sandbox.`,
    target ? `Target: ${target}` : undefined,
    `Sandbox (writable): ${sandbox}`,
    `Implementation requires an explicit request from the user, then ${cmd} implement,`,
    'then an approved plan. Nothing outside the sandbox may change before that.',
  ].filter(Boolean).join('\n');
}

/** Why a shell command was denied: name it and point at the sandbox. */
export function shellDenyMessage({ phase, command, sandbox, cmd = '/probe' }) {
  const label = PHASE_LABEL[phase] || PHASE_LABEL.probe;
  return [
    `Blocked by ${label}: this command mutates state.`,
    `Command: ${command}`,
    'Reading, running tests and running benchmarks are fine. Put scripts and their',
    `output in the sandbox instead: ${sandbox}`,
    `To ask for a plan: ${cmd} implement.`,
  ].join('\n');
}

/** Permission-dialog message for the approval moment (planning only). */
export function approvalAskMessage({ sandbox, cmd = '/probe' }) {
  return [
    'PROBE PLAN AWAITING APPROVAL. Allow this write to unlock writes for implementation;',
    'reject to keep the project blocked (the model must revise the plan first).',
    `Sandbox stays writable either way: ${sandbox}`,
    `You can also approve without writing anything: ${cmd} approve.`,
  ].join('\n');
}
