import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { assertFlagCombinations, dimensionFlagsUsed, parseCliArgs } from '../src/args.js';
import { DIMENSION_DEFAULTS, resolveDimensions } from '../src/context/dimensions.js';
import { resolveContext } from '../src/context/resolve.js';
import { manifestFromProjectContext } from '../src/domain/manifest.js';
import { CliError, EXIT_USAGE } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { helpText } from '../src/ui/help.js';
import { NonInteractivePrompter } from '../src/context/prompts.js';
import { runCreate } from '../src/commands/create.js';
import { emptyFs, renderPlan, testLogger, TEST_CWD } from './helpers.js';

/**
 * The public CLI as a configuration layer, and the line under it.
 *
 * The claim this stage makes is narrow and worth stating precisely: CLI
 * arguments configure a `ProjectManifest`, and everything about whether that
 * manifest is *buildable* stays where it already lived. So the tests here come
 * in two halves.
 *
 * The first is ordinary: flags map to dimensions, unknown words are refused,
 * defaults fill the gaps.
 *
 * The second is the one that matters. It asserts what the CLI does **not** do -
 * that an incompatible stack is refused by the compatibility engine rather than
 * by a branch in the parser, that `angular` is refused by the registry rather
 * than by a list in the CLI, and that a legacy invocation resolves to exactly
 * the manifest it always did. A configuration layer that starts deciding these
 * things is a second implementation of the architecture, which is the failure
 * this stage exists to avoid.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

/** Drives the real resolver the way the real CLI does, minus the terminal. */
const resolve = async (argv: readonly string[]) =>
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

const manifestFor = async (argv: readonly string[]) => (await resolve(argv)).manifest;

const failure = async (argv: readonly string[]): Promise<CliError> => {
  try {
    // `assertFlagCombinations` runs from the CLI entry before dispatch, so a
    // test that skipped it would miss every cross-flag rule.
    const flags = parseCliArgs(['acme-site', '--yes', ...argv]);
    assertFlagCombinations(flags);
    await resolve(argv);
  } catch (error) {
    expect(error, 'expected a CliError').toBeInstanceOf(CliError);
    return error as CliError;
  }
  expect.unreachable('the invocation was accepted');
};

const textOf = (error: CliError): string => `${error.message}\n${error.hint ?? ''}`;

/** Runs a resolved manifest through the pipeline, where selection happens. */
const planForManifest = (manifest: Parameters<typeof planManifest>[0]) =>
  planManifest(manifest, {
    registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'coming-soon',
  });

/** Message and hint together - the registry puts the detail in the hint. */
const planFailure = (manifest: Parameters<typeof planManifest>[0]): string => {
  try {
    planForManifest(manifest);
  } catch (error) {
    expect(error, 'expected a CliError').toBeInstanceOf(CliError);
    return textOf(error as CliError);
  }
  return expect.unreachable('the manifest was accepted');
};

// ---------------------------------------------------------------------------
// Defaults - the compatibility requirement
// ---------------------------------------------------------------------------

