import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../src/args.js';
import { DEFAULTS, TEMPLATE_ID_PLACEHOLDER } from '../src/context/defaults.js';
import { NonInteractivePrompter } from '../src/context/prompts.js';
import { resolveContext, type ResolveOptions } from '../src/context/resolve.js';
import { CliError } from '../src/errors.js';
import { emptyRegistry } from '../src/templates/registry.js';
import type { ResolutionResult } from '../src/types.js';
import {
  FakePrompter,
  TEST_CWD,
  TEST_HOME,
  emptyFs,
  occupiedFs,
  type FakeAnswers,
} from './helpers.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

interface RunOptions {
  argv?: string[];
  answers?: FakeAnswers;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
  fs?: ResolveOptions['fs'];
}

/** Drives the resolver end to end without touching disk or stdin. */
async function run(options: RunOptions = {}): Promise<ResolutionResult & { asked: string[] }> {
  const flags = parseCliArgs(options.argv ?? []);
  const prompter =
    options.interactive === false
      ? new NonInteractivePrompter('test')
      : new FakePrompter(options.answers ?? {});

  const result = await resolveContext({
    flags,
    cwd: TEST_CWD,
    home: TEST_HOME,
    env: options.env ?? {},
    prompter,
    registry: emptyRegistry,
    cliVersion: '9.9.9',
    now: NOW,
    fs: options.fs ?? emptyFs,
    readFile: (filePath: string) => {
      const key = path.basename(filePath);
      const content = options.files?.[key];
      if (content === undefined) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    },
  });

  return {
    ...result,
    asked: prompter instanceof FakePrompter ? prompter.asked : [],
  };
}

describe('default resolution', () => {
  it('fills every unanswered field from the defaults module', async () => {
    const { context, sources } = await run({ argv: ['acme-website', '--yes'], interactive: false });

    expect(context.projectName).toBe('acme-website');
    expect(context.targetDir).toBe(path.resolve(TEST_CWD, 'acme-website'));
    expect(context.site.name).toBe('Acme Website');
    expect(context.site.url).toBeNull();
    expect(context.site.locale).toBe(DEFAULTS.locale);
    expect(context.site.author).toBeNull();
    expect(context.template.id).toBe(TEMPLATE_ID_PLACEHOLDER);
    expect(context.template.version).toBeNull();
    expect(context.template.mode).toBe(DEFAULTS.mode);
    expect(context.features).toEqual([]);
    expect(context.packageManager).toBe(DEFAULTS.packageManager);
    expect(context.install).toBe(DEFAULTS.install);
    expect(context.git).toBe(DEFAULTS.git);
    expect(context.cliVersion).toBe('9.9.9');
    expect(context.generatedAt).toBe(NOW.toISOString());
    expect(sources['site.url']).toBe('default');
  });

  it('never invents an author or a production URL', async () => {
    const { context } = await run({ argv: ['acme-website', '--yes'], interactive: false });
    expect(context.site.author).toBeNull();
    expect(context.site.url).toBeNull();
  });

  it('title-cases the directory name into a site name', async () => {
    const { context } = await run({ argv: ['acme-website', '--yes'], interactive: false });
    expect(context.site.name).toBe('Acme Website');
  });
});

