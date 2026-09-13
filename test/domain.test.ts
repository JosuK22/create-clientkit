import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADAPTER_KINDS,
  adapterRef,
  ARCHITECTURE_IDS,
  BUILD_TOOL_IDS,
  CAPABILITIES,
  definesRole,
  describeConstraint,
  emptyContribution,
  FEATURE_IDS,
  FILE_ROLES,
  FRAMEWORK_IDS,
  LANGUAGE_IDS,
  manifestFromProjectContext,
  resolveRole,
  ROUTER_IDS,
  STYLING_IDS,
  UI_LIBRARY_IDS,
} from '../src/domain/index.js';
import type {
  AdapterDeclaration,
  ArchitectureDefinition,
  Contribution,
  DependencyContribution,
  FileContribution,
  ProjectManifest,
  ResolvedProject,
} from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { makeContext } from './helpers.js';

/**
 * Tests for the V2 domain vocabulary.
 *
 * The point is not that the types compile - `tsc` already says so. It is that
 * the model can express the things the architecture claims it can, and cannot
 * express the thing it claims to avoid. Where an assertion would only restate a
 * type, it is not here.
 */

// ---------------------------------------------------------------------------
// Fixtures: the architecture document's own worked example.
// ---------------------------------------------------------------------------

const angular: AdapterDeclaration = {
  id: 'angular',
  kind: 'framework',
  displayName: 'Angular',
  provides: ['angular-runtime', 'spa-routing', 'typescript'],
  requires: [],
  minNode: '>=20.19',
};

const react: AdapterDeclaration = {
  id: 'react',
  kind: 'framework',
  displayName: 'React',
  provides: ['react-runtime', 'jsx'],
  requires: [],
};

const chakra: AdapterDeclaration = {
  id: 'chakra',
  kind: 'ui-library',
  displayName: 'Chakra UI',
  provides: ['css-in-js'],
  requires: [
    { kind: 'requires', capability: 'react-runtime', because: 'Chakra UI is built on React' },
  ],
};

const tailwind: AdapterDeclaration = {
  id: 'tailwind',
  kind: 'styling',
  displayName: 'Tailwind CSS',
  provides: ['css-framework', 'postcss'],
  requires: [],
};

const FIXTURES = [angular, react, chakra, tailwind];

const reactStandard: ArchitectureDefinition = {
  id: 'react-standard',
  displayName: 'React standard',
  directories: ['src/components', 'src/styles'],
  roles: {
    'app.entry': 'src/main.tsx',
    'styles.global': 'src/styles/index.css',
    package: 'package.json',
  },
};

const angularStandard: ArchitectureDefinition = {
  id: 'angular-standard',
  displayName: 'Angular standard',
  directories: ['src/app/core', 'src/app/shared'],
  roles: {
    'app.entry': 'src/main.ts',
    'styles.global': 'src/styles.scss',
    package: 'package.json',
  },
};

// ---------------------------------------------------------------------------

describe('dimensions stay separate', () => {
  it('styling and UI library are disjoint vocabularies', () => {
    // Collapsing these would make "Tailwind and MUI together" inexpressible and
    // imply Bootstrap and Chakra are interchangeable. They are not.
    const overlap = STYLING_IDS.filter((id) => (UI_LIBRARY_IDS as readonly string[]).includes(id));
    expect(overlap).toEqual(['none']); // only the shared "opt out" value
  });

  it('framework and build tool are separate axes', () => {
    // React does not imply a bundler; Astro is both a framework and its build
    // tool. Both facts have to be representable without inventing a
    // "react-vite" framework.
    expect(FRAMEWORK_IDS).toContain('react');
    expect(BUILD_TOOL_IDS).toContain('vite');
    expect(FRAMEWORK_IDS).not.toContain('react-vite');
    expect(FRAMEWORK_IDS).toContain('astro');
    expect(BUILD_TOOL_IDS).toContain('astro');
  });

  it('every dimension has unique ids', () => {
    const dimensions = {
      framework: FRAMEWORK_IDS,
      buildTool: BUILD_TOOL_IDS,
      language: LANGUAGE_IDS,
      styling: STYLING_IDS,
      uiLibrary: UI_LIBRARY_IDS,
      router: ROUTER_IDS,
      architecture: ARCHITECTURE_IDS,
      feature: FEATURE_IDS,
      capability: CAPABILITIES,
      role: FILE_ROLES,
      adapterKind: ADAPTER_KINDS,
    };
    for (const [name, ids] of Object.entries(dimensions)) {
      expect(new Set(ids).size, `${name} has a duplicate id`).toBe(ids.length);
    }
  });
});

