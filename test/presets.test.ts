import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { assertFlagCombinations, parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { promptDimensions } from '../src/context/interactive.js';
import { createPresetRegistry, PRESETS, presetDimensions } from '../src/context/presets.js';
import type { Preset } from '../src/context/presets.js';
import { NonInteractivePrompter, type Prompter } from '../src/context/prompts.js';
import { resolveContext } from '../src/context/resolve.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { manifestFromProjectContext } from '../src/domain/manifest.js';
import { CliError, EXIT_USAGE } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { emptyFs, FakePrompter, renderPlan, tempDir, testLogger, TEST_CWD } from './helpers.js';
import type { FakeAnswers } from './helpers.js';
import { helpText } from '../src/ui/help.js';

/**
 * Presets, and the one thing that makes a fourth input mechanism safe.
 *
 * A preset is a partial `DimensionInput` with a name. Selecting one is meant to
 * be indistinguishable from having typed the flags it lists - so the tests that
 * carry this stage are the equivalence ones, asserting that
 * `--preset react-mui` and the explicit flags produce the same manifest and the
 * same generation plan.
 *
 * The rest is about what a preset must never grow into. It owns no files, names
 * no template, selects no adapter and decides no compatibility; a structural
 * suite walks the definitions and the module to say so, because "it is only
 * data" is a property that erodes one convenience at a time.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const source = (relative: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');

const resolve = (argv: readonly string[], options: { file?: unknown; prompter?: Prompter } = {}) =>
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
    ...(options.file === undefined ? {} : { readFile: () => JSON.stringify(options.file) }),
  });

/** Non-interactive, the way `--yes` drives it. */
const fromFlags = (argv: readonly string[]) => resolve(['acme-site', '--yes', ...argv]);

const fromFile = (file: unknown, argv: readonly string[] = []) =>
  resolve(['acme-site', '--yes', '--from', 'clientkit.json', ...argv], { file });

const fromAnswers = (answers: FakeAnswers, argv: readonly string[] = []) => {
  const prompter = new FakePrompter({ dir: 'acme-site', ...answers });
  return resolve(['acme-site', ...argv], { prompter }).then((resolution) => ({
    ...resolution,
    asked: prompter.asked,
    prompter,
  }));
};

const failure = async (argv: readonly string[], file?: unknown): Promise<CliError> => {
  // A file is only read when `--from` names one, so the flag comes with it.
  const withFile = file === undefined ? argv : ['--from', 'clientkit.json', ...argv];
  try {
    const flags = parseCliArgs(['acme-site', '--yes', ...withFile]);
    assertFlagCombinations(flags);
    await resolve(['acme-site', '--yes', ...withFile], file === undefined ? {} : { file });
  } catch (error) {
    expect(error, 'expected a CliError').toBeInstanceOf(CliError);
    return error as CliError;
  }
  return expect.unreachable('the invocation was accepted');
};

const textOf = (error: CliError): string => `${error.message}\n${error.hint ?? ''}`;

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

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the preset registry', () => {
  const all = PRESETS.all();

  it('ships the four proven stacks', () => {
    expect(all.map((preset) => preset.id)).toEqual([
      'astro-tailwind',
      'react-tailwind',
      'react-bootstrap',
      'react-mui',
    ]);
  });

  it('gives every preset a unique, lowercase, kebab-case id', () => {
    expect(new Set(all.map((preset) => preset.id)).size).toBe(all.length);
    for (const preset of all) {
      expect(preset.id, `${preset.id} is not kebab-case`).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  it('gives every preset a display name and a description', () => {
    for (const preset of all) {
      expect(preset.displayName.trim(), `${preset.id} has no display name`).not.toBe('');
      expect(preset.description.trim(), `${preset.id} has no description`).not.toBe('');
    }
  });

  it('names only ids the registry actually implements', () => {
    // A preset naming `nextjs` would be an advertisement for something that
    // does not exist. Checked against the adapter registry rather than a list.
    for (const preset of all) {
      const { framework, styling, uiLibrary, router } = preset.dimensions;
      if (framework !== undefined) expect(adapters.hasFramework(framework as never)).toBe(true);
      if (styling !== undefined && styling !== 'none') {
        expect(adapters.hasStyling(styling as never), `${preset.id}: ${styling}`).toBe(true);
      }
      if (uiLibrary !== undefined && uiLibrary !== 'none') {
        expect(adapters.hasUiLibrary(uiLibrary as never), `${preset.id}: ${uiLibrary}`).toBe(true);
      }
      if (router !== undefined && router !== 'none' && router !== 'file-based') {
        expect(adapters.hasRouter(router as never), `${preset.id}: ${router}`).toBe(true);
      }
    }
  });

  it('returns them in a fixed order', () => {
    expect(PRESETS.all().map((p) => p.id)).toEqual(PRESETS.all().map((p) => p.id));
  });

  it('looks up a known preset', () => {
    expect(PRESETS.get('react-mui').dimensions).toEqual({
      framework: 'react',
      styling: 'tailwind',
      uiLibrary: 'mui',
    });
    expect(PRESETS.has('react-mui')).toBe(true);
  });

  it('refuses an unknown one by name, listing what exists', () => {
    let error: CliError | undefined;
    try {
      PRESETS.get('my-awesome-stack');
    } catch (thrown) {
      error = thrown as CliError;
    }
    expect(error?.message).toContain('Unknown preset "my-awesome-stack"');
    expect(error?.hint).toContain('react-tailwind');
    expect(error?.exitCode).toBe(EXIT_USAGE);
  });

  it('contributes nothing when no preset was named', () => {
    expect(presetDimensions(undefined, PRESETS)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Definitions are validated on construction
// ---------------------------------------------------------------------------

describe('a malformed preset cannot ship', () => {
  const valid: Preset = {
    id: 'ok',
    displayName: 'Fine',
    description: 'a valid preset',
    dimensions: { framework: 'react' },
  };
  const build = (over: Partial<Preset>) => () => createPresetRegistry([{ ...valid, ...over }]);

  it('rejects an id that is not kebab-case', () => {
    expect(build({ id: 'React_Tailwind' })).toThrow(/kebab-case/);
    expect(build({ id: '-leading' })).toThrow(/kebab-case/);
  });

  it('rejects a duplicate id', () => {
    expect(() => createPresetRegistry([valid, valid])).toThrow(/used twice/);
  });

  it('rejects an empty display name or description', () => {
    expect(build({ displayName: '  ' })).toThrow(/display name is empty/);
    expect(build({ description: '' })).toThrow(/description is empty/);
  });

  it('rejects a preset that states nothing', () => {
    expect(build({ dimensions: {} })).toThrow(/states no dimensions/);
  });

  it('rejects a duplicated feature', () => {
    expect(build({ dimensions: { features: ['seo', 'seo'] } })).toThrow(/lists a feature twice/);
  });

  it('accepts the shipped set', () => {
    expect(() => createPresetRegistry()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Each preset resolves
// ---------------------------------------------------------------------------

describe('every shipped preset resolves to a buildable project', () => {
  const expected: Readonly<Record<string, Record<string, unknown>>> = {
    'astro-tailwind': {
      framework: 'astro',
      buildTool: 'astro',
      styling: 'tailwind',
      uiLibrary: 'none',
      router: 'file-based',
      architecture: 'astro-standard',
      starter: 'coming-soon',
    },
    'react-tailwind': {
      framework: 'react',
      buildTool: 'vite',
      language: 'ts',
      styling: 'tailwind',
      uiLibrary: 'none',
      router: 'none',
      architecture: 'react-standard',
      starter: 'coming-soon',
    },
    'react-bootstrap': { framework: 'react', styling: 'bootstrap', uiLibrary: 'none' },
    'react-mui': { framework: 'react', styling: 'tailwind', uiLibrary: 'mui' },
  };

  for (const preset of PRESETS.all()) {
    it(`${preset.id} produces the expected manifest`, async () => {
      const { manifest } = await fromFlags(['--preset', preset.id]);
      expect(manifest).toMatchObject(expected[preset.id] as object);
    });

    it(`${preset.id} produces a valid generation plan`, async () => {
      const resolution = await fromFlags(['--preset', preset.id]);
      const planned = planManifest(resolution.manifest, {
        registry,
        cliVersion: '9.9.9',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode: resolution.context.template.mode,
        templateId: resolution.context.template.id,
      });
      expect(planned.plan.operations.length).toBeGreaterThan(10);
      expect(planned.project.manifest.framework).toBe(resolution.manifest.framework);
    });
  }

  it('leaves dimensions it does not state to the usual machinery', () => {
    // `react-tailwind` says nothing about the build tool, the language, the
    // router or the architecture. All four still resolve, from React's own
    // declarations - which is why the preset does not restate them.
    expect(PRESETS.get('react-tailwind').dimensions).toEqual({
      framework: 'react',
      styling: 'tailwind',
    });
  });
});

// ---------------------------------------------------------------------------
// Equivalence
// ---------------------------------------------------------------------------

describe('a preset equals the flags it stands for', () => {
  const equivalents: Readonly<Record<string, readonly string[]>> = {
    'astro-tailwind': ['--framework', 'astro', '--styling', 'tailwind'],
    'react-tailwind': ['--framework', 'react', '--styling', 'tailwind'],
    'react-bootstrap': ['--framework', 'react', '--styling', 'bootstrap'],
    'react-mui': ['--framework', 'react', '--styling', 'tailwind', '--ui-library', 'mui'],
  };

  for (const [id, flags] of Object.entries(equivalents)) {
    it(`${id}: same manifest as the explicit flags`, async () => {
      const viaPreset = await fromFlags(['--preset', id]);
      const viaFlags = await fromFlags(flags);
      expect(viaPreset.manifest).toEqual(viaFlags.manifest);
    });

    it(`${id}: same plan as the explicit flags`, async () => {
      expect(plan(await fromFlags(['--preset', id]))).toBe(plan(await fromFlags(flags)));
    });

    it(`${id}: same manifest through a config file`, async () => {
      const viaFile = await fromFile({ stack: { preset: id } });
      expect(viaFile.manifest).toEqual((await fromFlags(['--preset', id])).manifest);
    });

    it(`${id}: same manifest chosen interactively`, async () => {
      const viaAnswers = await fromAnswers({ dimensions: { preset: id } });
      expect(viaAnswers.manifest).toEqual((await fromFlags(['--preset', id])).manifest);
    });
  }
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('a preset supplies defaults and never overrides', () => {
  it('a flag beats the preset', async () => {
    const { manifest } = await fromFlags(['--preset', 'react-tailwind', '--ui-library', 'mui']);
    expect(manifest).toMatchObject({
      framework: 'react',
      styling: 'tailwind',
      uiLibrary: 'mui',
    });
  });

  it('a styling flag beats the preset styling', async () => {
    expect(
      (await fromFlags(['--preset', 'react-tailwind', '--styling', 'bootstrap'])).manifest,
    ).toMatchObject({ framework: 'react', styling: 'bootstrap' });
  });

  it('a router flag fills what the preset left alone', async () => {
    expect(
      (await fromFlags(['--preset', 'react-tailwind', '--router', 'react-router'])).manifest.router,
    ).toBe('react-router');
  });

  it('a feature flag replaces rather than merges', async () => {
    const { manifest } = await fromFlags([
      '--preset',
      'react-tailwind',
      '--router',
      'react-router',
      '--features',
      'client-route-fallback',
    ]);
    expect(manifest.features).toEqual(['client-route-fallback']);
  });

  /*
   * A preset that states features, which none of the shipped four do.
   *
   * That gap was invisible until a mutation making preset features override an
   * explicit `--features` survived the whole suite: with no feature-bearing
   * preset anywhere, the rung being mutated was never loaded. Injected rather
   * than added to the shipped set, because the shipped set should stay the
   * proven stacks rather than grow an entry to suit a test.
   */
  const withFeatures = createPresetRegistry([
    {
      id: 'opinionated',
      displayName: 'Opinionated',
      description: 'a preset that picks features too',
      dimensions: { framework: 'astro', styling: 'tailwind', features: ['seo', 'accessibility'] },
    },
  ]);

  const usingFeaturePreset = (argv: readonly string[], file?: unknown) =>
    resolveContext({
      flags: parseCliArgs([
        'acme-site',
        '--yes',
        ...(file === undefined ? [] : ['--from', 'clientkit.json']),
        ...argv,
      ]),
      cwd: TEST_CWD,
      env: {},
      prompter: new NonInteractivePrompter('t'),
      registry,
      cliVersion: '9.9.9',
      now: new Date('2026-01-01T00:00:00.000Z'),
      templatesRoot: TEMPLATES_ROOT,
      fs: emptyFs,
      presets: withFeatures,
      ...(file === undefined ? {} : { readFile: () => JSON.stringify(file) }),
    });

  it('a preset can state features, and they reach the manifest', async () => {
    const { manifest } = await usingFeaturePreset(['--preset', 'opinionated']);
    expect(manifest.features).toEqual(['accessibility', 'seo']);
  });

  it('an explicit feature flag replaces the preset list rather than merging', async () => {
    // Replacement is what makes a preset overridable: merging would leave a
    // feature the preset chose impossible to remove.
    const { manifest } = await usingFeaturePreset([
      '--preset',
      'opinionated',
      '--features',
      'structured-data',
    ]);
    expect(manifest.features).toEqual(['structured-data']);
    expect(manifest.features).not.toContain('seo');
  });

  it('a config feature list also replaces the preset list', async () => {
    const { manifest } = await usingFeaturePreset([], {
      stack: { preset: 'opinionated', features: ['structured-data'] },
    });
    expect(manifest.features).toEqual(['structured-data']);
  });

  it('a config value beats the preset', async () => {
    const { manifest } = await fromFile({
      stack: { preset: 'react-tailwind', styling: 'bootstrap' },
    });
    expect(manifest).toMatchObject({ framework: 'react', styling: 'bootstrap' });
  });

  it('a flag beats a config value which beats the preset', async () => {
    const { manifest } = await fromFile(
      { stack: { preset: 'react-tailwind', styling: 'bootstrap', uiLibrary: 'mui' } },
      ['--ui-library', 'none'],
    );
    expect(manifest).toMatchObject({
      framework: 'react', // preset
      styling: 'bootstrap', // file, beating the preset's tailwind
      uiLibrary: 'none', // flag, beating the file
    });
  });

  it('a flag preset beats a config preset', async () => {
    const { manifest } = await fromFile({ stack: { preset: 'astro-tailwind' } }, [
      '--preset',
      'react-bootstrap',
    ]);
    expect(manifest).toMatchObject({ framework: 'react', styling: 'bootstrap' });
  });

  it('overriding into an impossible stack is refused by the engine, not here', async () => {
    // `--preset react-mui --framework astro` resolves - MUI needs
    // `react-runtime` and Astro has none, which the compatibility engine says,
    // in its own words.
    const { manifest } = await fromFlags(['--preset', 'react-mui', '--framework', 'astro']);
    expect(manifest.framework).toBe('astro');
    expect(manifest.uiLibrary).toBe('mui');

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
    expect(textOf(error as CliError)).toContain('react-runtime');
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe('provenance distinguishes a preset from an explicit value', () => {
  it('labels preset-supplied dimensions', async () => {
    const { stack } = await fromFlags(['--preset', 'react-mui']);
    expect(stack['framework']).toBe('preset');
    expect(stack['styling']).toBe('preset');
    expect(stack['uiLibrary']).toBe('preset');
  });

  it('labels an override as the layer that overrode', async () => {
    const { stack } = await fromFile({ stack: { preset: 'react-mui', styling: 'bootstrap' } }, [
      '--ui-library',
      'none',
    ]);
    expect(stack['framework']).toBe('preset');
    expect(stack['styling']).toBe('file');
    expect(stack['uiLibrary']).toBe('flag');
  });

  it('attributes a dimension no layer stated to whoever derived it', async () => {
    // Stage 19: a blank said nothing. The framework's declaration supplied the
    // build tool and the router, so they say so.
    const { stack } = await fromFlags(['--preset', 'react-tailwind']);
    expect(stack['router']).toBe('adapter');
    expect(stack['buildTool']).toBe('adapter');
  });
});

// ---------------------------------------------------------------------------
// Interactive
// ---------------------------------------------------------------------------

describe('choosing a preset interactively', () => {
  const menus = async (input: Record<string, unknown>, answers: FakeAnswers = {}) => {
    const prompter = new FakePrompter(answers);
    const result = await promptDimensions({
      input,
      adapters,
      prompter,
      mode: 'coming-soon',
      presets: PRESETS,
    });
    return { ...result, prompter };
  };

  it('offers every preset plus Custom', async () => {
    const { prompter } = await menus({});
    const question = prompter.questions.find((q) => q.dimension === 'preset');
    expect(question?.options.map((option) => option.value)).toEqual([
      ...PRESETS.all().map((preset) => preset.id),
      'custom',
    ]);
  });

  it('defaults to Custom, so pressing Enter changes nothing', async () => {
    const { prompter, asked } = await menus({});
    expect(prompter.questions.find((q) => q.dimension === 'preset')?.initialValue).toBe('custom');
    // ...and the ordinary questions still follow.
    expect(asked).toContain('framework');
    expect(asked).toContain('styling');
  });

  it('skips the dimensions the chosen preset states', async () => {
    const { asked } = await menus({}, { dimensions: { preset: 'react-mui' } });
    expect(asked).toContain('preset');
    for (const dimension of ['framework', 'styling', 'uiLibrary']) {
      expect(asked, `${dimension} was asked though the preset states it`).not.toContain(dimension);
    }
  });

  it('still asks the dimensions it does not state', async () => {
    const { asked } = await menus({}, { dimensions: { preset: 'react-tailwind' } });
    expect(asked).toContain('uiLibrary');
    expect(asked).toContain('router');
  });

  it('names each preset the way the registry does', async () => {
    const { prompter } = await menus({});
    const question = prompter.questions.find((q) => q.dimension === 'preset');
    for (const preset of PRESETS.all()) {
      const option = question?.options.find((entry) => entry.value === preset.id);
      expect(option?.label).toBe(preset.displayName);
      expect(option?.hint).toBe(preset.description);
    }
  });

  it('survives a partial configuration, because it can still contribute', async () => {
    /*
     * Stage 17 hid the menu the moment any dimension was settled. Stage 18
     * replaced that with a question about usefulness, so a flag that overlaps a
     * preset no longer suppresses it - the preset still has the rest to give.
     * The composability suite covers the rule; this holds the specific
     * regression.
     */
    for (const input of [{ framework: 'react' }, { styling: 'bootstrap' }]) {
      const { asked } = await menus(input);
      expect(asked, JSON.stringify(input)).toContain('preset');
    }
  });

  it('is not offered when a preset flag already chose one', async () => {
    const { asked } = await fromAnswers({}, ['--preset', 'react-mui']);
    expect(asked).not.toContain('preset');
  });

  it('is not offered when the prompter cannot ask', async () => {
    const prompter = new NonInteractivePrompter('--yes');
    const result = await promptDimensions({
      input: {},
      adapters,
      prompter,
      mode: 'coming-soon',
      presets: PRESETS,
    });
    expect(result.asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --yes and the default
// ---------------------------------------------------------------------------

describe('the default is untouched', () => {
  it('--yes with no preset still resolves the V1 stack', async () => {
    const { context, manifest } = await fromFlags([]);
    expect(manifest).toEqual(manifestFromProjectContext(context));
    expect(manifest.framework).toBe('astro');
    expect(manifest.styling).toBe('tailwind');
  });

  it('no preset is silently applied', async () => {
    const { stack } = await fromFlags([]);
    expect(stack['framework']).toBe('default');
    expect(stack['framework']).not.toBe('preset');
  });

  it('--preset with --yes needs no prompting', async () => {
    // A `NonInteractivePrompter` throws on any question, so reaching a manifest
    // is the assertion.
    for (const preset of PRESETS.all()) {
      const { manifest } = await fromFlags(['--preset', preset.id]);
      expect(manifest.framework, preset.id).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Templates, and unknown names
// ---------------------------------------------------------------------------

describe('a preset is not a template', () => {
  it('refuses --template alongside --preset', () => {
    const flags = parseCliArgs(['acme', '--template', 'astro-tailwind', '--preset', 'react-mui']);
    expect(() => assertFlagCombinations(flags)).toThrow(/--template cannot be combined/);
  });

  it('refuses them even when the names are identical', () => {
    // They agree by coincidence of naming, not by meaning: one selects a stack,
    // the other names an implementation.
    const flags = parseCliArgs([
      'acme',
      '--template',
      'astro-tailwind',
      '--preset',
      'astro-tailwind',
    ]);
    expect(() => assertFlagCombinations(flags)).toThrow(/--template cannot be combined/);
  });

  it('refuses a template and a preset in one config file', async () => {
    const error = await failure([], {
      template: { id: 'astro-tailwind' },
      stack: { preset: 'react-mui' },
    });
    expect(error.message).toContain('both name what to build');
  });

  it('the preset resolves dimensions rather than selecting a template', async () => {
    // `--preset astro-tailwind` and `--template astro-tailwind` reach the same
    // generated project by different routes; the preset route states a
    // framework and lets the framework choose its template.
    const viaPreset = await fromFlags(['--preset', 'astro-tailwind']);
    expect(viaPreset.stack['framework']).toBe('preset');
    expect(viaPreset.sources['template.id']).toBe('default');
  });

  it('refuses an unknown preset rather than falling back', async () => {
    const error = await failure(['--preset', 'my-awesome-stack']);
    expect(error.message).toContain('Unknown preset "my-awesome-stack"');
    expect(error.hint).toContain('astro-tailwind');
    // The failure mode that matters: it must not quietly become the default.
    expect(error.message).not.toContain('astro-tailwind"');
  });

  it('refuses an unknown preset named in a config file', async () => {
    expect(textOf(await failure([], { stack: { preset: 'nope' } }))).toContain(
      'Unknown preset "nope"',
    );
  });
});

// ---------------------------------------------------------------------------
// Structural: presets are data
// ---------------------------------------------------------------------------

describe('the preset layer stays declarative', () => {
  const module = source('src/context/presets.ts');
  const code = module.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('touches no filesystem, process or network API', () => {
    for (const forbidden of [
      'node:fs',
      'node:path',
      'node:child_process',
      'readFileSync',
      'writeFileSync',
      'execSync',
      'spawn',
      'fetch(',
      'import(',
    ]) {
      expect(module, `presets.ts uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('generates nothing and composes nothing', () => {
    for (const forbidden of ['FileOperation', 'apply(', 'planManifest', 'composePackage']) {
      expect(module, `presets.ts references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('selects no adapter and evaluates no capability', () => {
    for (const forbidden of [
      'createAdapterRegistry',
      'checkCompatibility',
      'selectAdapters',
      'react-runtime',
      'document-metadata',
      'composed-stylesheet',
      'file-based-routing',
    ]) {
      expect(module, `presets.ts references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('branches on no preset id and no framework id', () => {
    // The registry returns data; the caller merges it. A branch here would be
    // the first step towards a compatibility matrix.
    for (const id of ['react-mui', 'react-tailwind', 'astro-tailwind', 'react-bootstrap']) {
      expect(code.includes(`=== '${id}'`), `presets.ts branches on ${id}`).toBe(false);
    }
    for (const name of ['astro', 'react', 'nextjs']) {
      expect(code.includes(`=== '${name}'`), `presets.ts branches on ${name}`).toBe(false);
    }
  });

  it('no definition names a template, a path or a file', () => {
    for (const preset of PRESETS.all()) {
      const serialised = JSON.stringify(preset);
      for (const forbidden of ['template', 'path', 'file', 'adapter', 'dist', 'node_modules']) {
        expect(serialised.toLowerCase(), `${preset.id} mentions ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it('every definition contains only dimension keys', () => {
    const allowed = new Set([
      'framework',
      'buildTool',
      'language',
      'styling',
      'uiLibrary',
      'router',
      'architecture',
      'features',
    ]);
    for (const preset of PRESETS.all()) {
      for (const key of Object.keys(preset.dimensions)) {
        expect(allowed.has(key), `${preset.id} states "${key}", which is not a dimension`).toBe(
          true,
        );
      }
    }
  });

  it('the resolver reads preset data generically', () => {
    const resolver = source('src/context/resolve.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const id of PRESETS.all().map((preset) => preset.id)) {
      expect(resolver, `resolve.ts names the ${id} preset`).not.toContain(`'${id}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same preset resolves identically twice', async () => {
    for (const preset of PRESETS.all()) {
      const first = await fromFlags(['--preset', preset.id]);
      const second = await fromFlags(['--preset', preset.id]);
      expect(JSON.stringify(first.manifest), preset.id).toBe(JSON.stringify(second.manifest));
    }
  });

  it('a preset plus an override is stable', async () => {
    const argv = ['--preset', 'react-tailwind', '--router', 'react-router', '--ui-library', 'mui'];
    expect(plan(await fromFlags(argv))).toBe(plan(await fromFlags(argv)));
  });

  it('preset features keep the shared ordering rules', async () => {
    const withFeatures = createPresetRegistry([
      {
        id: 'demo',
        displayName: 'Demo',
        description: 'a preset with features',
        dimensions: { framework: 'astro', features: ['structured-data', 'accessibility', 'seo'] },
      },
    ]);
    const { manifest } = await resolveContext({
      flags: parseCliArgs(['acme-site', '--yes', '--preset', 'demo']),
      cwd: TEST_CWD,
      env: {},
      prompter: new NonInteractivePrompter('t'),
      registry,
      cliVersion: '9.9.9',
      now: new Date('2026-01-01T00:00:00.000Z'),
      templatesRoot: TEMPLATES_ROOT,
      fs: emptyFs,
      presets: withFeatures,
    });
    expect(manifest.features).toEqual(['accessibility', 'seo', 'structured-data']);
  });
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

describe('help advertises exactly what exists', () => {
  const text = helpText();

  it('documents the flag', () => {
    expect(text).toContain('--preset');
  });

  it('lists every shipped preset, and nothing else', () => {
    const section = text.slice(text.indexOf('  Presets'), text.indexOf('  Stack'));
    for (const preset of PRESETS.all()) {
      expect(section, `help omits ${preset.id}`).toContain(preset.id);
      expect(section, `help omits the name of ${preset.id}`).toContain(preset.displayName);
    }
    // Every id the section advertises must resolve.
    for (const match of section.matchAll(/^ {6}(\S+)/gm)) {
      expect(PRESETS.has(match[1] as string), `help advertises "${match[1]}"`).toBe(true);
    }
  });

  it('says a preset is overridable', () => {
    expect(text).toMatch(/overridden/);
  });
});

// ---------------------------------------------------------------------------
// Through the command
// ---------------------------------------------------------------------------

describe('the create command honours a preset', () => {
  const create = async (argv: readonly string[]) => {
    const { dir, cleanup } = tempDir('preset');
    try {
      const { logger, out } = testLogger();
      const code = await runCreate({
        flags: parseCliArgs([path.join(dir, 'acme-site'), '--yes', '--dry-run', ...argv]),
        logger,
        registry,
        cliVersion: '9.9.9',
        cwd: dir,
        env: {},
        isTTY: false,
        nodeVersion: process.versions.node,
      });
      return { code, text: out.text, dir };
    } finally {
      cleanup();
    }
  };

  it('plans React for a React preset', async () => {
    const { code, text } = await create(['--preset', 'react-mui']);
    expect(code).toBe(0);
    expect(text).toContain('react-vite');
    expect(text).toContain('src/components/ui/AppProviders.tsx');
    expect(text).not.toContain('astro.config.mjs');
  });

  it('plans Astro for the Astro preset', async () => {
    const { code, text } = await create(['--preset', 'astro-tailwind']);
    expect(code).toBe(0);
    expect(text).toContain('astro.config.mjs');
  });

  it('shows the resolved stack and its provenance', async () => {
    const { text } = await create(['--preset', 'react-mui', '--debug']);
    expect(text).toContain('Stack');
    expect(text).toContain('[preset]');
  });

  it('honours an override on the command line', async () => {
    const { text } = await create(['--preset', 'react-mui', '--ui-library', 'none']);
    expect(text).not.toContain('src/components/ui/AppProviders.tsx');
  });

  it('writes nothing for an unknown preset', async () => {
    const { dir, cleanup } = tempDir('preset-bad');
    try {
      const target = path.join(dir, 'acme-site');
      const { logger } = testLogger();
      await expect(
        runCreate({
          flags: parseCliArgs([target, '--yes', '--preset', 'nope']),
          logger,
          registry,
          cliVersion: '9.9.9',
          cwd: dir,
          env: {},
          isTTY: false,
          nodeVersion: process.versions.node,
        }),
      ).rejects.toThrow(/Unknown preset/);
      expect(existsSync(target), 'a project directory was created').toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reads a preset from a config file on disk', async () => {
    const { dir, cleanup } = tempDir('preset-config');
    try {
      const configPath = path.join(dir, 'clientkit.json');
      writeFileSync(configPath, JSON.stringify({ stack: { preset: 'react-bootstrap' } }));
      const { logger, out } = testLogger();
      const code = await runCreate({
        flags: parseCliArgs([
          path.join(dir, 'acme-site'),
          '--yes',
          '--dry-run',
          '--from',
          configPath,
        ]),
        logger,
        registry,
        cliVersion: '9.9.9',
        cwd: dir,
        env: {},
        isTTY: false,
        nodeVersion: process.versions.node,
      });
      expect(code).toBe(0);
      expect(out.text).toContain('react-vite');
    } finally {
      cleanup();
    }
  });
});