describe('interactive flow', () => {
  it('skips the directory question when a positional is supplied', async () => {
    const { asked } = await run({ argv: ['acme-website'] });
    expect(asked).toEqual([
      'siteName',
      'url',
      'preset',
      'framework',
      'styling',
      'features',
      'mode',
      'setup',
    ]);
  });

  it('asks the client questions, then the stack, then the starter', async () => {
    /*
     * Stage 15 inserted the stack block. The four V1 questions are all still
     * asked, in the order they always were; `mode` and `setup` are still the
     * last two.
     *
     * Stage 17 added the preset question at the head of that block. The fake
     * answers it with the question's own default, which is "Custom" - so
     * nothing is seeded and every question below is asked exactly as before.
     *
     * What is *not* asked is the point. The default framework is Astro, which
     * fixes its build tool, language, router and architecture - so those are
     * derived rather than offered as a menu of one. A component library is not
     * asked either, and that one is decided by the compatibility engine rather
     * than by a rule here: MUI needs `react-runtime`, Astro does not provide
     * it, so `none` is the only survivor and a single survivor is a derivation.
     */
    const { asked } = await run({ answers: { dir: 'acme-website' } });
    expect(asked).toEqual([
      'dir',
      'siteName',
      'url',
      'preset',
      'framework',
      'styling',
      'features',
      'mode',
      'setup',
    ]);
  });

  it('uses the prompt answers', async () => {
    const { context, sources } = await run({
      answers: {
        dir: 'acme-website',
        siteName: 'Acme Ltd',
        url: 'https://acme.example/',
        mode: 'full',
        setup: { install: false, git: true },
      },
    });

    expect(context.site.name).toBe('Acme Ltd');
    expect(context.site.url).toBe('https://acme.example');
    expect(context.template.mode).toBe('full');
    expect(context.install).toBe(false);
    expect(context.git).toBe(true);
    expect(sources['site.name']).toBe('prompt');
    expect(sources['template.mode']).toBe('prompt');
  });

  it('treats a skipped URL answer as explicitly absent', async () => {
    const { context } = await run({ answers: { dir: 'acme-website', url: null } });
    expect(context.site.url).toBeNull();
  });
});

describe('precedence', () => {
  it('lets CLI flags beat the config file', async () => {
    const { context, sources } = await run({
      argv: ['acme-website', '--from', 'preset.json', '--pm', 'bun', '--no-git'],
      files: {
        'preset.json': JSON.stringify({ packageManager: 'yarn', git: true, install: true }),
      },
    });

    expect(context.packageManager).toBe('bun');
    expect(context.git).toBe(false);
    expect(sources['packageManager']).toBe('flag');
    expect(sources['git']).toBe('flag');
  });

  it('lets the config file beat prompts by never asking for supplied values', async () => {
    const { context, sources, asked } = await run({
      argv: ['acme-website', '--from', 'preset.json'],
      answers: { siteName: 'From Prompt', mode: 'full' },
      files: {
        'preset.json': JSON.stringify({
          site: { name: 'From File', url: 'https://file.example' },
          template: { mode: 'coming-soon' },
        }),
      },
    });

    expect(context.site.name).toBe('From File');
    expect(context.site.url).toBe('https://file.example');
    expect(context.template.mode).toBe('coming-soon');
    expect(sources['site.name']).toBe('file');
    expect(asked).not.toContain('siteName');
    expect(asked).not.toContain('mode');
  });

  it('lets prompts beat built-in defaults', async () => {
    const { context, sources } = await run({
      answers: { dir: 'acme-website', mode: 'full' },
    });
    expect(context.template.mode).toBe('full');
    expect(sources['template.mode']).toBe('prompt');
  });

  it('applies flags over prompt answers for setup', async () => {
    const { context, sources } = await run({
      argv: ['acme-website', '--no-install'],
      answers: { setup: { install: true, git: true } },
    });
    expect(context.install).toBe(false);
    expect(context.git).toBe(true);
    expect(sources['install']).toBe('flag');
    expect(sources['git']).toBe('prompt');
  });

  it('skips the setup question when both values are explicit', async () => {
    const { asked } = await run({ argv: ['acme-website', '--no-install', '--no-git'] });
    expect(asked).not.toContain('setup');
  });
});

describe('--yes', () => {
  it('never prompts', async () => {
    const { asked } = await run({ argv: ['acme-website', '--yes'], interactive: false });
    expect(asked).toEqual([]);
  });

  it('fails when no directory can be derived', async () => {
    await expect(run({ argv: ['--yes'], interactive: false })).rejects.toThrow(
      /No target directory/,
    );
  });

  it('still honours a directory supplied by the config file', async () => {
    const { context, sources } = await run({
      argv: ['--yes', '--from', 'preset.json'],
      interactive: false,
      files: { 'preset.json': JSON.stringify({ dir: 'acme-website' }) },
    });
    expect(context.projectName).toBe('acme-website');
    expect(sources['targetDir']).toBe('file');
  });
});