describe('the manifest describes intent, not implementation', () => {
  it('carries no resolved versions or paths', () => {
    const manifest = manifestFromProjectContext(makeContext());
    const keys = Object.keys(manifest);
    // A manifest field that mentions a version or a config file would mean a
    // dependency release could invalidate a user's saved configuration.
    for (const key of keys) {
      expect(key, `"${key}" looks like an implementation detail`).not.toMatch(
        /version|config[A-Z]|plugin|dependency/i,
      );
    }
    expect(keys).toContain('framework');
    expect(keys).toContain('styling');
  });

  it('keeps URL-less representable as explicitly absent', () => {
    const urlLess = manifestFromProjectContext(
      makeContext({
        site: {
          name: 'Acme Ltd',
          url: null,
          description: 'Bespoke widgets.',
          locale: 'en',
          author: null,
        },
      }),
    );
    // null, not '' and not a placeholder domain - the invariant the whole
    // product rests on has to survive the new vocabulary.
    expect(urlLess.site.url).toBeNull();
  });
});

describe('the V1 stack is expressible in the V2 vocabulary', () => {
  // If what ships today cannot be described here, the vocabulary is wrong. This
  // checks the model against the real product rather than against fixtures
  // invented to suit it.
  it('describes the shipped Astro + Tailwind stack', () => {
    const manifest = manifestFromProjectContext(makeContext());
    expect(manifest.framework).toBe('astro');
    expect(manifest.buildTool).toBe('astro');
    expect(manifest.language).toBe('ts');
    expect(manifest.styling).toBe('tailwind');
    expect(manifest.uiLibrary).toBe('none');
    expect(manifest.architecture).toBe('astro-standard');
  });

  it('maps V1 mode onto a starter feature rather than a core concept', () => {
    const comingSoon = manifestFromProjectContext(
      makeContext({ template: { id: 'astro-tailwind', version: '0.1.0', mode: 'coming-soon' } }),
    );
    const full = manifestFromProjectContext(
      makeContext({ template: { id: 'astro-tailwind', version: '0.1.0', mode: 'full' } }),
    );
    expect(comingSoon.features).toEqual(['starter:coming-soon']);
    expect(full.features).toEqual(['starter:full']);
    // and "mode" is gone from the vocabulary entirely
    expect(Object.keys(full)).not.toContain('mode');
  });

  it('preserves the V1 fields that are still meaningful', () => {
    const context = makeContext();
    const manifest = manifestFromProjectContext(context);
    expect(manifest.projectName).toBe(context.projectName);
    expect(manifest.targetDir).toBe(context.targetDir);
    expect(manifest.site).toEqual(context.site);
    expect(manifest.packageManager).toBe(context.packageManager);
    expect(manifest.git).toBe(context.git);
    expect(manifest.install).toBe(context.install);
  });
});

describe('compatibility is expressed without a combination matrix', () => {
  it('rejects Chakra on Angular without any rule naming both', () => {
    const selected = new Set(angular.provides);
    const requirement = chakra.requires[0]!;
    expect(requirement.kind).toBe('requires');
    expect(
      requirement.kind === 'requires' && selected.has(requirement.capability),
      'Angular should not satisfy Chakra',
    ).toBe(false);
  });

  it('accepts Chakra on React using the same declarations, unchanged', () => {
    const selected = new Set(react.provides);
    const requirement = chakra.requires[0]!;
    expect(requirement.kind === 'requires' && selected.has(requirement.capability)).toBe(true);
  });

  it('no declaration names another adapter — the property that makes it scale', () => {
    // This is the architectural invariant. The moment a constraint references
    // an adapter id, adding a framework means editing unrelated adapters, and
    // the design has degenerated into a matrix with extra steps.
    const adapterIds = new Set(FIXTURES.map((d) => d.id));
    const capabilities = new Set<string>(CAPABILITIES);

    for (const declaration of FIXTURES) {
      for (const constraint of declaration.requires) {
        const referenced =
          constraint.kind === 'requiresOneOf' ? constraint.capabilities : [constraint.capability];
        for (const value of referenced) {
          expect(capabilities.has(value), `${declaration.id} references unknown "${value}"`).toBe(
            true,
          );
          expect(
            adapterIds.has(value),
            `${declaration.id} names an adapter, not a capability`,
          ).toBe(false);
        }
      }
    }
  });

  it('a new framework needs no edit to existing declarations', () => {
    // Vue arrives declaring its own runtime. Chakra's declaration is untouched
    // and still correctly excludes it, because it asked for a capability rather
    // than listing frameworks.
    const vueProvides = new Set(['spa-routing', 'typescript']);
    const requirement = chakra.requires[0]!;
    expect(requirement.kind === 'requires' && vueProvides.has(requirement.capability)).toBe(false);
    expect(chakra.requires).toHaveLength(1); // unchanged by the arrival of Vue
  });

  it('every constraint carries a human reason, because it is the error text', () => {
    for (const declaration of FIXTURES) {
      for (const constraint of declaration.requires) {
        expect(constraint.because.length, `${declaration.id} has an empty reason`).toBeGreaterThan(
          0,
        );
        expect(describeConstraint(constraint)).toContain(constraint.because);
      }
    }
  });

  it('renders each constraint kind', () => {
    expect(
      describeConstraint({ kind: 'requires', capability: 'jsx', because: 'it compiles JSX' }),
    ).toBe('requires jsx (it compiles JSX)');
    expect(
      describeConstraint({
        kind: 'conflicts',
        capability: 'css-framework',
        because: 'two CSS frameworks fight',
      }),
    ).toBe('cannot be combined with css-framework (two CSS frameworks fight)');
    expect(
      describeConstraint({
        kind: 'requiresOneOf',
        capabilities: ['postcss', 'sass'],
        because: 'it needs a preprocessor',
      }),
    ).toBe('requires one of postcss, sass (it needs a preprocessor)');
  });
});

