import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { runUpgrade } from '../src/commands/upgrade.js';
import { CliError } from '../src/errors.js';
import { PROVENANCE_FILE } from '../src/generate/provenance.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { CLI_VERSION } from '../src/version.js';
import { FakePrompter, tempDir, testLogger } from './helpers.js';

/**
 * The upgrade command, end to end, against real directories.
 *
 * ## What it promises
 *
 * > ClientKit re-generates the files it would generate today for this
 * > project's recorded stack, using the configuration you supply now. It lists
 * > every file it would replace and asks before replacing any of them. It never
 * > deletes a file, and it never touches a file it did not plan.
 *
 * Every test here is about one clause of that sentence, and most of them are
 * about the last two. The planner's own suite covers the arithmetic; these
 * exist because an upgrade is the first thing ClientKit does to a directory
 * somebody is already working in, and unit tests of a pure function cannot
 * tell you whether a developer's file survived.
 *
 * ## The one thing that must never happen
 *
 * A file ClientKit did not plan is not touched, and nothing is deleted - not
 * an orphan, not a stale file, not one that looks generated. Several tests
 * below assert that by comparing bytes before and after rather than by
 * checking a message.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function scratch(): string {
  const { dir, cleanup } = tempDir('upgrade');
  cleanups.push(cleanup);
  return dir;
}

const BASE = ['--name', 'Acme Ltd', '--url', 'https://acme.example', '--no-git', '--no-install'];
const MARKER = 'USER_CUSTOM_CONTENT';

/** A real project, generated the way a user would. */
async function generated(cwd: string, extra: string[] = []): Promise<string> {
  const { logger } = testLogger();
  const code = await runCreate({
    flags: parseCliArgs(['site', ...BASE, ...extra, '--yes']),
    logger,
    registry,
    cliVersion: CLI_VERSION,
    cwd,
    env: {},
    isTTY: false,
    nodeVersion: process.versions.node,
  });
  expect(code).toBe(0);
  return path.join(cwd, 'site');
}

interface UpgradeRun {
  readonly argv: string[];
  readonly confirm?: boolean;
  readonly isTTY?: boolean;
  readonly yes?: boolean;
}

