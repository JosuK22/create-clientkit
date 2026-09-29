import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { assertFlagCombinations, parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { promptDimensions } from '../src/context/interactive.js';
import { createPresetRegistry, PRESETS } from '../src/context/presets.js';
import { NonInteractivePrompter, type Prompter } from '../src/context/prompts.js';
import { resolveContext } from '../src/context/resolve.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { emptyFs, FakePrompter, renderPlan, testLogger, TEST_CWD } from './helpers.js';
import type { FakeAnswers } from './helpers.js';

/**
 * Presets composed with partial configuration.
 *
 * Stage 17 hid the preset menu the moment any dimension was settled, which was
 * a blunt reading of a real concern: a menu whose choices would be silently
 * overridden is misleading. But `--router react-router` settles one dimension
 * and leaves four, and hiding a menu that could still supply a framework, a
 * styling system and a component library helps nobody.
 *
 * The rule this stage replaces it with is per preset and about usefulness:
 *
 *     offer a preset if it states a dimension nothing has answered yet
 *
 * Everything else follows from it. A preset survives a flag that overlaps it,
 * because it still has the rest to give. It disappears when it has nothing left.
 * And it fills gaps rather than overwriting, so precedence is unchanged - which
 * is the property the equivalence tests at the bottom actually check.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const source = (relative: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');

/** The preset menu for a given partial input, without the surrounding resolver. */
const menu = async (input: Record<string, unknown>, answers: FakeAnswers = {}) => {
  const prompter = new FakePrompter(answers);
  const result = await promptDimensions({
    input,
    adapters,
    prompter,
    mode: 'coming-soon',
    presets: PRESETS,
  });
  const question = prompter.questions.find((entry) => entry.dimension === 'preset');
  return {
    ...result,
    prompter,
    /** The preset ids offered, without the trailing Custom. */
    offered: (question?.options ?? [])
      .map((option) => option.value)
      .filter((value) => value !== 'custom'),
    question,
  };
};

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

/** A run where the user picks a preset from the menu. */
const picking = (preset: string, argv: readonly string[] = [], file?: unknown) => {
  const prompter = new FakePrompter({ dir: 'acme-site', dimensions: { preset } });
  return resolve(
    ['acme-site', ...(file === undefined ? [] : ['--from', 'clientkit.json']), ...argv],
    { prompter, ...(file === undefined ? {} : { file }) },
  ).then((resolution) => ({ ...resolution, asked: prompter.asked }));
};

/** Non-interactive, flags only. */
const fromFlags = (argv: readonly string[]) => resolve(['acme-site', '--yes', ...argv]);

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
// Eligibility
// ---------------------------------------------------------------------------

describe('a preset is offered while it can still contribute', () => {
  it('offers the Start from presets when nothing is settled', async () => {
    expect((await menu({})).offered).toEqual(PRESETS.startFrom().map((preset) => preset.id));
    expect((await menu({})).offered).toEqual([
      'astro-tailwind',
      'react-tailwind',
      'nextjs-tailwind',
    ]);
  });

  const partial: readonly [string, Record<string, unknown>][] = [
    ['framework only', { framework: 'react' }],
    ['router only', { router: 'react-router' }],
    ['styling only', { styling: 'tailwind' }],
    ['UI library only', { uiLibrary: 'mui' }],
    ['build tool only', { framework: 'react', buildTool: 'vite' }],
    ['features only', { features: ['seo'] }],
  ];

  for (const [name, input] of partial) {
    it(`still offers presets with ${name} settled`, async () => {
      const { offered, asked } = await menu(input);
      expect(asked, name).toContain('preset');
      expect(offered.length, name).toBeGreaterThan(0);
    });
  }

  it('keeps a preset whose dimension is settled differently, if it adds anything else', async () => {
    // `--framework react` and `astro-tailwind` disagree about the framework.
    // The preset stays, because it can still supply the styling system, and
    // the explicit framework wins - which is precedence, not a conflict.
    const { offered } = await menu({ framework: 'react' });
    expect(offered).toContain('astro-tailwind');
  });

  it('drops a preset once everything it states is settled', async () => {
    // Every Start from preset states a framework and a styling system; with
    // both answered, none has anything left to give, so none is offered.
    const { offered, asked } = await menu({ framework: 'react', styling: 'tailwind' });
    expect(offered).toEqual([]);
    expect(asked).not.toContain('preset');
  });

  it('skips the question entirely when no preset can contribute', async () => {
    const { asked } = await menu({ framework: 'react', styling: 'tailwind', uiLibrary: 'mui' });
    expect(asked).not.toContain('preset');
  });

  it('says what a partial contribution would actually set', async () => {
    // The label of a preset whose framework is already decided would otherwise
    // promise something the flag has settled.
    const { question } = await menu({ framework: 'react' });
    const astro = question?.options.find((option) => option.value === 'astro-tailwind');
    expect(astro?.label).toBe('Astro + Tailwind');
    expect(astro?.hint).toBe('sets styling');
  });

  it('keeps its own description when it contributes everything it states', async () => {
    const { question } = await menu({});
    const astro = question?.options.find((option) => option.value === 'astro-tailwind');
    expect(astro?.hint).toBe(PRESETS.get('astro-tailwind').description);
  });

  it('always offers Custom', async () => {
    for (const input of [{}, { framework: 'react' }, { router: 'react-router' }]) {
      const prompter = new FakePrompter({});
      await promptDimensions({
        input,
        adapters,
        prompter,
        mode: 'coming-soon',
        presets: PRESETS,
      });
      const question = prompter.questions.find((entry) => entry.dimension === 'preset');
      expect(
        question?.options.map((option) => option.value),
        JSON.stringify(input),
      ).toContain('custom');
    }
  });

  it('defaults to the first preset that is whole and buildable', async () => {
    const initial = async (input: Record<string, unknown>) =>
      (await menu(input)).question?.initialValue;
    expect(await initial({})).toBe('astro-tailwind');
    // Astro cannot take React Router or MUI, so Enter skips it rather than
    // walking into the compatibility engine's refusal.
    expect(await initial({ router: 'react-router' })).toBe('react-tailwind');
    expect(await initial({ uiLibrary: 'mui' })).toBe('react-tailwind');
  });

  it('defaults to Custom when every preset would only partly apply', async () => {
    // Under `--framework react`, Enter on "Astro + Tailwind" would take only its
    // styling - a stack its name does not describe.
    for (const input of [{ framework: 'react' }, { styling: 'bootstrap' }]) {
      const { question } = await menu(input);
      expect(question?.initialValue, JSON.stringify(input)).toBe('custom');
    }
  });

  it('Custom seeds nothing', async () => {
    // `input` still grows, because the ordinary dimension questions follow and
    // the fake answers them with their defaults. What Custom must not do is
    // contribute anything of its own, which is what `presetSeeded` records.
    const { presetSeeded } = await menu(
      { router: 'react-router' },
      { dimensions: { preset: 'custom' } },
    );
    expect(presetSeeded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe('a chosen preset fills gaps and never overwrites', () => {
  it('seeds only what was unresolved', async () => {
    const { presetSeeded, input } = await menu(
      { router: 'react-router' },
      { dimensions: { preset: 'react-tailwind' } },
    );
    expect(presetSeeded).toEqual(['framework', 'styling']);
    expect(input).toMatchObject({
      framework: 'react',
      styling: 'tailwind',
      router: 'react-router',
    });
  });

  it('leaves a settled dimension alone', async () => {
    const { presetSeeded, input } = await menu(
      { uiLibrary: 'mui' },
      { dimensions: { preset: 'react-tailwind' } },
    );
    expect(presetSeeded).toEqual(['framework', 'styling']);
    expect(input.uiLibrary).toBe('mui');
  });

  it('leaves a settled dimension alone even when the preset disagrees', async () => {
    const { presetSeeded, input } = await menu(
      { styling: 'bootstrap' },
      { dimensions: { preset: 'react-tailwind' } },
    );
    expect(presetSeeded).toEqual(['framework']);
    expect(input.styling).toBe('bootstrap');
  });

  it('does not mutate the preset definition', async () => {
    const before = JSON.stringify(PRESETS.get('react-tailwind'));
    await menu({ styling: 'bootstrap' }, { dimensions: { preset: 'react-tailwind' } });
    expect(JSON.stringify(PRESETS.get('react-tailwind'))).toBe(before);
  });

  it('still asks for what neither the flags nor the preset settled', async () => {
    const { asked } = await menu(
      { styling: 'bootstrap' },
      { dimensions: { preset: 'react-tailwind' } },
    );
    // `react-tailwind` supplies the framework; the router is nobody's.
    expect(asked).toContain('router');
    expect(asked).not.toContain('framework');
    expect(asked).not.toContain('styling');
  });
});

// ---------------------------------------------------------------------------
// The full flow, through the resolver
// ---------------------------------------------------------------------------

describe('partial configuration plus a chosen preset', () => {
  it('a router flag and an interactively chosen preset compose', async () => {
    const { manifest } = await picking('react-tailwind', ['--router', 'react-router']);
    expect(manifest).toMatchObject({
      framework: 'react',
      styling: 'tailwind',
      router: 'react-router',
    });
  });

  it('and equals the fully explicit flags', async () => {
    const composed = await picking('react-tailwind', ['--router', 'react-router']);
    const explicit = await fromFlags([
      '--framework',
      'react',
      '--styling',
      'tailwind',
      '--router',
      'react-router',
    ]);
    expect(composed.manifest).toEqual(explicit.manifest);
    expect(plan(composed)).toBe(plan(explicit));
  });

  it('a config value and a chosen preset compose', async () => {
    const { manifest } = await picking('react-tailwind', [], { stack: { uiLibrary: 'mui' } });
    expect(manifest).toMatchObject({
      framework: 'react',
      styling: 'tailwind',
      uiLibrary: 'mui',
    });
  });

  it('a config value beats the preset it overlaps', async () => {
    const { manifest } = await picking('react-tailwind', [], { stack: { styling: 'bootstrap' } });
    expect(manifest).toMatchObject({ framework: 'react', styling: 'bootstrap' });
  });

  it('a flag beats the preset it overlaps', async () => {
    const { manifest } = await picking('react-tailwind', ['--styling', 'bootstrap']);
    expect(manifest).toMatchObject({ framework: 'react', styling: 'bootstrap' });
  });

  it('an explicit flag beats a config value beats the preset', async () => {
    const { manifest } = await picking('react-tailwind', ['--ui-library', 'none'], {
      stack: { styling: 'bootstrap', uiLibrary: 'mui' },
    });
    expect(manifest).toMatchObject({
      framework: 'react', // preset
      styling: 'bootstrap', // file, beating the preset
      uiLibrary: 'none', // flag, beating the file
    });
  });

  it('a named preset is not asked about again', async () => {
    const { asked, manifest } = await picking('react-tailwind', ['--preset', 'react-mui']);
    expect(asked).not.toContain('preset');
    // The named one won; the menu never appeared to offer the other.
    expect(manifest.uiLibrary).toBe('mui');
  });

  it('a preset named in a config file is not asked about again', async () => {
    const { asked, manifest } = await picking('react-tailwind', [], {
      stack: { preset: 'react-bootstrap' },
    });
    expect(asked).not.toContain('preset');
    expect(manifest.styling).toBe('bootstrap');
  });
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

describe('features follow the same rules as every other dimension', () => {
  const withFeatures = createPresetRegistry([
    {
      id: 'opinionated',
      displayName: 'Opinionated',
      description: 'a preset that picks features too',
      dimensions: { framework: 'astro', features: ['seo', 'accessibility'] },
      startFrom: true,
    },
  ]);

  const pick = (argv: readonly string[]) => {
    const prompter = new FakePrompter({ dir: 'acme-site', dimensions: { preset: 'opinionated' } });
    return resolveContext({
      flags: parseCliArgs(['acme-site', ...argv]),
      cwd: TEST_CWD,
      env: {},
      prompter,
      registry,
      cliVersion: '9.9.9',
      now: new Date('2026-01-01T00:00:00.000Z'),
      templatesRoot: TEMPLATES_ROOT,
      fs: emptyFs,
      presets: withFeatures,
    });
  };

  it('a chosen preset can seed features', async () => {
    expect((await pick([])).manifest.features).toEqual(['accessibility', 'seo']);
  });

  it('an explicit feature flag settles the dimension, so the preset does not seed it', async () => {
    const { manifest } = await pick(['--features', 'structured-data']);
    expect(manifest.features).toEqual(['structured-data']);
    expect(manifest.features).not.toContain('seo');
  });

  it('an empty feature flag is not a settled feature list', async () => {
    // `flags.features` is `[]` when the flag was never passed, and an empty
    // array must not count as an answer - otherwise a preset could never seed
    // features at all.
    expect((await pick([])).manifest.features).toContain('seo');
  });

  it('an empty array reaching the prompt layer is still not an answer', async () => {
    /*
     * The resolver normalises `[]` to `undefined` before it gets here, so the
     * test above cannot see the difference - a mutation making emptiness count
     * as settled survived the entire suite for exactly that reason.
     *
     * The semantic belongs to `DimensionInput` rather than to the resolver: an
     * empty feature list means "nothing stated", and any caller constructing
     * one honestly is entitled to that meaning. So it is asserted here, at the
     * boundary where the rule actually lives.
     */
    const prompter = new FakePrompter({ dimensions: { preset: 'opinionated' } });
    const result = await promptDimensions({
      input: { features: [] },
      adapters,
      prompter,
      mode: 'coming-soon',
      presets: withFeatures,
    });
    expect(result.presetSeeded).toContain('features');
    expect(result.input.features).toEqual(['seo', 'accessibility']);
  });

  it('a non-empty array reaching the prompt layer is an answer', async () => {
    const prompter = new FakePrompter({ dimensions: { preset: 'opinionated' } });
    const result = await promptDimensions({
      input: { features: ['structured-data'] },
      adapters,
      prompter,
      mode: 'coming-soon',
      presets: withFeatures,
    });
    expect(result.presetSeeded).not.toContain('features');
    expect(result.input.features).toEqual(['structured-data']);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe('provenance names the layer that actually won', () => {
  it('labels interactively seeded values as preset', async () => {
    const { stack } = await picking('react-tailwind', ['--router', 'react-router']);
    expect(stack['framework']).toBe('preset');
    expect(stack['styling']).toBe('preset');
    // The preset does not state one; it was asked.
    expect(stack['uiLibrary']).toBe('prompt');
    expect(stack['router']).toBe('flag');
  });

  it('labels an overridden dimension by its winner, not by the preset', async () => {
    const { stack } = await picking('react-tailwind', ['--ui-library', 'none'], {
      stack: { styling: 'bootstrap' },
    });
    expect(stack['framework']).toBe('preset');
    expect(stack['styling']).toBe('file');
    expect(stack['uiLibrary']).toBe('flag');
  });

  it('records no dimension row for the preset question itself', async () => {
    // `preset` is a question, not a dimension; a source beside a value the
    // summary never prints would be noise.
    const { stack } = await picking('react-tailwind');
    expect(stack['preset']).toBeUndefined();
  });

  it('attributes a derived dimension to the framework that decided it', async () => {
    // Stage 18 left this blank; Stage 19 fills it. Vite is React's declaration
    // speaking, not a user choice and not a built-in preference.
    const { stack } = await picking('react-tailwind');
    expect(stack['buildTool']).toBe('adapter');
    expect(stack['language']).toBe('adapter');
    expect(stack['architecture']).toBe('adapter');
  });
});

// ---------------------------------------------------------------------------
// Nothing is chosen for the user
// ---------------------------------------------------------------------------

describe('a preset is never inferred', () => {
  it('flags that resemble a preset do not become one', async () => {
    const { stack, manifest } = await fromFlags(['--framework', 'react', '--styling', 'tailwind']);
    expect(stack['framework']).toBe('flag');
    expect(stack['styling']).toBe('flag');
    expect(manifest).toMatchObject({ framework: 'react', styling: 'tailwind' });
  });

  it('--yes with no preset resolves the default stack', async () => {
    const { manifest, stack } = await fromFlags([]);
    expect(manifest.framework).toBe('astro');
    expect(manifest.styling).toBe('tailwind');
    // Attributed to the built-in default, never to a preset - the distinction
    // this whole section exists to hold.
    expect(stack['framework']).toBe('default');
    expect(stack['styling']).toBe('default');
  });

  it('--yes never reaches the preset question', async () => {
    // A `NonInteractivePrompter` throws on any question, so resolving is proof.
    const { manifest } = await fromFlags(['--router', 'react-router', '--framework', 'react']);
    expect(manifest.router).toBe('react-router');
  });

  it('pressing Enter on Start from takes Astro + Tailwind, and says it was the preset', async () => {
    // The interactive default is a preset the user saw and accepted, so it is
    // credited to the preset - unlike --yes, above, which never shows the menu.
    const prompter = new FakePrompter({ dir: 'acme-site' });
    const { manifest, stack } = await resolve(['acme-site'], { prompter });
    expect(manifest).toMatchObject({ framework: 'astro', styling: 'tailwind' });
    expect(prompter.asked).toContain('preset');
    expect(prompter.asked).not.toContain('framework');
    expect(stack['framework']).toBe('preset');
    // The same stack as the flag-less default: only the attribution differs.
    expect(manifest).toEqual((await fromFlags([])).manifest);
  });
});

// ---------------------------------------------------------------------------
// Compatibility and the template policy are untouched
// ---------------------------------------------------------------------------

describe('the boundaries Stage 17 drew still hold', () => {
  it('a composed stack that cannot be built is refused by the engine', async () => {
    // `--ui-library mui` plus the Astro preset: MUI needs `react-runtime`.
    const { manifest } = await picking('astro-tailwind', ['--ui-library', 'mui']);
    expect(manifest).toMatchObject({ framework: 'astro', uiLibrary: 'mui' });

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
    expect(`${error?.message}\n${error?.hint}`).toContain('react-runtime');
  });

  it('template and preset are still refused together', () => {
    const flags = parseCliArgs(['acme', '--template', 'astro-tailwind', '--preset', 'react-mui']);
    expect(() => assertFlagCombinations(flags)).toThrow(/--template cannot be combined/);
  });

  it('an unknown preset is still refused', async () => {
    await expect(fromFlags(['--preset', 'nope'])).rejects.toThrow(/Unknown preset "nope"/);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the offered set is stable for the same partial input', async () => {
    for (const input of [{}, { framework: 'react' }, { styling: 'tailwind' }]) {
      const first = await menu(input);
      const second = await menu(input);
      expect(first.offered, JSON.stringify(input)).toEqual(second.offered);
    }
  });

  it('the offered set follows the registry order', async () => {
    const order = PRESETS.all().map((preset) => preset.id);
    const { offered } = await menu({ framework: 'react' });
    expect(offered).toEqual(order.filter((id) => offered.includes(id)));
  });

  it('the seeded order is stable', async () => {
    const a = await menu({ router: 'react-router' }, { dimensions: { preset: 'react-tailwind' } });
    const b = await menu({ router: 'react-router' }, { dimensions: { preset: 'react-tailwind' } });
    expect(a.presetSeeded).toEqual(b.presetSeeded);
  });

  it('the same composition resolves to the same plan twice', async () => {
    const once = await picking('react-tailwind', ['--router', 'react-router']);
    const twice = await picking('react-tailwind', ['--router', 'react-router']);
    expect(plan(once)).toBe(plan(twice));
  });
});

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

describe('the selection logic stays declarative', () => {
  const interactive = source('src/context/interactive.ts');
  const code = interactive.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('names no capability', () => {
    for (const capability of [
      'document-metadata',
      'react-runtime',
      'composed-stylesheet',
      'client-side-routing',
      'file-based-routing',
    ]) {
      expect(code, `interactive.ts mentions ${capability}`).not.toContain(capability);
    }
  });

  it('branches on no framework and no preset id', () => {
    for (const name of ['astro', 'react', 'nextjs']) {
      expect(code.includes(`=== '${name}'`), `branches on ${name}`).toBe(false);
    }
    for (const preset of PRESETS.all()) {
      expect(code, `names the ${preset.id} preset`).not.toContain(`'${preset.id}'`);
    }
  });

  it('touches no filesystem and generates nothing', () => {
    for (const forbidden of [
      'node:fs',
      'writeFileSync',
      'readFileSync',
      'FileOperation',
      'apply(',
      'planManifest',
    ]) {
      expect(interactive, `interactive.ts uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('reads eligibility from dimension keys rather than adapter internals', () => {
    // The whole rule is "does the preset state a key nothing has answered".
    expect(code).toContain('settled(');
    expect(code).not.toContain(
      'architectureDefinitions.find((definition) => definition.id === key',
    );
  });
});

// ---------------------------------------------------------------------------
// Through the command
// ---------------------------------------------------------------------------

describe('the create command composes them', () => {
  const create = async (argv: readonly string[], answers: FakeAnswers = {}) => {
    const { logger, out } = testLogger();
    const code = await runCreate({
      flags: parseCliArgs(['acme-site', '--dry-run', ...argv]),
      logger,
      registry,
      cliVersion: '9.9.9',
      cwd: TEST_CWD,
      env: {},
      isTTY: true,
      nodeVersion: process.versions.node,
      prompter: new FakePrompter({ dir: 'acme-site', ...answers }),
    });
    return { code, text: out.text };
  };

  it('a router flag plus a chosen preset reaches the plan', async () => {
    const { code, text } = await create(['--router', 'react-router', '--ui-library', 'mui'], {
      dimensions: { preset: 'react-tailwind' },
    });
    expect(code).toBe(0);
    expect(text).toContain('react-vite');
    expect(text).toContain('src/routes/AppRouter.tsx');
    expect(text).toContain('src/components/ui/AppProviders.tsx');
  });

  it('shows the composed provenance', async () => {
    const { text } = await create(['--router', 'react-router', '--debug'], {
      dimensions: { preset: 'react-tailwind' },
    });
    expect(text).toContain('[preset]');
    expect(text).toContain('[flag]');
  });

  it('a styling flag plus a chosen preset reaches the plan', async () => {
    const { text } = await create(['--styling', 'bootstrap', '--ui-library', 'mui'], {
      dimensions: { preset: 'react-tailwind' },
    });
    expect(text).toContain('react-vite');
    expect(text).toContain('src/components/ui/AppProviders.tsx');
  });

  it('a fully specified stack asks no preset question', async () => {
    const { logger } = testLogger();
    const prompter = new FakePrompter({ dir: 'acme-site' });
    await runCreate({
      flags: parseCliArgs([
        'acme-site',
        '--dry-run',
        '--framework',
        'react',
        '--styling',
        'tailwind',
        '--ui-library',
        'mui',
      ]),
      logger,
      registry,
      cliVersion: '9.9.9',
      cwd: TEST_CWD,
      env: {},
      isTTY: true,
      nodeVersion: process.versions.node,
      prompter,
    });
    expect(prompter.asked).not.toContain('preset');
  });
});
