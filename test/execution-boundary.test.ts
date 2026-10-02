import type * as ChildProcess from 'node:child_process';
import type * as Fs from 'node:fs';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BridgeModule from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import {
  createTemplateCatalog,
  validateTemplateCatalog,
} from '../src/adapters/template-catalog.js';
import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { runDetect } from '../src/commands/detect.js';
import { runDoctor } from '../src/commands/doctor.js';
import { decideExecution, decideRegeneration, pathsToWrite } from '../src/commands/regenerate.js';
import { runUpgrade } from '../src/commands/upgrade.js';
import { CliError, ExecutionError } from '../src/errors.js';
import type * as ApplyModule from '../src/generate/apply.js';
import { apply } from '../src/generate/apply.js';
import { comparePlan, observeTarget } from '../src/generate/compare.js';
import type { GenerationPlan } from '../src/generate/files.js';
import type * as PostStepsModule from '../src/generate/postSteps.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { CLI_VERSION } from '../src/version.js';
import { verifyTemplatePlans } from '../src/verify/templates.js';
import { FakePrompter, tempDir, testLogger } from './helpers.js';

/**
 * Stage 9: the boundary between planning and execution.
 *
 * Planning - resolution, templates, validation, the Generation Plan, the
 * comparison, the change analysis and its diff, detect, doctor, a dry run -
 * only reads. Execution - `apply()` and `runPostSteps()` - is the only thing
 * that writes or starts a process, and it is reached only after every
 * decision has been made.
 *
 * Held two ways. The source is scanned, so a mutating import or a new caller
 * of the executor anywhere else fails here. And the real commands run with
 * every mutating `node:fs` function, every `node:child_process` function,
 * `apply` and `runPostSteps` instrumented: each call is recorded with the
 * stack that made it, so "planning wrote nothing" and "only the executor
 * wrote" are observed, not inferred. Processes are never really started:
 * `spawnSync` answers success, and every other way to start one throws.
 */

const record = vi.hoisted(() => ({
  /** Every mutating fs call: the function, its first argument, and the stack that made it. */
  mutations: [] as { fn: string; target: string; stack: string }[],
  /** Every process started, as `program args...`. */
  spawned: [] as string[],
  /** The executor, in order: `apply`, `post-steps`, `spawn ...`. */
  events: [] as string[],
  applied: [] as string[][],
  /** Every Generation Plan the planner returned, in order. */
  plans: [] as GenerationPlan[],
  /** When set, every plan the planner returns is frozen, all the way down. */
  freezePlans: false,
}));

const MUTATING_FS = vi.hoisted(
  () =>
    [
      'appendFile',
      'appendFileSync',
      'chmod',
      'chmodSync',
      'copyFile',
      'copyFileSync',
      'cp',
      'cpSync',
      'createWriteStream',
      'link',
      'linkSync',
      'mkdir',
      'mkdirSync',
      'mkdtemp',
      'mkdtempSync',
      'rename',
      'renameSync',
      'rm',
      'rmSync',
      'rmdir',
      'rmdirSync',
      'symlink',
      'symlinkSync',
      'truncate',
      'truncateSync',
      'unlink',
      'unlinkSync',
      'utimes',
      'utimesSync',
      'writeFile',
      'writeFileSync',
    ] as const,
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of MUTATING_FS) {
    const original = (actual as unknown as Record<string, unknown>)[name];
    if (typeof original !== 'function') continue;
    wrapped[name] = (...args: unknown[]) => {
      record.mutations.push({
        fn: name,
        target: String(args[0]),
        stack: new Error().stack ?? '',
      });
      return (original as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const refuse =
    (name: string) =>
    (command: string): never => {
      record.spawned.push(`${name}:${command}`);
      throw new Error(`execution-boundary: unexpected ${name}("${command}")`);
    };
  return {
    ...actual,
    // Never really started: the executor is told it worked.
    spawnSync: (command: string, args: readonly string[] = []) => {
      const line = [command, ...args].join(' ');
      record.spawned.push(line);
      record.events.push(`spawn ${line}`);
      return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null };
    },
    spawn: refuse('spawn'),
    exec: refuse('exec'),
    execSync: refuse('execSync'),
    execFile: refuse('execFile'),
    execFileSync: refuse('execFileSync'),
    fork: refuse('fork'),
  };
});

