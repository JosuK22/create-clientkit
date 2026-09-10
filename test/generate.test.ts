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
 * Behaviour tests for the generate command against a real filesystem.
 *
 * These cover the directory-safety matrix that unit tests cannot reach,
 * including the interactive confirmation branch - the one path that needed a
 * terminal until the prompter became injectable.
 */
const registry = createRegistry(findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src')));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function scratch(): string {
  const { dir, cleanup } = tempDir('gen');
  cleanups.push(cleanup);
  return dir;
}

interface RunOptions {
  argv?: string[];
  isTTY?: boolean;
  confirm?: boolean;
}

async function generate(cwd: string, options: RunOptions = {}) {
  const { logger, out, err } = testLogger();
  const flags = parseCliArgs(options.argv ?? ['site', '--yes', '--no-install', '--no-git']);

  // A fake prompter stands in for a terminal, and only when a test actually
  // drives the confirmation. Leaving it out elsewhere keeps the real prompter
  // selection under test - notably that --yes refuses regardless of the TTY.
  const prompter =
    options.confirm === undefined
      ? undefined
      : new FakePrompter({ confirmNonEmpty: options.confirm });

  const code = await runCreate({
    flags,
    logger,
    registry,
    cliVersion: CLI_VERSION,
    cwd,
    env: {},
    isTTY: options.isTTY ?? false,
    nodeVersion: process.versions.node,
    ...(prompter ? { prompter } : {}),
  });

  return { code, out: out.text, err: err.text };
}

const listFiles = (root: string): string[] => {
  const walk = (dir: string, prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? walk(path.join(dir, entry.name), relative) : [relative];
    });
  return walk(root).sort();
};

describe('generating into a usable directory', () => {
  it('generates into a directory that does not exist', async () => {
    const cwd = scratch();
    const { code } = await generate(cwd);

    expect(code).toBe(0);
    expect(existsSync(path.join(cwd, 'site', 'package.json'))).toBe(true);
    expect(listFiles(path.join(cwd, 'site')).length).toBeGreaterThan(15);
  });

  it('generates into an existing empty directory', async () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'site'), { recursive: true });

    const { code } = await generate(cwd);

    expect(code).toBe(0);
    expect(existsSync(path.join(cwd, 'site', 'astro.config.mjs'))).toBe(true);
  });

  it('generates into a directory containing only .git, and keeps it', async () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'site', '.git'), { recursive: true });
    writeFileSync(path.join(cwd, 'site', '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const { code } = await generate(cwd);

    expect(code).toBe(0);
    expect(existsSync(path.join(cwd, 'site', 'package.json'))).toBe(true);
    expect(readFileSync(path.join(cwd, 'site', '.git', 'HEAD'), 'utf8')).toContain(
      'refs/heads/main',
    );
  });

  it('writes LF line endings on every platform', async () => {
    const cwd = scratch();
    await generate(cwd);

    for (const file of ['package.json', 'README.md', '.gitignore', 'src/pages/index.astro']) {
      const content = readFileSync(path.join(cwd, 'site', file), 'utf8');
      expect(content, `${file} has CRLF`).not.toContain('\r\n');
    }
  });

  it('leaves no staging directory behind', async () => {
    const cwd = scratch();
    await generate(cwd);

    expect(readdirSync(cwd).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });
});

describe('non-empty directory safety', () => {
  function seed(cwd: string): string {
    const dir = path.join(cwd, 'site');
    mkdirSync(path.join(dir, 'src', 'custom'), { recursive: true });
    writeFileSync(path.join(dir, 'IMPORTANT.txt'), 'do not touch');
    writeFileSync(path.join(dir, 'src', 'custom', 'mine.ts'), 'export const x = 1;');
    return dir;
  }

  it('refuses in non-interactive mode and changes nothing', async () => {
    const cwd = scratch();
    const dir = seed(cwd);
    const before = listFiles(dir);

    await expect(generate(cwd, { isTTY: false })).rejects.toThrow(
      /already exists and is not empty/,
    );
    expect(listFiles(dir)).toEqual(before);
  });

  it('refuses under --yes even with a terminal attached', async () => {
    const cwd = scratch();
    const dir = seed(cwd);
    const before = listFiles(dir);

    // --yes disables prompting, so there is no way to obtain consent.
    await expect(
      generate(cwd, { argv: ['site', '--yes', '--no-install', '--no-git'], isTTY: true }),
    ).rejects.toThrow(CliError);
    expect(listFiles(dir)).toEqual(before);
  });

  it('cancels cleanly when the developer declines', async () => {
    const cwd = scratch();
    const dir = seed(cwd);
    const before = listFiles(dir);

    const { code, err } = await generate(cwd, {
      argv: ['site', '--no-install', '--no-git', '--name', 'Acme'],
      isTTY: true,
      confirm: false,
    });

    expect(code).toBe(0);
    expect(err).toContain('Cancelled');
    expect(listFiles(dir)).toEqual(before);
  });

  it('warns and lists what would be replaced before asking', async () => {
    const cwd = scratch();
    const dir = seed(cwd);
    writeFileSync(path.join(dir, 'package.json'), '{"name":"existing"}');

    const { err } = await generate(cwd, {
      argv: ['site', '--no-install', '--no-git', '--name', 'Acme'],
      isTTY: true,
      confirm: false,
    });

    expect(err).toContain('already contains files');
    expect(err).toContain('package.json');
  });

  it('generates on confirmation and preserves unrelated files', async () => {
    const cwd = scratch();
    const dir = seed(cwd);

    const { code } = await generate(cwd, {
      argv: ['site', '--no-install', '--no-git', '--name', 'Acme'],
      isTTY: true,
      confirm: true,
    });

    expect(code).toBe(0);
    // Generated.
    expect(existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'src', 'pages', 'index.astro'))).toBe(true);
    // Untouched.
    expect(readFileSync(path.join(dir, 'IMPORTANT.txt'), 'utf8')).toBe('do not touch');
    expect(readFileSync(path.join(dir, 'src', 'custom', 'mine.ts'), 'utf8')).toBe(
      'export const x = 1;',
    );
  });

  it('reports the files it replaced', async () => {
    const cwd = scratch();
    const dir = seed(cwd);
    writeFileSync(path.join(dir, 'package.json'), '{"name":"existing"}');

    const { err } = await generate(cwd, {
      argv: ['site', '--no-install', '--no-git', '--name', 'Acme'],
      isTTY: true,
      confirm: true,
    });

    expect(err).toContain('Replaced 1 existing file');
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name).toBe('site');
  });
});

describe('platform behaviour', () => {
  it('resolves the target directory relative to the working directory', async () => {
    const cwd = scratch();
    await generate(cwd, {
      argv: ['nested/site', '--yes', '--no-install', '--no-git'],
    });

    expect(existsSync(path.join(cwd, 'nested', 'site', 'package.json'))).toBe(true);
  });

  it('discovers templates from the installed layout', () => {
    // Guards the walk-up strategy that lets the same code find templates in a
    // source checkout and in an installed package.
    expect(registry.has('astro-tailwind')).toBe(true);
    expect(existsSync(path.join(registry.rootFor('astro-tailwind'), 'template.json'))).toBe(true);
  });

  it('writes template files with their underscore prefix removed', async () => {
    const cwd = scratch();
    await generate(cwd);

    const files = listFiles(path.join(cwd, 'site'));
    expect(files).toContain('.gitignore');
    expect(files).toContain('package.json');
    expect(files.some((f) => f.startsWith('_'))).toBe(false);
  });
});
