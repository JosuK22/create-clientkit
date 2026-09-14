import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { loadConfigFile } from '../src/context/fromFile.js';
import { NonInteractivePrompter, type Prompter } from '../src/context/prompts.js';
import { resolveContext } from '../src/context/resolve.js';
import { manifestFromProjectContext } from '../src/domain/manifest.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { emptyFs, FakePrompter, renderPlan, tempDir, testLogger, TEST_CWD } from './helpers.js';
import type { FakeAnswers } from './helpers.js';

/**
 * A configuration file as the third way to describe the same project.
 *
 * Stage 14 gave the dimensions flags and Stage 15 gave them questions; this
 * gives them a file. The claim is the same one both earlier stages made and is
 * the only reason a third input mechanism is safe to add: whatever route a
 * value takes, it becomes a string in the same `DimensionInput`, is normalised
 * by the same `resolveDimensions`, and is assembled by the same `manifestFrom`.
 *
 * So the load-bearing tests here are the three-way equivalence ones. A file, a
 * set of flags and a set of answers describing one stack must produce one
 * manifest and one generation plan - and if they ever stop doing so, it should
 * be these that say so rather than a user.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);

const source = (relative: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');

const base = (
  argv: readonly string[],
  file: unknown,
  prompter: Prompter = new NonInteractivePrompter('t'),
) =>
  resolveContext({
    flags: parseCliArgs([...argv]),
    cwd: TEST_CWD,
    env: {},
    prompter,
    registry,
    cliVersion: '9.9.9',
    now: new Date('2026-01-01T00:00:00.000Z'),
    templatesRoot: TEMPLATES_ROOT,
    fs: emptyFs,
    readFile: () => JSON.stringify(file),
  });

/** Resolves from a config file, non-interactively, as `--yes` drives it. */
const fromConfig = (file: unknown, argv: readonly string[] = []) =>
  base(['acme-site', '--yes', '--from', 'clientkit.json', ...argv], file);

/** The same, but with a scripted user for the partial-configuration tests. */
const fromConfigInteractive = (file: unknown, answers: FakeAnswers = {}, argv: string[] = []) => {
  const prompter = new FakePrompter({ dir: 'acme-site', ...answers });
  return base(['acme-site', '--from', 'clientkit.json', ...argv], file, prompter).then(
    (resolution) => ({ ...resolution, asked: prompter.asked }),
  );
};

/** Resolves from flags alone, with no file in play. */
const fromFlags = (argv: readonly string[]) =>
  resolveContext({
    flags: parseCliArgs(['acme-site', '--yes', ...argv]),
    cwd: TEST_CWD,
    env: {},
    prompter: new NonInteractivePrompter('t'),
    registry,
    cliVersion: '9.9.9',
    now: new Date('2026-01-01T00:00:00.000Z'),
    templatesRoot: TEMPLATES_ROOT,
    fs: emptyFs,
  });

/** Resolves from answers alone. */
const fromAnswers = (answers: FakeAnswers) =>
  resolveContext({
    flags: parseCliArgs(['acme-site']),
    cwd: TEST_CWD,
    env: {},
    prompter: new FakePrompter({ dir: 'acme-site', ...answers }),
    registry,
    cliVersion: '9.9.9',
    now: new Date('2026-01-01T00:00:00.000Z'),
    templatesRoot: TEMPLATES_ROOT,
    fs: emptyFs,
  });

const failure = async (file: unknown, argv: readonly string[] = []): Promise<CliError> => {
  try {
    await fromConfig(file, argv);
  } catch (error) {
    expect(error, 'expected a CliError').toBeInstanceOf(CliError);
    return error as CliError;
  }
  return expect.unreachable('the configuration was accepted');
};

const textOf = (error: CliError): string => `${error.message}\n${error.hint ?? ''}`;

