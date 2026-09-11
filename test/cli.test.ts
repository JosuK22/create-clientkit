import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../src/args.js';
import { main, reportError } from '../src/cli.js';
import { CancelledError, CliError } from '../src/errors.js';
import { detectPackageManager } from '../src/util/pm.js';
import { MIN_NODE_VERSION, nodeVersionMessage, satisfiesMinimum } from '../src/util/node.js';
import { TEST_CWD, testLogger } from './helpers.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

describe('parseCliArgs', () => {
  it('parses the full flag surface', () => {
    const flags = parseCliArgs([
      'acme',
      '--template',
      'astro-tailwind',
      '--yes',
      '--from',
      'p.json',
      '--dry-run',
      '--no-git',
      '--no-install',
      '--pm',
      'pnpm',
      '--debug',
    ]);

    expect(flags.positionals).toEqual(['acme']);
    expect(flags.template).toBe('astro-tailwind');
    expect(flags.yes).toBe(true);
    expect(flags.from).toBe('p.json');
    expect(flags.dryRun).toBe(true);
    expect(flags.noGit).toBe(true);
    expect(flags.noInstall).toBe(true);
    expect(flags.pm).toBe('pnpm');
    expect(flags.debug).toBe(true);
  });

  it('supports short flags', () => {
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['-v']).version).toBe(true);
    expect(parseCliArgs(['-y']).yes).toBe(true);
    expect(parseCliArgs(['-t', 'x']).template).toBe('x');
  });

  it('rejects unknown flags with a usage exit code', () => {
    try {
      parseCliArgs(['--nope']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });

  it('rejects more than one positional', () => {
    expect(() => parseCliArgs(['a', 'b'])).toThrow(/at most one target directory/);
  });
});

describe('node version guard', () => {
  it('compares versions correctly', () => {
    expect(satisfiesMinimum('20.19.0')).toBe(true);
    expect(satisfiesMinimum('v22.15.0')).toBe(true);
    expect(satisfiesMinimum('21.0.0')).toBe(true);
    expect(satisfiesMinimum('20.18.9')).toBe(false);
    expect(satisfiesMinimum('18.20.0')).toBe(false);
  });

  it('produces a message naming both versions', () => {
    const message = nodeVersionMessage('18.20.0');
    expect(message).toContain('20.19.0');
    expect(message).toContain('18.20.0');
  });

  it('keeps bin/cli.js, util/node.ts and package.json engines in sync', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      engines: { node: string };
    };
    const bin = readFileSync(path.join(REPO_ROOT, 'bin', 'cli.js'), 'utf8');

    expect(MIN_NODE_VERSION).toBe('20.19.0');
    expect(pkg.engines.node).toBe('>=20.19');
    expect(bin).toContain("var MIN_NODE = '20.19.0'");
  });
});

describe('detectPackageManager', () => {
  it.each([
    ['npm/10.9.2 node/v22.15.0 win32 x64 workspaces/false', 'npm'],
    ['pnpm/9.1.0 npm/? node/v22.15.0 win32 x64', 'pnpm'],
    ['yarn/4.1.0 npm/? node/v22.15.0 darwin arm64', 'yarn'],
    ['bun/1.1.8 npm/? node/v22.15.0 linux x64', 'bun'],
  ])('detects %s', (agent, expected) => {
    expect(detectPackageManager(agent)).toBe(expected);
  });

  it('returns null when detection is impossible', () => {
    expect(detectPackageManager(undefined)).toBeNull();
    expect(detectPackageManager('')).toBeNull();
    expect(detectPackageManager('deno/2.0.0')).toBeNull();
  });
});