async function upgrade(cwd: string, options: UpgradeRun) {
  const { logger, out, err } = testLogger();
  const prompter =
    options.confirm === undefined
      ? undefined
      : new FakePrompter({ confirmNonEmpty: options.confirm });

  try {
    const code = await runUpgrade({
      flags: parseCliArgs(options.argv),
      logger,
      registry,
      cliVersion: CLI_VERSION,
      cwd,
      env: {},
      isTTY: options.isTTY ?? false,
      templatesRoot: TEMPLATES_ROOT,
      ...(prompter ? { prompter } : {}),
    });
    return { code, text: `${out.text}${err.text}`, error: undefined as CliError | undefined };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return {
      code: error.exitCode,
      text: `${out.text}${err.text}${error.message}\n${error.hint ?? ''}`,
      error,
    };
  }
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

/** The edits a developer makes on day two, plus a file ClientKit never wrote. */
function editAsUser(dir: string, generatedFile: string): void {
  const readme = path.join(dir, 'README.md');
  writeFileSync(readme, `${readFileSync(readme, 'utf8')}\n\n${MARKER}: our runbook.\n`, 'utf8');

  const page = path.join(dir, generatedFile);
  writeFileSync(page, `${readFileSync(page, 'utf8')}\n// ${MARKER}\n`, 'utf8');

  mkdirSync(path.join(dir, 'src', 'custom'), { recursive: true });
  writeFileSync(
    path.join(dir, 'src', 'custom', 'UserOwned.ts'),
    `export const mine = '${MARKER}';\n`,
    'utf8',
  );
}

const REACT = ['--framework', 'react', '--styling', 'tailwind'];

// ---------------------------------------------------------------------------
// Refusing what it cannot understand
// ---------------------------------------------------------------------------

describe('upgrade refuses a project it cannot read', () => {
  it('refuses a directory with no provenance, and says why', async () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'plain'), { recursive: true });
    writeFileSync(path.join(cwd, 'plain', 'index.js'), 'console.log(1);\n', 'utf8');
    const before = snapshot(path.join(cwd, 'plain'));

    const result = await upgrade(cwd, { argv: ['upgrade', 'plain'], isTTY: true });

    expect(result.code).not.toBe(0);
    expect(result.text).toContain(PROVENANCE_FILE);
    expect(result.text).toContain('does not inspect');
    expect(snapshot(path.join(cwd, 'plain'))).toEqual(before);
  });

  it('refuses a document that is not JSON', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    writeFileSync(path.join(dir, PROVENANCE_FILE), '{ not json', 'utf8');
    const before = snapshot(dir);

    const result = await upgrade(cwd, { argv: ['upgrade', 'site'], isTTY: true });

    expect(result.code).not.toBe(0);
    expect(result.text).toContain('not a ClientKit provenance document');
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses a document whose template contradicts its stack', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    const file = path.join(dir, PROVENANCE_FILE);
    const document = JSON.parse(readFileSync(file, 'utf8')) as {
      template: { framework: string };
    };
    document.template.framework = 'astro';
    writeFileSync(file, JSON.stringify(document, null, 2), 'utf8');
    const before = snapshot(dir);

    const result = await upgrade(cwd, { argv: ['upgrade', 'site'], isTTY: true });

    expect(result.code).not.toBe(0);
    expect(result.text).toContain('stack');
    // The real reason, not a count of orphans.
    expect(result.text.toLowerCase()).not.toContain('orphan');
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses a 1.0.2 document that records no stack', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    const file = path.join(dir, PROVENANCE_FILE);
    const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete document.stack;
    writeFileSync(file, JSON.stringify(document, null, 2), 'utf8');
    const before = snapshot(dir);

    const result = await upgrade(cwd, { argv: ['upgrade', 'site'], isTTY: true });

    expect(result.code).not.toBe(0);
    expect(result.text).toContain('records no stack');
    expect(result.text).toContain('will not guess');
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses a document from a newer ClientKit', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    const file = path.join(dir, PROVENANCE_FILE);
    const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    document.cliVersion = '99.0.0';
    writeFileSync(file, JSON.stringify(document, null, 2), 'utf8');

    const result = await upgrade(cwd, { argv: ['upgrade', 'site'], isTTY: true });

    expect(result.code).not.toBe(0);
    expect(result.text).toContain('newer ClientKit');
  });

  it('refuses without a target directory', async () => {
    const result = await upgrade(scratch(), { argv: ['upgrade'], isTTY: true });
    expect(result.code).not.toBe(0);
    expect(result.text).toContain('directory of an existing ClientKit project');
  });
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

