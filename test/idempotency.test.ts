import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import {
  decideRegeneration,
  inspectTarget,
  pathsToWrite,
  postStepsAfter,
} from '../src/commands/regenerate.js';
import { CliError } from '../src/errors.js';
import type * as ApplyModule from '../src/generate/apply.js';
import type { GenerationPlan } from '../src/generate/files.js';
import type * as PostStepsModule from '../src/generate/postSteps.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { CLI_VERSION } from '../src/version.js';
import { FakePrompter, tempDir, testLogger } from './helpers.js';

/**
 * Stage 7: running ClientKit again on a project it generated.
 *
 * `apply` and `runPostSteps` are wrapped, not replaced: each still does its
 * real work, and the spies record what they were handed - so "nothing was
 * written" and "no post step ran" are observed, not inferred.
 */

const calls = vi.hoisted(() => ({
  applied: [] as string[][],
  postSteps: [] as string[][],
}));

vi.mock('../src/generate/apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ApplyModule>();
  return {
    ...actual,
    apply: (plan: GenerationPlan, options: Parameters<typeof actual.apply>[1]) => {
      calls.applied.push(plan.operations.map((operation) => operation.path));
      return actual.apply(plan, options);
    },
  };
});

vi.mock('../src/generate/postSteps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PostStepsModule>();
  return {
    ...actual,
    runPostSteps: (options: Parameters<typeof actual.runPostSteps>[0]) => {
      calls.postSteps.push([...options.steps]);
      return actual.runPostSteps(options);
    },
  };
});