describe('file roles decouple adapters from frameworks', () => {
  it('one role resolves to a different path per architecture', () => {
    // The whole mechanism in one assertion: an adapter asking for
    // "styles.global" lands correctly in both stacks without knowing either.
    expect(resolveRole(reactStandard, 'styles.global')).toBe('src/styles/index.css');
    expect(resolveRole(angularStandard, 'styles.global')).toBe('src/styles.scss');
    expect(resolveRole(reactStandard, 'app.entry')).toBe('src/main.tsx');
    expect(resolveRole(angularStandard, 'app.entry')).toBe('src/main.ts');
  });

  it('an unmapped role fails loudly and says what is available', () => {
    // Silently dropping the contribution would produce a project missing a file
    // with nothing to explain why.
    expect(() => resolveRole(reactStandard, 'page.notFound')).toThrow(CliError);
    try {
      resolveRole(reactStandard, 'page.notFound');
    } catch (error) {
      const message = `${(error as CliError).message} ${(error as { hint?: string }).hint ?? ''}`;
      expect(message).toContain('page.notFound');
      expect(message).toContain('react-standard');
      expect(message).toContain('app.entry'); // names what it does define
    }
  });

  it('definesRole answers without throwing', () => {
    expect(definesRole(reactStandard, 'styles.global')).toBe(true);
    expect(definesRole(reactStandard, 'page.notFound')).toBe(false);
  });
});

describe('contributions carry ownership', () => {
  const fileAt = (owner: string, intent: 'create' | 'merge'): FileContribution => ({
    target: { kind: 'role', role: 'styles.global' },
    intent,
    payload: { kind: 'text', content: '@import "tailwindcss";\n' },
    owner,
    order: 0,
    reason: 'global stylesheet',
  });

  it('distinguishes layering by one owner from a collision between two', () => {
    // V1 resolves a same-path collision by letting the last layer win, which is
    // right for base + mode and wrong for two independent adapters. The data
    // has to make the difference visible before a planner can act on it.
    const layered = [fileAt('framework:astro', 'create'), fileAt('framework:astro', 'merge')];
    const collision = [fileAt('framework:react', 'create'), fileAt('styling:tailwind', 'create')];

    const owners = (files: FileContribution[]) => new Set(files.map((f) => f.owner));
    const creates = (files: FileContribution[]) => files.filter((f) => f.intent === 'create');

    expect(owners(layered).size).toBe(1);
    expect(creates(collision)).toHaveLength(2);
    expect(owners(collision).size).toBe(2);
  });

  it('supports a role target and a literal path target, distinguishably', () => {
    const byRole = fileAt('styling:tailwind', 'create');
    const byPath: FileContribution = {
      ...byRole,
      target: { kind: 'path', path: 'src/app/globals.css' },
    };
    expect(byRole.target.kind).toBe('role');
    expect(byPath.target.kind).toBe('path');
  });

  it('represents a version conflict between two adapters', () => {
    const deps: DependencyContribution[] = [
      {
        name: 'react',
        version: '19.0.0',
        kind: 'prod',
        owner: 'framework:react',
        reason: 'runtime',
      },
      { name: 'react', version: '18.3.1', kind: 'peer', owner: 'ui-library:mui', reason: 'peer' },
    ];
    const versions = new Set(deps.filter((d) => d.name === 'react').map((d) => d.version));
    expect(versions.size).toBe(2); // detectable, which is all this stage needs
    expect(deps.map((d) => d.owner)).toEqual(['framework:react', 'ui-library:mui']);
  });

  it('every dependency carries the reason that answers "why is this here?"', () => {
    const dep: DependencyContribution = {
      name: '@emotion/react',
      version: '11.14.0',
      kind: 'prod',
      owner: 'ui-library:mui',
      reason: 'required by @mui/material',
    };
    expect(dep.reason).not.toBe('');
    expect(dep.owner).toContain(':');
  });

  it('an adapter that adds nothing says so explicitly', () => {
    const nothing: Contribution = emptyContribution('styling:none');
    expect(nothing.owner).toBe('styling:none');
    expect(nothing.files).toEqual([]);
    expect(nothing.dependencies).toEqual([]);
  });

  it('adapterRef stamps a kind-qualified owner', () => {
    expect(adapterRef(tailwind)).toBe('styling:tailwind');
    expect(adapterRef(angular)).toBe('framework:angular');
    // two adapters may share an id across kinds without colliding
    expect(adapterRef({ ...tailwind, kind: 'feature' })).toBe('feature:tailwind');
  });
});