describe('package manager resolution', () => {
  it('detects from npm_config_user_agent', async () => {
    const { context, sources } = await run({
      argv: ['acme-website', '--yes'],
      interactive: false,
      env: { npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v22.15.0 win32 x64' },
    });
    expect(context.packageManager).toBe('pnpm');
    expect(sources['packageManager']).toBe('derived');
  });

  it('falls back to npm when detection fails', async () => {
    const { context, sources } = await run({
      argv: ['acme-website', '--yes'],
      interactive: false,
      env: { npm_config_user_agent: 'deno/2.0.0' },
    });
    expect(context.packageManager).toBe('npm');
    expect(sources['packageManager']).toBe('default');
  });

  it('rejects an invalid --pm override', async () => {
    await expect(run({ argv: ['acme-website', '--pm', 'deno'] })).rejects.toThrow(
      /Unknown package manager/,
    );
  });
});

describe('invalid configuration', () => {
  it('rejects an invalid project name from the positional', async () => {
    await expect(run({ argv: ['Acme Website'] })).rejects.toThrow(/Invalid target directory/);
  });

  it('resolves a non-empty target directory instead of refusing it', async () => {
    // Directory policy belongs to the command layer, which knows whether it can
    // ask the developer to confirm a merge. The resolver only produces the
    // context. The refusal itself is covered in test/generate.test.ts.
    const { context } = await run({
      argv: ['acme-website', '--yes'],
      interactive: false,
      fs: occupiedFs(['index.html']),
    });
    expect(context.projectName).toBe('acme-website');
  });

  it('still refuses a filesystem root outright', async () => {
    await expect(run({ argv: ['/'], interactive: false })).rejects.toThrow(
      /Refusing to scaffold into a filesystem root/,
    );
  });

  it('rejects a malformed URL from the config file', async () => {
    await expect(
      run({
        argv: ['acme-website', '--from', 'preset.json'],
        files: { 'preset.json': JSON.stringify({ site: { url: 'not-a-url' } }) },
      }),
    ).rejects.toThrow(/site.url/);
  });

  it('rejects an unknown template because the registry is empty', async () => {
    await expect(run({ argv: ['acme-website', '--template', 'nextjs'] })).rejects.toThrow(
      /Unknown template/,
    );
  });

  it('rejects --list-templates combined with a directory', async () => {
    await expect(run({ argv: ['acme-website', '--list-templates'] })).rejects.toThrow(
      /cannot be combined/,
    );
  });

  it('reports failures as CliError, not as a crash', async () => {
    await expect(run({ argv: ['acme-website', '--pm', 'deno'] })).rejects.toBeInstanceOf(CliError);
  });
});

describe('ProjectContext immutability', () => {
  it('is frozen at every level', async () => {
    const { context } = await run({ argv: ['acme-website', '--yes'], interactive: false });

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.site)).toBe(true);
    expect(Object.isFrozen(context.template)).toBe(true);
    expect(Object.isFrozen(context.features)).toBe(true);
  });

  it('silently ignores or throws on mutation attempts', async () => {
    const { context } = await run({ argv: ['acme-website', '--yes'], interactive: false });
    const mutable = context as unknown as Record<string, unknown>;

    expect(() => {
      'use strict';
      mutable['projectName'] = 'hacked';
    }).toThrow();
    expect(context.projectName).toBe('acme-website');
  });
});

