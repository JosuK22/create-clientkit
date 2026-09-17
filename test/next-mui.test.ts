import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { MUI_DECLARATION } from '../src/adapters/mui.js';
import { NEXTJS_ARCHITECTURE, NEXTJS_DECLARATION } from '../src/adapters/nextjs.js';
import { REACT_ARCHITECTURE, REACT_DECLARATION } from '../src/adapters/react.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject } from '../src/adapters/selection.js';
import { composesAppRoot } from '../src/domain/app-composition.js';
import type { AdapterDeclaration, Capability, ProjectManifest } from '../src/domain/index.js';
import { definesRole, evaluateCombination } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * `client-app-root`, and whether MUI still genuinely needs it.
 *
 * ## Why this file exists
 *
 * Stage 24R found a capability declaration that had stopped describing the
 * code, and it survived three stages because every test asserted the
 * **refusal** and none asserted the **reason**. "Next + Bootstrap is refused"
 * stayed true the whole time, for a reason that had quietly expired.
 *
 * So this file does not assert that Next + MUI is refused and stop there. It
 * asserts each premise separately, against the code rather than against the
 * declaration:
 *
 *   1. MUI requires `client-app-root` - and what it contributes shows why.
 *   2. Next does not provide it - and the architecture shows why, in three
 *      independent ways that have nothing to do with the declaration.
 *   3. Therefore the combination is refused.
 *
 * If any of those stops being true, a test here fails rather than a refusal
 * quietly outliving its justification.
 *
 * ## The investigation, recorded
 *
 * The experiment that settled it: `client-app-root` was added to Next's
 * declaration and a project generated. It did not produce a working Next + MUI
 * project. It failed with
 *
 *     Architecture "next-app" does not define a path for the file role
 *     "app.providers".
 *
 * because MUI contributes a provider file by role and asks the composer to wrap
 * `app.root`, and the App Router architecture maps neither. The refusal is
 * overdetermined: the capability is absent, and so is every structure the
 * capability would have implied.
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

// ---------------------------------------------------------------------------
// Premise 1: MUI requires the capability, and its contribution shows why
// ---------------------------------------------------------------------------

describe('what MUI actually needs', () => {
  it('requires a React runtime and a client application root', () => {
    expect(requiredCapabilities(MUI_DECLARATION)).toEqual(['react-runtime', 'client-app-root']);
  });

  it('requires no styling system, build tool or router', () => {
    // MUI works with any styling system or none, ships compiled JavaScript,
    // and has no opinion about routing. Requiring any of these would encode a
    // product combination as a technical constraint.
    for (const capability of [
      'css-framework',
      'composed-stylesheet',
      'vite-plugins',
      'postcss',
      'client-side-routing',
      'file-based-routing',
    ] as Capability[]) {
      expect(requiredCapabilities(MUI_DECLARATION), capability).not.toContain(capability);
    }
  });

  it('contributes a provider file by role, which is what needs somewhere to go', () => {
    // Not taken from the declaration: read from what the adapter actually
    // produces. This is the half of the requirement the capability name hides.
    const contribution = adapters
      .uiLibrary('mui')
      .contribute(
        resolveProject(
          nextManifest({ framework: 'react', buildTool: 'vite', architecture: 'react-standard' }),
          adapters,
        ).project,
      );
    const targets = contribution.files.map((file) =>
      file.target.kind === 'role' ? file.target.role : file.target.path,
    );
    expect(targets).toEqual(['app.providers']);
  });

  it('asks the composer to wrap the application root', () => {
    const contribution = adapters
      .uiLibrary('mui')
      .contribute(
        resolveProject(
          nextManifest({ framework: 'react', buildTool: 'vite', architecture: 'react-standard' }),
          adapters,
        ).project,
      );
    const wrapping = contribution.config.filter((entry) => entry.target === 'app.root');
    expect(wrapping).toHaveLength(1);
    expect(wrapping[0]?.at).toBe('providers');
  });

  it('its provider is written for a client-rendered tree', () => {
    /*
     * The concrete reason the capability is about a *client* root rather than
     * any component that can wrap content. The template mounts `ThemeProvider`
     * and `CssBaseline` - React context - and carries no client-boundary
     * directive, because under a client-rendered root none is needed.
     *
     * Dropped into a React Server Component it would fail at build time. That
     * is the fact the capability names.
     */
    const provider = readFileSync(
      path.join(TEMPLATES_ROOT, 'ui-library', 'mui', 'AppProviders.tsx'),
      'utf8',
    );
    expect(provider).toContain('ThemeProvider');
    expect(provider).toContain('CssBaseline');
    expect(provider).not.toContain('use client');
  });

  it('names no framework anywhere', () => {
    const declared = JSON.stringify(MUI_DECLARATION).toLowerCase();
    for (const id of ['nextjs', 'next.js', 'astro', 'synthetic']) {
      expect(declared, `the declaration mentions ${id}`).not.toContain(id);
    }
    // `react-runtime` is a capability and legitimately contains "react"; what
    // must not appear is a framework id used to encode compatibility.
    const source = code('src/adapters/mui.ts').toLowerCase();
    expect(source).not.toContain('nextjs');
    expect(source).not.toMatch(/framework\s*[=!]==/);
  });
});