describe('the adapter contract', () => {
  it('an adapter is a pure function of data it is handed', () => {
    const manifest: ProjectManifest = manifestFromProjectContext(makeContext());
    const project: ResolvedProject = {
      manifest,
      capabilities: new Set(['static-output', 'typescript']),
      architecture: reactStandard,
      extensions: { source: '.ts', component: '.tsx', config: '.ts' },
      minNode: '>=22.12.0',
      templateOwnedRoles: [],
      requiredRoles: [],
      selection: {
        framework: 'astro',
        buildTool: 'astro',
        language: 'ts',
        styling: 'tailwind',
        uiLibrary: 'none',
        router: 'file-based',
        features: ['starter:coming-soon'],
      },
    };

    const adapter = {
      declaration: tailwind,
      resolve: () => ({ capabilities: ['postcss'] as const }),
      contribute: (input: ResolvedProject): Contribution => ({
        ...emptyContribution(adapterRef(tailwind)),
        files: [
          {
            target: { kind: 'role', role: 'styles.global' },
            intent: 'create',
            // reads the resolved project rather than deciding for itself
            payload: { kind: 'text', content: `/* ${input.extensions.source} */\n` },
            owner: adapterRef(tailwind),
            order: 0,
            reason: 'global stylesheet',
          },
        ],
      }),
    };

    const contribution = adapter.contribute(project);
    expect(contribution.owner).toBe('styling:tailwind');
    expect(contribution.files[0]?.payload).toEqual({ kind: 'text', content: '/* .ts */\n' });
    // called twice with the same input, it produces the same output
    expect(adapter.contribute(project)).toEqual(contribution);
  });

  it('expresses a fixed dimension and a real choice differently', () => {
    // Astro fixes its build tool; React does not. The prompt driver's single
    // rule - ask only when there is more than one option - needs this
    // distinction to exist in the data.
    const astroBuild = { kind: 'fixed', value: 'astro' } as const;
    const reactBuild = { kind: 'choice', options: ['vite'], default: 'vite' } as const;
    expect(astroBuild.kind).toBe('fixed');
    expect(reactBuild.kind).toBe('choice');
    expect(reactBuild.options).toHaveLength(1);
  });
});

describe('the domain layer stays pure', () => {
  it('no domain module imports the filesystem or a process API', () => {
    // Adapters must not be able to write files or run commands. The contract
    // hands them no such capability, and this guards the layer they live in
    // from acquiring one by import.
    const dir = path.resolve(import.meta.dirname, '..', 'src', 'domain');
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const forbidden = ['node:fs', 'node:child_process', 'node:process', 'node:os'];
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const module of forbidden) {
        expect(source.includes(`'${module}'`), `src/domain/${file} imports ${module}`).toBe(false);
      }
    }
  });

  it('is not imported by the V1 generation path', () => {
    // The dependency direction: V1 -> V2, never the reverse. If the resolver,
    // the planner or the CLI started importing the domain model, the shipped
    // bundle would change and the golden snapshots would be at risk.
    //
    // `src/adapters/` is excluded because adapters are V2 and importing the
    // domain vocabulary is their entire job. That exclusion arrived with Stage
    // 2; before it, this test walked everything outside `src/domain/`. The
    // complementary half - that the V1 path does not import `src/adapters/`
    // either - is asserted in adapters.test.ts, so the boundary is still
    // covered from both sides rather than loosened.
    const srcDir = path.resolve(import.meta.dirname, '..', 'src');
    const v2Directories = new Set(['domain', 'adapters']);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!v2Directories.has(entry.name)) walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (readFileSync(full, 'utf8').includes('domain/')) {
          offenders.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
