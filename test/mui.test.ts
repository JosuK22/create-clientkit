import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_DECLARATION } from '../src/adapters/bootstrap.js';
import { composedAppRoot, planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { MUI_DECLARATION } from '../src/adapters/mui.js';
import { REACT_DECLARATION } from '../src/adapters/react.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import { TAILWIND_DECLARATION } from '../src/adapters/tailwind.js';
import { VITE_DECLARATION } from '../src/adapters/vite.js';
import type {
  AdapterDeclaration,
  Contribution,
  ProjectManifest,
  UiLibraryId,
} from '../src/domain/index.js';
import { emptyContribution } from '../src/domain/index.js';
import { evaluateCombination } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * Material UI, and the UI-library dimension.
 *
 * The claim under test is not "MUI works". It is that a component library is a
 * dimension of its own - independent of the framework, the build tool, and
 * above all the styling system - so that `React + Vite + Tailwind + MUI` is a
 * composition of four adapters rather than a fifth product.
 *
 * The sharpest tests here are the hypothetical ones. MUI is proven to work with
 * a framework that does not exist and to be refused by another, purely on
 * capabilities, without MUI naming anything.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

/** Capability names a declaration requires, across both constraint shapes. */
const requiredCapabilities = (declaration: AdapterDeclaration): readonly string[] =>
  declaration.requires.flatMap((entry) =>
    entry.kind === 'requires'
      ? [entry.capability]
      : entry.kind === 'requiresOneOf'
        ? [...entry.capabilities]
        : [],
  );

const manifest = (
  uiLibrary: UiLibraryId,
  over: Partial<ProjectManifest> = {},
): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-app'),
  projectName: 'acme-app',
  framework: 'react',
  buildTool: 'vite',
  language: 'ts',
  styling: 'tailwind',
  uiLibrary,
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

const planFor = (uiLibrary: UiLibraryId, over: Partial<ProjectManifest> = {}) =>
  planManifest(manifest(uiLibrary, over), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: over.starter ?? 'coming-soon',
  });

const contributionsOf = (uiLibrary: UiLibraryId) =>
  resolveWithAdapters(manifest(uiLibrary), TEMPLATES_ROOT).contributions;

// ---------------------------------------------------------------------------
// The dimension
// ---------------------------------------------------------------------------

