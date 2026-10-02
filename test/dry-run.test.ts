import type * as ChildProcess from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BridgeModule from '../src/adapters/bridge.js';
import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import type { Prompter } from '../src/context/prompts.js';
import type * as ApplyModule from '../src/generate/apply.js';
import type { GenerationPlan } from '../src/generate/files.js';
import type * as PostStepsModule from '../src/generate/postSteps.js';
import { planPostSteps } from '../src/generate/postStepPlan.js';
import { runPostSteps } from '../src/generate/postSteps.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { FakePrompter, makeContext, tempDir, testLogger } from './helpers.js';

/**
 * Stage 4: `--dry-run` as a read-only preview of the Generation Plan.
 *
 * The dry run already returned before `apply()`. What this suite holds is the
 * rest of the contract: it is the same plan a real run applies, nothing on the
 * write path - `apply`, the post steps, a spawned process - is ever reached,
 * no byte on disk changes, and the preview says what a real run would do.
 *
 * `apply`, `runPostSteps`, the planner and `spawnSync` are wrapped rather than
 * replaced: each still does its real work, and the spies only record that it
 * was called and with what.
 */

const calls = vi.hoisted(() => ({
  apply: [] as GenerationPlan[],
  postSteps: 0,
  planned: [] as GenerationPlan[],
  spawned: [] as string[],
}));

vi.mock('../src/generate/apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ApplyModule>();
  return {
    ...actual,
    apply: (plan: GenerationPlan, options: Parameters<typeof actual.apply>[1]) => {
      calls.apply.push(plan);
      return actual.apply(plan, options);
    },
  };
});

vi.mock('../src/generate/postSteps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PostStepsModule>();
  return {
    ...actual,
    runPostSteps: (options: Parameters<typeof actual.runPostSteps>[0]) => {
      calls.postSteps += 1;
      return actual.runPostSteps(options);
    },
  };
});

vi.mock('../src/adapters/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BridgeModule>();
  return {
    ...actual,
    planManifest: (...args: Parameters<typeof actual.planManifest>) => {
      const result = actual.planManifest(...args);
      calls.planned.push(result.plan);
      return result;
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawnSync: (command: string, ...rest: unknown[]) => {
      calls.spawned.push(command);
      return (actual.spawnSync as (...a: unknown[]) => unknown)(command, ...rest);
    },
  };
});

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