vi.mock('../src/generate/apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ApplyModule>();
  return {
    ...actual,
    apply: (plan: GenerationPlan, options: Parameters<typeof actual.apply>[1]) => {
      record.events.push('apply');
      record.applied.push(plan.operations.map((operation) => operation.path));
      return actual.apply(plan, options);
    },
  };
});

vi.mock('../src/generate/postSteps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PostStepsModule>();
  return {
    ...actual,
    runPostSteps: (options: Parameters<typeof actual.runPostSteps>[0]) => {
      record.events.push(`post-steps ${options.steps.join(',')}`);
      return actual.runPostSteps(options);
    },
  };
});

vi.mock('../src/adapters/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BridgeModule>();
  const deepFreeze = <T>(value: T): T => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };
  return {
    ...actual,
    planManifest: (...args: Parameters<typeof actual.planManifest>) => {
      const result = actual.planManifest(...args);
      if (record.freezePlans) deepFreeze(result.plan);
      record.plans.push(result.plan);
      return result;
    },
  };
});

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const TEMPLATES_ROOT = findTemplatesRoot(SRC);
const registry = createRegistry(TEMPLATES_ROOT);

const cleanups: Array<() => void> = [];
beforeEach(() => {
  forget();
  record.freezePlans = false;
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Starts the record afresh: what follows is what the call under test did. */
function forget(): void {
  record.mutations.length = 0;
  record.spawned.length = 0;
  record.events.length = 0;
  record.applied.length = 0;
  record.plans.length = 0;
}

function scratch(): string {
  const { dir, cleanup } = tempDir('boundary');
  cleanups.push(cleanup);
  return dir;
}

const IDENTITY = ['--name', 'Acme Ltd', '--url', 'https://acme.example', '--pm', 'npm'];
const QUIET = ['--no-git', '--no-install'];

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

async function create(
  cwd: string,
  argv: readonly string[],
  prompter?: FakePrompter,
): Promise<{ code: number; text: string; error?: CliError }> {
  const { logger, out, err } = testLogger();
  try {
    const code = await runCreate({
      flags: parseCliArgs([...argv]),
      logger,
      registry,
      cliVersion: CLI_VERSION,
      cwd,
      env: {},
      isTTY: prompter !== undefined,
      nodeVersion: process.versions.node,
      ...(prompter === undefined ? {} : { prompter }),
    });
    return { code, text: plain(`${out.text}${err.text}`) };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { code: error.exitCode, text: plain(`${out.text}${err.text}`), error };
  }
}

async function upgrade(
  cwd: string,
  argv: readonly string[],
  prompter?: FakePrompter,
): Promise<{ code: number; text: string; error?: CliError }> {
  const { logger, out, err } = testLogger();
  try {
    const code = await runUpgrade({
      flags: parseCliArgs([...argv]),
      logger,
      registry,
      cliVersion: CLI_VERSION,
      cwd,
      env: {},
      isTTY: prompter !== undefined,
      templatesRoot: TEMPLATES_ROOT,
      ...(prompter === undefined ? {} : { prompter }),
    });
    return { code, text: plain(`${out.text}${err.text}`) };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { code: error.exitCode, text: plain(`${out.text}${err.text}`), error };
  }
}

/**
 * A generated project with everything a careless planner could touch: a git
 * repository, a lockfile, the record - and then a conflict (an edited
 * README), a deleted page and a file of the developer's own.
 */
async function project(): Promise<{ cwd: string; dir: string }> {
  const cwd = scratch();
  const { code } = await create(cwd, ['site', ...IDENTITY, ...QUIET, '--yes']);
  expect(code).toBe(0);
  const dir = path.join(cwd, 'site');
  mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n');
  writeFileSync(path.join(dir, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
  writeFileSync(path.join(dir, 'README.md'), '# Our notes\n');
  writeFileSync(path.join(dir, 'notes.txt'), 'mine\n');
  rmSync(path.join(dir, 'src', 'pages', 'index.astro'));
  forget();
  return { cwd, dir };
}

/** Every file and directory under a root, `.git` included: kind, size, mtime and bytes. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const key = path.relative(root, full).split(path.sep).join('/');
      const stats = statSync(full);
      if (entry.isDirectory()) {
        out[`${key}/`] = `dir:${stats.mtimeMs}`;
        walk(full);
      } else {
        out[key] = `${stats.size}:${stats.mtimeMs}:${readFileSync(full, 'base64')}`;
      }
    }
  };
  walk(root);
  return out;
}

/** Nothing written anywhere, nothing started, the executor never reached. */
function expectNoExecution(): void {
  expect(record.mutations.map((call) => `${call.fn} ${call.target}`)).toEqual([]);
  expect(record.spawned).toEqual([]);
  expect(record.events).toEqual([]);
}

const IN_EXECUTOR = /src[\\/]generate[\\/]apply\.ts/;

// ---------------------------------------------------------------------------
// The source: who may import what
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

interface ImportStatement {
  readonly file: string;
  readonly typeOnly: boolean;
  readonly clause: string;
  readonly from: string;
}

const SOURCES = sourceFiles(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

const IMPORTS: ImportStatement[] = SOURCES.flatMap(({ file, text }) =>
  [...text.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)';/gm)].map((match) => ({
    file,
    typeOnly: match[1] !== undefined,
    clause: match[2] ?? '',
    from: match[3] ?? '',
  })),
);

/** Named values an import brings in; `type` members excluded. */
function namedValues(statement: ImportStatement): string[] {
  if (statement.typeOnly) return [];
  const braces = /\{([\s\S]*)\}/.exec(statement.clause)?.[1] ?? '';
  return braces
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '' && !name.startsWith('type '))
    .map((name) => name.split(/\s+as\s+/)[0] ?? name);
}

/** Resolves a relative specifier to a path under src, without the extension. */
function resolved(statement: ImportStatement): string {
  if (!statement.from.startsWith('.')) return statement.from;
  return path.posix.join(path.posix.dirname(statement.file), statement.from).replace(/\.js$/, '');
}

const READ_ONLY_FS = new Set([
  'existsSync',
  'readFileSync',
  'readdirSync',
  'realpathSync',
  'statSync',
]);

describe('the source: mutation and processes have one home each', () => {
  it('finds the imports it scans (the scan is not vacuous)', () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(IMPORTS.some((statement) => statement.from === 'node:fs')).toBe(true);
    expect(IMPORTS.some((statement) => statement.from === 'node:child_process')).toBe(true);
  });

  it('imports node:fs by name only, so every function it uses is visible here', () => {
    const fsImports = IMPORTS.filter((statement) =>
      /^(node:)?fs(\/promises)?$/.test(statement.from),
    );
    for (const statement of fsImports) {
      expect(statement.from, statement.file).toBe('node:fs');
      expect(statement.clause.trim().startsWith('{'), statement.file).toBe(true);
    }
  });

  it('lets only the executor import a node:fs function that writes', () => {
    const writers = IMPORTS.filter((statement) => statement.from === 'node:fs').flatMap(
      (statement) =>
        namedValues(statement)
          .filter((name) => !READ_ONLY_FS.has(name))
          .map((name) => `${statement.file}: ${name}`),
    );
    expect(writers.every((entry) => entry.startsWith('generate/apply.ts: '))).toBe(true);
    // And the executor really is the one that writes.
    expect(writers).toEqual(
      expect.arrayContaining(['generate/apply.ts: writeFileSync', 'generate/apply.ts: renameSync']),
    );
  });

  it('lets only post-step execution import node:child_process', () => {
    const spawners = IMPORTS.filter((statement) =>
      /^(node:)?child_process$/.test(statement.from),
    ).map((statement) => statement.file);
    expect(spawners).toEqual(['generate/postSteps.ts']);
  });

  it('has no require(), dynamic import() or process.chdir() to hide either behind', () => {
    for (const { file, text } of SOURCES) {
      expect(/\brequire\(/.test(text), file).toBe(false);
      expect(/\bimport\(/.test(text), file).toBe(false);
      expect(/process\.chdir\(/.test(text), file).toBe(false);
    }
  });

  it('reaches the executor from create and upgrade only', () => {
    const callers = (module: string) =>
      IMPORTS.filter((statement) => resolved(statement) === module)
        .filter((statement) => namedValues(statement).length > 0)
        .map((statement) => statement.file)
        .sort();
    expect(callers('generate/apply')).toEqual(['commands/create.ts', 'commands/upgrade.ts']);
    // Upgrade writes files and runs no post step.
    expect(callers('generate/postSteps')).toEqual(['commands/create.ts']);
  });

  it('keeps planning free of the executor: post-step planning is its own module', () => {
    const planning = IMPORTS.filter((statement) =>
      [
        'generate/postStepPlan.ts',
        'generate/compare.ts',
        'generate/changes.ts',
        'generate/diff.ts',
        'generate/plan.ts',
        'commands/regenerate.ts',
      ].includes(statement.file),
    );
    expect(planning.length).toBeGreaterThan(0);
    for (const statement of planning) {
      expect(['generate/apply', 'generate/postSteps'], statement.file).not.toContain(
        resolved(statement),
      );
    }
    // The preview reads post-step *types* only.
    const ui = IMPORTS.filter(
      (statement) =>
        statement.file === 'ui/plan.ts' && resolved(statement) === 'generate/postSteps',
    );
    expect(ui.every((statement) => statement.typeOnly)).toBe(true);
  });

  it('gives a read-only name to nothing in the executor', () => {
    const readNames =
      /^(plan|resolve|validate|compare|analy[sz]e|detect|inspect|observe|find|decide)/;
    for (const file of ['generate/apply.ts', 'generate/postSteps.ts']) {
      const text = SOURCES.find((source) => source.file === file)?.text ?? '';
      const exported = [...text.matchAll(/^export (?:function|const) (\w+)/gm)].map(
        (match) => match[1] ?? '',
      );
      expect(
        exported.filter((name) => readNames.test(name)),
        file,
      ).toEqual([]);
    }
  });

  it('hands every executor call in a command what it was decided against', () => {
    for (const file of ['commands/create.ts', 'commands/upgrade.ts']) {
      const text = SOURCES.find((source) => source.file === file)?.text ?? '';
      // Calls, not mentions: `= apply(...)`, as both commands write it.
      const calls = [...text.matchAll(/=\s*apply\(([^;]*?)\);/g)].map((match) => match[1] ?? '');
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call, file).toMatch(/expected/);
    }
  });
});

// ---------------------------------------------------------------------------
// Planning, validation, analysis, detect, doctor: read-only
// ---------------------------------------------------------------------------

describe('planning only reads', () => {
  it('a dry run of a new project writes nothing and starts nothing, with every post step on', async () => {
    const cwd = scratch();
    const before = snapshot(cwd);
    forget();
    const { code, text } = await create(cwd, ['site', ...IDENTITY, '--yes', '--dry-run']);
    expect(code).toBe(0);
    // The steps are planned and shown, not run.
    expect(text).toContain('npm install');
    expect(text).toContain('git init --quiet');
    expectNoExecution();
    expect(snapshot(cwd)).toEqual(before);
  });

  it('a dry run of a ClientKit project, repeated, is identical and touches nothing', async () => {
    const { cwd, dir } = await project();
    const before = snapshot(dir);
    const runs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      forget();
      const { code, text } = await create(cwd, ['site', ...IDENTITY, '--yes', '--dry-run']);
      expect(code).toBe(0);
      expectNoExecution();
      // The clock is an input, not a result: the one line that names it may differ.
      runs.push(text.replace(/resolved \S+Z/, 'resolved <time>'));
    }
    expect(runs[0]).toContain('Conflicts (1)');
    expect(runs[0]).toContain('Files to restore (1)');
    expect(new Set(runs).size).toBe(1);
    expect(snapshot(dir)).toEqual(before);
  });

  it('a dry run into a directory ClientKit did not generate touches nothing', async () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'site'));
    writeFileSync(path.join(cwd, 'site', 'README.md'), 'theirs\n');
    const before = snapshot(cwd);
    forget();
    const { code } = await create(cwd, ['site', ...IDENTITY, '--yes', '--dry-run']);
    expect(code).toBe(0);
    expectNoExecution();
    expect(snapshot(cwd)).toEqual(before);
  });

  it('upgrade --dry-run touches nothing', async () => {
    const { cwd, dir } = await project();
    const before = snapshot(dir);
    const { code, text } = await upgrade(cwd, ['upgrade', 'site', '--dry-run']);
    expect(code).toBe(0);
    expect(text).toContain('Conflicts (1)');
    expectNoExecution();
    expect(snapshot(dir)).toEqual(before);
  });

  it('the comparison, change analysis and diff are read-only, and the same every time', async () => {
    const { cwd, dir } = await project();
    record.freezePlans = true;
    const before = snapshot(dir);
    const plan = await lastPlan(cwd);
    const decisions = [1, 2, 3].map(() => decideRegeneration(plan, { withDiff: true }));
    expect(decisions[1]).toEqual(decisions[0]);
    expect(decisions[2]).toEqual(decisions[0]);
    expect(decisions[0]?.conflicts).toEqual(['README.md']);
    expect(
      decisions[0]?.changes.changes.find((change) => change.kind === 'conflict'),
    ).toHaveProperty('diff');
    expectNoExecution();
    expect(snapshot(dir)).toEqual(before);
  });

  it('detect and doctor read the project and change nothing in it', async () => {
    const { dir } = await project();
    const before = snapshot(dir);
    for (const command of ['detect', 'doctor'] as const) {
      for (const extra of [[], ['--debug']]) {
        forget();
        const { logger } = testLogger();
        const flags = parseCliArgs([command, dir, ...extra]);
        const options = { flags, logger, cwd: path.dirname(dir), templatesRoot: TEMPLATES_ROOT };
        const code = command === 'detect' ? runDetect(options) : runDoctor(options);
        expect(typeof code).toBe('number');
        expectNoExecution();
      }
    }
    expect(snapshot(dir)).toEqual(before);
  });

  it(
    'catalog and template validation read the templates and change nothing',
    { timeout: 60_000 },
    () => {
      const before = snapshot(TEMPLATES_ROOT);
      const adapters = createAdapterRegistry(TEMPLATES_ROOT);
      forget();
      const validation = validateTemplateCatalog(adapters, TEMPLATES_ROOT);
      const results = verifyTemplatePlans(createTemplateCatalog(adapters, TEMPLATES_ROOT), {
        adapters,
        registry,
        templatesRoot: TEMPLATES_ROOT,
      });
      expect(validation.valid).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expectNoExecution();
      expect(snapshot(TEMPLATES_ROOT)).toEqual(before);
    },
  );
});

