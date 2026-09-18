import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { MUI_DECLARATION } from '../src/adapters/mui.js';
import { NEXTJS_ARCHITECTURE, NEXTJS_DECLARATION } from '../src/adapters/nextjs.js';
import { REACT_ARCHITECTURE, REACT_DECLARATION } from '../src/adapters/react.js';
import { REACT_ROUTER_DECLARATION } from '../src/adapters/react-router.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import { composesAppRoot } from '../src/domain/app-composition.js';
import type { AdapterDeclaration, Capability, ProjectManifest } from '../src/domain/index.js';
import { definesRole, evaluateCombination, resolveRole } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * Next.js + MUI, composed rather than special-cased.
 *
 * ## What Stage 25 found, and what Stage 26 did about it
 *
 * Stage 25 verified that the refusal was genuine: MUI needs somewhere to put a
 * provider and something to wrap, and the App Router architecture mapped
 * neither `app.providers` nor a composable root. That was true, and it was an
 * *architecture* gap rather than a capability lie - which is why it needed
 * implementing rather than correcting.
 *
 * Stage 26 closed it with one idea already used twice in this codebase: the
 * layout always wraps the application in whatever fills `app.providers`, and
 * the framework contributes an empty one when nothing else does. Exactly the
 * arrangement the stylesheet has had since Stage 23.
 *
 * ## The two things a browser had to tell us
 *
 * Neither was visible from the code or from a passing production build:
 *
 *   1. MUI's provider needed `'use client'`. One line, added to the single
 *      shared template - inert under a client-rendered root, load-bearing under
 *      a server-rendered one.
 *   2. Emotion emitted its styles into `<body>`, React 19 hoists `<style>` into
 *      `<head>` while hydrating, and every page load reported a recoverable
 *      hydration error while `next build` reported success. That is what the
 *      `server-inserted-head` capability and MUI's cache-provider variant fix.
 *
 * The second is the reason §25's browser validation is not ceremony.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const nextManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-site'),
  projectName: 'acme-site',
  framework: 'nextjs',
  buildTool: 'next',
  language: 'ts',
  styling: 'none',
  uiLibrary: 'mui',
  router: 'file-based',
  architecture: 'next-app',
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

const reactManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  nextManifest({
    framework: 'react',
    buildTool: 'vite',
    router: 'none',
    architecture: 'react-standard',
    styling: 'tailwind',
    ...over,
  });

const planFor = (manifest: ProjectManifest) =>
  planManifest(manifest, {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: manifest.starter,
  });

const pathsOf = (manifest: ProjectManifest): readonly string[] =>
  planFor(manifest).plan.operations.map((operation) => operation.path);

const fileAt = (manifest: ProjectManifest, file: string): string => {
  const operation = planFor(manifest).plan.operations.find((entry) => entry.path === file);
  if (operation === undefined) throw new Error(`no operation for ${file}`);
  return operation.type === 'write' ? operation.content : '';
};

const requiredCapabilities = (declaration: AdapterDeclaration): readonly Capability[] =>
  declaration.requires.flatMap((constraint) =>
    constraint.kind === 'requires'
      ? [constraint.capability]
      : constraint.kind === 'requiresOneOf'
        ? [...constraint.capabilities]
        : [],
  );