// ---------------------------------------------------------------------------
// Premise 2: Next does not provide it, and the architecture says so
// ---------------------------------------------------------------------------

describe('why Next genuinely lacks a client application root', () => {
  it('does not declare the capability', () => {
    expect(NEXTJS_DECLARATION.provides).not.toContain('client-app-root');
  });

  it('maps no application root to compose', () => {
    /*
     * The first structural fact, and it is independent of the declaration.
     * `app/layout.tsx` is the top of the tree and it *is* the layout; there is
     * no root component a user composes, and `app/page.tsx` is the route
     * itself rather than something a root renders.
     */
    expect(definesRole(NEXTJS_ARCHITECTURE, 'app.root')).toBe(false);
    expect(NEXTJS_ARCHITECTURE.rootExportName).toBeUndefined();
    expect(composesAppRoot(NEXTJS_ARCHITECTURE)).toBe(false);
  });

  it('maps nowhere to put a provider', () => {
    // The second structural fact. MUI's file contribution has no destination.
    expect(definesRole(NEXTJS_ARCHITECTURE, 'app.providers')).toBe(false);
  });

  it('React maps both, which is what makes the difference real', () => {
    // The control. The same two roles, mapped, plus the export name the
    // composed root needs - so the capability describes a difference that
    // exists in the architectures rather than only in the declarations.
    expect(definesRole(REACT_ARCHITECTURE, 'app.root')).toBe(true);
    expect(definesRole(REACT_ARCHITECTURE, 'app.providers')).toBe(true);
    expect(REACT_ARCHITECTURE.rootExportName).toBe('App');
    expect(composesAppRoot(REACT_ARCHITECTURE)).toBe(true);
    expect(REACT_DECLARATION.provides).toContain('client-app-root');
  });

  it('generates no client boundary anywhere', () => {
    /*
     * The third structural fact, and the one the capability's wording rests on.
     * Every generated component is a server component; nothing in the Next
     * template opts into the client. A context provider above the application
     * would need a boundary that does not exist.
     */
    const plan = planManifest(nextManifest({ uiLibrary: 'none' }), {
      registry: v1Registry,
      cliVersion: '9.9.9',
      generatedAt: '2026-01-01T00:00:00.000Z',
      mode: 'coming-soon',
    }).plan;
    const components = plan.operations.filter((entry) => entry.path.endsWith('.tsx'));
    expect(components.length).toBeGreaterThan(0);
    for (const operation of components) {
      const body = operation.type === 'write' ? operation.content : '';
      expect(body, operation.path).not.toContain('use client');
    }
  });

  it('the declaration and the architecture agree', () => {
    /*
     * The Stage 24R guard, generalised: a capability claim and the structure
     * that would justify it must not be able to drift apart. Either Next has a
     * composable client root and says so, or it has neither.
     */
    expect(NEXTJS_DECLARATION.provides.includes('client-app-root')).toBe(
      composesAppRoot(NEXTJS_ARCHITECTURE) && definesRole(NEXTJS_ARCHITECTURE, 'app.providers'),
    );
    expect(REACT_DECLARATION.provides.includes('client-app-root')).toBe(
      composesAppRoot(REACT_ARCHITECTURE) && definesRole(REACT_ARCHITECTURE, 'app.providers'),
    );
  });
});

