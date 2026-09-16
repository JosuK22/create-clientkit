import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAdapterRegistry } from '../src/adapters/registry.js';
import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { resolveDimensions } from '../src/context/dimensions.js';
import { explainStack, NO_FEATURES } from '../src/context/explain.js';
import { createPresetRegistry, PRESETS } from '../src/context/presets.js';
import { NonInteractivePrompter, type Prompter } from '../src/context/prompts.js';
import { resolveContext } from '../src/context/resolve.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan as renderResolved } from '../src/ui/plan.js';
import { emptyFs, FakePrompter, testLogger, TEST_CWD } from './helpers.js';
import type { FakeAnswers } from './helpers.js';

/**
 * "Why did this value win?"
 *
 * Six layers can now supply a dimension - a flag, a config file, a preset, an
 * interactive answer, the framework's own declaration, a built-in default - and
 * until this stage three of them were indistinguishable from silence: a derived
 * value printed with no attribution at all.
 *
 * The contract these tests hold has two halves, and the second is the one that
 * is easy to lose. The **value** must follow precedence, which earlier stages
 * already assert. The **source** must name the layer that actually supplied
 * that value - not the highest layer that mentioned it, not the preset that was
 * selected, not "prompt" for something nobody was asked. A diagnostic that
 * confidently misattributes is worse than none, because it is believed.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

/** The dimensions `react-mui` actually states. */
const PRESET_DIMENSIONS = PRESETS.get('react-mui').dimensions;