describe('an invocation with no stack flags resolves to what V1 always produced', () => {
  it('resolves the V1 stack, field by field', async () => {
    expect(await manifestFor([])).toMatchObject({
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

  it('is exactly the manifest the V1 bridge derives from the same context', async () => {
    /*
     * The strongest available statement, and the reason no V1 golden moved.
     *
     * `manifestFromProjectContext` is the hard-coded Astro manifest the bridge
     * has used since Stage 1 and that every V1 golden was captured through.
     * Resolving to something merely equivalent would not be enough - this
     * asserts the two are the same object graph, for every legacy invocation.
     */
    for (const argv of [
      [],
      ['--mode', 'coming-soon'],
      ['--mode', 'full'],
      ['--url', 'https://acme.example'],
      ['--template', 'astro-tailwind'],
      ['--template', 'astro-tailwind', '--mode', 'full'],
    ]) {
      const { context, manifest } = await resolve(argv);
      expect(manifest, argv.join(' ')).toEqual(manifestFromProjectContext(context));
    }
  });

  it('maps --mode onto the starter field rather than onto a dimension', async () => {
    // Through Stage 20 this landed in `features` as `starter:full`. It has a
    // field of its own now, and the feature list is left alone - which is the
    // assertion that would have failed under the old model.
    const full = await manifestFor(['--mode', 'full']);
    expect(full.starter).toBe('full');
    expect(full.features).toEqual([]);

    const comingSoon = await manifestFor(['--mode', 'coming-soon']);
    expect(comingSoon.starter).toBe('coming-soon');
    expect(comingSoon.features).toEqual([]);
  });

  it('keeps the default stack in one place rather than spread across the CLI', () => {
    expect(DIMENSION_DEFAULTS).toEqual({
      framework: 'astro',
      styling: 'tailwind',
      uiLibrary: 'none',
    });
  });
});

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

describe('each flag configures its own dimension', () => {
  it('parses the whole stack surface', () => {
    const flags = parseCliArgs([
      '--framework',
      'react',
      '--build-tool',
      'vite',
      '--language',
      'ts',
      '--styling',
      'bootstrap',
      '--ui-library',
      'mui',
      '--router',
      'react-router',
      '--architecture',
      'react-standard',
      '--features',
      'client-route-fallback',
    ]);

    expect(flags.framework).toBe('react');
    expect(flags.buildTool).toBe('vite');
    expect(flags.language).toBe('ts');
    expect(flags.styling).toBe('bootstrap');
    expect(flags.uiLibrary).toBe('mui');
    expect(flags.router).toBe('react-router');
    expect(flags.architecture).toBe('react-standard');
    expect(flags.features).toEqual(['client-route-fallback']);
  });

  it('resolves a full React configuration to the exact manifest', async () => {
    expect(
      await manifestFor([
        '--framework',
        'react',
        '--build-tool',
        'vite',
        '--language',
        'typescript',
        '--styling',
        'tailwind',
        '--ui-library',
        'mui',
        '--router',
        'react-router',
      ]),
    ).toMatchObject({
      framework: 'react',
      buildTool: 'vite',
      language: 'ts',
      styling: 'tailwind',
      uiLibrary: 'mui',
      router: 'react-router',
      architecture: 'react-standard',
      starter: 'coming-soon',
      features: [],
    });
  });

  it('carries each dimension through on its own', async () => {
    expect((await manifestFor(['--framework', 'react'])).framework).toBe('react');
    expect((await manifestFor(['--framework', 'react', '--build-tool', 'vite'])).buildTool).toBe(
      'vite',
    );
    expect((await manifestFor(['--styling', 'bootstrap'])).styling).toBe('bootstrap');
    expect((await manifestFor(['--framework', 'react', '--ui-library', 'mui'])).uiLibrary).toBe(
      'mui',
    );
    expect((await manifestFor(['--framework', 'react', '--router', 'react-router'])).router).toBe(
      'react-router',
    );
    expect(
      (await manifestFor(['--framework', 'react', '--architecture', 'react-standard']))
        .architecture,
    ).toBe('react-standard');
    expect((await manifestFor(['--framework', 'react', '--language', 'js'])).language).toBe('js');
  });

  it('accepts the long spelling of a language without inventing a second id', async () => {
    const canonical = await manifestFor(['--framework', 'react', '--language', 'ts']);
    const spelled = await manifestFor(['--framework', 'react', '--language', 'typescript']);
    expect(spelled).toEqual(canonical);
    expect(spelled.language).toBe('ts');
    expect((await manifestFor(['--framework', 'react', '--language', 'JavaScript'])).language).toBe(
      'js',
    );
  });
});

// ---------------------------------------------------------------------------
// Defaults the framework owns
// ---------------------------------------------------------------------------

describe('unstated dimensions come from the framework, not from a table of special cases', () => {
  it('React brings Vite and its own architecture without being told', async () => {
    expect(await manifestFor(['--framework', 'react'])).toMatchObject({
      buildTool: 'vite',
      language: 'ts',
      router: 'none',
      architecture: 'react-standard',
      starter: 'coming-soon',
    });
  });

  it('Astro keeps the build tool it owns', async () => {
    expect(await manifestFor(['--framework', 'astro'])).toMatchObject({
      buildTool: 'astro',
      router: 'file-based',
      architecture: 'astro-standard',
      starter: 'coming-soon',
    });
  });

  it('the router stays opt-in for React, as Stage 12 established', async () => {
    expect((await manifestFor(['--framework', 'react'])).router).toBe('none');
  });

  it('reads those defaults from the adapter rather than restating them', () => {
    // If the normaliser carried its own copy, editing the adapter would not
    // move this. The declaration is the source; this proves the path.
    const react = adapters.framework('react');
    const resolved = resolveDimensions({ framework: 'react' }, adapters);
    expect(react.buildTools.kind).toBe('choice');
    expect(resolved.buildTool).toBe(
      react.buildTools.kind === 'choice' ? react.buildTools.default : react.buildTools.value,
    );
    expect(resolved.architecture).toBe(
      react.architectures.kind === 'fixed' ? react.architectures.value : 'react-standard',
    );
  });

  it('contains no branch on a framework id', () => {
    // The normaliser is generic by construction. A framework named in it would
    // be the first crack in that.
    const source = readSource('src/context/dimensions.ts');
    for (const name of ['astro', 'react', 'nextjs', 'angular']) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code.includes(`=== '${name}'`), `dimensions.ts branches on ${name}`).toBe(false);
    }
  });
});

function readSource(relative: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync(
    path.resolve(import.meta.dirname, '..', relative),
    'utf8',
  ) as string;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

describe('--features', () => {
  it('takes one feature', async () => {
    expect((await manifestFor(['--features', 'not-found'])).features).toEqual(['not-found']);
  });

  it('takes several, comma-separated', async () => {
    expect(
      (await manifestFor(['--features', 'seo,structured-data,accessibility'])).features,
    ).toEqual(['accessibility', 'seo', 'structured-data']);
  });

  it('trims whitespace around each id', async () => {
    expect((await manifestFor(['--features', ' seo , accessibility '])).features).toEqual(
      (await manifestFor(['--features', 'seo,accessibility'])).features,
    );
  });

  it('keeps every occurrence when the flag is repeated', async () => {
    expect(
      (await manifestFor(['--features', 'seo', '--features', 'accessibility'])).features,
    ).toEqual(['accessibility', 'seo']);
  });

  it('is order-independent', async () => {
    expect((await manifestFor(['--features', 'seo,accessibility'])).features).toEqual(
      (await manifestFor(['--features', 'accessibility,seo'])).features,
    );
  });

  it('rejects an empty id rather than dropping it', async () => {
    expect(textOf(await failure(['--features', 'seo,,accessibility']))).toContain('empty value');
    expect(textOf(await failure(['--features', 'seo,']))).toContain('empty value');
  });

  it('rejects a duplicate rather than collapsing it', async () => {
    const error = await failure(['--features', 'seo,seo']);
    expect(error.message).toContain('more than once');
    expect(error.exitCode).toBe(EXIT_USAGE);
  });

  it('rejects a duplicate across two occurrences too', async () => {
    expect(textOf(await failure(['--features', 'seo', '--features', 'seo']))).toContain(
      'more than once',
    );
  });

  it('rejects an unknown feature without substituting one', async () => {
    const error = await failure(['--features', 'sitemapp']);
    expect(error.message).toContain('Unknown feature "sitemapp"');
    expect(error.hint).toContain('seo');
  });

  it('refuses a starter here, because --mode already owns it', async () => {
    const error = await failure(['--features', 'starter:full']);
    expect(error.message).toContain('starter:full');
    expect(error.hint).toContain('--mode');
  });

  it('accepts a known feature with no adapter, and lets selection refuse it', async () => {
    /*
     * `sitemap` is real vocabulary, so it is not the CLI's to reject. The
     * manifest is built and `selectAdapters` reports that nothing implements
     * it - which is exactly the boundary this stage is drawing, so the test
     * follows it through the pipeline rather than asserting at the wrong layer.
     */
    const manifest = await manifestFor(['--features', 'sitemap']);
    expect(manifest.features).toContain('sitemap');
    expect(planFailure(manifest)).toContain('no adapter implements it');
  });
});

// ---------------------------------------------------------------------------
// Unknown values
// ---------------------------------------------------------------------------

describe('unknown values are refused, never substituted', () => {
  const cases: readonly { argv: string[]; word: string; notSilently: string }[] = [
    { argv: ['--framework', 'vue'], word: 'framework "vue"', notSilently: 'astro' },
    { argv: ['--build-tool', 'webpack'], word: 'build tool "webpack"', notSilently: 'vite' },
    { argv: ['--language', 'rust'], word: 'language "rust"', notSilently: 'ts' },
    { argv: ['--styling', 'whatever'], word: 'styling system "whatever"', notSilently: 'tailwind' },
    { argv: ['--ui-library', 'nope'], word: 'UI library "nope"', notSilently: 'mui' },
    { argv: ['--router', 'next-router'], word: 'router "next-router"', notSilently: 'none' },
    {
      // Listed against the default framework, since none was given: the
      // supported architectures are whichever the selected framework defines.
      argv: ['--architecture', 'nonsense'],
      word: 'architecture "nonsense"',
      notSilently: 'astro-standard',
    },
    { argv: ['--features', 'telepathy'], word: 'feature "telepathy"', notSilently: 'seo' },
  ];

  for (const entry of cases) {
    it(`refuses ${entry.argv.join(' ')}`, async () => {
      const error = await failure(entry.argv);
      expect(error.message).toContain(`Unknown ${entry.word}`);
      expect(error.exitCode).toBe(EXIT_USAGE);
      // The point of the refusal: nothing was chosen in its place.
      expect(error.hint ?? '').toContain(entry.notSilently);
    });
  }

  it('an unknown framework never resolves to the default one', async () => {
    await failure(['--framework', 'vue']);
    // and the default path is genuinely astro, so the refusal above is meaningful
    expect((await manifestFor([])).framework).toBe('astro');
  });
});

// ---------------------------------------------------------------------------
// Known vocabulary, no adapter
// ---------------------------------------------------------------------------

describe('a known id with no adapter is the registry’s answer, not the CLI’s', () => {
  it('reports angular as unimplemented rather than unknown', async () => {
    const error = await failure(['--framework', 'angular']);
    expect(error.message).toContain('does not support framework "angular" yet');
    expect(error.hint).toContain('no adapter implements it');
  });

  it('reports chakra the same way, at the same layer', async () => {
    // The framework is looked up during normalisation because the remaining
    // defaults are read from it; every other dimension is looked up by
    // `selectAdapters`. Both produce the registry's sentence, and neither
    // produces a CLI-authored one.
    const manifest = await manifestFor(['--framework', 'react', '--ui-library', 'chakra']);
    expect(manifest.uiLibrary).toBe('chakra');
    expect(planFailure(manifest)).toContain('no adapter implements it');
  });

  it('the wording comes from the registry, so the CLI keeps no list of its own', () => {
    // Same sentence, reached directly. If the CLI ever grew its own copy the
    // two would drift, and this is what would notice.
    let fromRegistry = '';
    try {
      adapters.framework('angular');
    } catch (error) {
      fromRegistry = (error as CliError).message;
    }
    expect(fromRegistry).toContain('does not support framework "angular" yet');
  });

  it('names no framework id in the normaliser at all', () => {
    const code = readSource('src/context/dimensions.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain("'angular'");
    expect(code).not.toContain("'chakra'");
  });
});

// ---------------------------------------------------------------------------
// Legacy
// ---------------------------------------------------------------------------

describe('the legacy surface still works and still means what it did', () => {
  it('--template astro-tailwind resolves the V1 stack', async () => {
    const { context, manifest } = await resolve(['--template', 'astro-tailwind']);
    expect(context.template.id).toBe('astro-tailwind');
    expect(manifest.framework).toBe('astro');
    expect(manifest).toEqual(manifestFromProjectContext(context));
  });

  it('--mode still selects the starter, in both directions', async () => {
    expect((await resolve(['--mode', 'full'])).context.template.mode).toBe('full');
    expect((await resolve(['--mode', 'coming-soon'])).context.template.mode).toBe('coming-soon');
  });

  it('a URL and a URL-less run still differ only in the site URL', async () => {
    const withUrl = await manifestFor(['--url', 'https://acme.example']);
    const without = await manifestFor([]);
    expect(withUrl.site.url).toBe('https://acme.example');
    expect(without.site.url).toBeNull();
    expect({ ...withUrl, site: null }).toEqual({ ...without, site: null });
  });

  it('--mode is not a dimension and never becomes one', async () => {
    const manifest = await manifestFor(['--mode', 'full']);
    expect(Object.keys(manifest)).not.toContain('mode');
    // A starter, not a stack dimension: it is absent from the dimension list
    // the resolver explains, and present as its own field.
    expect(manifest.starter).toBe('full');
  });

  it('an unknown template is still refused by the template registry', async () => {
    expect(textOf(await failure(['--template', 'nope']))).toContain('Unknown template "nope"');
  });
});

// ---------------------------------------------------------------------------
// The conflict policy
// ---------------------------------------------------------------------------

describe('--template and the stack flags are refused together', () => {
  it('rejects the documented conflict rather than choosing a side', () => {
    const flags = parseCliArgs(['acme', '--template', 'astro-tailwind', '--framework', 'react']);
    try {
      assertFlagCombinations(flags);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain('--template cannot be combined with');
      expect((error as CliError).message).toContain('--framework');
      expect((error as CliError).exitCode).toBe(EXIT_USAGE);
    }
  });

  it('rejects it even when the two agree, because agreement is not a rule', () => {
    // `--template astro-tailwind --styling tailwind` is consistent today. A
    // policy that allowed it would have to explain what happens tomorrow when
    // it is not, and "it depends" is the answer this refuses to give.
    const flags = parseCliArgs(['acme', '--template', 'astro-tailwind', '--styling', 'tailwind']);
    expect(() => assertFlagCombinations(flags)).toThrow(/--template cannot be combined/);
  });

  it('names every stack flag that was used', () => {
    const flags = parseCliArgs([
      'acme',
      '--template',
      'astro-tailwind',
      '--framework',
      'react',
      '--features',
      'seo',
    ]);
    try {
      assertFlagCombinations(flags);
      expect.unreachable();
    } catch (error) {
      expect((error as CliError).message).toContain('--framework');
      expect((error as CliError).message).toContain('--features');
    }
  });

  it('reports exactly which flags an invocation used', () => {
    expect(dimensionFlagsUsed(parseCliArgs(['acme']))).toEqual([]);
    expect(dimensionFlagsUsed(parseCliArgs(['acme', '--framework', 'react']))).toEqual([
      '--framework',
    ]);
    expect(dimensionFlagsUsed(parseCliArgs(['acme', '--features', 'seo']))).toEqual(['--features']);
  });

  it('catches the same ambiguity arriving through a config file', async () => {
    const error = await (async () => {
      try {
        await resolveContext({
          flags: parseCliArgs(['acme-site', '--yes', '--framework', 'react', '--from', 'p.json']),
          cwd: TEST_CWD,
          env: {},
          prompter: new NonInteractivePrompter('test'),
          registry,
          cliVersion: '9.9.9',
          now: new Date('2026-01-01T00:00:00.000Z'),
          templatesRoot: TEMPLATES_ROOT,
          fs: emptyFs,
          // The real config-file shape. A bare string here is rejected by the
          // parser, which made this test pass without ever reaching the
          // conflict check it exists for.
          readFile: () => JSON.stringify({ template: { id: 'astro-tailwind' } }),
        });
      } catch (thrown) {
        return thrown as CliError;
      }
      expect.unreachable('the config-file conflict was accepted');
    })();
    expect(error).toBeInstanceOf(CliError);
    expect(textOf(error)).toContain('both name what to build');
  });

  it('allows a template alongside flags that are not dimensions', () => {
    const flags = parseCliArgs([
      'acme',
      '--template',
      'astro-tailwind',
      '--mode',
      'full',
      '--name',
      'Acme',
      '--no-git',
    ]);
    expect(() => assertFlagCombinations(flags)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The boundary: the CLI does not decide compatibility
// ---------------------------------------------------------------------------

describe('compatibility is decided downstream, and is provably not decided here', () => {
  it('resolves an incompatible stack into a manifest without complaint', async () => {
    // React + seo is refused, but not at this layer. The manifest is built
    // first, which is exactly the architecture: configure, then check.
    const manifest = await manifestFor(['--framework', 'react', '--features', 'seo']);
    expect(manifest.framework).toBe('react');
    expect(manifest.features).toContain('seo');
  });

  it('and the refusal comes from the compatibility engine, naming the capability', async () => {
    const manifest = await manifestFor(['--framework', 'react', '--features', 'seo']);
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
    expect(error?.message).toBe('That combination will not work.');
    expect(error?.hint).toContain('document-metadata');
  });

  it('refuses React + not-found for the routing reason, not a CLI reason', async () => {
    const manifest = await manifestFor([
      '--framework',
      'react',
      '--router',
      'react-router',
      '--features',
      'not-found',
    ]);
    expect(() =>
      planManifest(manifest, {
        registry,
        cliVersion: '9.9.9',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode: 'coming-soon',
      }),
    ).toThrow(CliError);
  });

  it('lets a disagreement between a framework and an explicit build tool reach the engine', async () => {
    // The CLI takes `--build-tool vite` at face value even though Astro fixes
    // its own. Quietly correcting it here would hide a conflict the user asked
    // for and needs to see.
    const manifest = await manifestFor(['--framework', 'astro', '--build-tool', 'vite']);
    expect(manifest.buildTool).toBe('vite');
  });

  it('the normaliser holds no capability vocabulary', () => {
    const source = readSource('src/context/dimensions.ts');
    for (const capability of [
      'document-metadata',
      'file-based-routing',
      'client-side-routing',
      'react-runtime',
      'composed-stylesheet',
    ]) {
      expect(source, `dimensions.ts mentions ${capability}`).not.toContain(capability);
    }
  });

  it('the CLI layer generates no files and touches no filesystem', () => {
    for (const file of ['src/context/dimensions.ts', 'src/args.ts']) {
      const source = readSource(file);
      for (const forbidden of ['writeFileSync', 'mkdirSync', 'rmSync', 'node:fs']) {
        expect(source, `${file} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Through to a plan
// ---------------------------------------------------------------------------

describe('CLI arguments reach a real generation plan', () => {
  const planFor = async (argv: readonly string[]) => {
    const { context, manifest } = await resolve(argv);
    return planManifest(manifest, {
      registry,
      cliVersion: '9.9.9',
      generatedAt: '2026-01-01T00:00:00.000Z',
      mode: context.template.mode,
      templateId: context.template.id,
    });
  };

  it('a React configuration plans React files', async () => {
    const planned = await planFor([
      '--framework',
      'react',
      '--styling',
      'tailwind',
      '--router',
      'react-router',
      '--features',
      'client-route-fallback',
    ]);
    const paths = planned.plan.operations.map((operation) => operation.path);
    expect(paths).toContain('src/App.tsx');
    expect(paths).toContain('src/routes/AppRouter.tsx');
    expect(paths).toContain('src/pages/NotFoundPage.tsx');
    expect(paths).not.toContain('astro.config.mjs');
  });

  it('reports the framework’s own template, which the V1 registry cannot', async () => {
    const planned = await planFor(['--framework', 'react']);
    expect(planned.templateManifest.id).toBe('react-vite');
    // The whole reason it is returned rather than looked up.
    expect(() => registry.get('react-vite')).toThrow(CliError);
  });

  it('the default invocation still plans the Astro project', async () => {
    const planned = await planFor([]);
    expect(planned.templateManifest.id).toBe('astro-tailwind');
    expect(planned.plan.operations.map((o) => o.path)).toContain('astro.config.mjs');
  });

  it('a CLI-configured stack equals the same manifest built by hand', async () => {
    /*
     * The equivalence the stage rests on: the CLI is one way to fill in a
     * manifest, not a second pipeline. Compared as rendered plans so a
     * difference anywhere in the generated output would show.
     */
    const { context, manifest } = await resolve([
      '--framework',
      'react',
      '--styling',
      'bootstrap',
      '--router',
      'react-router',
    ]);

    const byHand = {
      targetDir: manifest.targetDir,
      projectName: manifest.projectName,
      framework: 'react',
      buildTool: 'vite',
      language: 'ts',
      styling: 'bootstrap',
      uiLibrary: 'none',
      router: 'react-router',
      architecture: 'react-standard',
      starter: 'coming-soon',
      features: [],
      site: manifest.site,
      packageManager: manifest.packageManager,
      git: manifest.git,
      install: manifest.install,
    } as const;

    expect(manifest).toEqual(byHand);

    const options = {
      registry,
      cliVersion: '9.9.9',
      generatedAt: '2026-01-01T00:00:00.000Z',
      mode: context.template.mode,
      templateId: context.template.id,
    } as const;
    expect(renderPlan(planManifest(manifest, options).plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planManifest(byHand, options).plan, TEMPLATES_ROOT),
    );
  });
});

// ---------------------------------------------------------------------------
// Through the command, not around it
// ---------------------------------------------------------------------------

describe('the create command itself plans from the resolved manifest', () => {
  /*
   * Everything above drives `resolveContext` and `planManifest` in sequence,
   * which is what the command does - but asserting the two halves separately
   * proves nothing about the wiring between them.
   *
   * That gap was not hypothetical: a mutation that made the command plan a
   * hard-coded Astro manifest, so every dimension flag did nothing, passed the
   * entire suite. These tests run `runCreate` with `--dry-run`, which resolves,
   * plans and renders without writing anything, and read the result from what
   * the user would actually see.
   */
  const run = async (argv: readonly string[]) => {
    const { logger, out } = testLogger();
    const code = await runCreate({
      flags: parseCliArgs(['acme-site', '--yes', '--dry-run', ...argv]),
      logger,
      registry,
      cliVersion: '9.9.9',
      cwd: TEST_CWD,
      env: {},
      isTTY: false,
      nodeVersion: process.versions.node,
    });
    return { code, text: out.text };
  };

  it('generates React files when React is asked for', async () => {
    const { code, text } = await run(['--framework', 'react', '--router', 'react-router']);
    expect(code).toBe(0);
    expect(text).toContain('react-vite');
    expect(text).toContain('src/routes/AppRouter.tsx');
    expect(text).not.toContain('astro.config.mjs');
  });

  it('still generates the Astro project when nothing is asked for', async () => {
    const { code, text } = await run([]);
    expect(code).toBe(0);
    expect(text).toContain('astro-tailwind');
    expect(text).toContain('astro.config.mjs');
    expect(text).not.toContain('src/routes/AppRouter.tsx');
  });

  it('carries a feature all the way to a generated file', async () => {
    const { text } = await run([
      '--framework',
      'react',
      '--router',
      'react-router',
      '--features',
      'client-route-fallback',
    ]);
    expect(text).toContain('src/pages/NotFoundPage.tsx');
  });

  it('reports an incompatible stack through the compatibility engine', async () => {
    const { logger, err } = testLogger();
    const code = await runCreate({
      flags: parseCliArgs([
        'acme-site',
        '--yes',
        '--dry-run',
        '--framework',
        'react',
        '--features',
        'seo',
      ]),
      logger,
      registry,
      cliVersion: '9.9.9',
      cwd: TEST_CWD,
      env: {},
      isTTY: false,
      nodeVersion: process.versions.node,
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CliError);
      expect(textOf(error as CliError)).toContain('document-metadata');
      return -1;
    });
    expect(code).toBe(-1);
    expect(err.text).not.toContain('document-metadata');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same invocation resolves to the same manifest twice', async () => {
    const argv = [
      '--framework',
      'react',
      '--styling',
      'bootstrap',
      '--ui-library',
      'mui',
      '--router',
      'react-router',
      '--features',
      'client-route-fallback',
    ];
    expect(await manifestFor(argv)).toEqual(await manifestFor(argv));
  });

  it('feature order does not depend on how they were typed', async () => {
    expect(
      (await manifestFor(['--features', 'structured-data,accessibility,seo'])).features,
    ).toEqual((await manifestFor(['--features', 'seo,accessibility,structured-data'])).features);
  });

  it('sorts by code unit rather than by locale', async () => {
    // `localeCompare` would order these by collation rules that vary with the
    // environment; the manifest must not.
    const features = (await manifestFor(['--features', 'structured-data,not-found,accessibility']))
      .features;
    expect(features).toEqual(['accessibility', 'not-found', 'structured-data']);
  });

  it('resolution reads no environment beyond what it is given', async () => {
    const a = await manifestFor(['--framework', 'react']);
    const b = await manifestFor(['--framework', 'react']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

describe('help is accurate about what works', () => {
  const text = helpText();

  it('documents every stack flag in the section that describes them', () => {
    // Scoped to the Stack section on purpose: every flag name also appears in
    // the Examples block, so searching the whole text would still pass with a
    // row missing from the list a reader actually consults.
    const stack = text.slice(text.indexOf('  Stack'), text.indexOf('  Legacy'));
    for (const flag of [
      '--framework',
      '--build-tool',
      '--language',
      '--styling',
      '--ui-library',
      '--router',
      '--architecture',
      '--features',
    ]) {
      expect(stack, `the Stack section omits ${flag}`).toContain(flag);
    }
  });

  it('lists only implemented adapters as choices', () => {
    const stackSection = text.slice(text.indexOf('Stack'), text.indexOf('Legacy'));
    for (const framework of adapters.implementedFrameworks()) {
      expect(stackSection).toContain(framework);
    }
    // The vocabulary is wider, and the choice lists must not pretend otherwise.
    expect(stackSection).not.toContain('angular');
    expect(stackSection).not.toContain('chakra');
    expect(stackSection).not.toContain('angular');
  });

  it('says plainly that the vocabulary is wider than the choices', () => {
    const notes = text.slice(text.indexOf('Notes'));
    expect(notes).toContain('angular');
    expect(notes).toContain('no adapter implements it');
  });

  it('says combinations are checked rather than assumed', () => {
    expect(text).toContain('ClientKit checks rather than');
  });

  it('keeps the legacy flags documented', () => {
    expect(text).toContain('--template');
    expect(text).toContain('--list-templates');
    expect(text).toContain('cannot be combined');
  });

  it('tracks the registry rather than a hand-written list', () => {
    // Adding an adapter must move the help without anyone editing it.
    for (const id of adapters.implementedStyling()) expect(text).toContain(id);
    for (const id of adapters.implementedFeatures()) expect(text).toContain(id);
  });
});