// ---------------------------------------------------------------------------
// Premise 3: therefore refused - and refused before anything is written
// ---------------------------------------------------------------------------

describe('Next + MUI is refused, and the reason is the capability', () => {
  it('is incompatible, naming the missing capability', () => {
    const report = checkCompatibility(nextManifest(), adapters);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('client-app-root');
  });

  it('never says the framework does not support the library', () => {
    let text = '';
    try {
      resolveProject(nextManifest(), adapters);
    } catch (error) {
      const cli = error as CliError;
      text = `${cli.message}\n${cli.hint ?? ''}`;
    }
    expect(text).toContain('client-app-root');
    expect(text.toLowerCase()).not.toContain('next');
  });

  it('fails at resolution, before any file operation exists', () => {
    // Zero writes by construction: `resolveProject` runs before a plan is
    // built, so there is nothing to roll back.
    expect(() => resolveProject(nextManifest(), adapters)).toThrow(CliError);
    expect(() =>
      planManifest(nextManifest(), {
        registry: v1Registry,
        cliVersion: '9.9.9',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode: 'coming-soon',
      }),
    ).toThrow(CliError);
  });

  it('is refused for every starter and every styling choice', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      for (const styling of ['none', 'tailwind', 'bootstrap'] as const) {
        expect(
          checkCompatibility(nextManifest({ starter, styling }), adapters).compatible,
          `${starter}/${styling}`,
        ).toBe(false);
      }
    }
  });

  it('the refusal does not depend on ordering', () => {
    // Capability resolution is set membership, so neither the order adapters
    // were declared in nor the order capabilities appear in can change it.
    const forwards = evaluateCombination([NEXTJS_DECLARATION, MUI_DECLARATION]);
    const backwards = evaluateCombination([MUI_DECLARATION, NEXTJS_DECLARATION]);
    expect(forwards.compatible).toBe(false);
    expect(backwards.compatible).toBe(false);
    expect(JSON.stringify(forwards.violations)).toBe(JSON.stringify(backwards.violations));
  });

  it('repeated resolution produces an identical diagnostic', () => {
    const message = () => {
      try {
        resolveProject(nextManifest(), adapters);
      } catch (error) {
        return `${(error as CliError).message}\n${(error as CliError).hint ?? ''}`;
      }
      return '';
    };
    expect(message()).toBe(message());
  });
});

// ---------------------------------------------------------------------------
// The synthetic control: the capability is load-bearing
// ---------------------------------------------------------------------------

/**
 * A framework that does not exist, providing exactly what MUI asks for.
 *
 * Two capabilities, not one, and the second is unavoidable: MUI requires
 * `react-runtime` as well, because its components are React components. Adding
 * anything beyond those two would make the positive result ambiguous about
 * which capability carried it, so nothing else is here - no `typescript`, no
 * `jsx`, no styling, no routing.
 */
const SYNTHETIC_WITH: AdapterDeclaration = {
  id: 'synthetic-client-app-root',
  kind: 'framework',
  displayName: 'A framework with a client application root',
  provides: ['react-runtime', 'client-app-root'],
  requires: [],
};

/** The same framework with exactly the capability under test removed. */
const SYNTHETIC_WITHOUT: AdapterDeclaration = {
  ...SYNTHETIC_WITH,
  id: 'synthetic-no-client-app-root',
  displayName: 'A framework with a React runtime and no client root',
  provides: ['react-runtime'],
};

/** And with only the runtime removed, to show the other premise is separate. */
const SYNTHETIC_NO_RUNTIME: AdapterDeclaration = {
  ...SYNTHETIC_WITH,
  id: 'synthetic-no-react-runtime',
  displayName: 'A framework with a client root and no React runtime',
  provides: ['client-app-root'],
};