describe('upgrade replaces nothing without being told to', () => {
  it('declined: every byte in the project survives', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    editAsUser(dir, 'src/App.tsx');
    const before = snapshot(dir);

    const result = await upgrade(cwd, { argv: ['upgrade', 'site'], confirm: false, isTTY: true });

    expect(result.code).toBe(0);
    expect(result.text).toContain('Nothing was written');
    expect(snapshot(dir)).toEqual(before);
  });

  it('declined after a stack change: the old files are still there', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, [...REACT, '--ui-library', 'mui']);
    const before = snapshot(dir);

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--ui-library', 'none'],
      confirm: false,
      isTTY: true,
    });

    expect(result.code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(path.join(dir, 'src/components/ui/AppProviders.tsx'))).toBe(true);
  });

  it('refuses to run with --yes rather than confirming on the developer’s behalf', async () => {
    /*
     * The boundary Stage 55 measured and this command does not widen. `--yes`
     * answers configuration questions; it is not consent to replace a
     * developer's files, and an upgrade always targets a directory full of
     * them.
     */
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    const before = snapshot(dir);

    const result = await upgrade(cwd, { argv: ['upgrade', 'site', '--yes'], isTTY: true });

    expect(result.code).not.toBe(0);
    expect(result.text).toContain('--yes');
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses without a terminal rather than assuming yes', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    const before = snapshot(dir);

    const result = await upgrade(cwd, { argv: ['upgrade', 'site'], isTTY: false });

    expect(result.code).not.toBe(0);
    expect(result.text).toContain('not an interactive terminal');
    expect(snapshot(dir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('upgrade --dry-run writes nothing', () => {
  it('reports the plan and leaves the project alone', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, [...REACT, '--ui-library', 'mui']);
    editAsUser(dir, 'src/App.tsx');
    const before = snapshot(dir);

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--ui-library', 'none', '--dry-run'],
      isTTY: true,
    });

    expect(result.code).toBe(0);
    expect(result.text).toContain('Dry run');
    expect(result.text).toContain('src/components/ui/AppProviders.tsx');
    expect(snapshot(dir)).toEqual(before);
  });

  it('needs no confirmation, because nothing will be written', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    const before = snapshot(dir);
    // No prompter at all: if the command asked, this would throw.
    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--dry-run'],
      isTTY: true,
    });
    expect(result.code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// A confirmed upgrade
// ---------------------------------------------------------------------------

describe('a confirmed upgrade replaces what it named, and only that', () => {
  it('restores an edited generated file and keeps the developer’s own', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    const pristine = snapshot(dir);
    editAsUser(dir, 'src/App.tsx');

    const result = await upgrade(cwd, { argv: ['upgrade', 'site'], confirm: true, isTTY: true });
    expect(result.code).toBe(0);

    const after = snapshot(dir);
    // The generated files it warned about came back to what a fresh run makes.
    expect(after.get('src/App.tsx')).toBe(pristine.get('src/App.tsx'));
    expect(after.get('README.md')).toBe(pristine.get('README.md'));
    // The developer's own file is untouched, and still there.
    expect(after.get('src/custom/UserOwned.ts')).toBe(`export const mine = '${MARKER}';\n`);
  });

  it('deletes nothing at all', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, [...REACT, '--ui-library', 'mui', '--router', 'react-router']);
    editAsUser(dir, 'src/App.tsx');
    const before = new Set(snapshot(dir).keys());

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--ui-library', 'none', '--router', 'none'],
      confirm: true,
      isTTY: true,
    });
    expect(result.code).toBe(0);

    const after = new Set(snapshot(dir).keys());
    for (const file of before) {
      expect(after.has(file), `${file} disappeared`).toBe(true);
    }
  });

  it('leaves orphan candidates exactly where they are', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, [...REACT, '--ui-library', 'mui', '--router', 'react-router']);
    const providers = path.join(dir, 'src/components/ui/AppProviders.tsx');
    const router = path.join(dir, 'src/routes/AppRouter.tsx');
    const providersBefore = readFileSync(providers, 'utf8');
    const routerBefore = readFileSync(router, 'utf8');

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--ui-library', 'none', '--router', 'none'],
      confirm: true,
      isTTY: true,
    });
    expect(result.code).toBe(0);

    expect(readFileSync(providers, 'utf8')).toBe(providersBefore);
    expect(readFileSync(router, 'utf8')).toBe(routerBefore);
    expect(result.text).toContain('no longer generated');
  });

  it('names orphans as what they are, never as files to delete', async () => {
    const cwd = scratch();
    await generated(cwd, [...REACT, '--ui-library', 'mui']);

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--ui-library', 'none', '--dry-run'],
      isTTY: true,
    });

    expect(result.text).toContain('no longer generated by this stack');
    expect(result.text).toContain('These are not deleted');
    expect(result.text).not.toMatch(/files? to delete/i);
    expect(result.text).not.toMatch(/will be (deleted|removed)/i);
  });

  it('adds what the new stack needs', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    expect(existsSync(path.join(dir, 'src/components/ui/AppProviders.tsx'))).toBe(false);

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--ui-library', 'mui'],
      confirm: true,
      isTTY: true,
    });

    expect(result.code).toBe(0);
    expect(existsSync(path.join(dir, 'src/components/ui/AppProviders.tsx'))).toBe(true);
  });

  it('carries the recorded configuration forward without being told it again', async () => {
    /*
     * The upgrade UX rule: the recorded configuration is the baseline, and a
     * single override means "everything as before, but this". The site name
     * and URL were never restated on the upgrade command line.
     */
    const cwd = scratch();
    const dir = await generated(cwd, REACT);

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--styling', 'bootstrap'],
      confirm: true,
      isTTY: true,
    });
    expect(result.code).toBe(0);

    const config = readFileSync(path.join(dir, 'src/config/site.config.ts'), 'utf8');
    expect(config).toContain('Acme Ltd');
    expect(config).toContain('https://acme.example');
  });
});

