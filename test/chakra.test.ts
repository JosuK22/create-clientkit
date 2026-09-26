import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { CHAKRA_DECLARATION } from '../src/adapters/chakra.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import { parseCliArgs } from '../src/args.js';
import { promptDimensions } from '../src/context/interactive.js';
import { NonInteractivePrompter } from '../src/context/prompts.js';
import { resolveContext } from '../src/context/resolve.js';
import type { ProjectManifest, UiLibraryId } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { emptyFs, FakePrompter, renderPlan, TEST_CWD } from './helpers.js';

/**
 * Chakra UI, the second UI library.
 *
 * The claim under test is the one MUI's suite makes, applied to a second
 * library: adding a component library is one adapter, reached through every
 * entry point - flag, config file, interactive menu - without any of them
 * learning its name, and without moving a byte of any other stack's output.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const reactManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-app'),
  projectName: 'acme-app',
  framework: 'react',
  buildTool: 'vite',
  language: 'ts',
  styling: 'tailwind',
  uiLibrary: 'chakra',
  router: 'none',
  architecture: 'react-standard',
  starter: 'coming-soon',
  features: [],
  site: {
    name: 'Acme Ltd',
    url: 'https://acme.example',
    description: 'Bespoke widgets.',
    locale: 'en',
    author: null,
  },
  packageManager: 'npm',
  git: true,
  install: true,
  ...over,
});

const nextManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  reactManifest({
    framework: 'nextjs',
    buildTool: 'next',
    router: 'file-based',
    architecture: 'next-app',
    ...over,
  });

const astroManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  reactManifest({
    framework: 'astro',
    buildTool: 'astro',
    router: 'file-based',
    architecture: 'astro-standard',
    ...over,
  });

const planFor = (manifest: ProjectManifest) =>
  planManifest(manifest, {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: manifest.starter,
  });

const fileAt = (manifest: ProjectManifest, file: string): string => {
  const operation = planFor(manifest).plan.operations.find((entry) => entry.path === file);
  if (operation === undefined || operation.type !== 'write') throw new Error(`no ${file}`);
  return operation.content;
};

const dependenciesOf = (manifest: ProjectManifest): Record<string, string> =>
  (JSON.parse(fileAt(manifest, 'package.json')) as { dependencies?: Record<string, string> })
    .dependencies ?? {};

const template = (name: string): string =>
  readFileSync(path.join(TEMPLATES_ROOT, 'ui-library', 'chakra', name), 'utf8');

const resolveFlags = (argv: readonly string[], file?: unknown) =>
  resolveContext({
    flags: parseCliArgs(['acme-app', '--yes', ...argv]),
    cwd: TEST_CWD,
    env: {},
    prompter: new NonInteractivePrompter('t'),
    registry: v1Registry,
    cliVersion: '9.9.9',
    now: new Date('2026-01-01T00:00:00.000Z'),
    templatesRoot: TEMPLATES_ROOT,
    fs: emptyFs,
    readFile: () => JSON.stringify(file),
  });

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

describe('Chakra UI is a UI library', () => {
  it('occupies the UI-library dimension under the existing id', () => {
    expect(CHAKRA_DECLARATION.kind).toBe('ui-library');
    expect(CHAKRA_DECLARATION.id).toBe('chakra');
    expect(CHAKRA_DECLARATION.displayName).toBe('Chakra UI');
  });

  it('is implemented, alongside MUI', () => {
    expect(adapters.hasUiLibrary('chakra')).toBe(true);
    expect(adapters.uiLibrary('chakra').declaration).toBe(CHAKRA_DECLARATION);
    expect(adapters.implementedUiLibraries()).toEqual(['chakra', 'mui']);
  });

  it('requires a React runtime and somewhere to mount context, and nothing else', () => {
    const required = CHAKRA_DECLARATION.requires.map((entry) =>
      entry.kind === 'requires' ? entry.capability : entry.kind,
    );
    expect(required).toEqual(['react-runtime', 'client-app-root']);
  });

  it('is never addressable as a styling system', () => {
    expect(() => adapters.styling('chakra' as never)).toThrow(CliError);
  });
});

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

describe('every entry point reaches it', () => {
  it('--ui-library chakra resolves and plans', async () => {
    const { manifest } = await resolveFlags(['--framework', 'react', '--ui-library', 'chakra']);
    expect(manifest.uiLibrary).toBe('chakra');
    expect(() => planFor(manifest)).not.toThrow();
  });

  it('a config file with "uiLibrary": "chakra" is accepted', async () => {
    const { manifest } = await resolveFlags(['--from', 'clientkit.json'], {
      stack: {
        framework: 'react',
        buildTool: 'vite',
        language: 'typescript',
        styling: 'tailwind',
        uiLibrary: 'chakra',
      },
    });
    expect(manifest.uiLibrary).toBe('chakra');
    expect(() => planFor(manifest)).not.toThrow();
  });

  it('a config file with an unknown spelling is refused, not guessed at', async () => {
    await expect(
      resolveFlags(['--from', 'clientkit.json'], {
        stack: { framework: 'react', uiLibrary: 'chakra-ui' },
      }),
    ).rejects.toThrow(/Unknown UI library "chakra-ui"/);
  });

  it('the interactive menu offers it by its own name under React', async () => {
    const prompter = new FakePrompter({});
    await promptDimensions({
      input: { framework: 'react' },
      adapters,
      prompter,
      mode: 'coming-soon',
    });
    const question = prompter.questions.find((entry) => entry.dimension === 'uiLibrary');
    expect(question?.options.map((option) => option.value)).toEqual(['chakra', 'mui', 'none']);
    expect(question?.options.find((option) => option.value === 'chakra')?.label).toBe('Chakra UI');
  });

  it('the interactive menu never offers it under Astro', async () => {
    const prompter = new FakePrompter({});
    await promptDimensions({
      input: { framework: 'astro' },
      adapters,
      prompter,
      mode: 'coming-soon',
    });
    const offered = prompter.questions
      .filter((entry) => entry.dimension === 'uiLibrary')
      .flatMap((entry) => entry.options.map((option) => option.value));
    expect(offered).not.toContain('chakra');
  });
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('which frameworks can have it', () => {
  it('React + Vite, with every styling system and router it takes', () => {
    for (const styling of ['tailwind', 'bootstrap'] as const) {
      for (const router of ['none', 'react-router'] as const) {
        expect(
          checkCompatibility(reactManifest({ styling, router }), adapters).compatible,
          `${styling}/${router}`,
        ).toBe(true);
      }
    }
  });

  it('Next.js, with every styling system it takes', () => {
    for (const styling of ['tailwind', 'bootstrap', 'none'] as const) {
      expect(checkCompatibility(nextManifest({ styling }), adapters).compatible, styling).toBe(
        true,
      );
    }
  });

  it('not Astro, and the refusal names the missing capability', () => {
    const report = checkCompatibility(astroManifest(), adapters);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('react-runtime');
    expect(() => resolveProject(astroManifest(), adapters)).toThrow(CliError);
  });

  it('selects exactly one UI-library adapter, and it is Chakra', () => {
    const refs = selectAdapters(reactManifest(), adapters).adapters.map((entry) => entry.ref);
    expect(refs.filter((ref) => ref.startsWith('ui-library:'))).toEqual(['ui-library:chakra']);
  });
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

describe('dependencies', () => {
  const CHAKRA_PACKAGES = ['@chakra-ui/react', '@emotion/react'];

  it('installs Chakra and its required Emotion peer, pinned exactly', () => {
    const installed = dependenciesOf(reactManifest());
    expect(installed['@chakra-ui/react']).toBe('3.37.0');
    expect(installed['@emotion/react']).toBe('11.14.0');
    for (const version of Object.values(installed)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('adds only its own packages under React', () => {
    const withChakra = dependenciesOf(reactManifest());
    const without = dependenciesOf(reactManifest({ uiLibrary: 'none' }));
    const rest = { ...withChakra };
    for (const name of CHAKRA_PACKAGES) delete rest[name];
    expect(rest).toEqual(without);
  });

  it('adds the style cache only where there is a server render to flush', () => {
    expect(dependenciesOf(reactManifest())).not.toHaveProperty('@emotion/cache');
    const withChakra = dependenciesOf(nextManifest());
    const without = dependenciesOf(nextManifest({ uiLibrary: 'none' }));
    expect(withChakra['@emotion/cache']).toBe('11.14.0');
    const rest = { ...withChakra };
    for (const name of [...CHAKRA_PACKAGES, '@emotion/cache']) delete rest[name];
    expect(rest).toEqual(without);
  });

  it('never installs another UI library, and MUI never installs Chakra', () => {
    for (const manifest of [reactManifest(), nextManifest()]) {
      expect(Object.keys(dependenciesOf(manifest)).some((name) => name.startsWith('@mui/'))).toBe(
        false,
      );
    }
    for (const uiLibrary of ['mui', 'none'] as UiLibraryId[]) {
      for (const manifest of [reactManifest({ uiLibrary }), nextManifest({ uiLibrary })]) {
        expect(JSON.stringify(dependenciesOf(manifest)), uiLibrary).not.toContain('@chakra-ui/');
      }
    }
  });

  it('keeps every Chakra dependency traceable to Chakra', () => {
    const owned = resolveWithAdapters(reactManifest(), TEMPLATES_ROOT)
      .contributions.flatMap((contribution) => contribution.dependencies)
      .filter((entry) => CHAKRA_PACKAGES.includes(entry.name));
    expect(owned.map((entry) => entry.owner)).toEqual(['ui-library:chakra', 'ui-library:chakra']);
  });

  it('no template carries a Chakra package', () => {
    const templates = path.resolve(import.meta.dirname, '..', 'templates');
    for (const entry of readdirSync(templates, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name !== '_package.json') continue;
      const raw = readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
      expect(raw, `${entry.parentPath} mentions Chakra`).not.toContain('@chakra-ui/');
    }
  });
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

describe('the provider', () => {
  it('React: the client provider is generated and wraps the application', () => {
    const provider = fileAt(reactManifest(), 'src/components/ui/AppProviders.tsx');
    expect(provider).toBe(template('AppProviders.tsx'));
    expect(provider).toContain('<ChakraProvider value={system}>');
    expect(provider).not.toContain('useServerInsertedHTML');

    const app = fileAt(reactManifest(), 'src/App.tsx');
    expect(app).toContain("import { AppProviders } from './components/ui/AppProviders';");
    expect(app).toContain('<AppProviders>');
  });

  it('React Router: the provider wraps the router, not one route', () => {
    const app = fileAt(reactManifest({ router: 'react-router' }), 'src/App.tsx');
    expect(app.indexOf('<AppProviders>')).toBeGreaterThanOrEqual(0);
    expect(app.indexOf('<AppProviders>')).toBeLessThan(app.indexOf('<AppRouter>'));
  });

  it('Next.js: the server-inserted provider flushes styles into the head', () => {
    // Next's shell owns `AppProviders.tsx`; the UI library fills the slot
    // inside it, which the architecture maps to `UiProviders.tsx`.
    const provider = fileAt(nextManifest(), 'components/providers/UiProviders.tsx');
    expect(provider).toBe(template('AppProviders.server-inserted.tsx'));
    expect(provider.startsWith("'use client';")).toBe(true);
    expect(provider).toContain('useServerInsertedHTML');
    expect(provider).toContain('<ChakraProvider value={system}>');
    expect(fileAt(nextManifest(), 'components/providers/AppProviders.tsx')).toContain(
      "from './UiProviders'",
    );
    expect(fileAt(nextManifest(), 'app/layout.tsx')).toContain('<Providers>');
  });

  it('turns off the reset that would override the styling system', () => {
    for (const name of ['AppProviders.tsx', 'AppProviders.server-inserted.tsx']) {
      expect(template(name), name).toContain('preflight: false');
    }
  });
});

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

describe('golden: Chakra UI', () => {
  const scenarios = [
    {
      name: 'React + Vite + Tailwind + Chakra, Coming Soon',
      file: './golden/react-chakra-coming-soon-url.txt',
      manifest: reactManifest(),
    },
    {
      name: 'Next.js + Chakra, Coming Soon',
      file: './golden/next-chakra-coming-soon-url.txt',
      manifest: nextManifest({ styling: 'none' }),
    },
  ];

  for (const scenario of scenarios) {
    it(`golden: ${scenario.name}`, async () => {
      const { plan } = planFor(scenario.manifest);
      await expect(renderPlan(plan, TEMPLATES_ROOT)).toMatchFileSnapshot(scenario.file);
    });
  }
});