describe('MUI is compatible with capabilities, not with frameworks', () => {
  it('composes with a framework nobody has written', () => {
    const report = evaluateCombination([SYNTHETIC_WITH, MUI_DECLARATION]);
    expect(report.compatible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('refuses the same framework with client-app-root removed', () => {
    const report = evaluateCombination([SYNTHETIC_WITHOUT, MUI_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('client-app-root');
  });

  it('refuses it with react-runtime removed, for the other reason', () => {
    // Both requirements are separately load-bearing, which is what Stage 22's
    // split claimed and what this checks.
    const report = evaluateCombination([SYNTHETIC_NO_RUNTIME, MUI_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('react-runtime');
  });

  it('the capability is the only difference between the first two', () => {
    expect(SYNTHETIC_WITH.provides).toEqual(['react-runtime', 'client-app-root']);
    expect(SYNTHETIC_WITHOUT.provides).toEqual(['react-runtime']);
    expect(SYNTHETIC_WITH.kind).toBe(SYNTHETIC_WITHOUT.kind);
    expect(SYNTHETIC_WITH.requires).toEqual(SYNTHETIC_WITHOUT.requires);
  });

  it('supplies nothing beyond what MUI asks for', () => {
    // Isolation: the positive result cannot be explained by a capability that
    // happened to come along for the ride.
    expect([...SYNTHETIC_WITH.provides].sort()).toEqual(
      [...requiredCapabilities(MUI_DECLARATION)].sort(),
    );
  });

  it('cannot be selected, because it is not a framework this build has', () => {
    for (const id of [
      'synthetic-client-app-root',
      'synthetic-no-client-app-root',
      'synthetic-no-react-runtime',
    ]) {
      expect(() => adapters.framework(id as never)).toThrow(CliError);
      expect(adapters.hasFramework(id as never)).toBe(false);
    }
    expect(adapters.implementedFrameworks()).toEqual(['astro', 'nextjs', 'react']);
  });

  it('does not exist anywhere under src/', () => {
    for (const file of [
      'src/adapters/registry.ts',
      'src/adapters/mui.ts',
      'src/adapters/nextjs.ts',
      'src/domain/dimensions.ts',
    ]) {
      expect(code(file), `${file} mentions the synthetic framework`).not.toContain('synthetic');
    }
  });
});

// ---------------------------------------------------------------------------
// Nothing else moved
// ---------------------------------------------------------------------------

describe('the rest of the matrix is unchanged', () => {
  it('React + MUI still resolves', () => {
    const react = checkCompatibility(
      nextManifest({
        framework: 'react',
        buildTool: 'vite',
        router: 'none',
        architecture: 'react-standard',
        styling: 'tailwind',
      }),
      adapters,
    );
    expect(react.compatible).toBe(true);
  });

  it('every supported Next combination still resolves', () => {
    for (const [label, over] of [
      ['plain', { uiLibrary: 'none' }],
      ['tailwind', { uiLibrary: 'none', styling: 'tailwind' }],
      ['bootstrap', { uiLibrary: 'none', styling: 'bootstrap' }],
    ] as ReadonlyArray<readonly [string, Partial<ProjectManifest>]>) {
      expect(checkCompatibility(nextManifest(over), adapters).compatible, label).toBe(true);
    }
  });

  it('the other Next refusals keep their own reasons', () => {
    for (const [label, over, capability] of [
      ['react-router', { uiLibrary: 'none', router: 'react-router' }, 'client-app-root'],
      ['seo', { uiLibrary: 'none', features: ['seo'] }, 'composed-metadata'],
      [
        'client-route-fallback',
        { uiLibrary: 'none', features: ['client-route-fallback'] },
        'client-side-routing',
      ],
    ] as ReadonlyArray<readonly [string, Partial<ProjectManifest>, string]>) {
      const report = checkCompatibility(nextManifest(over), adapters);
      expect(report.compatible, label).toBe(false);
      expect(JSON.stringify(report.violations), label).toContain(capability);
    }
  });

  it('the Next adapter has no MUI logic and the engine has no case for the pair', () => {
    const next = code('src/adapters/nextjs.ts').toLowerCase();
    expect(next).not.toContain('mui');
    expect(next).not.toMatch(/uilibrary\s*[=!]==/);
    for (const file of ['src/domain/compatibility.ts', 'src/adapters/selection.ts']) {
      const source = code(file).toLowerCase();
      expect(source, file).not.toContain('mui');
      expect(source, file).not.toContain('nextjs');
    }
  });

  it('there is no Next-specific MUI module', () => {
    for (const file of ['src/adapters/next-mui.ts', 'src/adapters/nextjs-mui.ts']) {
      expect(() => readFileSync(path.resolve(import.meta.dirname, '..', file))).toThrow();
    }
  });
});
