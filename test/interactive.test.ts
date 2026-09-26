import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { promptDimensions } from '../src/context/interactive.js';
import { NonInteractivePrompter } from '../src/context/prompts.js';
import { resolveContext } from '../src/context/resolve.js';
import { manifestFromProjectContext } from '../src/domain/manifest.js';
import { CancelledError, CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { emptyFs, FakePrompter, renderPlan, testLogger, TEST_CWD } from './helpers.js';
import type { FakeAnswers } from './helpers.js';

/**
 * Interactive stack selection, and the single claim it rests on.
 *
 * The prompts are an input mechanism, not a configuration system. Whatever a
 * user answers travels the same road a flag does - the same `DimensionInput`,
 * the same `resolveDimensions`, the same `manifestFrom` - so the two cannot
 * drift apart without one of these tests noticing.
 *
 * Two groups of assertions carry most of the weight. The equivalence tests say
 * that answering the questions and typing the flags produce the *same*
 * manifest. The structural tests say the prompt layer holds no compatibility
 * rule of its own: it asks the engine which choices are worth offering, and a
 * menu that dropped Bootstrap under Astro did so because Astro's adapter says
 * it provides no `composed-stylesheet`, not because a list here says so.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const source = (relative: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');

/** Drives the real resolver with a scripted user. */
const run = async (argv: readonly string[], answers: FakeAnswers = {}) => {
  const prompter = new FakePrompter({ dir: 'acme-site', ...answers });
  const resolution = await resolveContext({
    flags: parseCliArgs([...argv]),
    cwd: TEST_CWD,
    env: {},
    prompter,
    registry,
    cliVersion: '9.9.9',
    now: new Date('2026-01-01T00:00:00.000Z'),
    templatesRoot: TEMPLATES_ROOT,
    fs: emptyFs,
  });
  return { ...resolution, asked: prompter.asked, prompter };
};

/** The same resolver, non-interactively, as `--yes` drives it. */
const runFlags = async (argv: readonly string[]) =>
  resolveContext({
    flags: parseCliArgs(['acme-site', '--yes', ...argv]),
    cwd: TEST_CWD,
    env: {},
    prompter: new NonInteractivePrompter('test'),
    registry,
    cliVersion: '9.9.9',
    now: new Date('2026-01-01T00:00:00.000Z'),
    templatesRoot: TEMPLATES_ROOT,
    fs: emptyFs,
  });

/** Just the menus, without the surrounding resolver. */
const menus = async (input: Record<string, unknown>, answers: FakeAnswers = {}) => {
  const prompter = new FakePrompter(answers);
  const result = await promptDimensions({
    input,
    adapters,
    prompter,
    mode: 'coming-soon',
  });
  const optionsFor = (dimension: string): readonly string[] =>
    [...prompter.questions, ...prompter.multiQuestions]
      .filter((question) => question.dimension === dimension)
      .flatMap((question) => question.options.map((option) => option.value));
  return { ...result, prompter, optionsFor };
};

// ---------------------------------------------------------------------------
// Accepting every default
// ---------------------------------------------------------------------------

describe('a user who presses Enter through the whole flow gets V1', () => {
  it('resolves the Astro stack, unchanged', async () => {
    const { manifest } = await run([]);
    expect(manifest).toMatchObject({
      framework: 'astro',
      buildTool: 'astro',
      language: 'ts',
      styling: 'tailwind',
      uiLibrary: 'none',
      router: 'file-based',
      architecture: 'astro-standard',
      starter: 'coming-soon',
      features: [],
    });
  });

  it('produces exactly the manifest the V1 bridge derives', async () => {
    // The same assertion Stage 14 makes for flags, now for answers. If the
    // interactive path ever invented a default of its own, this is what fails.
    const { context, manifest } = await run([]);
    expect(manifest).toEqual(manifestFromProjectContext(context));
  });

  it('offers the current value as the default of every question', async () => {
    const { prompter } = await run([]);
    for (const question of prompter.questions) {
      expect(
        question.options.map((option) => option.value),
        `${question.dimension} defaults to something it does not offer`,
      ).toContain(question.initialValue);
    }
    expect(prompter.questions.find((q) => q.dimension === 'framework')?.initialValue).toBe('astro');

    /*
     * Styling is no longer among the questions on the default path. Astro
     * requires a CSS framework since Stage 52 - its config imports one - so
     * Tailwind is the only survivor and a one-answer dimension is derived. The
     * default is still asserted, on a framework that genuinely offers a choice.
     */
    const { prompter: reactPrompter } = await run(['--framework', 'react']);
    expect(reactPrompter.questions.find((q) => q.dimension === 'styling')?.initialValue).toBe(
      'tailwind',
    );
  });

  it('selects no feature unless one is chosen', async () => {
    const { manifest } = await run([]);
    expect(manifest.features).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Which questions are worth asking
// ---------------------------------------------------------------------------

describe('questions with one answer are derived, not asked', () => {
  it('never asks for a build tool, because neither framework offers a choice', async () => {
    for (const framework of ['astro', 'react']) {
      const { asked } = await menus({ framework });
      expect(asked, framework).not.toContain('buildTool');
    }
  });

  it('never asks for a language or an architecture today', async () => {
    for (const framework of ['astro', 'react']) {
      const { asked } = await menus({ framework });
      expect(asked, framework).not.toContain('language');
      expect(asked, framework).not.toContain('architecture');
    }
  });

  it('derives them correctly all the same', async () => {
    const { manifest } = await run([], { dimensions: { framework: 'react' } });
    expect(manifest.buildTool).toBe('vite');
    expect(manifest.language).toBe('ts');
    expect(manifest.architecture).toBe('react-standard');
  });

  it('does not ask Astro for a router, which it fixes', async () => {
    const { asked } = await menus({ framework: 'astro' });
    expect(asked).not.toContain('router');
  });

  it('asks React for a router, which it genuinely offers', async () => {
    const { asked, optionsFor } = await menus({ framework: 'react' });
    expect(asked).toContain('router');
    expect(optionsFor('router')).toEqual(['none', 'react-router']);
  });

  it('would ask the moment a framework offered two of anything', () => {
    // The rule is a property of the declaration, not of a framework name: a
    // `choice` of two is asked, anything else is derived.
    const react = adapters.framework('react');
    expect(react.buildTools.kind).toBe('choice');
    expect(react.buildTools.kind === 'choice' && react.buildTools.options).toHaveLength(1);
    expect(react.routers.kind === 'choice' && react.routers.options.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Compatibility decides the menu, and the engine decides compatibility
// ---------------------------------------------------------------------------

describe('impossible combinations are never offered', () => {
  it('does not ask about styling under Astro, because only one answer survives', async () => {
    /*
     * This expected `['tailwind', 'none']` through Stage 51. Stage 52 built the
     * combinations rather than trusting them and found that `none` produced a
     * project that would not build - Astro's shipped config imports a CSS
     * framework plugin whose dependency arrives with the styling adapter - so
     * Astro now requires one.
     *
     * Bootstrap was already refused here, for its own reason, and still is.
     * With `none` gone too, Tailwind is the only survivor, and the same rule
     * that hides the component-library question hides this one: a dimension
     * with one possible answer is derived rather than shown as a menu of one.
     */
    const { optionsFor } = await menus({ framework: 'astro' });
    expect(optionsFor('styling')).toEqual([]);
  });

  it('still derives Tailwind for Astro rather than leaving it unset', async () => {
    const { manifest } = await run(['--framework', 'astro']);
    expect(manifest.styling).toBe('tailwind');
  });

  it('does offer Bootstrap under React', async () => {
    const { optionsFor } = await menus({ framework: 'react' });
    expect(optionsFor('styling')).toContain('bootstrap');
  });

  it('does not offer a component library where none can be mounted', async () => {
    // MUI needs `react-runtime`; Astro has none. One survivor is a derivation,
    // so the question disappears rather than showing a menu of one.
    const { asked } = await menus({ framework: 'astro' });
    expect(asked).not.toContain('uiLibrary');
  });

  it('offers MUI and Chakra UI under React', async () => {
    const { optionsFor } = await menus({ framework: 'react' });
    expect(optionsFor('uiLibrary')).toEqual(['chakra', 'mui', 'none']);
  });

  it('offers Astro the features Astro can have', async () => {
    const { optionsFor } = await menus({ framework: 'astro' });
    expect(optionsFor('features')).toEqual([
      'accessibility',
      'not-found',
      'seo',
      'structured-data',
    ]);
  });

  it('never offers React the file-based not-found', async () => {
    const { optionsFor } = await menus(
      { framework: 'react' },
      { dimensions: { router: 'react-router' } },
    );
    expect(optionsFor('features')).not.toContain('not-found');
  });

  it('offers the client-side fallback only once a router is chosen', async () => {
    const withRouter = await menus(
      { framework: 'react' },
      { dimensions: { router: 'react-router' } },
    );
    expect(withRouter.optionsFor('features')).toEqual(['client-route-fallback']);

    // Without one, nothing is offerable at all, so the question is skipped
    // rather than shown empty.
    const withoutRouter = await menus({ framework: 'react' }, { dimensions: { router: 'none' } });
    expect(withoutRouter.asked).not.toContain('features');
  });

  it('names each choice the way its own adapter does', async () => {
    const { prompter } = await menus({ framework: 'react' });
    const labels = new Map(
      prompter.questions.flatMap((question) =>
        question.options.map((option) => [option.value, option.label] as const),
      ),
    );
    expect(labels.get('mui')).toBe(adapters.uiLibrary('mui').declaration.displayName);
    expect(labels.get('bootstrap')).toBe(adapters.styling('bootstrap').declaration.displayName);
    expect(labels.get('react-router')).toBe(
      adapters.router('react-router').declaration.displayName,
    );
  });
});

// ---------------------------------------------------------------------------
// Explicit flags win
// ---------------------------------------------------------------------------

describe('a dimension given as a flag is never asked about', () => {
  it('skips the framework question when --framework is supplied', async () => {
    const { asked, manifest } = await run(['acme-site', '--framework', 'react']);
    expect(asked).not.toContain('framework');
    expect(manifest.framework).toBe('react');
  });

  it('skips both when two flags are supplied', async () => {
    const { asked } = await run(['acme-site', '--framework', 'react', '--styling', 'tailwind']);
    expect(asked).not.toContain('framework');
    expect(asked).not.toContain('styling');
  });

  it('still asks for the dimensions that were left out', async () => {
    const { asked } = await run(['acme-site', '--framework', 'react']);
    expect(asked).toContain('styling');
    expect(asked).toContain('uiLibrary');
    expect(asked).toContain('router');
  });

  it('asks nothing about the stack when every dimension is supplied', async () => {
    const { asked } = await run([
      'acme-site',
      '--framework',
      'react',
      '--styling',
      'tailwind',
      '--ui-library',
      'mui',
      '--router',
      'react-router',
      '--features',
      'client-route-fallback',
    ]);
    for (const dimension of ['framework', 'styling', 'uiLibrary', 'router', 'features']) {
      expect(asked, `${dimension} was asked though a flag supplied it`).not.toContain(dimension);
    }
  });

  it('a flag beats an answer the fake would have given', async () => {
    // The fake is told to answer `astro`; the flag says `react`. The flag wins
    // by the question never being put, which is the only way it can.
    const { manifest, asked } = await run(['acme-site', '--framework', 'react'], {
      dimensions: { framework: 'astro' },
    });
    expect(manifest.framework).toBe('react');
    expect(asked).not.toContain('framework');
  });

  it('a feature flag suppresses the feature question entirely', async () => {
    const { asked, manifest } = await run([
      'acme-site',
      '--framework',
      'react',
      '--router',
      'react-router',
      '--features',
      'client-route-fallback',
    ]);
    expect(asked).not.toContain('features');
    expect(manifest.features).toEqual(['client-route-fallback']);
  });
});

// ---------------------------------------------------------------------------
// The equivalence this stage exists to guarantee
// ---------------------------------------------------------------------------

describe('answering the questions and typing the flags produce one manifest', () => {
  const cases: readonly {
    name: string;
    answers: FakeAnswers;
    flags: readonly string[];
  }[] = [
    { name: 'the default stack', answers: {}, flags: [] },
    {
      name: 'React + Tailwind + React Router',
      answers: { dimensions: { framework: 'react', styling: 'tailwind', router: 'react-router' } },
      flags: ['--framework', 'react', '--styling', 'tailwind', '--router', 'react-router'],
    },
    {
      name: 'React + MUI',
      answers: {
        dimensions: {
          framework: 'react',
          styling: 'tailwind',
          uiLibrary: 'mui',
          router: 'react-router',
        },
      },
      flags: [
        '--framework',
        'react',
        '--styling',
        'tailwind',
        '--ui-library',
        'mui',
        '--router',
        'react-router',
      ],
    },
    {
      name: 'React + Bootstrap',
      answers: { dimensions: { framework: 'react', styling: 'bootstrap', router: 'none' } },
      flags: ['--framework', 'react', '--styling', 'bootstrap', '--router', 'none'],
    },
    {
      name: 'React + a feature',
      answers: {
        dimensions: { framework: 'react', styling: 'tailwind', router: 'react-router' },
        features: ['client-route-fallback'],
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
    },
    {
      name: 'Astro + three features',
      answers: {
        dimensions: { framework: 'astro', styling: 'tailwind' },
        features: ['seo', 'structured-data', 'accessibility'],
      },
      flags: ['--features', 'seo,structured-data,accessibility'],
    },
  ];

  for (const entry of cases) {
    it(`${entry.name}: the same manifest`, async () => {
      const interactive = await run(['acme-site'], entry.answers);
      const explicit = await runFlags(entry.flags);
      expect(interactive.manifest).toEqual(explicit.manifest);
    });

    it(`${entry.name}: the same generation plan`, async () => {
      /*
       * Compared as rendered plans rather than manifests, so a difference
       * anywhere downstream - a file, a dependency, a byte of composed output -
       * would show. The manifest being equal should make this redundant; it is
       * here because "should" is not a test.
       */
      const interactive = await run(['acme-site'], entry.answers);
      const explicit = await runFlags(entry.flags);
      const plan = (resolution: typeof interactive | typeof explicit) =>
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
      expect(plan(interactive)).toBe(plan(explicit));
    });
  }

  it('a half-answered, half-flagged run equals the fully-flagged one', async () => {
    const mixed = await run(['acme-site', '--framework', 'react', '--styling', 'bootstrap'], {
      dimensions: { uiLibrary: 'none', router: 'react-router' },
    });
    const explicit = await runFlags([
      '--framework',
      'react',
      '--styling',
      'bootstrap',
      '--ui-library',
      'none',
      '--router',
      'react-router',
    ]);
    expect(mixed.manifest).toEqual(explicit.manifest);
  });
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

describe('feature selection', () => {
  it('none selected leaves only the starter', async () => {
    const { manifest } = await run(['acme-site'], { features: [] });
    expect(manifest.features).toEqual([]);
  });

  it('one selected reaches the manifest', async () => {
    const { manifest } = await run(['acme-site'], { features: ['seo'] });
    expect(manifest.features).toEqual(['seo']);
  });

  it('several are sorted, whatever order they were ticked in', async () => {
    const forwards = await run(['acme-site'], {
      features: ['structured-data', 'accessibility', 'seo'],
    });
    const backwards = await run(['acme-site'], {
      features: ['seo', 'accessibility', 'structured-data'],
    });
    expect(forwards.manifest.features).toEqual(['accessibility', 'seo', 'structured-data']);
    expect(forwards.manifest.features).toEqual(backwards.manifest.features);
  });

  it('goes through the same parser the flag does', async () => {
    // The answers are handed back comma-joined, exactly as `--features a,b`
    // arrives, so trimming, de-duplication, sorting and refusal are one
    // implementation rather than two.
    const interactive = await run(['acme-site'], { features: ['seo', 'accessibility'] });
    const explicit = await runFlags(['--features', 'accessibility,seo']);
    expect(interactive.manifest.features).toEqual(explicit.manifest.features);
  });

  it('the starter is not selectable as a feature', async () => {
    const { optionsFor } = await menus({});
    for (const option of optionsFor('features')) {
      expect(option.startsWith('starter:'), `${option} was offered as a feature`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// --yes and non-interactive
// ---------------------------------------------------------------------------

describe('--yes', () => {
  it('asks nothing about the stack', async () => {
    const prompter = new NonInteractivePrompter('--yes was passed');
    const { manifest } = await resolveContext({
      flags: parseCliArgs(['acme-site', '--yes']),
      cwd: TEST_CWD,
      env: {},
      prompter,
      registry,
      cliVersion: '9.9.9',
      now: new Date('2026-01-01T00:00:00.000Z'),
      templatesRoot: TEMPLATES_ROOT,
      fs: emptyFs,
    });
    expect(manifest.framework).toBe('astro');
    expect(manifest.styling).toBe('tailwind');
    expect(manifest.features).toEqual([]);
  });

  it('resolves the same stack it did before the prompts existed', async () => {
    const { context, manifest } = await runFlags([]);
    expect(manifest).toEqual(manifestFromProjectContext(context));
  });

  it('still honours the stack flags', async () => {
    const { manifest } = await runFlags(['--framework', 'react', '--router', 'react-router']);
    expect(manifest).toMatchObject({ framework: 'react', router: 'react-router' });
  });

  it('the non-interactive prompter refuses a stack question by name', () => {
    const prompter = new NonInteractivePrompter('--yes was passed');
    expect(() =>
      prompter.selectDimension({
        dimension: 'framework',
        message: 'Framework',
        options: [],
        initialValue: 'astro',
      }),
    ).toThrow(/framework/);
    expect(() =>
      prompter.selectMany({
        dimension: 'features',
        message: 'Features',
        options: [],
        initialValues: [],
      }),
    ).toThrow(/features/);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancelling', () => {
  /*
   * Each dimension is cancelled on a stack that actually asks about it. Styling
   * moved onto React in Stage 52: Astro requires a CSS framework now, so
   * Tailwind is its only survivor and the question is derived rather than
   * asked - there is no longer a styling prompt there to cancel at.
   */
  for (const [dimension, argv] of [
    ['framework', ['acme-site']],
    ['styling', ['acme-site', '--framework', 'react']],
    ['features', ['acme-site']],
  ] as const) {
    it(`propagates a cancel at the ${dimension} question`, async () => {
      await expect(run(argv, { cancelAt: [dimension] })).rejects.toBeInstanceOf(CancelledError);
    });
  }

  it('cancels before anything downstream runs', async () => {
    // The resolver has not returned, so no plan exists and nothing can be
    // written. The atomic apply boundary is untouched by this stage.
    let resolved = true;
    try {
      await run(['acme-site'], { cancelAt: ['framework'] });
    } catch {
      resolved = false;
    }
    expect(resolved).toBe(false);
  });

  it('the CLI turns it into a clean exit rather than a stack trace', async () => {
    const { logger, out, err } = testLogger();
    const { reportError } = await import('../src/cli.js');
    const code = reportError(new CancelledError(), logger);
    expect(code).toBe(130);
    expect(`${out.text}${err.text}`).toContain('Cancelled');
    expect(`${out.text}${err.text}`).not.toContain('    at ');
  });
});

// ---------------------------------------------------------------------------
// Compatibility stays where it was
// ---------------------------------------------------------------------------

describe('compatibility is still the engine’s job', () => {
  it('an interactively chosen incompatible stack is refused by the engine', async () => {
    /*
     * The menus filter, but filtering is a courtesy rather than a guarantee -
     * a flag can still supply what a menu would not have offered. The engine is
     * what actually refuses, and it names the capability.
     */
    const { manifest } = await run(['acme-site', '--framework', 'react', '--features', 'seo']);
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
    expect(`${error?.message}\n${error?.hint}`).toContain('document-metadata');
  });

  it('the Stage 14 conflict policy is not bypassed by prompting', async () => {
    await expect(
      run(['acme-site', '--template', 'astro-tailwind', '--framework', 'react']),
    ).rejects.toThrow(/--template cannot be combined/);
  });

  it('an unknown value is still refused before any question is asked', async () => {
    const prompter = new FakePrompter({ dir: 'acme-site' });
    await expect(
      resolveContext({
        flags: parseCliArgs(['acme-site', '--framework', 'vue']),
        cwd: TEST_CWD,
        env: {},
        prompter,
        registry,
        cliVersion: '9.9.9',
        now: new Date('2026-01-01T00:00:00.000Z'),
        templatesRoot: TEMPLATES_ROOT,
        fs: emptyFs,
      }),
    ).rejects.toThrow(/Unknown framework "vue"/);
    expect(prompter.asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structural: the prompt layer is an input adapter
// ---------------------------------------------------------------------------

describe('the interactive layer holds no engine of its own', () => {
  const interactive = source('src/context/interactive.ts');
  const prompts = source('src/context/prompts.ts');
  const code = interactive.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('touches no filesystem, process or network API', () => {
    for (const file of [interactive, prompts]) {
      for (const forbidden of [
        'node:fs',
        'node:child_process',
        'node:process',
        'writeFileSync',
        'mkdirSync',
        'readFileSync',
        'execSync',
        'spawn',
        'fetch(',
      ]) {
        expect(file, `the prompt layer uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('branches on no framework id', () => {
    for (const name of ['astro', 'react', 'nextjs', 'angular']) {
      expect(code.includes(`=== '${name}'`), `interactive.ts branches on ${name}`).toBe(false);
    }
  });

  it('names no capability, because it evaluates none', () => {
    for (const capability of [
      'document-metadata',
      'file-based-routing',
      'client-side-routing',
      'react-runtime',
      'composed-stylesheet',
      'vite-plugins',
    ]) {
      expect(code, `interactive.ts mentions ${capability}`).not.toContain(capability);
    }
  });

  it('names no adapter id as a choice, because the registry supplies them', () => {
    for (const id of ['mui', 'bootstrap', 'react-router', 'tailwind', 'seo']) {
      expect(code, `interactive.ts hard-codes ${id}`).not.toContain(`'${id}'`);
    }
  });

  it('composes nothing and generates nothing', () => {
    for (const forbidden of ['planManifest', 'apply(', 'FileOperation', 'composePackage']) {
      expect(interactive, `the interactive layer references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('reaches a manifest only through the shared normaliser', () => {
    // One import of each, and no second path. A manifest built any other way
    // here would be the duplicate this stage exists to prevent.
    expect(interactive).toContain("from './dimensions.js'");
    expect(code.match(/manifestFrom\(/g) ?? []).toHaveLength(1);
    expect(code.match(/resolveDimensions\(/g) ?? []).toHaveLength(2);
  });

  it('the renderer knows nothing about dimensions', () => {
    // `prompts.ts` draws a list of strings. If it learned what a router was,
    // the generic question would have become a questionnaire.
    for (const word of ['framework', 'styling', 'router', 'uiLibrary', 'feature']) {
      expect(
        prompts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
        `prompts.ts mentions ${word}`,
      ).not.toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same answers resolve to the same manifest twice', async () => {
    const answers: FakeAnswers = {
      dimensions: { framework: 'react', styling: 'bootstrap', router: 'react-router' },
      features: ['client-route-fallback'],
    };
    const first = await run(['acme-site'], answers);
    const second = await run(['acme-site'], answers);
    expect(first.manifest).toEqual(second.manifest);
    expect(JSON.stringify(first.manifest)).toBe(JSON.stringify(second.manifest));
  });

  it('the menus are in a stable order', async () => {
    const first = await menus({ framework: 'react' });
    const second = await menus({ framework: 'react' });
    expect(first.prompter.questions.map((q) => q.dimension)).toEqual(
      second.prompter.questions.map((q) => q.dimension),
    );
    expect(first.optionsFor('styling')).toEqual(second.optionsFor('styling'));
  });

  it('the offered choices do not depend on the starter', async () => {
    // The interactive layer builds candidate manifests with a provisional
    // `mode`, because the real one is asked for afterwards. That is only safe
    // because selection skips every `starter:*` feature - which this asserts
    // rather than assumes.
    const comingSoon = await promptDimensions({
      input: { framework: 'react' },
      adapters,
      prompter: new FakePrompter({ dimensions: { router: 'react-router' } }),
      mode: 'coming-soon',
    });
    const full = await promptDimensions({
      input: { framework: 'react' },
      adapters,
      prompter: new FakePrompter({ dimensions: { router: 'react-router' } }),
      mode: 'full',
    });
    expect(comingSoon).toEqual(full);
  });

  it('the plan is identical across repeated resolution', async () => {
    const answers: FakeAnswers = { dimensions: { framework: 'react', router: 'react-router' } };
    const plan = async () => {
      const { context, manifest } = await run(['acme-site'], answers);
      return renderPlan(
        planManifest(manifest, {
          registry,
          cliVersion: '9.9.9',
          generatedAt: '2026-01-01T00:00:00.000Z',
          mode: context.template.mode,
          templateId: context.template.id,
        }).plan,
        TEMPLATES_ROOT,
      );
    };
    expect(await plan()).toBe(await plan());
  });
});

// ---------------------------------------------------------------------------
// Through the command
// ---------------------------------------------------------------------------

describe('the create command drives the whole flow', () => {
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

  it('generates the Astro project when every default is accepted', async () => {
    const { code, text } = await create([]);
    expect(code).toBe(0);
    expect(text).toContain('astro-tailwind');
    expect(text).toContain('astro.config.mjs');
  });

  it('generates React when React is chosen interactively', async () => {
    const { code, text } = await create([], {
      dimensions: { framework: 'react', router: 'react-router' },
    });
    expect(code).toBe(0);
    expect(text).toContain('react-vite');
    expect(text).toContain('src/routes/AppRouter.tsx');
    expect(text).not.toContain('astro.config.mjs');
  });

  it('carries an interactively chosen feature into the plan', async () => {
    const { text } = await create([], {
      dimensions: { framework: 'react', router: 'react-router' },
      features: ['client-route-fallback'],
    });
    expect(text).toContain('src/pages/NotFoundPage.tsx');
  });

  it('refuses to prompt when stdin is not a terminal, rather than hanging', async () => {
    /*
     * The CI-safety property. `main` builds its own prompter, so this is the
     * one path a test can drive all the way from argv - and the thing being
     * asserted is that an unanswered stack question never becomes a read that
     * will not return.
     */
    const { main } = await import('../src/cli.js');
    const { logger, err } = testLogger();
    const code = await main(['acme-site', '--framework', 'react', '--dry-run'], {
      cwd: TEST_CWD,
      env: {},
      isTTY: false,
      logger,
    });
    expect(code).toBe(2);
    expect(err.text).toContain('not an interactive terminal');
  });

  it('--yes reaches a plan from argv with no prompter at all', async () => {
    const { main } = await import('../src/cli.js');
    const { logger, out } = testLogger();
    const code = await main(
      ['acme-site', '--yes', '--framework', 'react', '--router', 'react-router', '--dry-run'],
      { cwd: TEST_CWD, env: {}, isTTY: false, logger },
    );
    expect(code).toBe(0);
    expect(out.text).toContain('src/routes/AppRouter.tsx');
  });

  it('writes nothing while prompting', async () => {
    // `--dry-run` returns before `apply()`, and the resolver has no filesystem
    // write of its own. The structural test above covers the second half.
    const { code, text } = await create([], { dimensions: { framework: 'react' } });
    expect(code).toBe(0);
    expect(text).toContain('DRY RUN');
  });
});