const code = (relative: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

/** A generated file with its prose removed, for assertions about code. */
const bodyAt = (manifest: ProjectManifest, file: string): string =>
  fileAt(manifest, file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

/** Where a UI library's own provider component goes. */
const PROVIDERS = 'components/providers/UiProviders.tsx';
/** The composed chain the layout renders, which Stage 27 separated from it. */
const SHELL = 'components/providers/AppProviders.tsx';

// ---------------------------------------------------------------------------
// The capability, and the architecture that now earns it
// ---------------------------------------------------------------------------

describe('Next provides a client application root, and the architecture says so', () => {
  it('declares the capability', () => {
    expect(NEXTJS_DECLARATION.provides).toContain('client-app-root');
  });

  it('maps somewhere to put a provider', () => {
    expect(definesRole(NEXTJS_ARCHITECTURE, 'app.providers')).toBe(true);
    expect(resolveRole(NEXTJS_ARCHITECTURE, 'app.providers')).toBe(PROVIDERS);
  });

  it('the layout wraps the application in the composed shell', () => {
    /*
     * The structural fact that makes the capability true, checked in the
     * generated file rather than in the adapter. The layout renders the shell
     * unconditionally, so there is always something to fill and adding a UI
     * library changes one composed file rather than the layout's shape.
     *
     * Stage 27 separated the shell from its occupant: the layout renders
     * `Providers`, which is composed from every contributed wrapper.
     */
    const layout = fileAt(nextManifest({ uiLibrary: 'none' }), 'app/layout.tsx');
    expect(layout).toContain("from '../components/providers/AppProviders'");
    expect(layout).toMatch(/<Providers>\s*\{children\}\s*<\/Providers>/);
  });

  it('the layout itself stays a server component', () => {
    // The thing §5 warned against: solving this by making the whole App Router
    // layout a client component. It is not, in any configuration.
    for (const uiLibrary of ['none', 'mui'] as const) {
      // Prose stripped: the layout explains *why* it is not a client
      // component, which means saying the words.
      expect(bodyAt(nextManifest({ uiLibrary }), 'app/layout.tsx'), uiLibrary).not.toContain(
        'use client',
      );
    }
  });

  it('the client boundary is exactly one component deep', () => {
    // MUI's provider carries the directive; neither the layout nor the composed
    // shell does, so the client bundle grows by one component rather than by
    // the whole tree.
    expect(bodyAt(nextManifest(), PROVIDERS)).toContain("'use client'");
    expect(bodyAt(nextManifest(), SHELL)).not.toContain('use client');
    expect(bodyAt(nextManifest({ uiLibrary: 'none' }), SHELL)).not.toContain('use client');
  });

  it('the declaration and the architecture cannot drift apart', () => {
    /*
     * The Stage 24R guard, kept and now satisfied in the other direction. A
     * capability claim and the structure that justifies it move together or a
     * test fails - which is what would have caught the drift that stage found.
     */
    expect(NEXTJS_DECLARATION.provides.includes('client-app-root')).toBe(
      definesRole(NEXTJS_ARCHITECTURE, 'app.providers'),
    );
    expect(REACT_DECLARATION.provides.includes('client-app-root')).toBe(
      definesRole(REACT_ARCHITECTURE, 'app.providers'),
    );
  });

  it('gained exactly two capabilities and nothing else', () => {
    // `client-app-root` and `server-inserted-head`; the other seven are
    // Stages 22 to 24R's, unchanged.
    expect([...NEXTJS_DECLARATION.provides].sort()).toEqual([
      'client-app-root',
      'composed-stylesheet',
      'document-metadata',
      'file-based-routing',
      'jsx',
      'postcss',
      'react-runtime',
      'server-inserted-head',
      'typescript',
    ]);
  });

  it('still does not provide a composed head, or anything else out of scope', () => {
    for (const capability of [
      'composed-metadata',
      'client-side-routing',
      'spa-routing',
      'vite-plugins',
      'static-output',
    ] as Capability[]) {
      expect(NEXTJS_DECLARATION.provides, capability).not.toContain(capability);
    }
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe('Next + MUI composes through the generic pipeline', () => {
  it('resolves, where Stage 25 verified it could not', () => {
    const report = checkCompatibility(nextManifest(), adapters);
    expect(report.compatible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('resolves for both starters and every styling choice', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      for (const styling of ['none', 'tailwind', 'bootstrap'] as const) {
        expect(
          checkCompatibility(nextManifest({ starter, styling }), adapters).compatible,
          `${starter}/${styling}`,
        ).toBe(true);
      }
    }
  });

  it('selects the framework and the UI library, and nothing else', () => {
    const refs = selectAdapters(nextManifest(), adapters).adapters.map((entry) => entry.ref);
    expect(refs).toEqual(['framework:nextjs', 'ui-library:mui']);
  });

  it('MUI owns the provider; Next stands down', () => {
    const { contributions } = resolveWithAdapters(nextManifest(), TEMPLATES_ROOT);
    const claims = new Map<string, string>();
    for (const contribution of contributions) {
      for (const file of contribution.files) {
        const key = file.target.kind === 'role' ? `role:${file.target.role}` : file.target.path;
        expect(claims.has(key), `${key} claimed twice`).toBe(false);
        claims.set(key, contribution.owner);
      }
    }
    expect(claims.get('role:app.providers')).toBe('ui-library:mui');
  });

  it('nobody contributes a provider when no UI library does', () => {
    /*
     * Stage 26 had Next contribute a pass-through file here. Stage 27 made the
     * shell composed, so the empty case is emitted rather than shipped - one
     * mechanism instead of a file plus a fallback.
     */
    const { contributions } = resolveWithAdapters(
      nextManifest({ uiLibrary: 'none' }),
      TEMPLATES_ROOT,
    );
    const provider = contributions
      .flatMap((contribution) => contribution.files)
      .find((file) => file.target.kind === 'role' && file.target.role === 'app.providers');
    expect(provider).toBeUndefined();
    expect(fileAt(nextManifest({ uiLibrary: 'none' }), SHELL)).toContain('return <>{children}</>;');
  });

  it('the shell is always written; its occupant only when there is one', () => {
    for (const uiLibrary of ['none', 'mui'] as const) {
      expect(pathsOf(nextManifest({ uiLibrary })).filter((f) => f === SHELL)).toHaveLength(1);
    }
    expect(pathsOf(nextManifest({ uiLibrary: 'mui' })).filter((f) => f === PROVIDERS)).toHaveLength(
      1,
    );
    expect(
      pathsOf(nextManifest({ uiLibrary: 'none' })).filter((f) => f === PROVIDERS),
    ).toHaveLength(0);
  });

  it('the MUI provider mounts the theme above the application', () => {
    const provider = fileAt(nextManifest(), PROVIDERS);
    expect(provider).toContain('ThemeProvider');
    expect(provider).toContain('CssBaseline');
    expect(provider).toContain('{children}');
    // And the shell nests it around the content the framework hands down.
    expect(fileAt(nextManifest(), SHELL)).toContain(
      "import { AppProviders } from './UiProviders';",
    );
  });

  it('installs the server-render integration, and only where there is one', () => {
    /*
     * Chosen on a capability. Emotion generates styles while rendering; on a
     * server-rendering framework they have to be flushed into the head, and on
     * a client-only one there is nothing to flush.
     */
    const next = JSON.parse(fileAt(nextManifest(), 'package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(next.dependencies['@mui/material-nextjs']).toBe('9.4.0');

    const react = JSON.parse(fileAt(reactManifest(), 'package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(react.dependencies['@mui/material-nextjs']).toBeUndefined();
  });

  it('the integration package is pinned to the same version as MUI itself', () => {
    const pkg = JSON.parse(fileAt(nextManifest(), 'package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@mui/material-nextjs']).toBe(pkg.dependencies['@mui/material']);
  });

  it('MUI owns every MUI dependency, and Next owns none of them', () => {
    /*
     * Asserted on the *dependency's* own owner, not on the contribution's.
     *
     * A mutation that moved `@mui/material-nextjs` to `framework:nextjs` while
     * leaving it inside MUI's contribution survived the first version of this
     * test, which checked the wrong field. The owner is what the package
     * composer attributes a version conflict to, so a wrong one sends a reader
     * to the wrong adapter.
     */
    const { contributions } = resolveWithAdapters(nextManifest(), TEMPLATES_ROOT);
    const dependencies = contributions.flatMap((contribution) => contribution.dependencies);
    expect(dependencies.length).toBeGreaterThan(5);

    for (const dependency of dependencies) {
      const isMui = dependency.name.startsWith('@mui/') || dependency.name.startsWith('@emotion/');
      expect(dependency.owner, dependency.name).toBe(isMui ? 'ui-library:mui' : 'framework:nextjs');
    }
    // And the integration specifically, since it is the one that looks as
    // though it might belong to the framework.
    expect(
      dependencies.find((dependency) => dependency.name === '@mui/material-nextjs')?.owner,
    ).toBe('ui-library:mui');
  });

  it('the starter markup is identical whichever UI library was selected', () => {
    // The starter knows neither Next nor MUI. If this ever differs, a UI
    // library has started dictating page markup.
    for (const starter of ['coming-soon', 'full'] as const) {
      for (const file of ['app/page.tsx', 'components/ui/Mark.tsx']) {
        expect(fileAt(nextManifest({ starter }), file), `${starter}/${file}`).toBe(
          fileAt(nextManifest({ starter, uiLibrary: 'none' }), file),
        );
      }
    }
  });

  it('is deterministic', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      expect(renderPlan(planFor(nextManifest({ starter })).plan, TEMPLATES_ROOT)).toBe(
        renderPlan(planFor(nextManifest({ starter })).plan, TEMPLATES_ROOT),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The compatibility guard §19/§20 demands
// ---------------------------------------------------------------------------

describe('gaining the capability made nothing else compatible', () => {
  it('React Router is still refused, and for a reason that is now separate', () => {
    /*
     * The landmine this stage had to defuse. React Router required
     * `client-app-root` and nothing else; giving Next that capability would
     * have made it capability-compatible while still having no route table to
     * own - a combination that resolves and then fails at generation.
     *
     * The fix is a conflict rather than a framework branch: a framework that
     * routes its own files leaves nothing for a client router to take over.
     * That holds for Astro too, and names neither.
     */
    const report = checkCompatibility(
      nextManifest({ uiLibrary: 'none', router: 'react-router' }),
      adapters,
    );
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('file-based-routing');
  });

  it('React Router still works where nothing else routes', () => {
    // The conflict must be about the capability, not about the library.
    expect(
      checkCompatibility(reactManifest({ uiLibrary: 'none', router: 'react-router' }), adapters)
        .compatible,
    ).toBe(true);
    expect(REACT_DECLARATION.provides).not.toContain('file-based-routing');
  });

  it('React Router and MUI still compose on React', () => {
    expect(checkCompatibility(reactManifest({ router: 'react-router' }), adapters).compatible).toBe(
      true,
    );
  });

  it('every adapter requiring client-app-root was re-checked', () => {
    /*
     * The §20 sweep, as a test rather than as a claim in a report. Exactly two
     * adapters require the capability; MUI is now satisfied on Next, and React
     * Router is refused by a second constraint that has nothing to do with it.
     */
    const consumers = [MUI_DECLARATION, REACT_ROUTER_DECLARATION].filter((declaration) =>
      requiredCapabilities(declaration).includes('client-app-root'),
    );
    expect(consumers).toHaveLength(2);

    expect(evaluateCombination([NEXTJS_DECLARATION, MUI_DECLARATION]).compatible).toBe(true);
    expect(evaluateCombination([NEXTJS_DECLARATION, REACT_ROUTER_DECLARATION]).compatible).toBe(
      false,
    );
  });

  it('the head features are still refused', () => {
    for (const feature of ['seo', 'structured-data', 'accessibility'] as const) {
      const report = checkCompatibility(
        nextManifest({ uiLibrary: 'none', features: [feature] }),
        adapters,
      );
      expect(report.compatible, feature).toBe(false);
      expect(JSON.stringify(report.violations), feature).toContain('composed-metadata');
    }
  });

  it('the client-side fallback is still refused', () => {
    const report = checkCompatibility(
      nextManifest({ uiLibrary: 'none', features: ['client-route-fallback'] }),
      adapters,
    );
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('client-side-routing');
  });

  it('not-found is placed by the architecture now that a page exists for it', () => {
    // Refused until Stage 50. MUI is unaffected either way.
    const paths = planFor(
      nextManifest({ uiLibrary: 'none', features: ['not-found'] }),
    ).plan.operations.map((entry) => entry.path);
    expect(paths).toContain('app/not-found.tsx');
  });

  it('refused combinations still fail before any file exists', () => {
    for (const over of [
      { uiLibrary: 'none', router: 'react-router' },
      { uiLibrary: 'none', features: ['seo'] },
    ] as Partial<ProjectManifest>[]) {
      expect(() => resolveProject(nextManifest(over), adapters)).toThrow(CliError);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('neither adapter knows the other exists', () => {
  it('MUI names no framework', () => {
    const mui = code('src/adapters/mui.ts').toLowerCase();
    expect(mui).not.toMatch(/framework\s*[=!]==/);
    expect(mui).not.toContain("'nextjs'");
    expect(mui).not.toContain("'react'");
    expect(mui).not.toContain("'astro'");
    // It branches on a capability, which is the whole point.
    expect(code('src/adapters/mui.ts')).toContain("capabilities.has('server-inserted-head')");
  });

  it('the package MUI ships for this is a dependency, not a branch', () => {
    /*
     * `@mui/material-nextjs` is MUI's own package and its vendor named it after
     * the framework it targets. That name appears in a dependency entry and in
     * one template import - never in a condition. What the adapter tests is the
     * capability above.
     */
    const mui = code('src/adapters/mui.ts');
    const branchLines = mui
      .split('\n')
      .filter((line) => /if\s*\(|\?\s|===|!==/.test(line))
      .join('\n');
    expect(branchLines).not.toContain('nextjs');
  });

  it('Next names no UI library', () => {
    const next = code('src/adapters/nextjs.ts').toLowerCase();
    expect(next).not.toContain('mui');
    expect(next).not.toContain('emotion');
    expect(next).not.toMatch(/uilibrary\s*===\s*'mui'/);
  });

  it('the compatibility engine has no case for the pair', () => {
    for (const file of ['src/domain/compatibility.ts', 'src/adapters/selection.ts']) {
      const source = code(file).toLowerCase();
      for (const name of ['nextjs', 'mui']) {
        expect(source, `${file} mentions ${name}`).not.toContain(name);
      }
    }
  });

  it('there is no combination adapter or helper', () => {
    for (const file of [
      'src/adapters/next-mui.ts',
      'src/adapters/nextjs-mui.ts',
      'src/adapters/mui-next.ts',
    ]) {
      expect(() => readFileSync(path.resolve(import.meta.dirname, '..', file))).toThrow();
    }
    for (const file of ['src/adapters/mui.ts', 'src/adapters/nextjs.ts']) {
      const source = code(file);
      for (const helper of ['muiForNext', 'nextMUI', 'isNextWithMUI']) {
        expect(source, `${file} defines ${helper}`).not.toContain(helper);
      }
    }
  });

  it('the starter contract knows none of it', () => {
    const starter = code('src/domain/starter.ts').toLowerCase();
    for (const name of ['next', 'mui', 'provider', 'app.providers']) {
      expect(starter, `starter.ts mentions ${name}`).not.toContain(name);
    }
  });

  it('one provider template serves both frameworks, in two variants chosen by capability', () => {
    // Not a per-framework fork: the same component, with and without the cache
    // provider the server-rendering case needs. The same shape Tailwind uses
    // to choose between its two build plugins.
    const client = readFileSync(
      path.join(TEMPLATES_ROOT, 'ui-library', 'mui', 'AppProviders.tsx'),
      'utf8',
    );
    const server = readFileSync(
      path.join(TEMPLATES_ROOT, 'ui-library', 'mui', 'AppProviders.server-inserted.tsx'),
      'utf8',
    );
    for (const source of [client, server]) {
      expect(source).toContain("'use client'");
      expect(source).toContain('ThemeProvider');
      expect(source).toContain('CssBaseline');
    }
    expect(client).not.toContain('AppRouterCacheProvider');
    expect(server).toContain('AppRouterCacheProvider');
  });
});

// ---------------------------------------------------------------------------
// React regression
// ---------------------------------------------------------------------------

describe('React + MUI is unchanged in every way that matters', () => {
  it('still resolves, and still composes its application root', () => {
    expect(checkCompatibility(reactManifest(), adapters).compatible).toBe(true);
    expect(composesAppRoot(REACT_ARCHITECTURE)).toBe(true);
  });

  it('still wraps the composed root in the provider', () => {
    const root = fileAt(reactManifest(), 'src/App.tsx');
    expect(root).toContain('AppProviders');
    expect(root).toContain('HomePage');
  });

  it('gets the client-only provider variant', () => {
    const provider = fileAt(reactManifest(), 'src/components/ui/AppProviders.tsx');
    expect(provider).not.toContain('AppRouterCacheProvider');
    // The directive is present and inert here - one template, correct under
    // both, rather than a second copy per framework.
    expect(provider).toContain("'use client'");
  });

  it('installs no server-render integration', () => {
    const pkg = JSON.parse(fileAt(reactManifest(), 'package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@emotion/react',
      '@emotion/styled',
      '@mui/material',
      'react',
      'react-dom',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

describe('golden: Next.js + MUI', () => {
  const scenarios = [
    { name: 'Coming Soon + URL', file: './golden/next-mui-coming-soon-url.txt', over: {} },
    {
      name: 'Full + URL',
      file: './golden/next-mui-full-url.txt',
      over: { starter: 'full' } as Partial<ProjectManifest>,
    },
    {
      name: 'with Tailwind',
      file: './golden/next-mui-tailwind.txt',
      over: { styling: 'tailwind' } as Partial<ProjectManifest>,
    },
  ];

  for (const scenario of scenarios) {
    it(`golden: Next + MUI ${scenario.name}`, async () => {
      await expect(
        renderPlan(planFor(nextManifest(scenario.over)).plan, TEMPLATES_ROOT),
      ).toMatchFileSnapshot(scenario.file);
    });
  }
});