const source = (relative: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');

const resolve = (
  argv: readonly string[],
  options: {
    file?: unknown;
    prompter?: Prompter;
    presets?: ReturnType<typeof createPresetRegistry>;
  } = {},
) =>
  resolveContext({
    flags: parseCliArgs([...argv]),
    cwd: TEST_CWD,
    env: {},
    prompter: options.prompter ?? new NonInteractivePrompter('t'),
    registry,
    cliVersion: '9.9.9',
    now: new Date('2026-01-01T00:00:00.000Z'),
    templatesRoot: TEMPLATES_ROOT,
    fs: emptyFs,
    ...(options.presets === undefined ? {} : { presets: options.presets }),
    ...(options.file === undefined ? {} : { readFile: () => JSON.stringify(options.file) }),
  });

const fromFlags = (argv: readonly string[]) => resolve(['acme-site', '--yes', ...argv]);

const answering = (answers: FakeAnswers, argv: readonly string[] = [], file?: unknown) =>
  resolve(['acme-site', ...(file === undefined ? [] : ['--from', 'clientkit.json']), ...argv], {
    prompter: new FakePrompter({ dir: 'acme-site', ...answers }),
    ...(file === undefined ? {} : { file }),
  });

/** Every dimension the explanation reports, as `dimension -> source`. */
const attribution = (resolution: Awaited<ReturnType<typeof fromFlags>>) =>
  Object.fromEntries(
    explainStack(resolution.manifest, resolution.stack).map((entry) => [
      entry.dimension,
      entry.source,
    ]),
  );

// ---------------------------------------------------------------------------
// Every dimension is explainable
// ---------------------------------------------------------------------------

describe('every dimension has a source', () => {
  it('names all eight, in the canonical order', async () => {
    const explained = explainStack((await fromFlags([])).manifest, (await fromFlags([])).stack);
    expect(explained.map((entry) => entry.dimension)).toEqual([
      'framework',
      'buildTool',
      'language',
      'styling',
      'uiLibrary',
      'router',
      'architecture',
      'features',
    ]);
  });

  it('leaves none unattributed, however the stack was configured', async () => {
    const runs = [
      await fromFlags([]),
      await fromFlags(['--framework', 'react']),
      await fromFlags(['--preset', 'react-mui']),
      await fromFlags(['--framework', 'react', '--router', 'react-router']),
    ];
    for (const run of runs) {
      for (const entry of explainStack(run.manifest, run.stack)) {
        expect(entry.source, `${entry.dimension} has no source`).toBeDefined();
      }
    }
  });

  it('carries the resolved value alongside the source', async () => {
    const run = await fromFlags(['--framework', 'react', '--styling', 'bootstrap']);
    const explained = explainStack(run.manifest, run.stack);
    const byKey = new Map(explained.map((entry) => [entry.dimension, entry]));
    expect(byKey.get('framework')?.value).toBe('react');
    expect(byKey.get('styling')?.value).toBe('bootstrap');
    expect(byKey.get('buildTool')?.value).toBe('vite');
  });

  it('gives every row a human label', () => {
    for (const entry of explainStack(
      {
        framework: 'astro',
        buildTool: 'astro',
        language: 'ts',
        styling: 'tailwind',
        uiLibrary: 'none',
        router: 'file-based',
        architecture: 'astro-standard',
        starter: 'coming-soon',
        features: [],
      } as never,
      {},
    )) {
      expect(entry.label.trim(), `${entry.dimension} has no label`).not.toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// Precedence, for the source as well as the value
// ---------------------------------------------------------------------------

describe('the source names the layer that actually won', () => {
  it('flag beats everything', async () => {
    /*
     * Four layers all name a framework and the flag wins. The value being
     * `react` is the older assertion; the source being `flag` is this stage's.
     * Reporting `[preset]` here would be a confident lie about a value the
     * preset never supplied.
     */
    const run = await answering(
      { dimensions: { framework: 'astro' } },
      ['--framework', 'react', '--preset', 'astro-tailwind'],
      { stack: { framework: 'astro' } },
    );
    expect(run.manifest.framework).toBe('react');
    expect(attribution(run)['framework']).toBe('flag');
  });

  it('config beats preset, interactive and default', async () => {
    const run = await answering(
      { dimensions: { styling: 'tailwind' } },
      ['--preset', 'react-mui'],
      {
        stack: { styling: 'bootstrap' },
      },
    );
    expect(run.manifest.styling).toBe('bootstrap');
    expect(attribution(run)['styling']).toBe('file');
  });

  it('preset beats interactive and default', async () => {
    const run = await fromFlags(['--preset', 'react-mui']);
    expect(run.manifest.uiLibrary).toBe('mui');
    expect(attribution(run)['uiLibrary']).toBe('preset');
  });

  it('an interactive answer beats the default', async () => {
    const run = await answering({ dimensions: { framework: 'react', styling: 'bootstrap' } });
    expect(run.manifest.styling).toBe('bootstrap');
    expect(attribution(run)['styling']).toBe('prompt');
    expect(attribution(run)['framework']).toBe('prompt');
  });

  it('the default wins when nothing else spoke', async () => {
    const run = await fromFlags([]);
    expect(run.manifest.styling).toBe('tailwind');
    expect(attribution(run)['styling']).toBe('default');
  });

  it('the whole chain resolves in one run', async () => {
    const run = await answering(
      { dimensions: { router: 'react-router' } },
      ['--ui-library', 'mui', '--preset', 'react-bootstrap'],
      { stack: { styling: 'tailwind' } },
    );
    expect(attribution(run)).toMatchObject({
      framework: 'preset', // only the preset named it
      styling: 'file', // the file beat the preset's bootstrap
      uiLibrary: 'flag', // the flag beat everything
      router: 'prompt', // nobody else named it
      buildTool: 'adapter', // React's declaration
      architecture: 'adapter',
      features: 'default',
    });
    expect(run.manifest).toMatchObject({
      framework: 'react',
      styling: 'tailwind',
      uiLibrary: 'mui',
      router: 'react-router',
    });
  });
});

// ---------------------------------------------------------------------------
// Selected versus derived
// ---------------------------------------------------------------------------

describe('a derived value does not pretend to have been chosen', () => {
  it('attributes framework-owned dimensions to the adapter', async () => {
    const run = await fromFlags(['--framework', 'react']);
    expect(attribution(run)).toMatchObject({
      framework: 'flag',
      buildTool: 'adapter',
      language: 'adapter',
      router: 'adapter',
      architecture: 'adapter',
    });
  });

  it('attributes dimensions no framework owns to the default', async () => {
    // Nothing about React decides how CSS is authored, so an unstated styling
    // system is a built-in preference rather than the adapter speaking.
    const run = await fromFlags(['--framework', 'react']);
    expect(attribution(run)).toMatchObject({ styling: 'default', uiLibrary: 'default' });
  });

  it('never reports a derived value as interactive', async () => {
    const run = await answering({ dimensions: { framework: 'react' } });
    expect(attribution(run)['framework']).toBe('prompt');
    // ...but the four it implies were not asked about and must not claim to be.
    for (const dimension of ['buildTool', 'language', 'architecture']) {
      expect(attribution(run)[dimension], dimension).toBe('adapter');
    }
  });

  it('the two derived sources are distinguishable', async () => {
    const run = await fromFlags([]);
    const sources = attribution(run);
    expect(sources['buildTool']).toBe('adapter');
    expect(sources['styling']).toBe('default');
    expect(sources['buildTool']).not.toBe(sources['styling']);
  });

  it('records the origin where the value is decided, not where it is read', () => {
    // `resolveDimensions` is the only place a fallback happens, so it is the
    // only place that can say a fallback happened.
    const stated = resolveDimensions({ framework: 'react', styling: 'bootstrap' }, adapters);
    expect(stated.origins).toMatchObject({
      framework: 'stated',
      styling: 'stated',
      buildTool: 'adapter',
      uiLibrary: 'default',
    });
  });
});

// ---------------------------------------------------------------------------
// Partial preset attribution
// ---------------------------------------------------------------------------

describe('a preset is credited only with what it supplied', () => {
  it('does not claim a dimension the flag settled', async () => {
    const run = await answering({ dimensions: { preset: 'react-mui' } }, [
      '--router',
      'react-router',
    ]);
    expect(attribution(run)).toMatchObject({
      framework: 'preset',
      styling: 'preset',
      uiLibrary: 'preset',
      router: 'flag',
    });
  });

  it('does not claim a dimension it never states', async () => {
    const run = await fromFlags(['--preset', 'react-tailwind']);
    // `react-tailwind` says nothing about the component library.
    expect(attribution(run)['uiLibrary']).toBe('default');
    expect(attribution(run)['uiLibrary']).not.toBe('preset');
  });

  it('a named preset and a chosen preset are credited the same way', async () => {
    /*
     * Only for the dimensions the preset supplies. The two runs differ
     * elsewhere by design: a chosen preset means an interactive session, which
     * then asks about the router, so that one reads `prompt` rather than
     * `adapter`. Comparing the whole map would assert the two flows are
     * identical, which they are not and should not be.
     */
    const named = attribution(await fromFlags(['--preset', 'react-mui']));
    const chosen = attribution(await answering({ dimensions: { preset: 'react-mui' } }));
    for (const dimension of Object.keys(PRESET_DIMENSIONS)) {
      expect(chosen[dimension], dimension).toBe(named[dimension]);
      expect(chosen[dimension], dimension).toBe('preset');
    }
  });
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

describe('features are attributed like any other dimension', () => {
  const withFeatures = createPresetRegistry([
    {
      id: 'opinionated',
      displayName: 'Opinionated',
      description: 'picks features too',
      dimensions: { framework: 'astro', features: ['seo', 'accessibility'] },
    },
  ]);

  it('an unstated feature list is a default, not a choice', async () => {
    const run = await fromFlags([]);
    expect(attribution(run)['features']).toBe('default');
  });

  it('an empty feature flag is still not a choice', async () => {
    // The Stage 18 rule, restated as an attribution: `[]` is what a flag that
    // was never passed looks like, and calling that explicit would make "no
    // features" indistinguishable from "features: none".
    expect(resolveDimensions({ features: [] }, adapters).origins.features).toBe('default');
    expect(resolveDimensions({ features: ['seo'] }, adapters).origins.features).toBe('stated');
  });

  it('a feature flag is attributed to the flag', async () => {
    const run = await fromFlags(['--features', 'seo']);
    expect(attribution(run)['features']).toBe('flag');
  });

  it('a config feature list is attributed to the file', async () => {
    const run = await resolve(['acme-site', '--yes', '--from', 'clientkit.json'], {
      file: { stack: { features: ['seo'] } },
    });
    expect(attribution(run)['features']).toBe('file');
  });

  it('a preset feature list is attributed to the preset', async () => {
    const run = await resolve(['acme-site', '--yes', '--preset', 'opinionated'], {
      presets: withFeatures,
    });
    expect(attribution(run)['features']).toBe('preset');
  });

  it('shows the feature set without the starter', async () => {
    const run = await fromFlags(['--features', 'seo', '--mode', 'full']);
    const features = explainStack(run.manifest, run.stack).find(
      (entry) => entry.dimension === 'features',
    );
    // The starter is printed as the mode, on its own line. Until Stage 21 it
    // was also in this list and had to be filtered back out; now it is simply
    // somewhere else, and the assertion below is what proves it.
    expect(features?.value).toBe('seo');
    expect(run.manifest.starter).toBe('full');
    expect(run.manifest.features).toEqual(['seo']);
  });

  it('shows an empty set as none rather than blank', async () => {
    const run = await fromFlags([]);
    const features = explainStack(run.manifest, run.stack).find(
      (entry) => entry.dimension === 'features',
    );
    expect(features?.value).toBe(NO_FEATURES);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same input explains identically twice', async () => {
    const argv = ['--preset', 'react-mui', '--router', 'react-router'];
    const first = await fromFlags(argv);
    const second = await fromFlags(argv);
    expect(JSON.stringify(explainStack(first.manifest, first.stack))).toBe(
      JSON.stringify(explainStack(second.manifest, second.stack)),
    );
  });

  it('the order does not depend on the order sources were recorded', async () => {
    const a = await fromFlags(['--framework', 'react']);
    const b = await fromFlags(['--styling', 'bootstrap', '--framework', 'react']);
    expect(explainStack(a.manifest, a.stack).map((entry) => entry.dimension)).toEqual(
      explainStack(b.manifest, b.stack).map((entry) => entry.dimension),
    );
  });

  it('the order does not depend on the attribution map at all', async () => {
    const run = await fromFlags(['--framework', 'react']);
    const reversed = Object.fromEntries(Object.entries(run.stack).reverse());
    expect(explainStack(run.manifest, reversed).map((entry) => entry.dimension)).toEqual(
      explainStack(run.manifest, run.stack).map((entry) => entry.dimension),
    );
  });

  it('carries no timestamp, path or machine-specific value', async () => {
    const run = await fromFlags(['--framework', 'react']);
    const rendered = JSON.stringify(explainStack(run.manifest, run.stack));
    expect(rendered).not.toContain(TEST_CWD);
    expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(rendered).not.toContain('\\');
  });
});

// ---------------------------------------------------------------------------
// Structural: the explanation explains, it does not resolve
// ---------------------------------------------------------------------------

describe('the explanation is a projection, not a second resolver', () => {
  const explain = source('src/context/explain.ts');
  const code = explain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('consults no adapter and no registry', () => {
    for (const forbidden of [
      'createAdapterRegistry',
      'resolveDimensions',
      'checkCompatibility',
      'selectAdapters',
      'PRESETS',
      'presetDimensions',
    ]) {
      expect(explain, `explain.ts references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('ranks nothing, because it applies no precedence', () => {
    // Any of these names appearing in the code would mean it had an opinion
    // about which layer wins - which is the resolver's, and only the resolver's.
    for (const layer of ["'flag'", "'file'", "'preset'", "'prompt'", "'adapter'"]) {
      expect(code, `explain.ts decides ${layer}`).not.toContain(layer);
    }
  });

  it('touches no filesystem and generates nothing', () => {
    for (const forbidden of [
      'node:fs',
      'node:child_process',
      'node:process',
      'readFileSync',
      'writeFileSync',
      'FileOperation',
      'apply(',
      'planManifest',
    ]) {
      expect(explain, `explain.ts uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('branches on no framework and no adapter id', () => {
    for (const name of ['astro', 'react', 'nextjs', 'mui', 'tailwind', 'vite']) {
      expect(code.toLowerCase(), `explain.ts mentions ${name}`).not.toContain(`'${name}'`);
    }
  });

  it('states the order explicitly rather than deriving it from a manifest', () => {
    // `Object.keys(manifest)` would make the diagnostic order an accident of
    // the type's field order, which nothing guarantees.
    expect(code).not.toContain('Object.keys');
    expect(code).toContain('DIMENSIONS');
  });

  it('is the only place the renderer gets the stack from', () => {
    const plan = source('src/ui/plan.ts');
    expect(plan).toContain('explainStack');
    // A row built by hand beside one built from the explanation would be a
    // dimension that can appear in one and not the other.
    expect(plan).not.toContain("row('Framework'");
    expect(plan).not.toContain("row('Build tool'");
  });
});

// ---------------------------------------------------------------------------
// Through the command
// ---------------------------------------------------------------------------

describe('the debug output explains the stack', () => {
  const create = async (argv: readonly string[], answers: FakeAnswers = {}) => {
    const { logger, out } = testLogger();
    const code = await runCreate({
      flags: parseCliArgs(['acme-site', '--dry-run', ...argv]),
      logger,
      registry,
      cliVersion: '9.9.9',
      cwd: TEST_CWD,
      env: {},
      isTTY: false,
      nodeVersion: process.versions.node,
      prompter: new FakePrompter({ dir: 'acme-site', ...answers }),
    });
    // Rendered with colour; the assertions below are about text, not ANSI.
    // eslint-disable-next-line no-control-regex
    return { code, text: out.text.replace(/\[[0-9;]*m/g, '') };
  };

  it('prints a source beside every dimension', async () => {
    const { code, text } = await create(['--preset', 'react-mui', '--debug']);
    expect(code).toBe(0);
    const stack = text.slice(text.indexOf('Stack'));
    for (const label of [
      'Framework',
      'Build tool',
      'Language',
      'Styling',
      'Component library',
      'Routing',
      'Architecture',
      'Features',
    ]) {
      const line = stack.split('\n').find((entry) => entry.includes(label));
      expect(line, `${label} has no row`).toBeDefined();
      expect(line, `${label} has no source`).toMatch(/\[[a-z]+\]$/);
    }
  });

  it('distinguishes selected from derived in the output', async () => {
    const { text } = await create(['--preset', 'react-mui', '--router', 'react-router', '--debug']);
    const stack = text.slice(text.indexOf('Stack'));
    expect(stack).toMatch(/Framework\s+react\s+\[preset\]/);
    expect(stack).toMatch(/Build tool\s+vite\s+\[adapter\]/);
    expect(stack).toMatch(/Routing\s+react-router\s+\[flag\]/);
  });

  it('is byte-identical across runs', async () => {
    const first = await create(['--framework', 'react', '--debug']);
    const second = await create(['--framework', 'react', '--debug']);
    const stackOf = (text: string) => text.slice(text.indexOf('Stack'), text.indexOf('  CLI '));
    expect(stackOf(first.text)).toBe(stackOf(second.text));
  });

  it('always explains under --dry-run, and only under --debug otherwise', () => {
    /*
     * A pre-existing split this stage did not change, worth stating because it
     * is easy to misread: `--dry-run` is itself the explain view and passes
     * `showSources: true` unconditionally, while the summary printed after a
     * real generation shows sources only with `--debug`.
     */
    const manifest = {
      framework: 'react',
      buildTool: 'vite',
      language: 'ts',
      styling: 'tailwind',
      uiLibrary: 'none',
      router: 'none',
      architecture: 'react-standard',
      starter: 'coming-soon',
      features: [],
    } as never;
    const context = {
      targetDir: 'x',
      projectName: 'x',
      site: { name: 'X', url: null, description: '', locale: 'en', author: null },
      template: { id: 't', version: null, mode: 'coming-soon' },
      features: [],
      packageManager: 'npm',
      git: false,
      install: false,
      cliVersion: '9.9.9',
      generatedAt: '2026-01-01T00:00:00.000Z',
    } as never;

    const quiet = renderResolved(
      context,
      manifest,
      {},
      { framework: 'flag' },
      {
        showSources: false,
      },
    );
    const loud = renderResolved(
      context,
      manifest,
      {},
      { framework: 'flag' },
      {
        showSources: true,
      },
    );
    expect(quiet).not.toContain('[flag]');
    expect(loud).toContain('[flag]');
  });

  it('adds no new flag to do it', () => {
    const args = source('src/args.ts');
    expect(args).not.toContain('explain');
  });
});