/** The Generation Plan a dry run of the project builds, as the planner returned it. */
async function lastPlan(cwd: string): Promise<GenerationPlan> {
  record.plans.length = 0;
  await create(cwd, ['site', ...IDENTITY, ...QUIET, '--yes', '--dry-run']);
  const plan = record.plans.at(-1);
  forget();
  if (plan === undefined) throw new Error('the dry run built no plan');
  return plan;
}

// ---------------------------------------------------------------------------
// Decisions come first; a refusal writes nothing
// ---------------------------------------------------------------------------

describe('every decision is made before anything is written', () => {
  it('--yes refuses a conflict before the executor is reached', async () => {
    const { cwd, dir } = await project();
    const before = snapshot(dir);
    const { error } = await create(cwd, ['site', ...IDENTITY, '--yes']);
    expect(error?.message).toContain('differ from what ClientKit would write now');
    expectNoExecution();
    expect(snapshot(dir)).toEqual(before);
  });

  it('a "no" writes nothing - not even the missing file that needed no question', async () => {
    const { cwd, dir } = await project();
    const before = snapshot(dir);
    const prompter = new FakePrompter({ confirmNonEmpty: false });
    const { code } = await create(cwd, ['site', ...IDENTITY, '--yes'], prompter);
    expect(code).toBe(0);
    expect(prompter.asked).toContain('confirmNonEmpty');
    expectNoExecution();
    expect(snapshot(dir)).toEqual(before);
  });

  it('upgrade without a terminal refuses a conflict and writes nothing', async () => {
    const { cwd, dir } = await project();
    const before = snapshot(dir);
    const { error } = await upgrade(cwd, ['upgrade', 'site']);
    expect(error).toBeDefined();
    expectNoExecution();
    expect(snapshot(dir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Execution: only the executor writes, then the approved post steps run
// ---------------------------------------------------------------------------

describe('execution', () => {
  it('a confirmed create writes only through apply(), then runs exactly the planned steps', async () => {
    const { cwd, dir } = await project();
    writeFileSync(path.join(dir, 'package.json'), '{}\n');
    forget();
    record.freezePlans = true;

    const prompter = new FakePrompter({ confirmNonEmpty: true });
    const { code } = await create(cwd, ['site', ...IDENTITY, '--yes'], prompter);
    expect(code).toBe(0);

    // Decide, ask, write, then the steps that follow what was written.
    expect(record.events).toEqual(['apply', 'post-steps install', 'spawn npm install']);
    // Exactly what was decided: the conflicts agreed to, the restore, the record.
    expect([...(record.applied[0] ?? [])].sort()).toEqual(
      ['.client-site.json', 'README.md', 'package.json', 'src/pages/index.astro'].sort(),
    );
    expect(record.mutations.length).toBeGreaterThan(0);
    for (const call of record.mutations)
      expect(call.stack, `${call.fn} ${call.target}`).toMatch(IN_EXECUTOR);
    // The developer's own file, and the lockfile and git state, are not the plan's.
    expect(readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('mine\n');
    expect(readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).toBe(
      '{ "lockfileVersion": 3 }\n',
    );
    expect(readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
  });

  it('a first generation writes through apply() only, then installs and initialises git', async () => {
    const cwd = scratch();
    forget();
    record.freezePlans = true;
    const { code } = await create(cwd, ['site', ...IDENTITY, '--yes']);
    expect(code).toBe(0);
    expect(record.events).toEqual([
      'apply',
      'post-steps install,git-init',
      'spawn npm install',
      'spawn git init --quiet',
    ]);
    for (const call of record.mutations)
      expect(call.stack, `${call.fn} ${call.target}`).toMatch(IN_EXECUTOR);
  });

  it('a confirmed upgrade writes through apply() only and starts nothing', async () => {
    const { cwd, dir } = await project();
    const prompter = new FakePrompter({ confirmNonEmpty: true });
    const { code } = await upgrade(cwd, ['upgrade', 'site'], prompter);
    expect(code).toBe(0);
    expect(record.events).toEqual(['apply']);
    expect(record.spawned).toEqual([]);
    for (const call of record.mutations)
      expect(call.stack, `${call.fn} ${call.target}`).toMatch(IN_EXECUTOR);
    expect(readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('mine\n');
  });

  it('a project already up to date reaches neither the executor nor a post step', async () => {
    const cwd = scratch();
    expect((await create(cwd, ['site', ...IDENTITY, ...QUIET, '--yes'])).code).toBe(0);
    const before = snapshot(path.join(cwd, 'site'));
    forget();
    const { code, text } = await create(cwd, ['site', ...IDENTITY, '--yes']);
    expect(code).toBe(0);
    expect(text).toContain('already up to date');
    expectNoExecution();
    expect(snapshot(path.join(cwd, 'site'))).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The execution decision, and what the executor checks before writing
// ---------------------------------------------------------------------------

/** A prompter that, while the question is open, lets something else edit the project. */
class MeddlingPrompter extends FakePrompter {
  constructor(private readonly meddle: () => void) {
    super({ confirmNonEmpty: true });
  }

  override async confirmNonEmpty(): Promise<boolean> {
    this.meddle();
    return super.confirmNonEmpty();
  }
}

describe('the execution decision', () => {
  it('is the plan narrowed to the decided paths, the observation, and the steps that follow', async () => {
    const { cwd, dir } = await project();
    const plan = await lastPlan(cwd);
    const frozen = JSON.stringify(plan);
    const decision = decideRegeneration(plan);

    const agreed = decideExecution(plan, decision, true, ['install', 'git-init']);
    expect(agreed.plan.operations.map((operation) => operation.path).sort()).toEqual(
      pathsToWrite(decision, true).sort(),
    );
    expect(agreed.plan.operations.every((operation) => plan.operations.includes(operation))).toBe(
      true,
    );
    expect(agreed.expected).toBe(decision.comparison.observed);
    // package.json is not written, so no install; the project has a .git, so no git init.
    expect(agreed.postSteps).toEqual([]);
    rmSync(path.join(dir, '.git'), { recursive: true });
    expect(decideExecution(plan, decision, true, ['install', 'git-init']).postSteps).toEqual([
      'git-init',
    ]);

    const refused = decideExecution(plan, decision, false, ['install', 'git-init']);
    expect(refused.plan.operations).toEqual([]);
    expect(refused.postSteps).toEqual([]);

    // Deciding consumed and changed nothing.
    expect(JSON.stringify(plan)).toBe(frozen);
    expect(readdirSync(dir)).toContain('notes.txt');
  });

  it('observes every planned path the comparison read', async () => {
    const { cwd } = await project();
    const plan = await lastPlan(cwd);
    const comparison = comparePlan(plan);
    expect([...comparison.observed.keys()].sort()).toEqual(
      plan.operations.map((operation) => operation.path).sort(),
    );
    expect(comparison.observed.get('src/pages/index.astro')).toBe('absent');
    expect(comparison.observed.get('README.md')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(observeTarget(plan)).toEqual(comparison.observed);
  });
});

describe('time of check, time of use', () => {
  it('a conflict edited again while the question is open is not overwritten', async () => {
    const { cwd, dir } = await project();
    const prompter = new MeddlingPrompter(() =>
      writeFileSync(path.join(dir, 'README.md'), '# Our notes, edited again\n'),
    );
    const { error } = await create(cwd, ['site', ...IDENTITY, ...QUIET, '--yes'], prompter);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error?.message).toContain(
      'changed after ClientKit checked them, so nothing was written',
    );
    expect(error?.hint).toContain('README.md');
    // Nothing reached the project: not the README, not the missing page, not the record.
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# Our notes, edited again\n');
    expect(readdirSync(path.join(dir, 'src', 'pages'))).not.toContain('index.astro');
    expect(record.events).toEqual(['apply']);
    // And no staging directory was left beside it.
    expect(readdirSync(cwd)).toEqual(['site']);
  });

  it('a missing file that appears while the question is open is not overwritten', async () => {
    const { cwd, dir } = await project();
    const page = path.join(dir, 'src', 'pages', 'index.astro');
    const prompter = new MeddlingPrompter(() => writeFileSync(page, 'written meanwhile\n'));
    const { error } = await create(cwd, ['site', ...IDENTITY, ...QUIET, '--yes'], prompter);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error?.hint).toContain('src/pages/index.astro');
    expect(readFileSync(page, 'utf8')).toBe('written meanwhile\n');
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# Our notes\n');
  });

  it('a file that appears in a directory ClientKit did not generate is not overwritten', async () => {
    const cwd = scratch();
    const dir = path.join(cwd, 'site');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'notes.txt'), 'theirs\n');
    const prompter = new MeddlingPrompter(() =>
      writeFileSync(path.join(dir, 'package.json'), '{ "name": "theirs" }\n'),
    );
    const { error } = await create(cwd, ['site', ...IDENTITY, ...QUIET, '--yes'], prompter);
    expect(error).toBeInstanceOf(ExecutionError);
    expect(error?.hint).toContain('package.json');
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'package.json']);
  });

  it('the executor refuses a plan whose paths were never observed', () => {
    const cwd = scratch();
    const plan: GenerationPlan = {
      templateId: 'test',
      templateVersion: '0.0.0',
      mode: 'full',
      targetDir: path.join(cwd, 'site'),
      operations: [{ type: 'write', path: 'a.txt', content: 'a\n', origin: 'test' }],
    };
    expect(() => apply(plan, { expected: new Map() })).toThrow(ExecutionError);
    expect(readdirSync(cwd)).toEqual([]);
    // With the observation, the same plan is written.
    expect(apply(plan, { expected: observeTarget(plan) }).written).toEqual(['a.txt']);
  });
});
