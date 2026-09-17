import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  Adapter,
  AdapterDeclaration,
  AdapterResolution,
  FrameworkAdapter,
} from '../src/domain/adapters.js';
import { adapterRef } from '../src/domain/adapters.js';
import type { Capability } from '../src/domain/capabilities.js';
import { CAPABILITIES } from '../src/domain/capabilities.js';
import {
  assertCapabilityContracts,
  assertRolesArePlaceable,
  capabilitiesInCategory,
  capabilityBreaches,
  CAPABILITY_CATEGORIES,
  CAPABILITY_CONTRACTS,
  surfacesOf,
} from '../src/domain/capability-contract.js';
import { emptyContribution } from '../src/domain/contributions.js';
import type { ArchitectureId, FrameworkId } from '../src/domain/dimensions.js';
import type { ProjectManifest } from '../src/domain/manifest.js';
import type { ResolvedProject } from '../src/domain/resolved.js';
import type { ArchitectureDefinition, FileRole } from '../src/domain/roles.js';
import { planManifest } from '../src/adapters/bridge.js';
import type { AdapterRegistry } from '../src/adapters/registry.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject } from '../src/adapters/selection.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';

/**
 * The capability <-> architecture contract.
 *
 * Stage 28. The engine judges declarations against each other and never sees an
 * architecture, so a framework could declare a capability its own architecture
 * cannot materialize and be found out later, during planning, by a role error
 * that names no capability and no reason. This proves the gap is closed in both
 * directions and - just as importantly - that closing it did not turn every
 * capability into a file.
 *
 * The synthetic architectures below are the load-bearing part. Testing the
 * three real frameworks would prove the contract holds for the three that were
 * written to satisfy it; only an architecture built to *violate* it can show
 * that the check does anything at all.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const v1Registry = createRegistry(TEMPLATES_ROOT);

const source = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');

/**
 * A file with its comments removed.
 *
 * The structural assertions below are about *logic*, and prose is not logic.
 * `capability-contract.ts` names `nextjs + not-found` in the comment recording
 * which late failure it was written for, and losing that sentence to keep a
 * grep happy would trade the useful thing for the easy one. What must not
 * appear is a branch, so the branches are what gets scanned.
 */
const codeOnly = (file: string): string =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const nextManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  ({
    targetDir: path.join(path.parse(process.cwd()).root, 'ck-test', 'site'),
    projectName: 'site',
    framework: 'nextjs',
    buildTool: 'next',
    language: 'ts',
    styling: 'none',
    uiLibrary: 'none',
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
  }) as ProjectManifest;

const reactManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  nextManifest({
    framework: 'react',
    buildTool: 'vite',
    router: 'none',
    architecture: 'react-standard',
    styling: 'tailwind',
    ...over,
  });

const astroManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  nextManifest({
    framework: 'astro',
    buildTool: 'astro',
    router: 'file-based',
    architecture: 'astro-standard',
    styling: 'tailwind',
    ...over,
  });

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    const cli = error as CliError;
    return `${cli.message}\n${cli.hint ?? ''}`;
  }
  return '';
};

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