// ---------------------------------------------------------------------------
// Provenance afterwards
// ---------------------------------------------------------------------------

describe('provenance afterwards describes the project that now exists', () => {
  it('records the new stack after a confirmed upgrade', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, [...REACT, '--ui-library', 'mui']);
    const recorded = () =>
      JSON.parse(readFileSync(path.join(dir, PROVENANCE_FILE), 'utf8')) as {
        stack: { uiLibrary: string; styling: string };
      };
    expect(recorded().stack.uiLibrary).toBe('mui');

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--ui-library', 'none', '--styling', 'bootstrap'],
      confirm: true,
      isTTY: true,
    });
    expect(result.code).toBe(0);

    // Not left claiming the old stack, which would make the next upgrade wrong.
    expect(recorded().stack.uiLibrary).toBe('none');
    expect(recorded().stack.styling).toBe('bootstrap');
  });

  it('leaves provenance untouched when the upgrade is declined', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, [...REACT, '--ui-library', 'mui']);
    const before = readFileSync(path.join(dir, PROVENANCE_FILE), 'utf8');

    await upgrade(cwd, {
      argv: ['upgrade', 'site', '--ui-library', 'none'],
      confirm: false,
      isTTY: true,
    });

    expect(readFileSync(path.join(dir, PROVENANCE_FILE), 'utf8')).toBe(before);
  });

  it('can be upgraded twice, the second reading what the first wrote', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, [...REACT, '--ui-library', 'mui']);

    expect(
      (
        await upgrade(cwd, {
          argv: ['upgrade', 'site', '--ui-library', 'none'],
          confirm: true,
          isTTY: true,
        })
      ).code,
    ).toBe(0);

    // The second run's baseline is the first run's result: asking for MUI back
    // is an addition, not a no-op.
    const second = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--ui-library', 'mui'],
      confirm: true,
      isTTY: true,
    });
    expect(second.code).toBe(0);
    expect(existsSync(path.join(dir, 'src/components/ui/AppProviders.tsx'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nothing to change
// ---------------------------------------------------------------------------

describe('an upgrade with nothing to change', () => {
  it('reports no additions and no orphans', async () => {
    const cwd = scratch();
    await generated(cwd, REACT);

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--dry-run'],
      isTTY: true,
    });

    expect(result.code).toBe(0);
    expect(result.text).not.toContain('no longer generated');
  });

  it('still rewrites planned files, because content can differ without the file list changing', async () => {
    /*
     * Site-level changes move no path at all - Stage 61 measured that across
     * every supported stack. So "the path set is unchanged" must not be read
     * as "there is nothing to do", or a renamed site would never reach the
     * generated config.
     */
    const cwd = scratch();
    const dir = await generated(cwd, REACT);

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--name', 'Zenith Industries'],
      confirm: true,
      isTTY: true,
    });
    expect(result.code).toBe(0);

    expect(readFileSync(path.join(dir, 'src/config/site.config.ts'), 'utf8')).toContain(
      'Zenith Industries',
    );
  });
});

