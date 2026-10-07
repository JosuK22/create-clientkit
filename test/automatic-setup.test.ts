import type * as ChildProcess from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { startingModeOptions } from '../src/context/interactive.js';
import { ClackPrompter, NonInteractivePrompter, type Prompter } from '../src/context/prompts.js';
import { runPostSteps } from '../src/generate/postSteps.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { postStepProgress } from '../src/ui/postSteps.js';
import { FakePrompter, makeContext, tempDir, testLogger } from './helpers.js';

/**
 * Install and git init are automatic, not a question.
 *
 * The interactive flow used to end with a "Setup" multiselect. It is gone: the
 * post steps run after the files are written unless `--no-install`, `--no-git`
 * or the config file turns them off, and each one says what it is doing as it
 * does it. Every spawned process is replaced here, so nothing is installed.
 */

const spawn = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; cwd: string; generated: boolean }[],
  /** Exit status per program; anything not listed succeeds. */
  status: {} as Record<string, number>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawnSync: (command: string, args: string[], options: { cwd: string }) => {
      spawn.calls.push({
        command,
        args,
        cwd: options.cwd,
        // Proof the files were written before the step ran.
        generated: existsSync(path.join(options.cwd, '.client-site.json')),
      });
      const status = spawn.status[command] ?? 0;
      return { status, stderr: status === 0 ? '' : `${command} exploded\nsecond line` };
    },
  };
});

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
/** Anything a spinner would leave behind: carriage returns, cursor moves, line clears. */
// eslint-disable-next-line no-control-regex
const CURSOR_CONTROL = /\r|\u001b\[[0-9;?]*[ABCDEFGHJKSTlh]/;

const cleanups: Array<() => void> = [];
beforeEach(() => {
  spawn.calls.length = 0;
  spawn.status = {};
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function scratch(): string {
  const { dir, cleanup } = tempDir('auto-setup');
  cleanups.push(cleanup);
  return dir;
}

async function create(
  cwd: string,
  argv: readonly string[],
  prompter?: Prompter,
): Promise<{ code: number; out: string; err: string; raw: string }> {
  const { logger, out, err } = testLogger();
  const code = await runCreate({
    flags: parseCliArgs([...argv]),
    logger,
    registry,
    cliVersion: '9.9.9',
    cwd,
    env: {},
    isTTY: prompter !== undefined,
    // Fixed, so the output does not depend on the runner: on Node 20 the
    // "template targets a newer Node" warning would join the progress lines.
    nodeVersion: '24.0.0',
    ...(prompter === undefined ? {} : { prompter }),
  });
  return { code, out: plain(out.text), err: plain(err.text), raw: out.text + err.text };
}

const programs = (): string[] => spawn.calls.map((call) => [call.command, ...call.args].join(' '));

// ---------------------------------------------------------------------------
// Starting mode
// ---------------------------------------------------------------------------

describe('Starting mode', () => {
  it('names both modes with what they are', () => {
    expect(startingModeOptions()).toEqual([
      {
        value: 'coming-soon',
        label: 'Coming Soon — Minimal launch page',
        hint: 'a single launch page you can put live today',
      },
      {
        value: 'full',
        label: 'Full Starter — Full application starter',
        hint: 'home page and sections, coming-soon route included',
      },
    ]);
  });

  it.each(['coming-soon', 'full'] as const)(
    'offers both, and %s reaches generation as the chosen mode',
    async (mode) => {
      const cwd = scratch();
      const prompter = new FakePrompter({
        dir: 'acme',
        mode,
        dimensions: { framework: 'react', styling: 'tailwind' },
      });
      const { code, out } = await create(cwd, [], prompter);

      expect(code).toBe(0);
      expect(prompter.modeOptions.map((option) => option.value)).toEqual(['coming-soon', 'full']);
      const record = JSON.parse(
        readFileSync(path.join(cwd, 'acme', '.client-site.json'), 'utf8'),
      ) as { mode: string };
      expect(record.mode).toBe(mode);
      // The summary says what the mode is, not only its id.
      const title = mode === 'full' ? 'Full Starter — Full application starter' : 'Coming Soon';
      expect(out).toMatch(new RegExp(`Mode\\s+${title}.*\\(${mode}\\)`));
    },
  );
});

// ---------------------------------------------------------------------------
// Setup is automatic
// ---------------------------------------------------------------------------

describe('setup', () => {
  it('is not a question any prompter can ask', () => {
    expect('setup' in ClackPrompter.prototype).toBe(false);
    expect('setup' in NonInteractivePrompter.prototype).toBe(false);
  });

  it('installs and initialises git after an interactive create, without asking', async () => {
    const cwd = scratch();
    const prompter = new FakePrompter({ dir: 'acme' });
    const { code } = await create(cwd, [], prompter);

    expect(code).toBe(0);
    expect(prompter.asked).not.toContain('setup');
    expect(programs()).toEqual(['npm install', 'git init --quiet']);
    for (const call of spawn.calls) {
      expect(call.cwd).toBe(path.join(cwd, 'acme'));
      expect(call.generated).toBe(true);
    }
  });

  it('does the same under --yes', async () => {
    const { code } = await create(scratch(), ['acme', '--yes']);
    expect(code).toBe(0);
    expect(programs()).toEqual(['npm install', 'git init --quiet']);
  });

  it.each(['pnpm', 'yarn', 'bun'] as const)(
    'installs with the resolved manager, %s',
    async (pm) => {
      const { err } = await create(scratch(), ['acme', '--yes', '--pm', pm]);
      expect(programs()).toEqual([`${pm} install`, 'git init --quiet']);
      expect(err).toContain(`Installing dependencies with ${pm}...`);
    },
  );

  it('keeps --no-install and --no-git as opt-outs', async () => {
    await create(scratch(), ['acme', '--yes', '--no-install']);
    expect(programs()).toEqual(['git init --quiet']);

    spawn.calls.length = 0;
    await create(scratch(), ['acme', '--yes', '--no-git']);
    expect(programs()).toEqual(['npm install']);

    spawn.calls.length = 0;
    const { err } = await create(scratch(), ['acme', '--yes', '--no-install', '--no-git']);
    expect(programs()).toEqual([]);
    expect(err).not.toContain('Installing');
    expect(err).not.toContain('Initializing');
  });

  it('runs nothing on a dry run', async () => {
    const cwd = scratch();
    const { out } = await create(cwd, ['acme', '--dry-run'], new FakePrompter());
    expect(programs()).toEqual([]);
    expect(existsSync(path.join(cwd, 'acme'))).toBe(false);
    expect(out).toMatch(/Post steps \(not run\)\n {2}npm install\n {2}git init --quiet/);
  });

  it('runs nothing when writing into a non-empty directory is declined', async () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'acme'));
    writeFileSync(path.join(cwd, 'acme', 'notes.txt'), 'mine');
    const { code, err } = await create(
      cwd,
      [],
      new FakePrompter({ dir: 'acme', confirmNonEmpty: false }),
    );
    expect(code).toBe(0);
    expect(err).toContain('Cancelled. Nothing was written.');
    expect(programs()).toEqual([]);
  });

  it('runs nothing when generation is refused', async () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'acme'));
    writeFileSync(path.join(cwd, 'acme', 'notes.txt'), 'mine');
    await expect(create(cwd, ['acme', '--yes'])).rejects.toThrow(/not empty/);
    expect(programs()).toEqual([]);
  });

  it('runs nothing when a prompt is cancelled', async () => {
    const prompter = new FakePrompter({ dir: 'acme', cancelAt: ['framework'] });
    await expect(create(scratch(), [], prompter)).rejects.toThrow();
    expect(programs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('progress', () => {
  it('says what it is doing, in order, once each', async () => {
    const { err } = await create(scratch(), ['acme', '--yes']);
    const lines = err.split('\n').filter((line) => line.trim() !== '');
    const expected = [
      'i Creating project files...',
      expect.stringMatching(/^\* Created \d+ files in acme$/),
      'i Installing dependencies with npm...',
      '* Dependencies installed',
      'i Initializing Git...',
      '* Git initialized',
    ];
    expect(lines).toEqual(expected);
  });

  it('reports a failed install in words, with the reason, and still initialises git', async () => {
    spawn.status = { npm: 1 };
    const { code, err, out } = await create(scratch(), ['acme', '--yes']);

    expect(code).toBe(0);
    expect(programs()).toEqual(['npm install', 'git init --quiet']);
    expect(err).toContain('x Failed to install dependencies\n  npm exploded\n');
    expect(err).toContain('The project was generated; finish this step yourself.');
    expect(err).not.toContain('Dependencies installed');
    expect(err).toContain('* Git initialized');
    // Next steps tell the person to install, with the manager that failed.
    expect(out).toMatch(/Next steps\n {2}cd acme\n {2}npm install\n {2}npm run dev/);
  });

  it('reports a Windows error without its carriage return', () => {
    const { logger, err } = testLogger();
    const context = makeContext();
    runPostSteps({
      context,
      logger,
      steps: ['install'],
      run: () => ({ status: 1, stderr: "'npm' is not recognized,\r\noperable program.\r\n" }),
      progress: postStepProgress(logger, context),
    });
    expect(plain(err.text)).toContain(
      "x Failed to install dependencies\n  'npm' is not recognized,\n",
    );
    expect(err.text).not.toContain('\r');
  });

  it('reports a failed git init in words', async () => {
    spawn.status = { git: 128 };
    const { err } = await create(scratch(), ['acme', '--yes']);
    expect(err).toContain('* Dependencies installed');
    expect(err).toContain('x Failed to initialize Git\n  git exploded\n');
  });

  it('writes no spinner or cursor control, so CI logs and pipes stay clean', async () => {
    spawn.status = { npm: 1 };
    const { raw } = await create(scratch(), ['acme', '--yes']);
    expect(raw).not.toMatch(CURSOR_CONTROL);
  });

  it('tells the reporter about each command as it starts and as it ends', () => {
    const events: string[] = [];
    const context = makeContext({ packageManager: 'pnpm' });
    const { logger } = testLogger();
    const progress = postStepProgress(logger, context);
    runPostSteps({
      context,
      logger,
      steps: ['install', 'git-init', 'format'],
      run: (command) => {
        events.push(`run ${command}`);
        return { status: 0, stderr: '' };
      },
      progress: {
        started: (step) => {
          events.push(`start ${step}`);
          progress.started(step);
        },
        finished: (result) => {
          events.push(`end ${result.step} ${result.status}`);
          progress.finished(result);
        },
      },
    });
    // `format` is inert, so it never starts.
    expect(events).toEqual([
      'start install',
      'run pnpm',
      'end install ok',
      'start git-init',
      'run git',
      'end git-init ok',
    ]);
  });
});