describe('every capability is classified', () => {
  it('has a contract, because the table is total', () => {
    // `Record<Capability, ...>` makes this a compile-time guarantee; asserted
    // anyway so the failure is a readable name rather than a type error in a
    // stage nobody is reading the types of.
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_CONTRACTS[capability], capability).toBeDefined();
      expect(CAPABILITY_CONTRACTS[capability].because.length, capability).toBeGreaterThan(20);
    }
  });

  it('classifies nothing outside the four categories', () => {
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_CATEGORIES, capability).toContain(
        CAPABILITY_CONTRACTS[capability].category,
      );
    }
  });

  it('accounts for every capability exactly once across the categories', () => {
    const counted = CAPABILITY_CATEGORIES.flatMap((category) => capabilitiesInCategory(category));
    expect([...counted].sort()).toEqual([...CAPABILITIES].sort());
    expect(new Set(counted).size).toBe(CAPABILITIES.length);
  });

  it('gives a surface only to an architectural or composition capability', () => {
    /*
     * The overgeneralization guard, and the reason the category is a field
     * rather than a comment.
     *
     * The failure this stage is most likely to cause is the opposite of the one
     * it set out to fix: deciding that every capability ought to map a role,
     * inventing `language.typescript`, and making the vocabulary less true in
     * the name of rigour. Adding a surface to a pure capability now requires
     * also reclassifying it, which is a deliberate act somebody has to defend.
     */
    for (const capability of CAPABILITIES) {
      const { category } = CAPABILITY_CONTRACTS[capability];
      const hasSurface = surfacesOf(capability).length > 0;
      if (category === 'pure' || category === 'tooling') {
        expect(hasSurface, `${capability} is ${category} and must promise no surface`).toBe(false);
      } else {
        expect(hasSurface, `${capability} is ${category} and must name its surface`).toBe(true);
      }
    }
  });

  it('keeps the capabilities that are genuinely about nothing generated pure', () => {
    /*
     * Named rather than derived from the table, so this asserts the semantics
     * instead of restating them. `typescript` is the example the stage brief
     * calls out: it is true of every file and owned by none, and a project does
     * not become more typed by having a role pointed at its tsconfig.
     */
    for (const capability of ['typescript', 'jsx', 'react-runtime', 'spa-routing'] as const) {
      expect(CAPABILITY_CONTRACTS[capability].category, capability).toBe('pure');
      expect(surfacesOf(capability), capability).toEqual([]);
    }
  });

  it('names a real file role for every surface', () => {
    for (const capability of CAPABILITIES) {
      for (const surface of surfacesOf(capability)) {
        expect(['file', 'data'], `${capability}/${surface.role}`).toContain(surface.via);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The real registry keeps its own promises
// ---------------------------------------------------------------------------

describe('every implemented framework can materialize what it declares', () => {
  it('has no breach in any architecture it offers', () => {
    for (const id of adapters.implementedFrameworks()) {
      const framework = adapters.framework(id);
      const declared = new Set<Capability>(framework.declaration.provides);
      for (const architecture of framework.architectureDefinitions) {
        const breaches = capabilityBreaches(
          declared,
          architecture,
          framework.templateOwnedRoles ?? [],
        );
        expect(breaches, `${id}/${architecture.id}: ${JSON.stringify(breaches)}`).toEqual([]);
      }
    }
  });

  it('catches a capability whose surface a real architecture cannot place', () => {
    /*
     * The same check, run against a capability the framework does not declare.
     * Astro is the honest example rather than a hypothetical one: it maps
     * `styles.global` and its own template owns it, which is exactly why it
     * does not claim `composed-stylesheet` and exactly why Bootstrap is refused
     * there.
     */
    const astro = adapters.framework('astro');
    const breaches = capabilityBreaches(
      new Set<Capability>(['composed-stylesheet']),
      astro.architectureDefinitions[0] as ArchitectureDefinition,
      astro.templateOwnedRoles ?? [],
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.reason).toBe('template-owned');
    expect(breaches[0]?.role).toBe('styles.global');
  });
});

// ---------------------------------------------------------------------------
// Synthetic architectures
// ---------------------------------------------------------------------------

/**
 * A framework that exists only here, so the contract can be tested against
 * declarations nobody wrote to satisfy it.
 *
 * It ships no template and contributes nothing: the three cases below are
 * decided before any file is planned, which is the point.
 */
function syntheticFramework(options: {
  readonly id: string;
  readonly provides: readonly Capability[];
  readonly roles: ArchitectureDefinition['roles'];
  readonly templateOwnedRoles?: readonly FileRole[];
  /** Roles the architecture says the project cannot ship without. */
  readonly requiredRoles?: readonly FileRole[];
}): FrameworkAdapter {
  const declaration: AdapterDeclaration = {
    id: options.id,
    kind: 'framework',
    displayName: `Synthetic ${options.id}`,
    provides: options.provides,
    requires: [],
  };
  const architecture: ArchitectureDefinition = {
    id: `${options.id}-arch` as ArchitectureId,
    displayName: `Synthetic ${options.id} architecture`,
    directories: [],
    roles: options.roles,
    ...(options.requiredRoles ? { requiredRoles: options.requiredRoles } : {}),
  };

  return {
    declaration,
    ownsBuildTool: true,
    buildTools: { kind: 'fixed', value: 'next' },
    languages: { kind: 'fixed', value: 'ts' },
    routers: { kind: 'fixed', value: 'file-based' },
    architectures: { kind: 'fixed', value: architecture.id },
    architectureDefinitions: [architecture],
    ...(options.templateOwnedRoles ? { templateOwnedRoles: options.templateOwnedRoles } : {}),
    resolve(): AdapterResolution {
      return { extensions: { source: '.ts', component: '.tsx', config: '.ts' } };
    },
    contribute(): ReturnType<Adapter['contribute']> {
      return emptyContribution(adapterRef(declaration));
    },
  };
}

/** The real registry with one framework swapped in. */
function registryWith(framework: FrameworkAdapter): AdapterRegistry {
  return {
    ...adapters,
    framework: (id) => (id === framework.declaration.id ? framework : adapters.framework(id)),
    hasFramework: (id) => id === framework.declaration.id || adapters.hasFramework(id),
  };
}

/** The one architecture a synthetic framework offers. */
const onlyArchitecture = (framework: FrameworkAdapter): ArchitectureDefinition => {
  const [architecture] = framework.architectureDefinitions;
  if (architecture === undefined) throw new Error('synthetic framework defines no architecture');
  return architecture;
};

const syntheticManifest = (framework: FrameworkAdapter): ProjectManifest =>
  nextManifest({
    framework: framework.declaration.id as FrameworkId,
    architecture: onlyArchitecture(framework).id,
    uiLibrary: 'mui',
  });

/**
 * MUI is the consumer throughout: it requires `client-app-root` and contributes
 * a provider file, which is precisely the capability whose truth Stage 25 found
 * spread across a declaration, an architecture and a role.
 */
const PROVIDERS: ArchitectureDefinition['roles'] = {
  'app.providers': 'src/AppProviders.tsx',
  'app.layout': 'src/Layout.tsx',
  package: 'package.json',
};

describe('capability and architecture are checked in both directions', () => {
  const both = syntheticFramework({
    id: 'synthetic-both',
    provides: ['react-runtime', 'jsx', 'typescript', 'client-app-root'],
    roles: PROVIDERS,
  });

  const capabilityOnly = syntheticFramework({
    id: 'synthetic-capability-only',
    provides: ['react-runtime', 'jsx', 'typescript', 'client-app-root'],
    // Same declaration, no provider surface.
    roles: { 'app.layout': 'src/Layout.tsx', package: 'package.json' },
  });

  const architectureOnly = syntheticFramework({
    id: 'synthetic-architecture-only',
    // Same roles, no claim.
    provides: ['react-runtime', 'jsx', 'typescript'],
    roles: PROVIDERS,
  });

  it('A: capability declared and surface mapped resolves', () => {
    const { project } = resolveProject(syntheticManifest(both), registryWith(both));
    expect(project.capabilities.has('client-app-root')).toBe(true);
    expect(project.architecture.roles['app.providers']).toBe('src/AppProviders.tsx');
  });

  it('B: capability declared with no surface is refused, naming both', () => {
    const manifest = syntheticManifest(capabilityOnly);
    const registry = registryWith(capabilityOnly);

    // The engine is satisfied: MUI asked for a capability that is declared.
    expect(checkCompatibility(manifest, registry).compatible).toBe(true);

    // The architecture is not, and that is the gap this stage closes.
    const message = refusal(() => resolveProject(manifest, registry));
    expect(message).toContain('client-app-root');
    expect(message).toContain('app.providers');
    expect(message).toContain('framework:synthetic-capability-only');
  });

  it('C: surface mapped without the capability is refused by the engine', () => {
    /*
     * The direction that keeps the two concepts apart. Mapping a role is not a
     * way to acquire a capability - if it were, an architecture could grant
     * itself anything by naming a path, and `provides` would stop meaning
     * anything. React maps `page.notFound` and has no file-based routing; the
     * same separation, in the real registry.
     */
    const manifest = syntheticManifest(architectureOnly);
    const registry = registryWith(architectureOnly);

    const report = checkCompatibility(manifest, registry);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('client-app-root');

    const message = refusal(() => resolveProject(manifest, registry));
    expect(message).toContain('client-app-root');
  });

  it('B fails before a single file operation exists', () => {
    const manifest = syntheticManifest(capabilityOnly);
    // `resolveProject` is upstream of every contribution, so there is nothing
    // to roll back - the plan was never built.
    expect(() => resolveProject(manifest, registryWith(capabilityOnly))).toThrow(CliError);
  });

  it('refuses a composition capability whose surface the template owns', () => {
    /*
     * The second reason a contract can be broken, and the one a mapping check
     * alone would miss. The role is mapped; the framework's own template layer
     * already fills it, so a contribution aimed there is refused and the
     * stylesheet the capability promises never arrives.
     */
    const owned = syntheticFramework({
      id: 'synthetic-template-owned',
      provides: ['react-runtime', 'jsx', 'typescript', 'client-app-root', 'composed-stylesheet'],
      roles: { ...PROVIDERS, 'styles.global': 'src/global.css' },
      templateOwnedRoles: ['styles.global'],
    });

    const message = refusal(() => resolveProject(syntheticManifest(owned), registryWith(owned)));
    expect(message).toContain('composed-stylesheet');
    expect(message).toContain('styles.global');
    expect(message).toContain('template owns that file');
  });

  it('is deterministic whatever order the capabilities arrive in', () => {
    /*
     * Two breaches, not one: with a single breach every permutation trivially
     * agrees, and the assertion would pass however the walk was written. The
     * order has to come from the capability vocabulary rather than from the
     * caller's set, or the same broken stack explains itself differently
     * depending on which adapter happened to resolve first.
     */
    const architecture: ArchitectureDefinition = {
      id: 'synthetic-two-breaches' as ArchitectureId,
      displayName: 'Synthetic, missing both surfaces',
      directories: [],
      roles: { package: 'package.json' },
    };
    const declared: Capability[] = [
      'client-app-root',
      'composed-stylesheet',
      'react-runtime',
      'typescript',
    ];

    const runs = [
      declared,
      [...declared].reverse(),
      ['composed-stylesheet', 'typescript', 'client-app-root', 'react-runtime'] as Capability[],
      ['typescript', 'client-app-root', 'composed-stylesheet', 'react-runtime'] as Capability[],
    ].map((order) => JSON.stringify(capabilityBreaches(new Set(order), architecture, [])));

    expect(new Set(runs).size).toBe(1);
    // And both breaches really are reported, so the agreement above is not
    // agreement about an empty list.
    expect(
      capabilityBreaches(new Set(declared), architecture, []).map((b) => b.capability),
    ).toEqual(['composed-stylesheet', 'client-app-root']);
  });

  it('lets a data surface ship with the template', () => {
    /*
     * The distinction between the two surface kinds, which nothing in the real
     * registry exercises: no architecture today both owns `app.layout` from a
     * template layer and composes metadata into it, so only a synthetic can
     * show that the difference is real rather than a field nobody reads.
     *
     * It is the difference between Astro and Bootstrap. Astro's BaseLayout is
     * shipped by its template and still composes contributed metadata, because
     * what a metadata feature contributes is *values*. Astro's stylesheet is
     * also shipped by its template, and a styling adapter's stylesheet is a
     * *file*, so it would be refused as a collision - which is exactly why
     * Astro declares `composed-metadata` and not `composed-stylesheet`.
     */
    const shipped = syntheticFramework({
      id: 'synthetic-shipped-layout',
      provides: ['typescript', 'composed-metadata'],
      roles: { 'app.layout': 'src/Layout.tsx', package: 'package.json' },
      templateOwnedRoles: ['app.layout'],
    });

    const manifest = nextManifest({
      framework: shipped.declaration.id as FrameworkId,
      architecture: onlyArchitecture(shipped).id,
      uiLibrary: 'none',
    });
    expect(() => resolveProject(manifest, registryWith(shipped))).not.toThrow();

    // And the same architecture claiming a *file* surface it owns is refused,
    // so the pass above is the surface kind and not a disabled check.
    const alsoStyles = syntheticFramework({
      id: 'synthetic-shipped-styles',
      provides: ['typescript', 'composed-stylesheet'],
      roles: { 'styles.global': 'src/global.css', package: 'package.json' },
      templateOwnedRoles: ['styles.global'],
    });
    expect(
      refusal(() =>
        resolveProject(
          nextManifest({
            framework: alsoStyles.declaration.id as FrameworkId,
            architecture: onlyArchitecture(alsoStyles).id,
            uiLibrary: 'none',
          }),
          registryWith(alsoStyles),
        ),
      ),
    ).toContain('composed-stylesheet');
  });

  it('names the architecture when it requires a role it does not map', () => {
    /*
     * The self-contradiction an architecture can write about itself, and the
     * reason its own `requiredRoles` are attributed rather than folded into an
     * anonymous "this stack". No real architecture does this - React requires
     * `styles.global` and maps it - but a fourth framework listing a guarantee
     * and forgetting the mapping is the same mistake as a false capability, and
     * deserves the same sentence.
     */
    const contradictory = syntheticFramework({
      id: 'synthetic-contradictory',
      provides: ['typescript'],
      roles: { package: 'package.json' },
      requiredRoles: ['page.notFound'],
    });

    const message = refusal(() =>
      resolveProject(
        nextManifest({
          framework: contradictory.declaration.id as FrameworkId,
          architecture: onlyArchitecture(contradictory).id,
          uiLibrary: 'none',
        }),
        registryWith(contradictory),
      ),
    );
    expect(message).toContain('page.notFound');
    expect(message).toContain('architecture:synthetic-contradictory-arch');
  });

  it('produces the same diagnostic every time', () => {
    const manifest = syntheticManifest(capabilityOnly);
    const registry = registryWith(capabilityOnly);
    const messages = [1, 2, 3].map(() => refusal(() => resolveProject(manifest, registry)));
    expect(new Set(messages).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The case studies
// ---------------------------------------------------------------------------

describe('client-app-root', () => {
  it('names the provider surface, not the application root', () => {
    /*
     * The distinction Stage 27 made and this stage must not undo. React's root
     * *is* the application - it renders the home page - while Next's shell
     * wraps content the framework hands down. Both can mount context above the
     * tree, and requiring `app.root` would refuse Next for having a different
     * shape rather than a missing one.
     */
    expect(surfacesOf('client-app-root')).toEqual([{ role: 'app.providers', via: 'file' }]);
    expect(surfacesOf('client-app-root').map((surface) => surface.role)).not.toContain('app.root');
  });

  it('is materialized differently by the two architectures that declare it', () => {
    const react = adapters.framework('react').architectureDefinitions[0];
    const next = adapters.framework('nextjs').architectureDefinitions[0];

    // React: a real root component, composed, which the entry renders.
    expect(react?.roles['app.root']).toBeDefined();
    expect(react?.roles['app.shell']).toBeUndefined();
    // Next: no root; a shell between the framework's layout and the content.
    expect(next?.roles['app.root']).toBeUndefined();
    expect(next?.roles['app.shell']).toBeDefined();
    // And both satisfy the contract, through the one surface it names.
    for (const architecture of [react, next]) {
      expect(architecture?.roles['app.providers']).toBeDefined();
    }
  });

  it('is what refuses a UI library, not the runtime', () => {
    const astro = checkCompatibility(astroManifest({ uiLibrary: 'mui' }), adapters);
    expect(astro.compatible).toBe(false);
    // Astro fails on the runtime first; the interesting case is a framework
    // that has React and no client root, which is what Synthetic B is.
    expect(JSON.stringify(astro.violations)).toContain('react-runtime');
  });
});

describe('composed-stylesheet', () => {
  it('means a contributed file, which is why template ownership breaks it', () => {
    expect(CAPABILITY_CONTRACTS['composed-stylesheet'].category).toBe('composition');
    expect(surfacesOf('composed-stylesheet')).toEqual([{ role: 'styles.global', via: 'file' }]);
  });

  it('is declared by the two architectures that leave the stylesheet to a contributor', () => {
    for (const id of ['react', 'nextjs'] as const) {
      const framework = adapters.framework(id);
      expect(framework.declaration.provides, id).toContain('composed-stylesheet');
      expect(framework.templateOwnedRoles ?? [], id).not.toContain('styles.global');
    }
  });

  it('is absent where the template ships the stylesheet', () => {
    const astro = adapters.framework('astro');
    expect(astro.declaration.provides).not.toContain('composed-stylesheet');
    expect(astro.templateOwnedRoles ?? []).toContain('styles.global');
  });

  it('is what Bootstrap asks for, in capability terms and no other', () => {
    const bootstrap = adapters.styling('bootstrap').declaration;
    expect(JSON.stringify(bootstrap.requires)).toContain('composed-stylesheet');
    // No framework is named anywhere in the request.
    for (const name of ['astro', 'nextjs', 'react']) {
      expect(JSON.stringify(bootstrap), name).not.toContain(name);
    }
  });
});

describe('composed-metadata', () => {
  it('is composed from values, so the shell may ship with the template', () => {
    expect(CAPABILITY_CONTRACTS['composed-metadata'].category).toBe('composition');
    expect(surfacesOf('composed-metadata')).toEqual([{ role: 'app.layout', via: 'data' }]);
  });

  it('is still absent from Next, and the metadata features are still refused', () => {
    for (const feature of ['seo', 'structured-data', 'accessibility'] as const) {
      const report = checkCompatibility(nextManifest({ features: [feature] }), adapters);
      expect(report.compatible, feature).toBe(false);
      expect(JSON.stringify(report.violations), feature).toContain('composed-metadata');
    }
  });

  it('is not granted by mapping the layout', () => {
    // Next maps `app.layout` and does not own it from a template layer, so the
    // structural half of the contract is satisfied - and the capability is
    // still false, because Next's layout reads no contributions. The contract
    // is a necessary condition on declaring, never a sufficient one.
    const next = adapters.framework('nextjs');
    expect(next.architectureDefinitions[0]?.roles['app.layout']).toBeDefined();
    expect(next.declaration.provides).not.toContain('composed-metadata');
  });
});

// ---------------------------------------------------------------------------
// The late failure this stage found
// ---------------------------------------------------------------------------

describe('a role the architecture cannot place is refused at resolution', () => {
  it('refuses next + not-found before any planning happens', () => {
    /*
     * The one genuine late failure in the system before this stage: compatible
     * (Next really does route by file), then dead halfway through planning with
     * `Architecture "next-app" does not define a path for the file role
     * "page.notFound"` - naming no feature, no reason, and offering a hint
     * about styling.
     */
    const manifest = nextManifest({ features: ['not-found'] });
    expect(checkCompatibility(manifest, adapters).compatible).toBe(true);

    const message = refusal(() => resolveProject(manifest, adapters));
    expect(message).toContain('page.notFound');
    expect(message).toContain('feature:not-found');
  });

  it('keeps the planner guard for the question only a plan can answer', () => {
    /*
     * Not the same check moved earlier. `styles.global` is mapped by the React
     * architecture, so nothing above can refuse it; whether anything *filled*
     * it is a fact about the finished plan, and that guard stays where it is.
     */
    const manifest = reactManifest({ styling: 'none' });
    expect(() => resolveProject(manifest, adapters)).not.toThrow();

    const message = refusal(() =>
      planManifest(manifest, {
        registry: v1Registry,
        cliVersion: '9.9.9',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode: manifest.starter,
      }),
    );
    expect(message).toContain('styles.global');
  });

  it('names every asker when more than one wants the same missing role', () => {
    const architecture: ArchitectureDefinition = {
      id: 'synthetic-empty' as ArchitectureId,
      displayName: 'Synthetic empty',
      directories: [],
      roles: { package: 'package.json' },
    };
    const message = refusal(() =>
      assertRolesArePlaceable(
        architecture,
        new Map([['page.notFound', ['feature:not-found', 'feature:client-route-fallback']]]),
      ),
    );
    expect(message).toContain('feature:not-found');
    expect(message).toContain('feature:client-route-fallback');
    expect(message).toContain('page.notFound');
  });

  it('says nothing when every required role is placeable', () => {
    const architecture = adapters.framework('astro').architectureDefinitions[0];
    expect(() =>
      assertRolesArePlaceable(
        architecture as ArchitectureDefinition,
        new Map([['page.notFound', ['feature:not-found']]]),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Regression: nothing that worked stopped working
// ---------------------------------------------------------------------------

describe('the supported stacks are unchanged', () => {
  const supported: readonly (readonly [string, ProjectManifest])[] = [
    ['next', nextManifest()],
    ['next + tailwind', nextManifest({ styling: 'tailwind' })],
    ['next + bootstrap', nextManifest({ styling: 'bootstrap' })],
    ['next + mui', nextManifest({ uiLibrary: 'mui' })],
    ['next + mui + tailwind', nextManifest({ uiLibrary: 'mui', styling: 'tailwind' })],
    ['react + mui', reactManifest({ uiLibrary: 'mui' })],
    ['react + mui + tailwind', reactManifest({ uiLibrary: 'mui', styling: 'tailwind' })],
    ['react + mui + react-router', reactManifest({ uiLibrary: 'mui', router: 'react-router' })],
    ['astro + tailwind', astroManifest()],
  ];

  for (const [label, manifest] of supported) {
    it(`${label} still resolves`, () => {
      expect(checkCompatibility(manifest, adapters).compatible, label).toBe(true);
      expect(() => resolveProject(manifest, adapters), label).not.toThrow();
    });
  }
});

describe('the refusals are unchanged', () => {
  const refused: readonly (readonly [string, ProjectManifest, string])[] = [
    ['next + react-router', nextManifest({ router: 'react-router' }), 'file-based-routing'],
    ['next + seo', nextManifest({ features: ['seo'] }), 'composed-metadata'],
    [
      'next + structured-data',
      nextManifest({ features: ['structured-data'] }),
      'composed-metadata',
    ],
    ['next + accessibility', nextManifest({ features: ['accessibility'] }), 'composed-metadata'],
    ['next + not-found', nextManifest({ features: ['not-found'] }), 'page.notFound'],
    [
      'next + client-route-fallback',
      nextManifest({ features: ['client-route-fallback'] }),
      'client-side-routing',
    ],
    ['astro + bootstrap', astroManifest({ styling: 'bootstrap' }), 'composed-stylesheet'],
  ];

  for (const [label, manifest, because] of refused) {
    it(`${label} is still refused, naming ${because}`, () => {
      const message = refusal(() => resolveProject(manifest, adapters));
      expect(message, label).not.toBe('');
      expect(message, label).toContain(because);
    });
  }

  it('refuses before anything is written, whichever check fires', () => {
    for (const [label, manifest] of refused) {
      let planned = false;
      try {
        planManifest(manifest, {
          registry: v1Registry,
          cliVersion: '9.9.9',
          generatedAt: '2026-01-01T00:00:00.000Z',
          mode: manifest.starter,
        });
        planned = true;
      } catch {
        // expected
      }
      expect(planned, `${label} produced a plan`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the contract is expressed in capabilities, never in names', () => {
  it('names no framework, UI library or styling system', () => {
    const text = codeOnly('src/domain/capability-contract.ts').toLowerCase();
    for (const name of ['nextjs', 'react-standard', 'next-app', 'astro-standard', 'bootstrap']) {
      expect(text, `capability-contract.ts branches on ${name}`).not.toContain(name);
    }
    // `react` survives inside `react-runtime`, which is a capability id and the
    // whole point; assert the *branching* forms are absent instead.
    expect(text).not.toMatch(/framework\s*[=!]==/);
    expect(text).not.toMatch(/uilibrary\s*[=!]==/);
    expect(text).not.toMatch(/styling\s*[=!]==/);
  });

  it('keeps the validation layer free of framework branches', () => {
    for (const file of [
      'src/domain/capability-contract.ts',
      'src/domain/compatibility.ts',
      'src/domain/resolution.ts',
      'src/adapters/selection.ts',
    ]) {
      const text = codeOnly(file);
      for (const literal of ["'nextjs'", "'astro'", "'react'", "'mui'", "'bootstrap'"]) {
        expect(text, `${file} branches on ${literal}`).not.toContain(literal);
      }
    }
  });

  it('has no combination module', () => {
    for (const file of [
      'src/domain/capability-matrix.ts',
      'src/adapters/next-capabilities.ts',
      'src/domain/framework-capabilities.ts',
    ]) {
      expect(() => source(file), file).toThrow();
    }
  });

  it('adds no runtime dependency', () => {
    const pkg = JSON.parse(source('package.json')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('touches no filesystem from the domain layer', () => {
    const text = source('src/domain/capability-contract.ts');
    for (const module of ['node:fs', 'node:path', 'node:child_process', 'node:process']) {
      expect(text, `capability-contract.ts imports ${module}`).not.toContain(`'${module}'`);
    }
  });
});

describe('the assertion is reachable and does nothing when it should not', () => {
  it('passes a stack whose architecture keeps every promise', () => {
    const next = adapters.framework('nextjs');
    expect(() =>
      assertCapabilityContracts(
        new Set<Capability>(next.declaration.provides),
        next.architectureDefinitions[0] as ArchitectureDefinition,
        next.templateOwnedRoles ?? [],
        new Map(),
      ),
    ).not.toThrow();
  });

  it('falls back to a readable subject when nothing claims the capability', () => {
    const architecture: ArchitectureDefinition = {
      id: 'synthetic-empty' as ArchitectureId,
      displayName: 'Synthetic empty',
      directories: [],
      roles: {},
    };
    const message = refusal(() =>
      assertCapabilityContracts(
        new Set<Capability>(['client-app-root']),
        architecture,
        [],
        new Map(),
      ),
    );
    expect(message).toContain('Something in this stack');
    expect(message).toContain('client-app-root');
  });
});

// ---------------------------------------------------------------------------
// Generated output
// ---------------------------------------------------------------------------

describe('hardening changed no generated project', () => {
  it('produces the same paths for every supported stack it did before', () => {
    /*
     * A cheap shape check next to the goldens rather than a replacement for
     * them: the point is that adding two assertions at resolution altered no
     * plan, and a stack that silently lost a file would show up here first.
     */
    const counts: Record<string, number> = {};
    for (const [label, manifest] of [
      ['next', nextManifest()],
      ['next + mui', nextManifest({ uiLibrary: 'mui' })],
      ['react + tailwind', reactManifest()],
    ] as const) {
      const plan = planManifest(manifest as ProjectManifest, {
        registry: v1Registry,
        cliVersion: '9.9.9',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode: (manifest as ProjectManifest).starter,
      });
      counts[label] = plan.plan.operations.length;
    }
    // Recorded values, so a change has to be looked at rather than absorbed.
    expect(counts).toEqual({ next: 14, 'next + mui': 15, 'react + tailwind': 21 });
  });

  it('resolves identically on repeated runs', () => {
    const a = resolveProject(nextManifest({ uiLibrary: 'mui' }), adapters).project;
    const b = resolveProject(nextManifest({ uiLibrary: 'mui' }), adapters).project;
    expect(JSON.stringify({ ...a, capabilities: [...a.capabilities].sort() })).toBe(
      JSON.stringify({ ...b, capabilities: [...b.capabilities].sort() }),
    );
  });
});

/**
 * A `ResolvedProject` is never constructed by hand here on purpose: every
 * assertion above goes through `resolveProject`, which is the only path the CLI
 * has. A contract that held for a literal and not for the real pipeline would
 * be worth nothing.
 */
const _typeCheck: (project: ResolvedProject) => FileRole[] = (project) => [
  ...project.requiredRoles,
];
void _typeCheck;