const load = (file: unknown) =>
  loadConfigFile('clientkit.json', { cwd: TEST_CWD, readFile: () => JSON.stringify(file) });

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('a configuration written before this stage still works', () => {
  it('a template-only file resolves the V1 stack', async () => {
    const { context, manifest } = await fromConfig({ template: { id: 'astro-tailwind' } });
    expect(context.template.id).toBe('astro-tailwind');
    expect(manifest).toEqual(manifestFromProjectContext(context));
  });

  it('every V1 field is still read', async () => {
    const { context } = await fromConfig({
      site: { name: 'Acme Ltd', url: 'https://acme.example', locale: 'en-GB' },
      template: { mode: 'full' },
      packageManager: 'pnpm',
      git: false,
      install: false,
    });
    expect(context.site.name).toBe('Acme Ltd');
    expect(context.site.url).toBe('https://acme.example');
    expect(context.site.locale).toBe('en-GB');
    expect(context.template.mode).toBe('full');
    expect(context.packageManager).toBe('pnpm');
    expect(context.git).toBe(false);
    expect(context.install).toBe(false);
  });

  it('a file with no stack block contributes no dimensions', () => {
    expect(load({ site: { name: 'Acme' } }).stack).toEqual({});
  });

  it('an empty file is still an empty file', () => {
    expect(load({})).toEqual({ context: {}, stack: {} });
  });
});

// ---------------------------------------------------------------------------
// The stack block
// ---------------------------------------------------------------------------

