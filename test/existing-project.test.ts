import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { CLI_VERSION } from '../src/version.js';
import { FakePrompter, tempDir, testLogger } from './helpers.js';

/**
 * What ClientKit promises the *second* time it meets a directory.
 *
 * ## The contract, stated
 *
 * ClientKit creates projects. It has no upgrade command, no migration and no
 * reconfiguration: the only thing it can do to a directory that already has
 * content is merge a freshly generated project into it, and only after saying
 * exactly what that would replace and being told to go ahead.
 *
 *     non-interactive, any non-empty directory  ->  refused, nothing written
 *     --dry-run                                 ->  nothing written, ever
 *     interactive, declined                     ->  nothing written
 *     interactive, confirmed                    ->  planned files replaced,
 *                                                   everything else untouched,
 *                                                   nothing deleted
 *
 * `test/generate.test.ts` already covers that matrix for an *arbitrary*
 * directory - a stray README, someone's notes. These tests are about the case
 * that arrives later and matters more: a directory ClientKit itself generated,
 * which a developer has since been working in.
 *
 * ## What is deliberately not promised
 *
 * Nothing here removes a file. A project generated with MUI and re-generated
 * without it keeps `AppProviders.tsx`, now importing a dependency that is no
 * longer installed. That is not a migration failing; it is that there is no
 * migration, and the last test in this file pins that so the limitation cannot
 * quietly change into a half-built one.
 */

const registry = createRegistry(findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src')));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function scratch(): string {
  const { dir, cleanup } = tempDir('existing');
  cleanups.push(cleanup);
  return dir;
}

interface RunOptions {
  readonly argv: string[];
  readonly isTTY?: boolean;
  readonly confirm?: boolean;
}

async function run(cwd: string, options: RunOptions) {
  const { logger, out, err } = testLogger();
  const prompter =
    options.confirm === undefined
      ? undefined
      : new FakePrompter({ confirmNonEmpty: options.confirm });

  const code = await runCreate({
    flags: parseCliArgs(options.argv),
    logger,
    registry,
    cliVersion: CLI_VERSION,
    cwd,
    env: {},
    isTTY: options.isTTY ?? false,
    nodeVersion: process.versions.node,
    ...(prompter ? { prompter } : {}),
  });
  return { code, text: `${out.text}${err.text}` };
}

/** Every file's path and contents, so "unchanged" can mean bytes. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix = ''): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else files.set(relative, readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
}

const MARKER = 'USER_CUSTOM_CONTENT';

const BASE = ['--name', 'Acme Ltd', '--url', 'https://acme.example', '--no-git', '--no-install'];

/** A real project, generated the way a user would. */
async function generated(cwd: string, extra: string[] = []): Promise<string> {
  const { code } = await run(cwd, { argv: ['site', ...BASE, ...extra, '--yes'] });
  expect(code).toBe(0);
  return path.join(cwd, 'site');
}

