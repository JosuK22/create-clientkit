import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACCESSIBILITY_DECLARATION } from '../src/adapters/accessibility.js';
import { ASTRO_DECLARATION } from '../src/adapters/astro.js';
import { BOOTSTRAP_DECLARATION } from '../src/adapters/bootstrap.js';
import { composedAppRoot, planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { MUI_DECLARATION } from '../src/adapters/mui.js';
import { NOT_FOUND_DECLARATION } from '../src/adapters/not-found.js';
import { REACT_DECLARATION } from '../src/adapters/react.js';
import { REACT_ROUTER_DECLARATION } from '../src/adapters/react-router.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { SEO_DECLARATION } from '../src/adapters/seo.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import { STRUCTURED_DATA_DECLARATION } from '../src/adapters/structured-data.js';
import { TAILWIND_DECLARATION } from '../src/adapters/tailwind.js';
import { VITE_DECLARATION } from '../src/adapters/vite.js';
import { appRootEntries } from '../src/domain/app-composition.js';
import type { ConfigContribution, Contribution } from '../src/domain/contributions.js';
import { emptyContribution } from '../src/domain/contributions.js';
import type {
  AdapterDeclaration,
  ProjectManifest,
  RouterId,
  StylingId,
  UiLibraryId,
} from '../src/domain/index.js';
import { evaluateCombination } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * React Router, and the routing dimension.
 *
 * The claim under test is that routing is a dimension of its own - selected
 * explicitly, composable with any styling system and any UI library, owned by
 * neither the framework nor the build tool.
 *
 * The most important test in this file is the one that keeps a combination
 * *unsupported*: a client-side catch-all is not an HTTP 404, so
 * `react + vite + react-router + not-found` stays refused. Making it pass would
 * produce a project whose "404 page" answers 200 to every crawler.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const react = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-app'),
  projectName: 'acme-app',
  framework: 'react',
  buildTool: 'vite',
  language: 'ts',
  styling: 'tailwind',
  uiLibrary: 'none',
  router: 'react-router',
  architecture: 'react-standard',
  starter: 'full',
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

const planFor = (over: Partial<ProjectManifest> = {}) =>
  planManifest(react(over), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'full',
  });

const fileAt = (target: string, over: Partial<ProjectManifest> = {}): string => {
  const operation = planFor(over).plan.operations.find((entry) => entry.path === target);
  return operation?.type === 'write' ? operation.content : '';
};

const requiredCapabilities = (declaration: AdapterDeclaration): readonly string[] =>
  declaration.requires.flatMap((entry) =>
    entry.kind === 'requires'
      ? [entry.capability]
      : entry.kind === 'requiresOneOf'
        ? [...entry.capabilities]
        : [],
  );

// ---------------------------------------------------------------------------
// The dimension
// ---------------------------------------------------------------------------

describe('routing is a dimension of its own', () => {
  it('the adapter occupies the router dimension', () => {
    expect(REACT_ROUTER_DECLARATION.kind).toBe('router');
    expect(REACT_ROUTER_DECLARATION.id).toBe('react-router');
  });

  it('is addressable only as a router', () => {
    expect(adapters.router('react-router').declaration.id).toBe('react-router');
    expect(() => adapters.styling('react-router' as never)).toThrow(CliError);
    expect(() => adapters.uiLibrary('react-router' as never)).toThrow(CliError);
    expect(() => adapters.feature('react-router' as never)).toThrow(CliError);
  });

  it('reports itself as the only implemented router', () => {
    expect(adapters.implementedRouters()).toEqual(['react-router']);
    expect(adapters.hasRouter('react-router')).toBe(true);
    expect(adapters.hasRouter('angular-router')).toBe(false);
  });

  it('refuses a known but unimplemented router, with no fallback', () => {
    expect(() => adapters.router('angular-router')).toThrow(CliError);
    let refs: readonly string[];
    try {
      refs = selectAdapters(react({ router: 'angular-router' }), adapters).adapters.map(
        (entry) => entry.ref,
      );
    } catch {
      refs = [];
    }
    expect(refs).not.toContain('router:react-router');
  });
});