describe('main', () => {
  it('prints help and exits 0', async () => {
    const { logger, out } = testLogger();
    const code = await main(['--help'], { logger, cwd: TEST_CWD });

    expect(code).toBe(0);
    expect(out.text).toContain('create-clientkit');
    expect(out.text).toContain('--list-templates');
  });

  // 1.0.0 shipped with a leftover M1 note in --help saying "no files are
  // generated yet", which was true when generation was unimplemented and
  // false by M2. Nothing caught it: every gate checked that generation
  // worked, none checked that the help text still described reality.
  //
  // This guards the class, not the sentence - any help text that disclaims
  // being finished is a release blocker once the feature exists.
  it('does not claim in --help that generation is unimplemented', async () => {
    const { logger, out } = testLogger();
    await main(['--help'], { logger, cwd: TEST_CWD });

    const stale = [
      /no files are\s+generated/i,
      /not generated yet/i,
      /early build/i,
      /\bnot (?:yet )?implemented\b/i,
      /\bwork in progress\b/i,
      /\bplaceholder\b/i,
    ];

    for (const pattern of stale) {
      expect(
        pattern.test(out.text),
        `--help still carries an unimplemented-status claim matching ${pattern}`,
      ).toBe(false);
    }
  });

  it('documents the install and git defaults in --help', async () => {
    const { logger, out } = testLogger();
    await main(['--help'], { logger, cwd: TEST_CWD });

    expect(out.text).toMatch(/--no-install/);
    expect(out.text).toMatch(/--no-git/);
    expect(out.text).toMatch(/installed and a git repository is initialised/i);
  });

  it('prints the version and exits 0', async () => {
    const { logger, out } = testLogger();
    const code = await main(['--version'], { logger, cwd: TEST_CWD });

    expect(code).toBe(0);
    expect(out.text.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists the templates that ship with the package', async () => {
    const { logger, out } = testLogger();
    const code = await main(['--list-templates'], { logger, cwd: TEST_CWD });

    expect(code).toBe(0);
    expect(out.text).toContain('astro-tailwind');
  });

  it('fails cleanly on a non-TTY stdin without --yes instead of hanging', async () => {
    const { logger, err } = testLogger();
    const code = await main(['acme-website'], { logger, cwd: TEST_CWD, isTTY: false });

    expect(code).toBe(2);
    expect(err.text).toContain('not an interactive terminal');
    expect(err.text).toContain('--yes');
  });

  it('refuses an unsupported Node version before doing any work', async () => {
    const { logger, err } = testLogger();
    const code = await main(['acme-website', '--yes'], {
      logger,
      cwd: TEST_CWD,
      isTTY: false,
      nodeVersion: '18.20.0',
    });

    expect(code).toBe(1);
    expect(err.text).toContain('20.19.0');
  });

  it('resolves and prints a real file plan under --dry-run', async () => {
    const { logger, out } = testLogger();
    const code = await main(['acme-website', '--yes', '--dry-run'], {
      logger,
      cwd: TEST_CWD,
      isTTY: false,
      env: {},
    });

    expect(code).toBe(0);
    expect(out.text).toContain('DRY RUN');
    expect(out.text).toContain('acme-website');
    expect(out.text).toContain('coming-soon');
    expect(out.text).toContain('package.json');
    expect(out.text).toMatch(/Total: \d+ files/);
  });

  it('reports a missing --from file as a user error', async () => {
    const { logger, err } = testLogger();
    const code = await main(['acme-website', '--yes', '--from', 'missing.json'], {
      logger,
      cwd: TEST_CWD,
      isTTY: false,
    });

    expect(code).toBe(1);
    expect(err.text).toContain('Config file not found');
  });

  it('prints a hint instead of a stack trace without --debug', async () => {
    const { logger, err } = testLogger();
    await main(['--nope'], { logger, cwd: TEST_CWD, isTTY: false });

    expect(err.text).toContain('--help');
    expect(err.text).not.toContain('at Object');
  });
});

describe('flag combinations', () => {
  it('rejects --list-templates combined with a directory', async () => {
    const { logger, err } = testLogger();
    const code = await main(['--list-templates', 'acme-website'], { logger, cwd: TEST_CWD });

    expect(code).toBe(2);
    expect(err.text).toContain('cannot be combined');
  });

  it('rejects --list-templates combined with --from', async () => {
    const { logger, err } = testLogger();
    const code = await main(['--list-templates', '--from', 'p.json'], { logger, cwd: TEST_CWD });

    expect(code).toBe(2);
    expect(err.text).toContain('cannot be combined');
  });

  it('still answers --help even alongside a conflicting combination', async () => {
    const { logger, out } = testLogger();
    const code = await main(['--list-templates', 'acme', '--help'], { logger, cwd: TEST_CWD });

    expect(code).toBe(0);
    expect(out.text).toContain('Usage');
  });
});

describe('reportError', () => {
  it('maps a cancelled prompt to exit 130 with no stack trace', () => {
    const { logger, err } = testLogger();
    const code = reportError(new CancelledError(), logger);

    expect(code).toBe(130);
    expect(err.text).toContain('Cancelled');
    expect(err.text).not.toContain('at ');
  });

  it('reports an unexpected error as one sentence plus a --debug hint', () => {
    const { logger, err } = testLogger();
    const code = reportError(new TypeError('boom'), logger);

    expect(code).toBe(1);
    expect(err.text).toContain('Unexpected error: boom');
    expect(err.text).toContain('--debug');
    expect(err.text).not.toContain('at Object');
  });

  it('prints a stack trace when debug is enabled', () => {
    const { logger, err } = testLogger();
    logger.setDebug(true);
    reportError(new TypeError('boom'), logger);

    expect(err.text).toContain('debug');
  });

  it('honours the exit code carried by a CliError', () => {
    const { logger } = testLogger();
    expect(reportError(new CliError('nope', { exitCode: 2 }), logger)).toBe(2);
  });
});