// ---------------------------------------------------------------------------
// Frameworks and modes
// ---------------------------------------------------------------------------

describe('upgrade works across frameworks and starters', () => {
  it('upgrades an Astro project', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, ['--framework', 'astro']);
    const custom = path.join(dir, 'src', 'custom', 'UserOwned.ts');
    mkdirSync(path.dirname(custom), { recursive: true });
    writeFileSync(custom, `export const mine = '${MARKER}';\n`, 'utf8');

    const result = await upgrade(cwd, { argv: ['upgrade', 'site'], confirm: true, isTTY: true });

    expect(result.code).toBe(0);
    expect(readFileSync(custom, 'utf8')).toContain(MARKER);
  });

  it('reports the path a Next starter change moves', async () => {
    const cwd = scratch();
    await generated(cwd, ['--framework', 'nextjs', '--mode', 'coming-soon']);

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--mode', 'full', '--dry-run'],
      isTTY: true,
    });

    expect(result.code).toBe(0);
    expect(result.text).toContain('components/ui/Section.tsx');
  });

  it('changes framework, reporting the old framework’s files as orphans', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, ['--framework', 'astro']);

    const result = await upgrade(cwd, {
      argv: ['upgrade', 'site', '--framework', 'react', '--styling', 'tailwind', '--dry-run'],
      isTTY: true,
    });

    expect(result.code).toBe(0);
    expect(result.text).toContain('no longer generated');
    // Astro pages are .astro; they are reported, and they still exist.
    expect(existsSync(path.join(dir, 'src/pages/index.astro'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

describe('a failed upgrade claims nothing', () => {
  it('leaves the project untouched when the target cannot be written', async () => {
    const cwd = scratch();
    const dir = await generated(cwd, REACT);
    const before = snapshot(dir);

    // A directory where a planned file must go: the write fails part-way, and
    // the existing atomic apply must leave the project exactly as it was.
    const blocked = path.join(dir, 'src', 'App.tsx');
    const { rmSync } = await import('node:fs');
    rmSync(blocked);
    mkdirSync(blocked, { recursive: true });
    writeFileSync(path.join(blocked, 'blocker.txt'), 'in the way\n', 'utf8');

    const result = await upgrade(cwd, { argv: ['upgrade', 'site'], confirm: true, isTTY: true });

    expect(result.code).not.toBe(0);
    // Provenance was not rewritten to claim the upgrade happened.
    expect(readFileSync(path.join(dir, PROVENANCE_FILE), 'utf8')).toBe(before.get(PROVENANCE_FILE));
    expect(readFileSync(path.join(blocked, 'blocker.txt'), 'utf8')).toBe('in the way\n');
  });
});

// ---------------------------------------------------------------------------
// Structural guarantees
// ---------------------------------------------------------------------------

describe('the command cannot grow the powers it refuses', () => {
  it('contains no deletion of project files', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'commands', 'upgrade.ts'),
      'utf8',
    );
    for (const forbidden of ['rmSync', 'unlinkSync', 'rmdirSync', 'renameSync']) {
      expect(source, `upgrade.ts reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('computes no path difference of its own', () => {
    // The arithmetic belongs to the planner. A second copy here could disagree
    // with the one the tests cover.
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'commands', 'upgrade.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).toContain('planUpgrade');
    expect(source).not.toContain('orphanCandidates:');
  });

  it('decides ownership from the plan, never from file contents', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'commands', 'upgrade.ts'),
      'utf8',
    );
    // It reads exactly one file itself - the provenance document - through the
    // injected reader. Nothing inspects generated output to decide anything.
    expect(source).not.toContain('readdirSync');
    expect(source).not.toContain('statSync');
  });
});