describe('a UI library is not a styling system', () => {
  it('MUI occupies the UI-library dimension', () => {
    expect(MUI_DECLARATION.kind).toBe('ui-library');
  });

  it('Tailwind and Bootstrap remain styling systems', () => {
    // Guards the dimension from collapsing in a future refactor: the moment
    // one of these three moves, a project can no longer ask for a component
    // library and a stylesheet at the same time.
    expect(TAILWIND_DECLARATION.kind).toBe('styling');
    expect(BOOTSTRAP_DECLARATION.kind).toBe('styling');
  });

  it('the two dimensions are filled independently in one project', () => {
    const selected = selectAdapters(manifest('mui'), adapters).adapters.map((entry) => entry.ref);
    expect(selected).toContain('styling:tailwind');
    expect(selected).toContain('ui-library:mui');
  });

  it('MUI is addressable only as a UI library, never as styling', () => {
    expect(() => adapters.styling('mui' as never)).toThrow(CliError);
    expect(adapters.uiLibrary('mui').declaration.id).toBe('mui');
  });

  it('Emotion is MUI\u2019s engine, not the project\u2019s styling choice', () => {
    // The distinction that is easiest to get wrong. Emotion is CSS-in-JS and
    // MUI depends on it, but the project's styling dimension is still Tailwind
    // and the global stylesheet still comes from the styling adapter.
    const emotion = contributionsOf('mui')
      .flatMap((contribution) => contribution.dependencies)
      .filter((dependency) => dependency.name.startsWith('@emotion/'));
    expect(emotion.length).toBeGreaterThan(0);
    expect(emotion.every((dependency) => dependency.owner === 'ui-library:mui')).toBe(true);

    const stylesheet = planFor('mui').plan.operations.find(
      (operation) => operation.path === 'src/styles/index.css',
    );
    expect(stylesheet?.origin).toBe('styling:tailwind');
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe('MUI requires a capability, not an adapter', () => {
  it('requires a React runtime and somewhere to mount context, and nothing else', () => {
    // `client-app-root` was split out of `react-runtime` in Stage 22. The
    // declaration always said MUI mounts context above the tree; asking only
    // for the runtime was sufficient while React was the only framework that
    // provided one, and stopped being sufficient when Next arrived with a
    // server-rendered root.
    expect(requiredCapabilities(MUI_DECLARATION)).toEqual(['react-runtime', 'client-app-root']);
  });

  it('names no framework, build tool or styling system anywhere in what it declares', () => {
    const declared = JSON.stringify(MUI_DECLARATION).toLowerCase();
    for (const name of ['react-adapter', 'vite', 'tailwind', 'bootstrap', 'astro']) {
      expect(declared, `the declaration mentions ${name}`).not.toContain(name);
    }
    // `react-runtime` is a capability and legitimately contains "react"; the
    // requirement is that no *adapter id* is used to encode compatibility.
    expect(requiredCapabilities(MUI_DECLARATION)).toEqual(['react-runtime', 'client-app-root']);
  });

  it('names no adapter in its code, only in prose explaining the design', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'mui.ts'),
      'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .toLowerCase();
    for (const name of ['vite', 'tailwind', 'bootstrap', 'astro']) {
      expect(code, `mui.ts names ${name} in code`).not.toContain(name);
    }
  });

  it('React + Vite + Tailwind + MUI is compatible', () => {
    const report = checkCompatibility(manifest('mui'), adapters);
    expect(report.compatible).toBe(true);
  });

  it('a hypothetical non-React framework that provides react-runtime satisfies MUI', () => {
    // The strongest statement available: MUI works with a framework that does
    // not exist, has never been written, and that MUI cannot name.
    const hypothetical: AdapterDeclaration = {
      id: 'preact' as never,
      kind: 'framework',
      displayName: 'A framework that is not React',
      provides: ['react-runtime', 'jsx', 'typescript', 'composed-stylesheet', 'client-app-root'],
      requires: [],
    };
    const report = evaluateCombination([hypothetical, MUI_DECLARATION]);
    expect(report.compatible).toBe(true);
  });

  it('a hypothetical framework without react-runtime is refused', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'svelte' as never,
      kind: 'framework',
      displayName: 'A framework with no React runtime',
      provides: ['jsx', 'typescript', 'composed-stylesheet'],
      requires: [],
    };
    const report = evaluateCombination([hypothetical, MUI_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report)).toContain('react-runtime');
  });

  it('a hypothetical build tool that is not Vite is not rejected', () => {
    // MUI ships compiled JavaScript and needs no bundler plugin. Requiring
    // `vite-plugins` would have quietly excluded every other bundler.
    const hypothetical: AdapterDeclaration = {
      id: 'rspack' as never,
      kind: 'build-tool',
      displayName: 'A build tool that is not Vite',
      provides: ['vite-plugins'],
      requires: [],
    };
    const report = evaluateCombination([
      REACT_DECLARATION,
      hypothetical,
      BOOTSTRAP_DECLARATION,
      MUI_DECLARATION,
    ]);
    expect(report.compatible).toBe(true);
  });

  it('MUI is compatible with a styling system it was never tested against', () => {
    // Compatibility is not support - see the docs - but the capability model
    // must not manufacture a conflict where none exists.
    const report = evaluateCombination([
      REACT_DECLARATION,
      VITE_DECLARATION,
      BOOTSTRAP_DECLARATION,
      MUI_DECLARATION,
    ]);
    expect(report.compatible).toBe(true);
  });

  it('MUI asks for no styling system of its own', () => {
    /*
     * This asserted `compatible` outright until Stage 52, which found that the
     * stack it was asserting about could not be generated: React's entry point
     * imports the global stylesheet, nothing contributes one without a styling
     * system, and the refusal arrived at plan time while compatibility said
     * yes. React now says so itself.
     *
     * The claim this test exists for is untouched and is stated more exactly:
     * whatever is missing here is React's requirement, never MUI's. MUI brings
     * its own styles and adds no styling constraint to any stack it joins.
     */
    const report = evaluateCombination([REACT_DECLARATION, VITE_DECLARATION, MUI_DECLARATION]);
    expect(report.violations.map((violation) => violation.adapter)).not.toContain(
      MUI_DECLARATION.id,
    );
    expect(
      MUI_DECLARATION.requires.map((constraint) => JSON.stringify(constraint)).join(),
    ).not.toContain('css-framework');
    // And with any styling system present, nothing is missing at all.
    expect(
      evaluateCombination([
        REACT_DECLARATION,
        VITE_DECLARATION,
        BOOTSTRAP_DECLARATION,
        MUI_DECLARATION,
      ]).compatible,
    ).toBe(true);
  });

  it('a second hypothetical UI library needs no change to React', () => {
    // Proves the capability, not the adapter, is what React exposes.
    const alpha: AdapterDeclaration = {
      id: 'chakra',
      kind: 'ui-library',
      displayName: 'A hypothetical component library',
      provides: [],
      requires: [
        { kind: 'requires', capability: 'react-runtime', because: 'it renders React components' },
      ],
    };
    expect(evaluateCombination([REACT_DECLARATION, BOOTSTRAP_DECLARATION, alpha]).compatible).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('selection', () => {
  it('React + Vite + Tailwind + MUI selects exactly four adapters', () => {
    expect(selectAdapters(manifest('mui'), adapters).adapters.map((entry) => entry.ref)).toEqual([
      'framework:react',
      'build-tool:vite',
      'styling:tailwind',
      'ui-library:mui',
    ]);
  });

  it('uiLibrary none selects no UI-library adapter, and is not an error', () => {
    expect(selectAdapters(manifest('none'), adapters).adapters.map((entry) => entry.ref)).toEqual([
      'framework:react',
      'build-tool:vite',
      'styling:tailwind',
    ]);
  });

  it('refuses a known but unimplemented UI library, with no fallback', () => {
    for (const id of ['chakra', 'angular-material'] as const) {
      expect(() => adapters.uiLibrary(id)).toThrow(CliError);
      expect(() => resolveProject(manifest(id), adapters)).toThrow(CliError);
    }
  });

  it('an unimplemented UI library never becomes MUI', () => {
    let selected: readonly string[];
    try {
      selected = selectAdapters(manifest('chakra'), adapters).adapters.map((entry) => entry.ref);
    } catch {
      selected = [];
    }
    expect(selected).not.toContain('ui-library:mui');
  });

  it('MUI never silently becomes none', () => {
    expect(selectAdapters(manifest('mui'), adapters).adapters.map((entry) => entry.ref)).toContain(
      'ui-library:mui',
    );
  });

  it('reports which UI libraries are actually implemented', () => {
    expect(adapters.implementedUiLibraries()).toEqual(['mui']);
    expect(adapters.hasUiLibrary('mui')).toBe(true);
    expect(adapters.hasUiLibrary('chakra')).toBe(false);
  });

  it('carries the choice through to the resolved project', () => {
    const { project } = resolveProject(manifest('mui'), adapters);
    expect(project.selection.uiLibrary).toBe('mui');
    expect(project.capabilities.has('css-in-js')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

describe('contributions', () => {
  const muiContribution = () =>
    contributionsOf('mui').find((contribution) => contribution.owner === 'ui-library:mui');

  it('owns its packages, including its styling engine', () => {
    const dependencies = muiContribution()?.dependencies ?? [];
    expect(dependencies.map((entry) => entry.name).sort()).toEqual([
      '@emotion/react',
      '@emotion/styled',
      '@mui/material',
    ]);
    expect(dependencies.every((entry) => entry.owner === 'ui-library:mui')).toBe(true);
    expect(dependencies.every((entry) => entry.kind === 'prod')).toBe(true);
    expect(dependencies.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('pins exact versions rather than ranges', () => {
    for (const dependency of muiContribution()?.dependencies ?? []) {
      expect(dependency.version, `${dependency.name} is not an exact pin`).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
    }
  });

  it('no other adapter smuggles in a MUI package', () => {
    for (const contribution of contributionsOf('mui')) {
      if (contribution.owner === 'ui-library:mui') continue;
      for (const dependency of contribution.dependencies) {
        expect(
          dependency.name.startsWith('@mui/') || dependency.name.startsWith('@emotion/'),
          `${contribution.owner} declares ${dependency.name}`,
        ).toBe(false);
      }
    }
  });

  it('contributes no scripts, because it needs none', () => {
    expect(muiContribution()?.scripts).toEqual([]);
  });

  it('contributes no configuration file of its own', () => {
    // MUI is configured in TypeScript by editing the provider it contributes.
    // Inventing a mui.config.ts would be an abstraction with nothing in it.
    const files = muiContribution()?.files ?? [];
    expect(files.map((file) => file.target)).toEqual([{ kind: 'role', role: 'app.providers' }]);
    expect(files.every((file) => file.target.kind === 'role')).toBe(true);
  });

  it('contributes no template layer, so it cannot override anyone', () => {
    expect(muiContribution()?.templateLayers).toEqual([]);
  });

  it('addresses the application root by slot, naming only its own export', () => {
    const config = muiContribution()?.config ?? [];
    expect(config.map((entry) => ({ target: entry.target, at: entry.at }))).toEqual([
      { target: 'app.root', at: 'providers' },
    ]);
    // Since Stage 12 the entry also names the role holding its own file and
    // where it nests, because a router can now wrap the application too. Both
    // are semantic: still no path, still only its own export.
    expect(config[0]?.value).toEqual({
      importName: 'AppProviders',
      role: 'app.providers',
      order: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the MUI adapter stays inside the contract', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'mui.ts'),
    'utf8',
  );

  it('touches no filesystem, process or network API', () => {
    for (const forbidden of [
      'node:fs',
      'node:child_process',
      'node:process',
      'readFileSync',
      'writeFileSync',
      'execSync',
      'spawn',
      'fetch(',
    ]) {
      expect(source, `mui.ts uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('imports no other adapter', () => {
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      expect(specifier, `mui.ts imports ${specifier}`).not.toMatch(
        /\.\/(react|vite|tailwind|bootstrap|astro)\.js$/,
      );
    }
  });

  it('is a pure function of its inputs', () => {
    const first = JSON.stringify(contributionsOf('mui'));
    const second = JSON.stringify(contributionsOf('mui'));
    expect(first).toBe(second);
  });

  it('resolves identically whatever the rest of the manifest says', () => {
    const mui = adapters.uiLibrary('mui');
    expect(mui.resolve(manifest('mui'))).toEqual(
      mui.resolve({ ...manifest('mui'), styling: 'bootstrap', buildTool: 'vite' }),
    );
  });
});

// ---------------------------------------------------------------------------
// The composed application root
// ---------------------------------------------------------------------------

describe('the composed application root', () => {
  const appRoot = (uiLibrary: UiLibraryId): string => {
    const operation = planFor(uiLibrary).plan.operations.find(
      (entry) => entry.path === 'src/App.tsx',
    );
    return operation?.type === 'write' ? operation.content : '';
  };

  it('wraps the page in the provider when a UI library is selected', () => {
    const content = appRoot('mui');
    expect(content).toContain("import { AppProviders } from './components/ui/AppProviders';");
    expect(content).toContain('<AppProviders>');
    expect(content).toContain('<HomePage />');
  });

  it('emits the plain root when none is', () => {
    const content = appRoot('none');
    expect(content).toContain('return <HomePage />;');
    expect(content).not.toContain('AppProviders');
  });

  it('records both contributors in the origin', () => {
    const operation = planFor('mui').plan.operations.find((entry) => entry.path === 'src/App.tsx');
    expect(operation?.origin).toBe('composed from framework:react + ui-library:mui');
  });

  it('produces the provider file the wrapper imports', () => {
    const paths = planFor('mui').plan.operations.map((entry) => entry.path);
    expect(paths).toContain('src/components/ui/AppProviders.tsx');
  });

  it('uses a POSIX-relative specifier, never a filesystem path', () => {
    const content = appRoot('mui');
    expect(content).not.toContain('\\');
    expect(content).not.toContain(TEST_CWD);
  });

  it('does not disturb the entry point the framework owns', () => {
    const entry = planFor('mui').plan.operations.find((op) => op.path === 'src/main.tsx');
    expect(entry?.origin).toBe('base');
    expect(entry?.type === 'write' ? entry.content : '').toContain("import { App } from './App';");
  });

  it('refuses a wrapper whose provider file nothing produces', () => {
    // The failure this prevents is the worst kind: an App.tsx importing a file
    // that was never written. It installs, it typechecks against nothing, and
    // it dies at build time. Constructed synthetically because no real adapter
    // can reach this state - MUI contributes the wrapper and the file together,
    // so only a broken adapter would arrive here.
    const { project } = resolveProject(manifest('none'), adapters);
    const wrapperOnly: Contribution = {
      ...emptyContribution('ui-library:alpha'),
      config: [
        {
          target: 'app.root',
          at: 'providers',
          value: { importName: 'AlphaProviders' },
          owner: 'ui-library:alpha',
          reason: 'a library that forgot to ship its provider',
        },
      ],
    };
    const framework: Contribution = {
      ...emptyContribution('framework:react'),
      config: [
        {
          target: 'app.root',
          at: 'page',
          value: { importName: 'HomePage' },
          owner: 'framework:react',
          reason: 'the page',
        },
      ],
    };

    expect(() => composedAppRoot(project, [framework, wrapperOnly], [])).toThrow(CliError);
    expect(() => composedAppRoot(project, [framework, wrapperOnly], [])).toThrow(
      /contributes no file for it/,
    );
  });

  it('nests two adapters that both wrap the application', () => {
    const { project } = resolveProject(manifest('none'), adapters);
    const page: Contribution = {
      ...emptyContribution('framework:react'),
      config: [
        {
          target: 'app.root',
          at: 'page',
          value: { importName: 'HomePage' },
          owner: 'framework:react',
          reason: 'the page',
        },
      ],
    };
    const wrapper = (owner: string): Contribution => ({
      ...emptyContribution(owner),
      config: [
        {
          target: 'app.root',
          at: 'providers',
          value: { importName: 'Providers' },
          owner,
          reason: 'wraps the app',
        },
      ],
    });

    // Stage 7 refused this outright, because only one kind of wrapper existed.
    // Stage 12 added a second - a router and a UI library both legitimately sit
    // above the tree - so identical bindings are the conflict, not the count.
    expect(() =>
      composedAppRoot(project, [page, wrapper('ui-library:alpha'), wrapper('ui-library:beta')], []),
    ).toThrow(/both want "Providers"/);
  });

  it('refuses a root with no page at all', () => {
    const { project } = resolveProject(manifest('none'), adapters);
    expect(() => composedAppRoot(project, [], [])).toThrow(/which page to render/);
  });

  it('leaves the page itself to the framework', () => {
    const page = planFor('mui').plan.operations.find((op) => op.path === 'src/pages/HomePage.tsx');
    expect(page?.origin).toBe('modes/coming-soon');
  });
});

// ---------------------------------------------------------------------------
// Package composition and drift
// ---------------------------------------------------------------------------

describe('MUI reaches package.json only through contributions', () => {
  const packageOf = (uiLibrary: UiLibraryId): Record<string, Record<string, string>> => {
    const operation = planFor(uiLibrary).plan.operations.find(
      (entry) => entry.path === 'package.json',
    );
    if (operation === undefined || operation.type !== 'write') throw new Error('no package.json');
    return JSON.parse(operation.content) as Record<string, Record<string, string>>;
  };

  it('installs exactly the packages MUI declared, at those versions', () => {
    const declared = Object.fromEntries(
      contributionsOf('mui')
        .flatMap((contribution) => contribution.dependencies)
        .filter((entry) => entry.owner === 'ui-library:mui')
        .map((entry) => [entry.name, entry.version]),
    );
    const installed = packageOf('mui')['dependencies'] ?? {};
    for (const [name, version] of Object.entries(declared)) {
      expect(installed[name], `${name} is not installed at the declared version`).toBe(version);
    }
  });

  it('installs none of them when MUI is not selected', () => {
    const installed = JSON.stringify(packageOf('none'));
    expect(installed).not.toContain('@mui/');
    expect(installed).not.toContain('@emotion/');
  });

  it('keeps every MUI dependency traceable to MUI', () => {
    const { composedPackage } = planFor('mui');
    for (const name of ['@mui/material', '@emotion/react', '@emotion/styled']) {
      const resolved = composedPackage?.dependencies.find((entry) => entry.name === name);
      expect(resolved?.contributors.map((entry) => entry.owner)).toEqual(['ui-library:mui']);
      expect(resolved?.contributors[0]?.reason.length).toBeGreaterThan(0);
    }
  });

  it('no template carries a MUI package', () => {
    // The Stage 6 rule, extended to the new dimension. A template listing
    // @mui/material would be silently ignored by the composer, which is worse
    // than a conflict because a reader would believe it.
    const templates = path.resolve(import.meta.dirname, '..', 'templates');
    for (const entry of readdirSync(templates, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name !== '_package.json') continue;
      const raw = readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
      expect(raw, `${entry.parentPath} mentions MUI`).not.toContain('@mui/');
      expect(raw, `${entry.parentPath} mentions Emotion`).not.toContain('@emotion/');
    }
  });

  it('adds MUI without moving anything else', () => {
    const withMui = packageOf('mui');
    const without = packageOf('none');
    const removed = { ...withMui['dependencies'] };
    for (const name of ['@mui/material', '@emotion/react', '@emotion/styled']) delete removed[name];
    expect(removed).toEqual(without['dependencies']);
    expect(withMui['devDependencies']).toEqual(without['devDependencies']);
    expect(withMui['scripts']).toEqual(without['scripts']);
  });
});

// ---------------------------------------------------------------------------
// Styling validation is not bypassed
// ---------------------------------------------------------------------------

describe('selecting a UI library does not weaken anything else', () => {
  it('still refuses React with no styling system', () => {
    /*
     * A UI library must not accidentally satisfy the architecture's stylesheet
     * requirement: MUI mounts a theme, not a global stylesheet. Unchanged in
     * substance; only the layer that says so moved. Through Stage 51 this was
     * the plan-time role guard, and Stage 52 found that compatibility had been
     * saying the same stack was fine - so the interactive flow offered it.
     */
    expect(() => planFor('mui', { styling: 'none' })).toThrow(CliError);
    expect(() => planFor('mui', { styling: 'none' })).toThrow(/will not work/);
    expect(checkCompatibility(manifest('mui', { styling: 'none' }), adapters).compatible).toBe(
      false,
    );
    // Refused for the stylesheet, and not because a UI library was selected.
    expect(checkCompatibility(manifest('none', { styling: 'none' }), adapters).compatible).toBe(
      false,
    );
  });

  it('does not substitute a styling system of its own', () => {
    let hint = '';
    try {
      planFor('mui', { styling: 'none' });
    } catch (error) {
      hint = (error as CliError).hint ?? '';
    }
    expect(hint).toMatch(/styling system/i);
  });

  it('the stylesheet still comes from the styling adapter', () => {
    const stylesheet = planFor('mui').plan.operations.find(
      (entry) => entry.path === 'src/styles/index.css',
    );
    expect(stylesheet?.origin).toBe('styling:tailwind');
    expect(stylesheet?.type === 'write' ? stylesheet.content : '').toContain(
      "@import 'tailwindcss'",
    );
  });

  it('MUI creates no second global stylesheet', () => {
    const stylesheets = planFor('mui')
      .plan.operations.map((entry) => entry.path)
      .filter((entry) => entry.endsWith('.css'));
    expect(stylesheets).toEqual(['src/styles/index.css']);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same manifest produces the same plan twice', () => {
    expect(renderPlan(planFor('mui').plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planFor('mui').plan, TEMPLATES_ROOT),
    );
  });

  it('no generated content carries a machine-specific value', () => {
    for (const operation of planFor('mui').plan.operations) {
      if (operation.type !== 'write') continue;
      expect(operation.content).not.toContain(TEST_CWD);
      expect(operation.content).not.toContain('C:\\');
      expect(operation.content).not.toContain('\r\n');
    }
  });
});

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

describe('golden: React + Vite + TypeScript + Tailwind + MUI', () => {
  const scenarios = [
    { name: 'MUI Coming Soon + URL', file: './golden/react-mui-coming-soon-url.txt', over: {} },
    {
      name: 'MUI Full + URL',
      file: './golden/react-mui-full-url.txt',
      over: { starter: 'full', features: [] as const },
    },
    {
      name: 'MUI URL-less',
      file: './golden/react-mui-url-less.txt',
      over: {
        site: {
          name: 'Acme Ltd',
          url: null,
          description: 'Bespoke widgets.',
          locale: 'en',
          author: null,
        },
      },
    },
  ];

  for (const scenario of scenarios) {
    it(`golden: ${scenario.name}`, async () => {
      const { plan } = planFor('mui', scenario.over as Partial<ProjectManifest>);
      await expect(renderPlan(plan, TEMPLATES_ROOT)).toMatchFileSnapshot(scenario.file);
    });
  }
});