// ---------------------------------------------------------------------------
// The framework does not drag it in
// ---------------------------------------------------------------------------

describe('the router is opt-in', () => {
  it('React does not select it', () => {
    const refs = selectAdapters(react({ router: 'none' }), adapters).adapters.map(
      (entry) => entry.ref,
    );
    expect(refs).not.toContain('router:react-router');
    expect(refs).toEqual(['framework:react', 'build-tool:vite', 'styling:tailwind']);
  });

  it('React declares no router capability of its own', () => {
    expect(REACT_DECLARATION.provides).not.toContain('client-side-routing');
  });

  it('the two manifests genuinely differ', () => {
    expect(renderPlan(planFor({ router: 'none' }).plan, TEMPLATES_ROOT)).not.toBe(
      renderPlan(planFor().plan, TEMPLATES_ROOT),
    );
  });

  it('without it, the generated project is exactly what it was', () => {
    // The invariant that matters most for everyone not asking for a router.
    const without = planFor({ router: 'none' }).plan;
    expect(without.operations).toHaveLength(21);
    expect(without.operations.map((entry) => entry.path)).not.toContain('src/routes/AppRouter.tsx');
    expect(JSON.stringify(without.operations)).not.toContain('react-router');
  });

  it('`file-based` selects no adapter either, because it is not one', () => {
    // It is what a framework that routes by file already does, recorded on the
    // manifest so the choice is visible rather than implied.
    const refs = selectAdapters(
      { ...react({ router: 'file-based' }), framework: 'astro', architecture: 'astro-standard' },
      adapters,
    ).adapters.map((entry) => entry.ref);
    expect(refs.some((ref) => ref.startsWith('router:'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Capability, not adapter identity
// ---------------------------------------------------------------------------

describe('it requires a capability and names nothing', () => {
  it('requires a React runtime and a client root, and nothing else', () => {
    // See MUI's equivalent: `client-app-root` is the half of `react-runtime`
    // that a framework routing its own files does not provide.
    expect(requiredCapabilities(REACT_ROUTER_DECLARATION)).toEqual([
      'react-runtime',
      'client-app-root',
    ]);
  });

  it('requires no build tool, styling system, UI library or feature', () => {
    for (const capability of [
      'vite-plugins',
      'css-framework',
      'composed-stylesheet',
      'css-in-js',
      'document-metadata',
      'file-based-routing',
    ]) {
      expect(requiredCapabilities(REACT_ROUTER_DECLARATION)).not.toContain(capability);
    }
  });

  it('provides client-side routing, and deliberately not file-based routing', () => {
    // The whole point. A catch-all renders a component; it does not produce an
    // HTTP 404.
    expect(REACT_ROUTER_DECLARATION.provides).toEqual(['client-side-routing']);
    expect(REACT_ROUTER_DECLARATION.provides).not.toContain('file-based-routing');
    expect(REACT_ROUTER_DECLARATION.provides).not.toContain('spa-routing');
  });

  it('names no adapter anywhere in what it declares', () => {
    const declared = JSON.stringify(REACT_ROUTER_DECLARATION).toLowerCase();
    for (const name of ['astro', 'vite', 'tailwind', 'bootstrap', 'mui', 'seo', 'not-found']) {
      expect(declared, `the declaration mentions ${name}`).not.toContain(name);
    }
  });

  it('names no other adapter in its code', () => {
    const code = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'react-router.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .toLowerCase();
    for (const name of ['astro', 'vite', 'tailwind', 'bootstrap', 'mui']) {
      expect(code, `react-router.ts names ${name} in code`).not.toContain(name);
    }
  });

  it('contains no concrete framework path', () => {
    const code = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'react-router.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const fragment of [
      'src/main',
      'src/App',
      'src/pages',
      'src/components',
      'src/layouts',
      'main.tsx',
      'App.tsx',
    ]) {
      expect(code, `react-router.ts contains ${fragment}`).not.toContain(fragment);
    }
  });

  it('imports no other adapter', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'react-router.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map((m) => m[1]);
    for (const specifier of imports) {
      expect(specifier, `it imports ${specifier}`).not.toMatch(
        /\.\/(react|vite|tailwind|bootstrap|mui|astro|seo|not-found|structured-data|accessibility)\.js$/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('compatibility is decided by capability', () => {
  it('React + Vite + Tailwind + router is compatible', () => {
    expect(checkCompatibility(react(), adapters).compatible).toBe(true);
  });

  it('a framework with no React runtime is refused', () => {
    expect(
      checkCompatibility(
        { ...react(), framework: 'astro', architecture: 'astro-standard' },
        adapters,
      ).compatible,
    ).toBe(false);
  });

  it('the refusal names the missing capability', () => {
    let error: CliError | undefined;
    try {
      resolveProject({ ...react(), framework: 'astro', architecture: 'astro-standard' }, adapters);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    expect(text).toContain('react-runtime');
    expect(text).toContain('React Router');
  });

  it('a hypothetical non-React framework providing react-runtime satisfies it', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'preact' as never,
      kind: 'framework',
      displayName: 'A framework that is not React',
      provides: ['react-runtime', 'jsx', 'composed-stylesheet', 'client-app-root'],
      requires: [],
    };
    expect(evaluateCombination([hypothetical, REACT_ROUTER_DECLARATION]).compatible).toBe(true);
  });

  it('a hypothetical framework without it is refused', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'svelte' as never,
      kind: 'framework',
      displayName: 'A framework with no React runtime',
      provides: ['jsx', 'composed-stylesheet'],
      requires: [],
    };
    const report = evaluateCombination([hypothetical, REACT_ROUTER_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report)).toContain('react-runtime');
  });

  it('is indifferent to the styling system', () => {
    for (const styling of [TAILWIND_DECLARATION, BOOTSTRAP_DECLARATION]) {
      expect(
        evaluateCombination([
          REACT_DECLARATION,
          VITE_DECLARATION,
          styling,
          REACT_ROUTER_DECLARATION,
        ]).compatible,
      ).toBe(true);
    }
  });

  it('is indifferent to the UI library', () => {
    expect(
      evaluateCombination([
        REACT_DECLARATION,
        VITE_DECLARATION,
        MUI_DECLARATION,
        REACT_ROUTER_DECLARATION,
      ]).compatible,
    ).toBe(true);
    expect(
      evaluateCombination([REACT_DECLARATION, VITE_DECLARATION, REACT_ROUTER_DECLARATION])
        .compatible,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The invariant this stage exists to protect
// ---------------------------------------------------------------------------

describe('a router is not file-based routing', () => {
  it('React + Vite + router + not-found is still refused', () => {
    // The most important test in this file. A client-side catch-all renders a
    // component after the response has already been sent; the status is still
    // whatever the host returned. Making this pass would ship a "404 page"
    // that answers 200 to every crawler.
    expect(
      checkCompatibility(react({ starter: 'full', features: ['not-found'] }), adapters).compatible,
    ).toBe(false);
  });

  it('the refusal still names file-based routing, not the router', () => {
    let error: CliError | undefined;
    try {
      resolveProject(react({ starter: 'full', features: ['not-found'] }), adapters);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    expect(text).toContain('file-based-routing');
    expect(text).toContain('Not-found page');
  });

  it('not-found was not weakened to accommodate the router', () => {
    expect(requiredCapabilities(NOT_FOUND_DECLARATION)).toEqual(['file-based-routing']);
  });

  it('the router does not satisfy not-found even in a synthetic combination', () => {
    expect(
      evaluateCombination([
        REACT_DECLARATION,
        VITE_DECLARATION,
        REACT_ROUTER_DECLARATION,
        NOT_FOUND_DECLARATION,
      ]).compatible,
    ).toBe(false);
  });

  it('the three routing capabilities remain distinct', () => {
    expect(ASTRO_DECLARATION.provides).toContain('file-based-routing');
    expect(REACT_DECLARATION.provides).toContain('spa-routing');
    expect(REACT_ROUTER_DECLARATION.provides).toContain('client-side-routing');
    expect(ASTRO_DECLARATION.provides).not.toContain('client-side-routing');
  });

  it('the generated router file says so too', () => {
    // The developer reading the file gets the same caveat the architecture does.
    const content = fileAt('src/routes/AppRouter.tsx');
    expect(content).toMatch(/does not produce an HTTP 404|response itself is still/i);
  });
});

// ---------------------------------------------------------------------------
// Independence from the features
// ---------------------------------------------------------------------------

describe('the router changes no feature', () => {
  it('SEO stays refused for React, router or not', () => {
    // React still has no document-metadata; a client router does not give it
    // one, and pretending otherwise would ship metadata crawlers never see.
    expect(
      checkCompatibility(react({ starter: 'full', features: ['seo'] }), adapters).compatible,
    ).toBe(false);
  });

  it('structured data stays refused for React', () => {
    expect(
      checkCompatibility(react({ starter: 'full', features: ['structured-data'] }), adapters)
        .compatible,
    ).toBe(false);
  });

  it('accessibility stays refused for React', () => {
    expect(
      checkCompatibility(react({ starter: 'full', features: ['accessibility'] }), adapters)
        .compatible,
    ).toBe(false);
  });

  it('the router provides no document-metadata', () => {
    expect(REACT_ROUTER_DECLARATION.provides).not.toContain('document-metadata');
    for (const declaration of [
      SEO_DECLARATION,
      STRUCTURED_DATA_DECLARATION,
      ACCESSIBILITY_DECLARATION,
    ]) {
      expect(requiredCapabilities(declaration)).toContain('document-metadata');
    }
  });

  it('generates no metadata, structured data or accessibility claim', () => {
    const result = planFor();
    expect(result.metadata).toEqual([]);
    expect(result.structuredData).toEqual([]);
    expect(result.accessibility).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What it contributes
// ---------------------------------------------------------------------------

describe('contributions', () => {
  const contribution = () =>
    resolveWithAdapters(react(), TEMPLATES_ROOT).contributions.find(
      (entry) => entry.owner === 'router:react-router',
    );

  it('owns exactly one dependency, pinned exactly', () => {
    const dependencies = contribution()?.dependencies ?? [];
    expect(dependencies.map((entry) => entry.name)).toEqual(['react-router-dom']);
    expect(dependencies[0]?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dependencies[0]?.kind).toBe('prod');
    expect(dependencies[0]?.owner).toBe('router:react-router');
    expect(dependencies[0]?.reason.length).toBeGreaterThan(0);
  });

  it('adds no script and no configuration file', () => {
    expect(contribution()?.scripts).toEqual([]);
    expect(contribution()?.templateLayers).toEqual([]);
  });

  it('contributes the home route rather than a file, since Stage 13', () => {
    // The route table became composed when a second adapter needed to add a
    // catch-all. The alternative was editing another owner's file by string
    // replacement, which this codebase does not do.
    expect(contribution()?.files).toEqual([]);
    const routes = (contribution()?.config ?? []).filter((entry) => entry.at === 'routes');
    expect(routes).toHaveLength(1);
    expect(routes[0]?.value).toEqual({ path: '/', element: { kind: 'children' }, order: 0 });
  });

  it('asks to wrap the application root, naming only its own export and role', () => {
    const config = (contribution()?.config ?? []).filter((entry) => entry.at !== 'routes');
    expect(config.map((entry) => ({ target: entry.target, at: entry.at }))).toEqual([
      { target: 'app.root', at: 'providers' },
    ]);
    const value = config[0]?.value as { importName: string; role: string; order: number };
    expect(value.importName).toBe('AppRouter');
    expect(value.role).toBe('app.router');
    // Innermost. A wrapper inside the router wraps one route; the theme has to
    // be outside it or a second route renders unthemed.
    expect(value.order).toBe(100);
  });

  it('no other adapter smuggles in a router package', () => {
    for (const entry of resolveWithAdapters(react(), TEMPLATES_ROOT).contributions) {
      if (entry.owner === 'router:react-router') continue;
      for (const dependency of entry.dependencies) {
        expect(dependency.name, `${entry.owner} declares ${dependency.name}`).not.toMatch(
          /router/i,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Package composition
// ---------------------------------------------------------------------------

describe('the dependency reaches package.json only through composition', () => {
  const packageOf = (over: Partial<ProjectManifest> = {}): Record<string, Record<string, string>> =>
    JSON.parse(fileAt('package.json', over)) as Record<string, Record<string, string>>;

  it('installs the router at the declared version', () => {
    const declared = (resolveWithAdapters(react(), TEMPLATES_ROOT).contributions.find(
      (entry) => entry.owner === 'router:react-router',
    )?.dependencies ?? [])[0];
    expect(packageOf()['dependencies']?.['react-router-dom']).toBe(declared?.version);
  });

  it('installs nothing router-shaped when no router is selected', () => {
    expect(JSON.stringify(packageOf({ router: 'none' }))).not.toContain('router');
  });

  it('keeps the dependency traceable to the router', () => {
    const resolved = planFor().composedPackage?.dependencies.find(
      (entry) => entry.name === 'react-router-dom',
    );
    expect(resolved?.contributors.map((entry) => entry.owner)).toEqual(['router:react-router']);
    expect(resolved?.contributors[0]?.reason.length).toBeGreaterThan(0);
  });

  it('adds the router without moving anything else', () => {
    const withRouter = { ...packageOf()['dependencies'] };
    delete withRouter['react-router-dom'];
    expect(withRouter).toEqual(packageOf({ router: 'none' })['dependencies']);
    expect(packageOf()['devDependencies']).toEqual(
      packageOf({ router: 'none' })['devDependencies'],
    );
    expect(packageOf()['scripts']).toEqual(packageOf({ router: 'none' })['scripts']);
  });

  it('no template carries a router package', () => {
    for (const template of ['astro-tailwind', 'react-vite']) {
      const raw = readFileSync(
        path.resolve(import.meta.dirname, '..', 'templates', template, 'base', '_package.json'),
        'utf8',
      );
      expect(raw, `${template} mentions a router`).not.toMatch(/router/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Root composition
// ---------------------------------------------------------------------------

describe('the application root composes the router', () => {
  it('wraps the page in the router', () => {
    const content = fileAt('src/App.tsx');
    expect(content).toContain("import { AppRouter } from './routes/AppRouter';");
    expect(content).toContain('<AppRouter>');
    expect(content).toContain('<HomePage />');
  });

  it('produces the file the wrapper imports', () => {
    expect(planFor().plan.operations.map((entry) => entry.path)).toContain(
      'src/routes/AppRouter.tsx',
    );
  });

  it('records both contributors in the origin', () => {
    const operation = planFor().plan.operations.find((entry) => entry.path === 'src/App.tsx');
    expect(operation?.origin).toBe('composed from framework:react + router:react-router');
  });

  it('replaces the "ships without a router" note, which would now be false', () => {
    // A generated file that describes itself incorrectly is worse than one with
    // no comment.
    expect(fileAt('src/App.tsx')).not.toContain('ships without a router');
    expect(fileAt('src/App.tsx', { router: 'none' })).toContain('ships without a router');
  });

  it('nests inside-out with a UI library, router innermost', () => {
    // The router goes inside the theme, and the direction matters more than it
    // looks. The page the router is handed becomes one route's element, so a
    // wrapper inside the router wraps that route and no other. Put the theme
    // there and a second route renders with no theme at all - which is exactly
    // what Stage 13's fallback did before this order was corrected.
    const content = fileAt('src/App.tsx', { uiLibrary: 'mui' });
    expect(content).toContain('<AppRouter>');
    expect(content).toContain('<AppProviders>');
    expect(content.indexOf('<AppProviders>')).toBeLessThan(content.indexOf('<AppRouter>'));
    expect(content.indexOf('<HomePage />')).toBeGreaterThan(content.indexOf('<AppRouter>'));
  });

  it('records all three contributors when a UI library is selected too', () => {
    const operation = planFor({ uiLibrary: 'mui' }).plan.operations.find(
      (entry) => entry.path === 'src/App.tsx',
    );
    expect(operation?.origin).toBe(
      'composed from framework:react + ui-library:mui + router:react-router',
    );
  });

  it('leaves the entry point and the page to the framework', () => {
    const entry = planFor().plan.operations.find((op) => op.path === 'src/main.tsx');
    const page = planFor().plan.operations.find((op) => op.path === 'src/pages/HomePage.tsx');
    expect(entry?.origin).toBe('base');
    expect(page?.origin).toBe('modes/full');
  });

  it('the router file is owned by the router', () => {
    const operation = planFor().plan.operations.find(
      (entry) => entry.path === 'src/routes/AppRouter.tsx',
    );
    expect(operation?.origin).toBe('router:react-router');
  });
});

// ---------------------------------------------------------------------------
// Nesting, duplicates and conflicts
// ---------------------------------------------------------------------------

describe('wrappers nest rather than fight', () => {
  const wrapper = (
    owner: string,
    importName: string,
    order: number,
    role = 'app.providers',
  ): ConfigContribution => ({
    target: 'app.root',
    at: 'providers',
    value: { importName, role, order },
    owner,
    reason: 'wraps the app',
  });

  it('orders by the declared position, not by selection order', () => {
    const forwards = appRootEntries(
      [wrapper('ui-library:mui', 'Providers', 10), wrapper('router:x', 'Router', 0)],
      'providers',
    );
    const backwards = appRootEntries(
      [wrapper('router:x', 'Router', 0), wrapper('ui-library:mui', 'Providers', 10)],
      'providers',
    );
    expect(forwards.map((entry) => entry.entry.importName)).toEqual(['Router', 'Providers']);
    expect(backwards.map((entry) => entry.entry.importName)).toEqual(
      forwards.map((entry) => entry.entry.importName),
    );
  });

  it('the declared order beats the owner name when the two disagree', () => {
    // The previous test cannot tell `order` from the owner tiebreak, because
    // "router:..." happens to sort before "ui-library:...". These owners sort
    // the opposite way to their declared positions, so only `order` can produce
    // the expected result - a mutation removing it survived until this existed.
    const claims = appRootEntries(
      [wrapper('a:sorts-first', 'Inner', 10), wrapper('z:sorts-last', 'Outer', 0)],
      'providers',
    );
    expect(claims.map((entry) => entry.entry.importName)).toEqual(['Outer', 'Inner']);
  });

  it('breaks ties on owner, never on input order', () => {
    const claims = appRootEntries(
      [wrapper('b:two', 'Two', 0), wrapper('a:one', 'One', 0)],
      'providers',
    );
    expect(claims.map((entry) => entry.owner)).toEqual(['a:one', 'b:two']);
  });

  it('collapses a byte-identical claim rather than nesting it twice', () => {
    const same = wrapper('router:x', 'Router', 0);
    expect(appRootEntries([same, { ...same }], 'providers')).toHaveLength(1);
  });

  it('refuses two adapters claiming one binding name', () => {
    expect(() =>
      appRootEntries(
        [wrapper('router:x', 'Wrapper', 0), wrapper('ui-library:y', 'Wrapper', 10)],
        'providers',
      ),
    ).toThrow(/both want "Wrapper"/);
  });

  it('refuses a wrapper whose role the architecture does not map', () => {
    // React maps no `config.framework` - it has no framework config file - so
    // a wrapper claiming it has nowhere to live. The diagnostic has to say that
    // rather than letting role resolution fail with a generic message.
    //
    // This used `page.notFound` until Stage 13 mapped it. The role had to be
    // one React genuinely does not map, or the test would pass against the
    // dangling-provider guard instead and stop proving anything about this one.
    const { project } = resolveProject(react({ router: 'none' }), adapters);
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
    const homeless: Contribution = {
      ...emptyContribution('router:nowhere'),
      config: [
        {
          target: 'app.root',
          at: 'providers',
          value: { importName: 'Nowhere', role: 'config.framework', order: 0 },
          owner: 'router:nowhere',
          reason: 'a wrapper the architecture has nowhere to put',
        },
      ],
    };

    expect(() => composedAppRoot(project, [page, homeless], [])).toThrow(CliError);
    expect(() => composedAppRoot(project, [page, homeless], [])).toThrow(
      /maps no "config\.framework" role/,
    );
  });

  it('still refuses two adapters supplying the page', () => {
    // A root renders one thing; that is a disagreement, not a nesting.
    const page = (owner: string): ConfigContribution => ({
      target: 'app.root',
      at: 'page',
      value: { importName: 'HomePage' },
      owner,
      reason: 'the page',
    });
    expect(() => {
      const entries = appRootEntries([page('framework:a'), page('framework:b')], 'page');
      if (entries.length > 1) throw new CliError('two pages');
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same manifest produces the same plan twice', () => {
    expect(renderPlan(planFor().plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planFor().plan, TEMPLATES_ROOT),
    );
  });

  it('the composed root is identical across repeated planning', () => {
    expect(fileAt('src/App.tsx', { uiLibrary: 'mui' })).toBe(
      fileAt('src/App.tsx', { uiLibrary: 'mui' }),
    );
  });

  it('no generated content carries a machine value or unresolved token', () => {
    for (const operation of planFor({ uiLibrary: 'mui' }).plan.operations) {
      if (operation.type !== 'write') continue;
      expect(operation.content).not.toContain(TEST_CWD);
      expect(operation.content).not.toContain('\r\n');
      expect(operation.content).not.toMatch(/\{\{\s*[a-zA-Z]/);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

describe('golden: React + Vite + TypeScript + Tailwind + React Router', () => {
  const scenarios: readonly {
    name: string;
    file: string;
    over: Partial<ProjectManifest>;
  }[] = [
    { name: 'router alone', file: './golden/react-router.txt', over: {} },
    {
      name: 'router with a UI library',
      file: './golden/react-router-mui.txt',
      over: { uiLibrary: 'mui' as UiLibraryId },
    },
    {
      name: 'router with Bootstrap',
      file: './golden/react-router-bootstrap.txt',
      over: { styling: 'bootstrap' as StylingId },
    },
  ];

  for (const scenario of scenarios) {
    it(`golden: ${scenario.name}`, async () => {
      await expect(renderPlan(planFor(scenario.over).plan, TEMPLATES_ROOT)).toMatchFileSnapshot(
        scenario.file,
      );
    });
  }

  it('the three are genuinely different snapshots', () => {
    const rendered = scenarios.map((scenario) =>
      renderPlan(planFor(scenario.over).plan, TEMPLATES_ROOT),
    );
    expect(new Set(rendered).size).toBe(3);
  });

  it('every router golden differs from its routerless equivalent', () => {
    for (const scenario of scenarios) {
      expect(renderPlan(planFor(scenario.over).plan, TEMPLATES_ROOT)).not.toBe(
        renderPlan(planFor({ ...scenario.over, router: 'none' as RouterId }).plan, TEMPLATES_ROOT),
      );
    }
  });
});