const registry = createRegistry(findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src')));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  calls.applied.length = 0;
  calls.postSteps.length = 0;
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function scratch(): string {
  const { dir, cleanup } = tempDir('idem');
  cleanups.push(cleanup);
  return dir;
}

const BASE = ['--name', 'Acme Ltd', '--url', 'https://acme.example', '--no-git', '--no-install'];
const REACT = ['--framework', 'react', '--styling', 'tailwind'];

async function run(
  cwd: string,
  argv: readonly string[],
  options: { confirm?: boolean } = {},
): Promise<{ code: number; text: string; asked: string[] }> {
  const { logger, out, err } = testLogger();
  const prompter =
    options.confirm === undefined
      ? undefined
      : new FakePrompter({ confirmNonEmpty: options.confirm });
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
  // eslint-disable-next-line no-control-regex
  const text = `${out.text}${err.text}`.replace(/\u001b\[[0-9;]*m/g, '');
  return { code, text, asked: prompter?.asked ?? [] };
}

/** Generate a project, then forget the calls that made it. */
async function generated(cwd: string, stack: readonly string[] = []): Promise<string> {
  const { code } = await run(cwd, ['site', ...BASE, ...stack, '--yes']);
  expect(code).toBe(0);
  calls.applied.length = 0;
  calls.postSteps.length = 0;
  return path.join(cwd, 'site');
}

/** Every file and directory, with size, mtime and bytes - `.git` included. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const key = path.relative(root, full).split(path.sep).join('/');
      const stats = statSync(full);
      if (entry.isDirectory()) {
        out[`${key}/`] = 'dir';
        walk(full);
      } else {
        out[key] = `${stats.size}:${stats.mtimeMs}:${readFileSync(full, 'base64')}`;
      }
    }
  };
  walk(root);
  return out;
}

const read = (dir: string, file: string): string => readFileSync(path.join(dir, file), 'utf8');
const edit = (dir: string, file: string): void =>
  writeFileSync(path.join(dir, file), `${read(dir, file)}\n<!-- edited -->\n`, 'utf8');

// ---------------------------------------------------------------------------
// Recognising the target
// ---------------------------------------------------------------------------

describe('what ClientKit recognises', () => {
  it('tells new, empty, its own, and unrecognised directories apart', async () => {
    const cwd = scratch();
    expect(inspectTarget(path.join(cwd, 'nope'), CLI_VERSION)).toEqual({ kind: 'new' });

    mkdirSync(path.join(cwd, 'empty', '.git'), { recursive: true });
    expect(inspectTarget(path.join(cwd, 'empty'), CLI_VERSION)).toEqual({ kind: 'empty' });

    const dir = await generated(cwd);
    expect(inspectTarget(dir, CLI_VERSION)).toEqual({ kind: 'clientkit' });

    mkdirSync(path.join(cwd, 'other'));
    writeFileSync(path.join(cwd, 'other', 'notes.txt'), 'mine');
    expect(inspectTarget(path.join(cwd, 'other'), CLI_VERSION)).toEqual({ kind: 'unrecognised' });

    writeFileSync(path.join(cwd, 'other', '.client-site.json'), '{ not json');
    const broken = inspectTarget(path.join(cwd, 'other'), CLI_VERSION);
    expect(broken.kind).toBe('unrecognised');
    expect(broken.kind === 'unrecognised' && broken.because).toMatch(
      /not a usable ClientKit record/,
    );
  });

  it('generates normally into a new or an empty directory', async () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'site', '.git'), { recursive: true });
    const { code } = await run(cwd, ['site', ...BASE, '--yes']);
    expect(code).toBe(0);
    expect(calls.applied).toHaveLength(1);
    expect(calls.applied[0]?.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// The exact repeat
// ---------------------------------------------------------------------------

describe('the same generation again', () => {
  for (const [name, stack] of [
    ['Astro', []],
    ['React + Tailwind', REACT],
    ['Next.js + MUI', ['--framework', 'nextjs', '--ui-library', 'mui']],
  ] as const) {
    it(`writes nothing, runs no post step, and succeeds: ${name}`, async () => {
      const cwd = scratch();
      const dir = await generated(cwd, stack);
      mkdirSync(path.join(dir, '.git'));
      writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      const before = snapshot(dir);

      const { code, text } = await run(cwd, ['site', ...BASE, ...stack, '--yes']);

      expect(code).toBe(0);
      expect(text).toMatch(
        /site is already up to date: all \d+ generated files match\. Nothing was written\./,
      );
      expect(calls.applied).toEqual([]);
      expect(calls.postSteps).toEqual([]);
      expect(snapshot(dir)).toEqual(before);
    });
  }

  it('asks nothing interactively either', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    const before = snapshot(dir);
    const { code, asked } = await run(cwd, ['site', ...BASE], { confirm: true });
    expect(code).toBe(0);
    expect(asked).not.toContain('confirmNonEmpty');
    expect(snapshot(dir)).toEqual(before);
  });

  it('is repeatable any number of times', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    const before = snapshot(dir);
    for (let run_ = 0; run_ < 3; run_ += 1) {
      expect((await run(cwd, ['site', ...BASE, '--yes'])).code).toBe(0);
    }
    expect(calls.applied).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  it('keeps the record byte for byte: no new timestamp for a run that changed nothing', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    const record = read(dir, '.client-site.json');
    await run(cwd, ['site', ...BASE, '--yes']);
    expect(read(dir, '.client-site.json')).toBe(record);
  });
});

// ---------------------------------------------------------------------------
// Missing, edited and unrelated files
// ---------------------------------------------------------------------------

describe('a missing generated file', () => {
  it('is restored, alone, without asking - with the record noting the run', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    const page = 'src/pages/index.astro';
    const original = read(dir, page);
    rmSync(path.join(dir, page));
    const before = snapshot(dir);

    const { code, text } = await run(cwd, ['site', ...BASE, '--yes']);

    expect(code).toBe(0);
    expect(calls.applied).toEqual([['.client-site.json', page]]);
    expect(read(dir, page)).toBe(original);
    expect(text).toMatch(/Updated site: 1 added, 1 replaced, \d+ already up to date\./);
    // Every other file untouched, to the millisecond.
    const after = snapshot(dir);
    for (const [file, value] of Object.entries(before)) {
      if (file === '.client-site.json') continue;
      expect(after[file], file).toBe(value);
    }
  });

  it('reinstalls only when package.json was the file restored', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    rmSync(path.join(dir, 'src', 'pages', 'index.astro'));
    await run(cwd, ['site', ...BASE, '--yes']);
    expect(calls.postSteps).toEqual([['git-init']]);

    rmSync(path.join(dir, 'package.json'));
    calls.postSteps.length = 0;
    await run(cwd, ['site', ...BASE, '--yes']);
    expect(calls.postSteps).toEqual([['install', 'git-init']]);
  });
});

describe('an edited generated file', () => {
  it('stops a --yes run with the list, and writes nothing at all', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    edit(dir, 'README.md');
    rmSync(path.join(dir, 'src', 'pages', 'index.astro')); // a safe change in the same run
    const before = snapshot(dir);

    const error = await run(cwd, ['site', ...BASE, '--yes']).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/1 generated file\(s\) .* differ/);
    expect((error as CliError).hint).toContain('  README.md');
    expect((error as CliError).hint).toContain('ClientKit cannot tell which');
    // Not even the safe half: a refusal changes nothing.
    expect(calls.applied).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  it('is left alone when a person declines', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    edit(dir, 'README.md');
    const before = snapshot(dir);
    const { code, text, asked } = await run(cwd, ['site', ...BASE], { confirm: false });
    expect(code).toBe(0);
    expect(asked).toContain('confirmNonEmpty');
    expect(text).toContain('Cancelled. Nothing was written.');
    expect(calls.applied).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  it('is replaced, alone, when a person agrees', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    edit(dir, 'README.md');
    const { code } = await run(cwd, ['site', ...BASE], { confirm: true });
    expect(code).toBe(0);
    expect(calls.applied).toEqual([['.client-site.json', 'README.md']]);
    expect(read(dir, 'README.md')).not.toContain('<!-- edited -->');
  });
});

describe('files ClientKit does not generate', () => {
  it('neither block a no-op nor get touched', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    mkdirSync(path.join(dir, 'src', 'mine'));
    writeFileSync(path.join(dir, 'src', 'mine', 'Owned.ts'), 'export const mine = 1;\n');
    const before = snapshot(dir);

    const { code, text } = await run(cwd, ['site', ...BASE, '--yes']);

    expect(code).toBe(0);
    expect(text).toContain('already up to date');
    expect(snapshot(dir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Directories ClientKit does not recognise
// ---------------------------------------------------------------------------

describe('a directory ClientKit cannot claim', () => {
  it('keeps the non-empty rule: --yes is refused as it always was', async () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'site'));
    writeFileSync(path.join(cwd, 'site', 'README.md'), 'someone else’s');
    await expect(run(cwd, ['site', ...BASE, '--yes'])).rejects.toThrow(
      /already exists and is not empty/,
    );
    expect(calls.applied).toEqual([]);
  });

  it('treats a generated project whose record was removed as unrecognised', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    rmSync(path.join(dir, '.client-site.json'));
    await expect(run(cwd, ['site', ...BASE, '--yes'])).rejects.toThrow(
      /already exists and is not empty/,
    );
  });

  it('says why a record it found could not be trusted', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    writeFileSync(path.join(dir, '.client-site.json'), '{ "not": "a record" }');
    const error = await run(cwd, ['site', ...BASE, '--yes']).then(
      () => undefined,
      (thrown: unknown) => thrown as CliError,
    );
    expect(error?.hint).toMatch(/ClientKit did not treat it as its own project/);
  });
});

// ---------------------------------------------------------------------------
// Configuration and template changes
// ---------------------------------------------------------------------------

describe('changing the configuration of a generated project', () => {
  it('React + Tailwind to React + MUI: refused under --yes, applied when agreed, nothing deleted', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    const before = snapshot(dir);

    await expect(
      run(cwd, ['site', ...BASE, ...REACT, '--ui-library', 'mui', '--yes']),
    ).rejects.toThrow(/differ from what ClientKit would write now/);
    expect(snapshot(dir)).toEqual(before);

    const { code } = await run(cwd, ['site', ...BASE, ...REACT, '--ui-library', 'mui'], {
      confirm: true,
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(dir, 'src', 'components', 'ui', 'AppProviders.tsx'))).toBe(true);
    expect(JSON.parse(read(dir, '.client-site.json')).stack.uiLibrary).toBe('mui');
    for (const file of Object.keys(before)) {
      expect(existsSync(path.join(dir, ...file.replace(/\/$/, '').split('/'))), file).toBe(true);
    }
  });

  it('Astro to React: a template change leaves the old template’s files where they are', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    const { code } = await run(cwd, ['site', ...BASE, ...REACT], { confirm: true });
    expect(code).toBe(0);
    expect(JSON.parse(read(dir, '.client-site.json')).template.id).toBe('react-vite');
    expect(existsSync(path.join(dir, 'src', 'App.tsx'))).toBe(true);
    // Astro's own files are not proven obsolete by anything ClientKit knows, so stay.
    expect(existsSync(path.join(dir, 'astro.config.mjs'))).toBe(true);
  });

  it('a repeat of the new configuration is then a no-op', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    await run(cwd, ['site', ...BASE, ...REACT, '--ui-library', 'mui'], { confirm: true });
    const before = snapshot(dir);
    calls.applied.length = 0;
    const { code } = await run(cwd, ['site', ...BASE, ...REACT, '--ui-library', 'mui', '--yes']);
    expect(code).toBe(0);
    expect(calls.applied).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('--dry-run uses the same decision', () => {
  const listed = (text: string, heading: string): string[] => {
    const block = text.split(`${heading} (`)[1]?.split('\n\n')[0] ?? '';
    return [...block.matchAll(/^ {2}[+~] (\S+)/gm)].map((match) => match[1] as string);
  };

  it('previews exactly what the confirmed run then writes', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    edit(dir, 'README.md');
    rmSync(path.join(dir, 'src', 'pages', 'index.astro'));
    const before = snapshot(dir);

    const preview = await run(cwd, ['site', ...BASE, '--dry-run'], { confirm: true });
    expect(snapshot(dir)).toEqual(before);
    expect(calls.applied).toEqual([]);
    const previewed = [
      ...listed(preview.text, 'Files to create'),
      ...listed(preview.text, 'Files to replace'),
    ];

    await run(cwd, ['site', ...BASE], { confirm: true });
    expect([...(calls.applied[0] ?? [])].sort()).toEqual([...previewed].sort());
    expect(previewed.sort()).toEqual(['.client-site.json', 'README.md', 'src/pages/index.astro']);
  });

  it('says a project that matches is already up to date', async () => {
    const cwd = scratch();
    await generated(cwd);
    const { text } = await run(cwd, ['site', ...BASE, '--yes', '--dry-run']);
    expect(text).toContain('This is a ClientKit project.');
    expect(text).toContain('Already up to date: without --dry-run, nothing would be written.');
    expect(text).toContain('Files to create (0)');
    expect(text).not.toContain('Files to replace');
    expect(text).toMatch(/Post steps \(not run\)\n {2}none/);
  });

  it('says a --yes run would stop when a generated file differs', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    edit(dir, 'README.md');
    const { text } = await run(cwd, ['site', ...BASE, '--yes', '--dry-run']);
    expect(text).toContain('1 generated file(s) differ from what ClientKit would write now.');
    expect(text).toContain('this run would stop and write nothing');
  });
});

// ---------------------------------------------------------------------------
// Determinism of the decision
// ---------------------------------------------------------------------------

describe('the decision is deterministic', () => {
  it('is the same whatever order the plan lists operations in, and every time', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    edit(dir, 'README.md');
    rmSync(path.join(dir, 'src', 'pages', 'index.astro'));
    const { plan } = await import('../src/adapters/bridge.js').then(async (bridge) => {
      const { resolveContext } = await import('../src/context/resolve.js');
      const { NonInteractivePrompter } = await import('../src/context/prompts.js');
      const resolution = await resolveContext({
        flags: parseCliArgs(['site', ...BASE, '--yes']),
        cwd,
        env: {},
        prompter: new NonInteractivePrompter('test'),
        registry,
        cliVersion: CLI_VERSION,
        now: new Date('2026-01-01T00:00:00.000Z'),
      });
      return bridge.planManifest(resolution.manifest, {
        registry,
        cliVersion: CLI_VERSION,
        generatedAt: resolution.context.generatedAt,
        mode: resolution.context.template.mode,
        templateId: resolution.context.template.id,
      });
    });
    const first = decideRegeneration(plan);
    const reversed = decideRegeneration({ ...plan, operations: [...plan.operations].reverse() });
    expect(reversed).toEqual(first);
    for (let again = 0; again < 3; again += 1) expect(decideRegeneration(plan)).toEqual(first);
    expect(first.missing).toEqual(['src/pages/index.astro']);
    expect(first.conflicts).toEqual(['README.md']);
    expect(pathsToWrite(first, false)).toEqual(['src/pages/index.astro', '.client-site.json']);
  });

  it('plans post steps from what was written, not from the run', () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, '.git'));
    expect(postStepsAfter(['install', 'git-init'], [], cwd)).toEqual([]);
    expect(postStepsAfter(['install', 'git-init'], ['package.json'], cwd)).toEqual(['install']);
    expect(
      postStepsAfter(['install', 'git-init'], ['README.md'], path.join(cwd, 'no-git')),
    ).toEqual(['git-init']);
  });
});