/** The edits a developer makes on day two, plus a file ClientKit never wrote. */
function editAsUser(dir: string): void {
  const readme = path.join(dir, 'README.md');
  writeFileSync(readme, `${readFileSync(readme, 'utf8')}\n\n${MARKER}: our runbook.\n`, 'utf8');

  const page = path.join(dir, 'src', 'pages', 'index.astro');
  writeFileSync(page, `${readFileSync(page, 'utf8')}\n<!-- ${MARKER} -->\n`, 'utf8');

  mkdirSync(path.join(dir, 'src', 'custom'), { recursive: true });
  writeFileSync(
    path.join(dir, 'src', 'custom', 'UserOwned.ts'),
    `export const mine = '${MARKER}';\n`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Refusal, which is the default answer
// ---------------------------------------------------------------------------

describe('a project ClientKit generated is not re-generated by default', () => {
  it('refuses a second --yes run and changes nothing', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    const before = snapshot(dir);

    await expect(run(cwd, { argv: ['site', ...BASE, '--yes'] })).rejects.toThrow(CliError);
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses even with a terminal attached, when --yes rules out asking', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    const before = snapshot(dir);

    await expect(run(cwd, { argv: ['site', ...BASE, '--yes'], isTTY: true })).rejects.toThrow(
      /already exists and is not empty/,
    );
    expect(snapshot(dir)).toEqual(before);
  });

  it('keeps the developer’s work when it refuses', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    editAsUser(dir);
    const before = snapshot(dir);

    await expect(run(cwd, { argv: ['site', ...BASE, '--yes'] })).rejects.toThrow(CliError);

    const after = snapshot(dir);
    expect(after).toEqual(before);
    expect(after.get('README.md')).toContain(MARKER);
    expect(after.get('src/custom/UserOwned.ts')).toContain(MARKER);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('--dry-run never touches an existing project', () => {
  it('resolves, reports and writes nothing', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    editAsUser(dir);
    const before = snapshot(dir);

    const { code } = await run(cwd, { argv: ['site', ...BASE, '--yes', '--dry-run'] });

    expect(code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  it('writes nothing even when the answer would have been yes', async () => {
    // A dry run is not a rehearsal for a confirmed merge: it is the whole run.
    const cwd = scratch();
    const dir = await generated(cwd);
    editAsUser(dir);
    const before = snapshot(dir);

    await run(cwd, { argv: ['site', ...BASE, '--dry-run'], isTTY: true, confirm: true });

    expect(snapshot(dir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The merge, once somebody has said yes
// ---------------------------------------------------------------------------

describe('a confirmed merge replaces what it names and nothing else', () => {
  it('says what it would replace before asking', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    editAsUser(dir);

    const { text } = await run(cwd, { argv: ['site', ...BASE], isTTY: true, confirm: false });

    expect(text).toContain('already contains files');
    expect(text).toMatch(/existing file\(s\) would be replaced/);
    // Cancelling is not an error.
    expect(text).toContain('Cancelled');
    expect(snapshot(dir).get('README.md')).toContain(MARKER);
  });

  it('leaves files the template does not name completely alone', async () => {
    /*
     * The README's promise, in a test: "Files the template does not name are
     * never touched." A developer's own module is the case that matters, and
     * it must survive a merge the developer agreed to.
     */
    const cwd = scratch();
    const dir = await generated(cwd);
    editAsUser(dir);

    const { code } = await run(cwd, { argv: ['site', ...BASE], isTTY: true, confirm: true });

    expect(code).toBe(0);
    expect(readFileSync(path.join(dir, 'src', 'custom', 'UserOwned.ts'), 'utf8')).toContain(MARKER);
  });

  it('replaces edits to generated files, which is what it warned about', async () => {
    /*
     * Not silent, and not a defect: the run lists the files, asks whether to
     * replace them with the default set to no, and afterwards reports how many
     * it replaced. This test exists so that stays true - an overwrite nobody
     * announced would be the thing to be afraid of.
     */
    const cwd = scratch();
    const dir = await generated(cwd);
    editAsUser(dir);

    const { text } = await run(cwd, { argv: ['site', ...BASE], isTTY: true, confirm: true });

    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).not.toContain(MARKER);
    expect(text).toMatch(/Replaced \d+ existing file\(s\)/);
  });

  it('deletes nothing', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    editAsUser(dir);
    const before = snapshot(dir);

    await run(cwd, { argv: ['site', ...BASE], isTTY: true, confirm: true });

    const after = snapshot(dir);
    for (const file of before.keys()) {
      expect(after.has(file), `${file} was deleted`).toBe(true);
    }
  });

  it('brings the generated half back to exactly what a fresh run produces', async () => {
    // Tool-owned determinism: whatever the developer did to a generated file,
    // a confirmed merge puts the canonical content back.
    const cwd = scratch();
    const dir = await generated(cwd);
    const pristine = snapshot(dir);
    editAsUser(dir);

    await run(cwd, { argv: ['site', ...BASE], isTTY: true, confirm: true });
    const after = snapshot(dir);

    for (const [file, content] of pristine) {
      // `.client-site.json` carries the generation timestamp by design.
      if (file === '.client-site.json') continue;
      expect(after.get(file), file).toBe(content);
    }
  });
});

// ---------------------------------------------------------------------------
// Provenance: written, and not read
// ---------------------------------------------------------------------------

describe('a generated project records how it was made', () => {
  it('writes the CLI version and the template it came from', async () => {
    const cwd = scratch();
    const dir = await generated(cwd);
    const provenance = JSON.parse(readFileSync(path.join(dir, '.client-site.json'), 'utf8')) as {
      cliVersion: string;
      template: { id: string };
    };

    expect(provenance.cliVersion).toBe(CLI_VERSION);
    expect(provenance.template.id).toBe('astro-tailwind');
  });

  it('does not read it back, and says nothing about versions on a second run', async () => {
    /*
     * The file exists so that a future `upgrade` or `add` command would not
     * have to guess - its own doc comment says so. Nothing consults it today,
     * and this pins that: claiming version-awareness the CLI does not have
     * would be worse than not having it.
     */
    const cwd = scratch();
    const dir = await generated(cwd);
    const file = path.join(dir, '.client-site.json');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/"cliVersion": "[^"]*"/, '"cliVersion": "0.0.1-ancient"'),
      'utf8',
    );

    const error = await run(cwd, { argv: ['site', ...BASE, '--yes'] }).then(
      () => undefined,
      (thrown: CliError) => thrown,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(`${(error as CliError).message}${(error as CliError).hint ?? ''}`).not.toMatch(
      /version|upgrade|migrat/i,
    );
  });
});

// ---------------------------------------------------------------------------
// The limitation, pinned
// ---------------------------------------------------------------------------

describe('re-generating a different stack is not a migration', () => {
  it('leaves the previous configuration’s files behind', async () => {
    /*
     * Measured in Stage 55 rather than assumed: a React project generated with
     * MUI and a router, re-generated without either, keeps `AppProviders.tsx`
     * and `AppRouter.tsx`. They still import packages the new `package.json` no
     * longer lists - the build tree-shakes them away and succeeds, `tsc` does
     * not and fails.
     *
     * That is not a migration going wrong. There is no migration: the merge
     * path writes the files a fresh project would have and never removes one,
     * because removing files from a directory somebody is working in is not a
     * thing to do without being asked far more precisely than this. The test is
     * here so the limitation is a decision on the record rather than a surprise,
     * and so it cannot turn into a half-built migration without failing.
     */
    const cwd = scratch();
    const dir = await generated(cwd, [
      '--framework',
      'react',
      '--styling',
      'tailwind',
      '--ui-library',
      'mui',
      '--router',
      'react-router',
    ]);
    expect(existsSync(path.join(dir, 'src', 'components', 'ui', 'AppProviders.tsx'))).toBe(true);
    expect(existsSync(path.join(dir, 'src', 'routes', 'AppRouter.tsx'))).toBe(true);

    await run(cwd, {
      argv: [
        'site',
        ...BASE,
        '--framework',
        'react',
        '--styling',
        'tailwind',
        '--ui-library',
        'none',
        '--router',
        'none',
      ],
      isTTY: true,
      confirm: true,
    });

    // Still there, and still the reason a typecheck would fail.
    expect(existsSync(path.join(dir, 'src', 'components', 'ui', 'AppProviders.tsx'))).toBe(true);
    expect(existsSync(path.join(dir, 'src', 'routes', 'AppRouter.tsx'))).toBe(true);

    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = Object.keys(pkg.dependencies ?? {});
    expect(dependencies.some((name) => name.includes('mui'))).toBe(false);
    expect(dependencies.some((name) => name.includes('react-router'))).toBe(false);
  });
});