describe('the stack block carries every dimension', () => {
  const FULL = {
    stack: {
      framework: 'react',
      buildTool: 'vite',
      language: 'typescript',
      styling: 'tailwind',
      uiLibrary: 'mui',
      router: 'react-router',
      architecture: 'react-standard',
      features: ['client-route-fallback'],
    },
  };

  it('resolves a fully specified stack with no prompting at all', async () => {
    const { manifest } = await fromConfig(FULL);
    expect(manifest).toMatchObject({
      framework: 'react',
      buildTool: 'vite',
      language: 'ts',
      styling: 'tailwind',
      uiLibrary: 'mui',
      router: 'react-router',
      architecture: 'react-standard',
      features: ['starter:coming-soon', 'client-route-fallback'],
    });
  });

  it('normalises through the shared parser, not a second one', async () => {
    // `typescript` is the long spelling the flag layer accepts; the manifest
    // carries `ts`. That translation exists once, and the file gets it for
    // free by handing over a raw string.
    expect((await fromConfig(FULL)).manifest.language).toBe('ts');
  });

  it('reads each dimension on its own', async () => {
    const cases: readonly [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['framework', { framework: 'react' }, { framework: 'react' }],
      ['buildTool', { framework: 'react', buildTool: 'vite' }, { buildTool: 'vite' }],
      ['language', { framework: 'react', language: 'ts' }, { language: 'ts' }],
      ['styling', { styling: 'none' }, { styling: 'none' }],
      ['uiLibrary', { framework: 'react', uiLibrary: 'mui' }, { uiLibrary: 'mui' }],
      ['router', { framework: 'react', router: 'react-router' }, { router: 'react-router' }],
      [
        'architecture',
        { framework: 'react', architecture: 'react-standard' },
        { architecture: 'react-standard' },
      ],
    ];
    for (const [name, stack, expected] of cases) {
      const { manifest } = await fromConfig({ stack });
      expect(manifest, name).toMatchObject(expected);
    }
  });

  it('leaves the framework to supply what the file did not', async () => {
    const { manifest } = await fromConfig({ stack: { framework: 'react' } });
    expect(manifest).toMatchObject({
      buildTool: 'vite',
      language: 'ts',
      router: 'none',
      architecture: 'react-standard',
      // Not framework-owned, so these come from the same defaults a bare
      // invocation uses - there is no config-file default anywhere.
      styling: 'tailwind',
      uiLibrary: 'none',
    });
  });

  it('keeps the stack out of the V1 half', () => {
    // The two halves are consumed by different layers and must not leak into
    // each other: a dimension in `context` would rejoin the V1 precedence
    // chain, where nothing would normalise it.
    const loaded = load(FULL);
    expect(Object.keys(loaded.context)).toEqual([]);
    expect(loaded.stack).toEqual(FULL.stack);
  });
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

describe('features in a configuration file', () => {
  it('takes one', async () => {
    const { manifest } = await fromConfig({ stack: { features: ['seo'] } });
    expect(manifest.features).toEqual(['starter:coming-soon', 'seo']);
  });

  it('takes several', async () => {
    const { manifest } = await fromConfig({
      stack: { features: ['seo', 'structured-data', 'accessibility'] },
    });
    expect(manifest.features).toEqual([
      'starter:coming-soon',
      'accessibility',
      'seo',
      'structured-data',
    ]);
  });

  it('sorts them, so two orderings are one request', async () => {
    const forwards = await fromConfig({ stack: { features: ['seo', 'accessibility'] } });
    const backwards = await fromConfig({ stack: { features: ['accessibility', 'seo'] } });
    expect(forwards.manifest.features).toEqual(backwards.manifest.features);
  });

  it('treats an empty array as no features', async () => {
    const { manifest } = await fromConfig({ stack: { features: [] } });
    expect(manifest.features).toEqual(['starter:coming-soon']);
  });

  it('rejects a duplicate, the same way the flag does', async () => {
    const error = await failure({ stack: { features: ['seo', 'seo'] } });
    expect(error.message).toContain('more than once');
    // ...but says so in the file's vocabulary rather than a flag the user
    // never typed.
    expect(error.message).toContain('stack.features');
    expect(error.message).not.toContain('--features');
  });

  it('rejects an unknown feature', async () => {
    expect(textOf(await failure({ stack: { features: ['telepathy'] } }))).toContain(
      'Unknown feature "telepathy"',
    );
  });

  it('rejects a starter, because the mode field owns that', async () => {
    expect(textOf(await failure({ stack: { features: ['starter:full'] } }))).toContain('--mode');
  });

  it('refuses the comma syntax, so there is only one way to write a list', () => {
    // `["seo,accessibility"]` would otherwise work by accident, because the
    // shared parser splits on commas.
    expect(() => load({ stack: { features: ['seo,accessibility'] } })).toThrow(/contains a comma/);
  });
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('a flag beats the file, per dimension', () => {
  it('an explicit flag wins', async () => {
    const { manifest } = await fromConfig({ stack: { framework: 'react', styling: 'tailwind' } }, [
      '--styling',
      'bootstrap',
    ]);
    expect(manifest.styling).toBe('bootstrap');
    expect(manifest.framework).toBe('react');
  });

  it('and the rest of the file still applies', async () => {
    const { manifest } = await fromConfig(
      { stack: { framework: 'react', router: 'react-router', uiLibrary: 'mui' } },
      ['--ui-library', 'none'],
    );
    expect(manifest).toMatchObject({
      framework: 'react',
      router: 'react-router',
      uiLibrary: 'none',
    });
  });

  it('a feature flag replaces the file list rather than merging with it', async () => {
    // Merging would make it impossible to *remove* a feature a shared file
    // sets, which is the thing an override is for.
    const { manifest } = await fromConfig({ stack: { features: ['seo'] } }, [
      '--features',
      'accessibility',
    ]);
    expect(manifest.features).toEqual(['starter:coming-soon', 'accessibility']);
  });

  it('records which source each dimension came from', async () => {
    const { stack } = await fromConfig({ stack: { framework: 'react', styling: 'tailwind' } }, [
      '--styling',
      'bootstrap',
    ]);
    expect(stack['framework']).toBe('file');
    expect(stack['styling']).toBe('flag');
  });

  it('attributes a dimension nobody stated to whoever derived it', async () => {
    const { stack } = await fromConfig({ stack: { framework: 'react' } });
    expect(stack['framework']).toBe('file');
    // No framework owns the component library, so this is a built-in default
    // rather than the adapter speaking.
    expect(stack['uiLibrary']).toBe('default');
    expect(stack['buildTool']).toBe('adapter');
  });
});

// ---------------------------------------------------------------------------
// Partial configuration
// ---------------------------------------------------------------------------

describe('a partial configuration is completed the usual way', () => {
  it('asks only for what the file left out', async () => {
    const { asked, manifest } = await fromConfigInteractive({ stack: { framework: 'react' } });
    expect(asked).not.toContain('framework');
    expect(asked).toContain('styling');
    expect(asked).toContain('router');
    expect(manifest.framework).toBe('react');
  });

  it('an answer fills a dimension the file omitted', async () => {
    const { manifest } = await fromConfigInteractive(
      { stack: { framework: 'react' } },
      { dimensions: { styling: 'bootstrap', router: 'react-router' } },
    );
    expect(manifest).toMatchObject({
      framework: 'react',
      styling: 'bootstrap',
      router: 'react-router',
    });
  });

  it('a fully specified file asks nothing about the stack', async () => {
    const { asked } = await fromConfigInteractive({
      stack: {
        framework: 'react',
        styling: 'bootstrap',
        uiLibrary: 'none',
        router: 'react-router',
        features: ['client-route-fallback'],
      },
    });
    for (const dimension of ['framework', 'styling', 'uiLibrary', 'router', 'features']) {
      expect(asked, `${dimension} was asked though the file supplied it`).not.toContain(dimension);
    }
  });

  it('--yes with a full file needs no prompter at all', async () => {
    // A `NonInteractivePrompter` throws on any question, so reaching a
    // manifest is the assertion.
    const { manifest } = await fromConfig({
      stack: { framework: 'react', styling: 'bootstrap', router: 'react-router' },
    });
    expect(manifest.framework).toBe('react');
  });
});

// ---------------------------------------------------------------------------
// Unknown and unimplemented
// ---------------------------------------------------------------------------

describe('a value the file cannot have', () => {
  const cases: readonly { stack: Record<string, unknown>; word: string }[] = [
    { stack: { framework: 'vue' }, word: 'Unknown framework "vue"' },
    { stack: { framework: 'react', buildTool: 'webpack' }, word: 'Unknown build tool "webpack"' },
    { stack: { framework: 'react', language: 'rust' }, word: 'Unknown language "rust"' },
    { stack: { styling: 'whatever' }, word: 'Unknown styling system "whatever"' },
    { stack: { uiLibrary: 'nope' }, word: 'Unknown UI library "nope"' },
    { stack: { router: 'next-router' }, word: 'Unknown router "next-router"' },
    { stack: { architecture: 'nonsense' }, word: 'Unknown architecture "nonsense"' },
    { stack: { features: ['telepathy'] }, word: 'Unknown feature "telepathy"' },
  ];

  for (const entry of cases) {
    it(`refuses ${JSON.stringify(entry.stack)}`, async () => {
      expect((await failure({ stack: entry.stack })).message).toContain(entry.word);
    });
  }

  it('reports a known id with no adapter as unimplemented, not unknown', async () => {
    const error = await failure({ stack: { framework: 'nextjs' } });
    expect(error.message).toContain('does not support framework "nextjs" yet');
    expect(error.hint).toContain('no adapter implements it');
  });

  it('reports chakra through the registry too', async () => {
    const { manifest } = await fromConfig({ stack: { framework: 'react', uiLibrary: 'chakra' } });
    // The registry refuses at selection, exactly as it does for the flag.
    expect(() =>
      planManifest(manifest, {
        registry,
        cliVersion: '9.9.9',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode: 'coming-soon',
      }),
    ).toThrow(CliError);
  });
});

// ---------------------------------------------------------------------------
// Schema errors, which are this layer's own
// ---------------------------------------------------------------------------

describe('the file is checked for shape, and only for shape', () => {
  it('rejects an unknown key inside the stack', () => {
    expect(() => load({ stack: { frameWork: 'react' } })).toThrow(/Unknown key "frameWork"/);
  });

  it('rejects a stack that is not an object', () => {
    expect(() => load({ stack: 'react' })).toThrow(/"stack" must be an object/);
  });

  it('rejects a dimension that is not a string', () => {
    expect(() => load({ stack: { framework: { name: 'react' } } })).toThrow(
      /"stack.framework" must be a string/,
    );
  });

  it('rejects features that are not an array', () => {
    expect(() => load({ stack: { features: 'seo' } })).toThrow(/"stack.features" must be an array/);
  });

  it('rejects a non-string inside features, naming the index', () => {
    expect(() => load({ stack: { features: ['seo', 7] } })).toThrow(/"stack.features\[1\]"/);
  });

  it('leaves the domain questions to the domain', () => {
    // Loading succeeds; the vocabulary refuses later. Keeping these apart is
    // what stops the parser from growing a copy of the registry.
    expect(() => load({ stack: { framework: 'vue' } })).not.toThrow();
    expect(load({ stack: { framework: 'vue' } }).stack.framework).toBe('vue');
  });
});

// ---------------------------------------------------------------------------
// Compatibility and the template policy
// ---------------------------------------------------------------------------

describe('the file does not get its own rules', () => {
  it('React + seo fails through the compatibility engine', async () => {
    const { manifest } = await fromConfig({ stack: { framework: 'react', features: ['seo'] } });
    let error: CliError | undefined;
    try {
      planManifest(manifest, {
        registry,
        cliVersion: '9.9.9',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode: 'coming-soon',
      });
    } catch (thrown) {
      error = thrown as CliError;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(textOf(error as CliError)).toContain('document-metadata');
  });

  it('and fails for the same reason the equivalent flags do', async () => {
    const viaFile = await fromConfig({ stack: { framework: 'react', features: ['seo'] } });
    const viaFlags = await fromFlags(['--framework', 'react', '--features', 'seo']);
    expect(viaFile.manifest).toEqual(viaFlags.manifest);
  });

  it('a template and a stack in one file is refused', async () => {
    const error = await failure({
      template: { id: 'astro-tailwind' },
      stack: { framework: 'react' },
    });
    expect(error.message).toContain('both name what to build');
  });

  it('refused even when the two agree', async () => {
    await failure({ template: { id: 'astro-tailwind' }, stack: { framework: 'astro' } });
  });

  it('--template with a file stack is refused too', async () => {
    const error = await failure({ stack: { framework: 'react' } }, [
      '--template',
      'astro-tailwind',
    ]);
    expect(error.message).toContain('both name what to build');
  });

  it('a template-only file with a dimension flag is still refused', async () => {
    const error = await failure({ template: { id: 'astro-tailwind' } }, ['--framework', 'react']);
    expect(error.message).toContain('both name what to build');
  });
});

// ---------------------------------------------------------------------------
// The equivalence this stage exists to guarantee
// ---------------------------------------------------------------------------

describe('flags, answers and a file describe one project', () => {
  const cases: readonly {
    name: string;
    file: Record<string, unknown>;
    flags: readonly string[];
    answers: FakeAnswers;
  }[] = [
    {
      name: 'Astro + Tailwind',
      file: { stack: { framework: 'astro', styling: 'tailwind' } },
      flags: ['--framework', 'astro', '--styling', 'tailwind'],
      answers: { dimensions: { framework: 'astro', styling: 'tailwind' } },
    },
    {
      name: 'React + Tailwind',
      file: { stack: { framework: 'react', styling: 'tailwind', router: 'none' } },
      flags: ['--framework', 'react', '--styling', 'tailwind', '--router', 'none'],
      answers: {
        dimensions: { framework: 'react', styling: 'tailwind', router: 'none', uiLibrary: 'none' },
      },
    },
    {
      name: 'React + Bootstrap',
      file: { stack: { framework: 'react', styling: 'bootstrap', router: 'none' } },
      flags: ['--framework', 'react', '--styling', 'bootstrap', '--router', 'none'],
      answers: {
        dimensions: { framework: 'react', styling: 'bootstrap', router: 'none', uiLibrary: 'none' },
      },
    },
    {
      name: 'React + MUI',
      file: {
        stack: { framework: 'react', styling: 'tailwind', uiLibrary: 'mui', router: 'none' },
      },
      flags: [
        '--framework',
        'react',
        '--styling',
        'tailwind',
        '--ui-library',
        'mui',
        '--router',
        'none',
      ],
      answers: {
        dimensions: { framework: 'react', styling: 'tailwind', uiLibrary: 'mui', router: 'none' },
      },
    },
    {
      name: 'React + React Router',
      file: { stack: { framework: 'react', styling: 'tailwind', router: 'react-router' } },
      flags: ['--framework', 'react', '--styling', 'tailwind', '--router', 'react-router'],
      answers: {
        dimensions: {
          framework: 'react',
          styling: 'tailwind',
          uiLibrary: 'none',
          router: 'react-router',
        },
      },
    },
    {
      name: 'React + client-route-fallback',
      file: {
        stack: {
          framework: 'react',
          styling: 'tailwind',
          router: 'react-router',
          features: ['client-route-fallback'],
        },
      },
      flags: [
        '--framework',
        'react',
        '--styling',
        'tailwind',
        '--router',
        'react-router',
        '--features',
        'client-route-fallback',
      ],
      answers: {
        dimensions: {
          framework: 'react',
          styling: 'tailwind',
          uiLibrary: 'none',
          router: 'react-router',
        },
        features: ['client-route-fallback'],
      },
    },
    {
      name: 'Astro + seo + structured-data + accessibility',
      file: {
        stack: {
          framework: 'astro',
          styling: 'tailwind',
          features: ['seo', 'structured-data', 'accessibility'],
        },
      },
      flags: ['--features', 'seo,structured-data,accessibility'],
      answers: {
        dimensions: { framework: 'astro', styling: 'tailwind' },
        features: ['seo', 'structured-data', 'accessibility'],
      },
    },
  ];

  const plan = (resolution: Awaited<ReturnType<typeof fromFlags>>) =>
    renderPlan(
      planManifest(resolution.manifest, {
        registry,
        cliVersion: '9.9.9',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode: resolution.context.template.mode,
        templateId: resolution.context.template.id,
      }).plan,
      TEMPLATES_ROOT,
    );

  for (const entry of cases) {
    it(`${entry.name}: one manifest from three inputs`, async () => {
      const viaFlags = await fromFlags(entry.flags);
      const viaAnswers = await fromAnswers(entry.answers);
      const viaFile = await fromConfig(entry.file);

      expect(viaAnswers.manifest, 'answers != flags').toEqual(viaFlags.manifest);
      expect(viaFile.manifest, 'file != answers').toEqual(viaAnswers.manifest);
    });

    it(`${entry.name}: one generation plan from three inputs`, async () => {
      const viaFlags = await fromFlags(entry.flags);
      const viaAnswers = await fromAnswers(entry.answers);
      const viaFile = await fromConfig(entry.file);

      expect(plan(viaAnswers)).toBe(plan(viaFlags));
      expect(plan(viaFile)).toBe(plan(viaAnswers));
    });
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const FILE = {
    stack: {
      framework: 'react',
      styling: 'bootstrap',
      router: 'react-router',
      features: ['client-route-fallback'],
    },
  };

  it('the same file resolves identically twice', async () => {
    const first = await fromConfig(FILE);
    const second = await fromConfig(FILE);
    expect(JSON.stringify(first.manifest)).toBe(JSON.stringify(second.manifest));
  });

  it('key order in the JSON does not matter', async () => {
    const reordered = {
      stack: {
        features: ['client-route-fallback'],
        router: 'react-router',
        styling: 'bootstrap',
        framework: 'react',
      },
    };
    expect((await fromConfig(reordered)).manifest).toEqual((await fromConfig(FILE)).manifest);
  });

  it('feature order in the JSON does not matter', async () => {
    const a = await fromConfig({ stack: { features: ['accessibility', 'seo'] } });
    const b = await fromConfig({ stack: { features: ['seo', 'accessibility'] } });
    expect(a.manifest.features).toEqual(b.manifest.features);
  });
});

// ---------------------------------------------------------------------------
// Structural: the loader is a loader
// ---------------------------------------------------------------------------

describe('the configuration layer holds no engine of its own', () => {
  const loader = source('src/context/fromFile.ts');
  const code = loader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('reads a file and nothing else', () => {
    // `readFileSync` is the point of the module; anything that writes, spawns
    // or fetches is not.
    expect(code).toContain('readFileSync');
    for (const forbidden of [
      'writeFileSync',
      'mkdirSync',
      'rmSync',
      'node:child_process',
      'execSync',
      'spawn',
      'fetch(',
      'import(',
      'require(',
      'eval(',
    ]) {
      expect(code, `the loader uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('generates nothing and composes nothing', () => {
    for (const forbidden of ['FileOperation', 'apply(', 'planManifest', 'composePackage']) {
      expect(loader, `the loader references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('branches on no framework id', () => {
    for (const name of ['astro', 'react', 'nextjs', 'angular']) {
      expect(code.includes(`=== '${name}'`), `fromFile.ts branches on ${name}`).toBe(false);
    }
  });

  it('names no capability, because it evaluates none', () => {
    for (const capability of [
      'document-metadata',
      'file-based-routing',
      'client-side-routing',
      'react-runtime',
      'composed-stylesheet',
    ]) {
      expect(code, `fromFile.ts mentions ${capability}`).not.toContain(capability);
    }
  });

  it('hard-codes no adapter id', () => {
    for (const id of ['mui', 'bootstrap', 'react-router', 'tailwind', 'seo', 'vite']) {
      expect(code, `fromFile.ts hard-codes ${id}`).not.toContain(`'${id}'`);
    }
  });

  it('cannot describe file operations', () => {
    // A `files` key would turn a configuration file into a build script.
    expect(() => load({ files: [{ path: 'x', content: 'y' }] })).toThrow(/Unknown key "files"/);
    expect(() => load({ stack: { files: [] } })).toThrow(/Unknown key "files"/);
  });

  it('cannot name a template path or an adapter internal', () => {
    expect(() => load({ stack: { templatePath: '/tmp/evil' } })).toThrow(/Unknown key/);
    expect(() => load({ adapters: ['react'] })).toThrow(/Unknown key "adapters"/);
  });
});

// ---------------------------------------------------------------------------
// Through the command
// ---------------------------------------------------------------------------

describe('the create command reads the configuration', () => {
  /*
   * A real file on a real disk, because the command has no injection seam for
   * reading one - and that is exactly what needs proving. A configuration that
   * reaches the resolver in a unit test says nothing about whether the command
   * passes `--from` along at all. Stage 14 learned that the hard way: a
   * mutation that hard-coded the manifest inside `runCreate` passed the whole
   * suite, because nothing drove the command.
   */
  const create = async (file: unknown, argv: readonly string[] = []) => {
    const { dir, cleanup } = tempDir('config');
    try {
      const configPath = path.join(dir, 'clientkit.json');
      writeFileSync(configPath, JSON.stringify(file, null, 2));
      const { logger, out, err } = testLogger();
      const code = await runCreate({
        flags: parseCliArgs([
          path.join(dir, 'acme-site'),
          '--yes',
          '--dry-run',
          '--from',
          configPath,
          ...argv,
        ]),
        logger,
        registry,
        cliVersion: '9.9.9',
        cwd: dir,
        env: {},
        isTTY: false,
        nodeVersion: process.versions.node,
      });
      return { code, text: out.text, errors: err.text };
    } finally {
      cleanup();
    }
  };

  it('plans React when the file says React', async () => {
    const { code, text } = await create({
      stack: { framework: 'react', styling: 'tailwind', router: 'react-router' },
    });
    expect(code).toBe(0);
    expect(text).toContain('react-vite');
    expect(text).toContain('src/routes/AppRouter.tsx');
    expect(text).not.toContain('astro.config.mjs');
  });

  it('carries a feature from the file into the plan', async () => {
    const { text } = await create({
      stack: {
        framework: 'react',
        router: 'react-router',
        features: ['client-route-fallback'],
      },
    });
    expect(text).toContain('src/pages/NotFoundPage.tsx');
  });

  it('still plans Astro when the file names no stack', async () => {
    const { code, text } = await create({ site: { name: 'Acme Ltd' } });
    expect(code).toBe(0);
    expect(text).toContain('astro-tailwind');
    expect(text).toContain('astro.config.mjs');
  });

  it('shows the resolved stack and its provenance in --dry-run', async () => {
    const { text } = await create({ stack: { framework: 'react', styling: 'tailwind' } }, [
      '--debug',
    ]);
    expect(text).toContain('react-vite');
    // `--debug` turns on source attribution, which is where a reader checks
    // whether a value came from the file or from somewhere else.
    expect(text).toMatch(/file/);
  });

  it('a flag on the command line still beats the file', async () => {
    const { text } = await create({ stack: { framework: 'astro' } }, ['--framework', 'react']);
    expect(text).toContain('react-vite');
  });

  it('writes nothing when the configuration is malformed', async () => {
    const { dir, cleanup } = tempDir('config-bad');
    try {
      const configPath = path.join(dir, 'clientkit.json');
      writeFileSync(configPath, '{ "stack": { "framework": ');
      const target = path.join(dir, 'acme-site');
      const { logger } = testLogger();
      await expect(
        runCreate({
          flags: parseCliArgs([target, '--yes', '--from', configPath]),
          logger,
          registry,
          cliVersion: '9.9.9',
          cwd: dir,
          env: {},
          isTTY: false,
          nodeVersion: process.versions.node,
        }),
      ).rejects.toThrow(CliError);
      expect(existsSync(target), 'a project directory was created').toBe(false);
    } finally {
      cleanup();
    }
  });

  it('writes nothing when the configuration is incompatible', async () => {
    const { dir, cleanup } = tempDir('config-incompatible');
    try {
      const configPath = path.join(dir, 'clientkit.json');
      writeFileSync(
        configPath,
        JSON.stringify({ stack: { framework: 'react', features: ['seo'] } }),
      );
      const target = path.join(dir, 'acme-site');
      const { logger } = testLogger();
      await expect(
        runCreate({
          flags: parseCliArgs([target, '--yes', '--from', configPath]),
          logger,
          registry,
          cliVersion: '9.9.9',
          cwd: dir,
          env: {},
          isTTY: false,
          nodeVersion: process.versions.node,
        }),
      ).rejects.toThrow(/combination will not work/);
      expect(existsSync(target), 'a project directory was created').toBe(false);
    } finally {
      cleanup();
    }
  });
});