const cleanups: Array<() => void> = [];
beforeEach(() => {
  calls.apply.length = 0;
  calls.planned.length = 0;
  calls.spawned.length = 0;
  calls.postSteps = 0;
  // `.client-site.json` records when it was generated; a fixed clock lets a
  // dry run and a real run be compared byte for byte.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A fresh directory that holds only what the test puts in it. */
function scratch(files: Record<string, string> = {}): string {
  const { dir, cleanup } = tempDir('dry-run');
  cleanups.push(cleanup);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

/** Every file and directory under `root`, with size, mtime and content. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const key = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out[`${key}/`] = `dir:${statSync(full).mtimeMs}`;
        walk(full);
      } else {
        const stats = statSync(full);
        out[key] = `${stats.size}:${stats.mtimeMs}:${readFileSync(full, 'base64')}`;
      }
    }
  };
  walk(root);
  return out;
}

async function create(
  cwd: string,
  argv: readonly string[],
  options: { prompter?: Prompter } = {},
): Promise<{ code: number; out: string; err: string }> {
  const { logger, out, err } = testLogger();
  const code = await runCreate({
    flags: parseCliArgs([...argv]),
    logger,
    registry,
    cliVersion: '9.9.9',
    cwd,
    env: {},
    isTTY: options.prompter !== undefined,
    nodeVersion: process.versions.node,
    ...(options.prompter === undefined ? {} : { prompter: options.prompter }),
  });
  return { code, out: plain(out.text), err: plain(err.text) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('the flag', () => {
  it('parses --dry-run, and is off without it', () => {
    expect(parseCliArgs(['acme', '--dry-run']).dryRun).toBe(true);
    expect(parseCliArgs(['acme']).dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('a dry run is the normal Generation Plan, never applied', () => {
  it('plans once and reaches neither apply() nor the post steps', async () => {
    const cwd = scratch();
    const { code } = await create(cwd, ['acme', '--yes', '--dry-run']);
    expect(code).toBe(0);
    expect(calls.planned).toHaveLength(1);
    expect(calls.apply).toEqual([]);
    expect(calls.postSteps).toBe(0);
    expect(calls.spawned).toEqual([]);
  });

  it.each([
    ['the default stack', []],
    ['React + Tailwind + React Router', ['--preset', 'react-tailwind', '--router', 'react-router']],
    ['Next.js + Tailwind', ['--preset', 'nextjs-tailwind']],
  ])('plans exactly what a real run applies: %s', async (_name, stack) => {
    const dryCwd = scratch();
    await create(dryCwd, ['acme', '--yes', '--dry-run', ...stack]);
    const dryPlan = calls.planned[0];

    const realCwd = scratch();
    const real = await create(realCwd, ['acme', '--yes', '--no-install', '--no-git', ...stack]);
    expect(real.code).toBe(0);
    const applied = calls.apply[0];

    // Same operations, same order, same bytes. Only the absolute target
    // differs, because the two runs are in two scratch directories.
    const strip = (plan: GenerationPlan | undefined) => ({
      ...plan,
      targetDir: path.basename(plan?.targetDir ?? ''),
    });
    expect(applied).toBeDefined();
    expect(strip(dryPlan)).toEqual(strip(applied));
  });

  it('lists every operation the plan holds, in plan order', async () => {
    const cwd = scratch();
    const { out } = await create(cwd, ['acme', '--yes', '--dry-run']);
    const listed = [...out.matchAll(/^ {2}[+~] (\S+)/gm)].map((match) => match[1]);
    expect(listed).toEqual(calls.planned[0]?.operations.map((operation) => operation.path));
    expect(out).toContain(`Total: ${calls.planned[0]?.operations.length} files`);
  });
});

// ---------------------------------------------------------------------------
// Read-only
// ---------------------------------------------------------------------------

describe('read-only', () => {
  it('creates no target directory and writes nothing next to it', async () => {
    const cwd = scratch({ 'unrelated.txt': 'keep' });
    const before = snapshot(cwd);
    await create(cwd, ['acme', '--yes', '--dry-run']);
    expect(existsSync(path.join(cwd, 'acme'))).toBe(false);
    expect(snapshot(cwd)).toEqual(before);
  });

  it('changes nothing in an existing project: files, lockfiles, package.json, git', async () => {
    const cwd = scratch({
      'acme/package.json': '{ "name": "existing", "private": true }',
      'acme/package-lock.json': '{ "lockfileVersion": 3 }',
      'acme/pnpm-lock.yaml': 'lockfileVersion: 9',
      'acme/src/App.tsx': 'export default function App() { return null; }',
      'acme/.git/HEAD': 'ref: refs/heads/main\n',
      'acme/.git/config': '[core]\n',
    });
    const before = snapshot(cwd);

    for (const argv of [
      ['acme', '--yes', '--dry-run'],
      ['acme', '--yes', '--dry-run', '--preset', 'react-tailwind', '--pm', 'pnpm'],
    ]) {
      const { code } = await create(cwd, argv);
      expect(code, argv.join(' ')).toBe(0);
    }
    // Interactively too, where a real run would ask - and the answer would be yes.
    await create(cwd, ['acme', '--dry-run'], {
      prompter: new FakePrompter({ confirmNonEmpty: true }),
    });

    expect(snapshot(cwd)).toEqual(before);
    expect(calls.apply).toEqual([]);
    expect(calls.spawned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Post steps
// ---------------------------------------------------------------------------

describe('post steps', () => {
  it.each(['npm', 'pnpm', 'yarn', 'bun'])(
    'shows "%s install" and git init, and runs neither',
    async (pm) => {
      const cwd = scratch();
      const { out } = await create(cwd, ['acme', '--yes', '--dry-run', '--pm', pm]);
      expect(out).toMatch(
        new RegExp(`Post steps \\(not run\\)\\n {2}${pm} install\\n {2}git init --quiet`),
      );
      expect(calls.spawned).toEqual([]);
      expect(calls.postSteps).toBe(0);
    },
  );

  it('says which are skipped, and why', async () => {
    const cwd = scratch();
    const { out } = await create(cwd, ['acme', '--yes', '--dry-run', '--no-install', '--no-git']);
    expect(out).toContain('install: skipped, disabled by --no-install');
    expect(out).toContain('git-init: skipped, disabled by --no-git');
  });

  it('previews exactly the commands a real run executes', () => {
    // One table: whatever planPostSteps says is what runPostSteps runs.
    for (const packageManager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
      const context = makeContext({ packageManager });
      const executed: string[][] = [];
      const { logger } = testLogger();
      runPostSteps({
        context,
        logger,
        steps: ['install', 'git-init', 'format'],
        run: (command, args) => {
          executed.push([command, ...args]);
          return { status: 0, stderr: '' };
        },
      });
      const planned = planPostSteps(context, ['install', 'git-init', 'format']);
      expect(executed).toEqual(
        planned.flatMap((entry) => ('command' in entry ? [[...entry.command]] : [])),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

describe('the preview', () => {
  it('shows the target, the files to create, and says nothing changed', async () => {
    const cwd = scratch();
    const { out, err } = await create(cwd, ['acme', '--yes', '--dry-run']);
    expect(out).toContain('DRY RUN - no files will be written.');
    expect(out).toContain(`Target            ${path.join(cwd, 'acme')}`);
    expect(out).toMatch(/Files to create \(\d+\)\n {2}\+ \.client-site\.json/);
    expect(out).not.toContain('Files to replace');
    expect(out).not.toContain('already contains files');
    expect(err).toContain('Dry run complete. No changes were made.');
  });

  it('separates files it would replace from files it would create', async () => {
    const cwd = scratch({ 'acme/package.json': '{}', 'acme/notes.txt': 'mine' });
    const { out } = await create(cwd, ['acme', '--yes', '--dry-run']);
    expect(out).toMatch(/Files to replace \(1\)\n {2}~ package\.json/);
    expect(out).not.toMatch(/\+ package\.json/);
    // A file the plan does not name is not listed at all.
    expect(out).not.toContain('notes.txt');
  });

  it('says a non-interactive run would stop at a non-empty directory', async () => {
    const cwd = scratch({ 'acme/notes.txt': 'mine' });
    const { out, code } = await create(cwd, ['acme', '--yes', '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain('The target directory already contains files.');
    expect(out).toContain('this run would stop here');
  });

  it('says an interactive run would ask first', async () => {
    const cwd = scratch({ 'acme/notes.txt': 'mine' });
    const prompter = new FakePrompter({});
    const { out } = await create(cwd, ['acme', '--dry-run'], { prompter });
    expect(out).toContain('you would be asked before anything is written');
    // A dry run is the whole run: the question is described, never asked.
    expect(prompter.asked).not.toContain('confirmNonEmpty');
  });

  it('matches what a real run then refuses', async () => {
    const cwd = scratch({ 'acme/notes.txt': 'mine' });
    const preview = await create(cwd, ['acme', '--yes', '--dry-run']);
    expect(preview.out).toContain('would stop here');
    await expect(create(cwd, ['acme', '--yes', '--no-install', '--no-git'])).rejects.toThrow(
      /already exists and is not empty/,
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism, and --debug staying separate
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('prints the same preview for the same input', async () => {
    const cwd = scratch();
    const first = await create(cwd, ['acme', '--yes', '--dry-run', '--preset', 'react-tailwind']);
    for (let run = 0; run < 3; run += 1) {
      const again = await create(cwd, ['acme', '--yes', '--dry-run', '--preset', 'react-tailwind']);
      expect(again.out).toEqual(first.out);
    }
  });

  it('does not depend on locale-sensitive ordering', async () => {
    const cwd = scratch({ 'acme/package.json': '{}', 'acme/README.md': '#' });
    const expected = (await create(cwd, ['acme', '--yes', '--dry-run'])).out;
    // Turkish collation rather than a throw: this stub spans an `await`, and the
    // test runner's own code runs meanwhile - a throwing global breaks its
    // progress reporting. That no generation code calls `localeCompare` at all
    // is held by the source scan in determinism.test.ts.
    const tr = new Intl.Collator('tr');
    const compare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
      this: string,
      that: string,
    ) {
      return tr.compare(String(this), that);
    });
    try {
      expect((await create(cwd, ['acme', '--yes', '--dry-run'])).out).toEqual(expected);
    } finally {
      compare.mockRestore();
    }
  });
});

describe('--debug stays a diagnostic', () => {
  it('adds where each file came from, and the preview is otherwise the same', async () => {
    const cwd = scratch();
    const quiet = await create(cwd, ['acme', '--yes', '--dry-run']);
    const loud = await create(cwd, ['acme', '--yes', '--dry-run', '--debug']);
    expect(quiet.out).not.toContain('  <- ');
    expect(loud.out).toContain('  <- ');
    // An origin can hold spaces (`base + modes/coming-soon`), so strip to end of line.
    expect(loud.out.replace(/ {2}<- .*$/gm, '')).toEqual(quiet.out);
  });
});