describe('--name / --url / --mode (M1 flag parity)', () => {
  it('--name sets the site name', async () => {
    const { context, sources } = await run({ argv: ['acme-website', '--name', 'Acme Ltd'] });
    expect(context.site.name).toBe('Acme Ltd');
    expect(sources['site.name']).toBe('flag');
  });

  it('--url sets and normalises the production URL', async () => {
    const { context, sources } = await run({
      argv: ['acme-website', '--url', 'https://acme.example/'],
    });
    expect(context.site.url).toBe('https://acme.example');
    expect(sources['site.url']).toBe('flag');
  });

  it('--mode sets the mode', async () => {
    const { context, sources } = await run({ argv: ['acme-website', '--mode', 'full'] });
    expect(context.template.mode).toBe('full');
    expect(sources['template.mode']).toBe('flag');
  });

  it('-m is a short alias for --mode', async () => {
    const { context } = await run({ argv: ['acme-website', '-m', 'full'] });
    expect(context.template.mode).toBe('full');
  });

  it('all three suppress their prompts', async () => {
    const { asked } = await run({
      argv: ['acme-website', '--name', 'Acme', '--url', 'https://acme.example', '--mode', 'full'],
    });
    // The stack is still unanswered, so it is still asked; the three V1 values
    // are not.
    expect(asked).toEqual(['preset', 'framework', 'styling', 'features', 'setup']);
  });

  it('--name overrides the site name from --from', async () => {
    const { context, sources } = await run({
      argv: ['acme-website', '--from', 'preset.json', '--name', 'From Flag'],
      files: { 'preset.json': JSON.stringify({ site: { name: 'From File' } }) },
    });
    expect(context.site.name).toBe('From Flag');
    expect(sources['site.name']).toBe('flag');
  });

  it('--url overrides the site URL from --from', async () => {
    const { context, sources } = await run({
      argv: ['acme-website', '--from', 'preset.json', '--url', 'https://flag.example'],
      files: { 'preset.json': JSON.stringify({ site: { url: 'https://file.example' } }) },
    });
    expect(context.site.url).toBe('https://flag.example');
    expect(sources['site.url']).toBe('flag');
  });

  it('--mode overrides the mode from --from', async () => {
    const { context, sources } = await run({
      argv: ['acme-website', '--from', 'preset.json', '--mode', 'full'],
      files: { 'preset.json': JSON.stringify({ template: { mode: 'coming-soon' } }) },
    });
    expect(context.template.mode).toBe('full');
    expect(sources['template.mode']).toBe('flag');
  });

  it('an empty --url means "no production URL", not "unset"', async () => {
    const { context, sources } = await run({
      argv: ['acme-website', '--from', 'preset.json', '--url', ''],
      files: { 'preset.json': JSON.stringify({ site: { url: 'https://file.example' } }) },
    });
    expect(context.site.url).toBeNull();
    expect(sources['site.url']).toBe('flag');
  });

  it('validates --name through the shared validator', async () => {
    await expect(run({ argv: ['acme-website', '--name', '   '] })).rejects.toThrow(
      /Invalid --name/,
    );
  });

  it('validates --url through the shared validator', async () => {
    await expect(run({ argv: ['acme-website', '--url', 'not-a-url'] })).rejects.toThrow(
      /Invalid --url/,
    );
    await expect(run({ argv: ['acme-website', '--url', 'ftp://acme.example'] })).rejects.toThrow(
      /Invalid --url/,
    );
  });

  it('rejects an unknown --mode', async () => {
    await expect(run({ argv: ['acme-website', '--mode', 'landing'] })).rejects.toThrow(
      /Unknown mode "landing"/,
    );
  });

  it('makes a fully non-interactive run possible without --from', async () => {
    const { context, asked } = await run({
      argv: [
        'acme-website',
        '--yes',
        '--name',
        'Acme Ltd',
        '--url',
        'https://acme.example',
        '--mode',
        'full',
        '--no-git',
        '--no-install',
      ],
      interactive: false,
    });
    expect(asked).toEqual([]);
    expect(context.site.name).toBe('Acme Ltd');
    expect(context.site.url).toBe('https://acme.example');
    expect(context.template.mode).toBe('full');
    expect(context.git).toBe(false);
    expect(context.install).toBe(false);
  });
});
