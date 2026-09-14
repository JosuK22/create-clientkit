import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertRequiredRoles,
  contributedFiles,
  layersFrom,
  resolveWithAdapters,
} from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { resolveProject } from '../src/adapters/selection.js';
import type { Contribution, TemplateLayerContribution } from '../src/domain/index.js';
import {
  ARCHITECTURE_IDS,
  BUILD_TOOL_IDS,
  FEATURE_IDS,
  FILE_ROLES,
  FRAMEWORK_IDS,
  ROUTER_IDS,
  STYLING_IDS,
  UI_LIBRARY_IDS,
  definesRole,
  resolveRole,
} from '../src/domain/index.js';
import type { FeatureId, FileRole, ProjectManifest } from '../src/domain/index.js';
import { isStarterId, planStarterLayers, selectStarter, starters } from '../src/domain/starter.js';
import { CliError } from '../src/errors.js';
import type { FileOperation } from '../src/generate/files.js';
import { findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * The starter contract.
 *
 * The claim under test is a negative one, and it is the whole point of the
 * stage: *nothing* about what a starter contributes depends on the framework
 * that renders it, the styling system next to it, the component library above
 * it, the router under it or the features beside it. If that holds, a third
 * framework contributes starters by naming two directories. If it does not,
 * the system grows a directory per combination and the arithmetic ends the
 * project.
 *
 * So the sharp tests here are the invariance ones: the same starter layers,
 * byte for byte, across every stack the engine will accept. A test that only
 * checked "the coming-soon starter produces a home page" would pass just as
 * happily in a world with a `react-tailwind-mui-starter` directory.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const ASTRO_TEMPLATE = path.join(TEMPLATES_ROOT, 'astro-tailwind');
const REACT_TEMPLATE = path.join(TEMPLATES_ROOT, 'react-vite');

const STARTER_SOURCE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'domain', 'starter.ts');
const STARTER_SOURCE = readFileSync(STARTER_SOURCE_PATH, 'utf8');

/**
 * The source with its prose removed.
 *
 * The header comment explains the combination problem, and explaining it means
 * naming frameworks. Scanning the raw file for framework names would therefore
 * fail on documentation, which is exactly the kind of test that gets deleted
 * rather than fixed.
 */
const STARTER_CODE = STARTER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const reactManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-app'),
  projectName: 'acme-app',
  framework: 'react',
  buildTool: 'vite',
  language: 'ts',
  styling: 'tailwind',
  uiLibrary: 'none',
  router: 'none',
  architecture: 'react-standard',
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

const astroManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  ...reactManifest(),
  targetDir: path.join(TEST_CWD, 'acme-site'),
  projectName: 'acme-site',
  framework: 'astro',
  buildTool: 'vite',
  router: 'file-based',
  architecture: 'astro-standard',
  ...over,
});

/** The layers the framework adapter contributes for a manifest. */
const starterLayersOf = (manifest: ProjectManifest): readonly TemplateLayerContribution[] => {
  const { contributions } = resolveWithAdapters(manifest, TEMPLATES_ROOT);
  const owner = `framework:${manifest.framework}`;
  const framework = contributions.find(
    (contribution: Contribution) => contribution.owner === owner,
  );
  if (framework === undefined) throw new Error(`no contribution from ${owner}`);
  return framework.templateLayers;
};

const operationsFor = (paths: readonly string[]): readonly FileOperation[] =>
  paths.map((entry) => ({ type: 'write', path: entry, content: '', origin: 'test' }));

// ---------------------------------------------------------------------------
// The contract itself
// ---------------------------------------------------------------------------

describe('the starter contract is data, not a framework', () => {
  it('plans layers for a framework that does not exist', () => {
    // No adapter, no registry, no template on disk. If this needed any of
    // those, a new framework could not contribute a starter without first
    // editing the contract.
    const layers = planStarterLayers({
      starter: selectStarter(['starter:full']),
      owner: 'framework:fictional',
      roots: { base: '/nowhere/shared', starter: '/nowhere/variants/full' },
      baseReason: 'the shared shell of a framework nobody has written',
    });

    expect(layers).toEqual([
      {
        name: 'base',
        root: '/nowhere/shared',
        owner: 'framework:fictional',
        order: 0,
        reason: 'the shared shell of a framework nobody has written',
      },
      {
        name: 'modes/full',
        root: '/nowhere/variants/full',
        owner: 'framework:fictional',
        order: 10,
        reason: 'the "full" starter selected by the manifest',
      },
    ]);
  });

  it('never invents a path of its own', () => {
    // Both roots come back exactly as handed in. The moment the contract joins
    // a segment itself, it has an opinion about how a framework is laid out.
    const roots = { base: 'a', starter: 'b' };
    const layers = planStarterLayers({
      starter: starters()[0]!,
      owner: 'framework:fictional',
      roots,
      baseReason: 'why',
    });
    expect(layers.map((layer) => layer.root)).toEqual(['a', 'b']);
  });

  it('gives every layer an owner and a reason', () => {
    for (const starter of starters()) {
      const layers = planStarterLayers({
        starter,
        owner: 'framework:fictional',
        roots: { base: 'a', starter: 'b' },
        baseReason: 'the shared part',
      });
      for (const layer of layers) {
        expect(layer.owner).toBe('framework:fictional');
        expect(layer.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('orders the layers explicitly, not by array position', () => {
    // Array position is not a contract - `layersFrom` sorts. A starter layer
    // that composed before the base would overwrite nothing and silently lose.
    const layers = planStarterLayers({
      starter: starters()[1]!,
      owner: 'framework:fictional',
      roots: { base: 'a', starter: 'b' },
      baseReason: 'the shared part',
    });
    expect(layers[0]!.order).toBeLessThan(layers[1]!.order);
    expect(layers.map((layer) => layer.name)).toEqual(['base', 'modes/full']);
  });

  it('guarantees semantic roles, never concrete paths', () => {
    for (const starter of starters()) {
      expect(starter.guarantees.length).toBeGreaterThan(0);
      for (const role of starter.guarantees) {
        expect(FILE_ROLES).toContain(role);
        // A role, not a path. `src/pages/index.astro` here would be Astro's
        // layout leaking into a contract two other frameworks also answer to.
        expect(role).not.toMatch(/[/\\.](astro|tsx|jsx|ts|js|html)$/);
      }
    }
  });

  it('describes each starter well enough to offer it', () => {
    for (const starter of starters()) {
      expect(isStarterId(starter.id)).toBe(true);
      expect(FEATURE_IDS).toContain(starter.id);
      expect(starter.displayName.length).toBeGreaterThan(0);
      expect(starter.description.length).toBeGreaterThan(0);
      expect(starter.layer.length).toBeGreaterThan(0);
      // A name a framework can map to a directory, not a directory.
      expect(starter.layer).not.toContain('/');
      expect(starter.layer).not.toContain('\\');
    }
  });
});

// ---------------------------------------------------------------------------
// Selecting one
// ---------------------------------------------------------------------------

describe('a project has exactly one starter', () => {
  it('defaults to coming-soon, which is what V1 does', () => {
    expect(selectStarter([]).id).toBe('starter:coming-soon');
    expect(selectStarter(['seo', 'not-found']).id).toBe('starter:coming-soon');
  });

  it('selects the named one', () => {
    expect(selectStarter(['starter:full']).layer).toBe('full');
    expect(selectStarter(['starter:coming-soon']).layer).toBe('coming-soon');
    expect(selectStarter(['seo', 'starter:full', 'not-found']).layer).toBe('full');
  });

  it('refuses two rather than picking one', () => {
    // The predecessor answered `coming-soon` here, because it was an
    // `includes()` call wearing a string's clothes. Generating a project the
    // caller did not ask for is the one outcome that helps nobody.
    expect(() => selectStarter(['starter:full', 'starter:coming-soon'])).toThrow(CliError);
    expect(() => selectStarter(['starter:full', 'starter:coming-soon'])).toThrow(/one starter/i);
  });

  it('names both when it refuses, in a stable order', () => {
    const hintOf = (features: readonly string[]): string => {
      try {
        selectStarter(features);
      } catch (error) {
        return (error as CliError).hint ?? '';
      }
      return '';
    };
    // Same diagnostic whichever order the manifest happened to list them in.
    expect(hintOf(['starter:full', 'starter:coming-soon'])).toBe(
      hintOf(['starter:coming-soon', 'starter:full']),
    );
    expect(hintOf(['starter:full', 'starter:coming-soon'])).toContain('starter:coming-soon');
  });

  it('refuses an unknown starter by name', () => {
    expect(() => selectStarter(['starter:nonsense'])).toThrow(/Unknown starter/);
    expect(() => selectStarter(['starter:nonsense'])).toThrow(/starter:nonsense/);
  });

  it('lists the real starters when it refuses', () => {
    try {
      selectStarter(['starter:nonsense']);
      expect.unreachable('should have refused');
    } catch (error) {
      const hint = (error as CliError).hint ?? '';
      for (const starter of starters()) expect(hint).toContain(starter.id);
    }
  });

  it('recognises starter ids without a table of them', () => {
    expect(isStarterId('starter:anything')).toBe(true);
    expect(isStarterId('seo')).toBe(false);
    expect(isStarterId('not-found')).toBe(false);
  });

  it('every starter id in the feature list is a real starter', () => {
    // The two lists are separate, and drift between them is the failure this
    // catches: a `starter:*` id nothing implements would reach `selectStarter`
    // as an unknown starter at generation time rather than here.
    const named = FEATURE_IDS.filter(isStarterId);
    expect([...named].sort()).toEqual(
      starters()
        .map((starter) => starter.id)
        .sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('planning a starter is deterministic', () => {
  it('returns an identical plan for identical input', () => {
    const input = {
      starter: selectStarter(['starter:full']),
      owner: 'framework:fictional',
      roots: { base: 'a', starter: 'b' },
      baseReason: 'the shared part',
    };
    const first = planStarterLayers(input);
    const second = planStarterLayers(input);
    expect(first).toEqual(second);
    // Field order too: the plan is rendered, diffed and snapshotted.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('returns the same starter list every time, in the same order', () => {
    expect(starters()).toEqual(starters());
    expect(starters().map((starter) => starter.id)).toEqual([
      'starter:coming-soon',
      'starter:full',
    ]);
  });

  it('produces the same layers through the adapter twice', () => {
    for (const manifest of [reactManifest(), astroManifest({ features: ['starter:full'] })]) {
      expect(starterLayersOf(manifest)).toEqual(starterLayersOf(manifest));
    }
  });

  it('orders composed layers by order, not by adapter iteration', () => {
    const { contributions } = resolveWithAdapters(
      reactManifest({ uiLibrary: 'mui', styling: 'bootstrap' }),
      TEMPLATES_ROOT,
    );
    expect(layersFrom(contributions)).toEqual(layersFrom([...contributions].reverse()));
  });
});

// ---------------------------------------------------------------------------
// Composition: the invariance that makes combination directories unnecessary
// ---------------------------------------------------------------------------

/**
 * Stacks the engine accepts, chosen to vary every dimension the starter is
 * *not* allowed to care about while holding the starter fixed.
 */
const REACT_STACKS: ReadonlyArray<readonly [string, Partial<ProjectManifest>]> = [
  ['bare', {}],
  ['a different styling system', { styling: 'bootstrap' }],
  ['a component library', { uiLibrary: 'mui' }],
  ['a router', { router: 'react-router' }],
  [
    'a router and a feature',
    { router: 'react-router', features: ['client-route-fallback'] as readonly FeatureId[] },
  ],
  [
    'a component library, a router and a feature',
    {
      uiLibrary: 'mui',
      router: 'react-router',
      features: ['client-route-fallback'] as readonly FeatureId[],
    },
  ],
  [
    'everything at once, on the other styling system',
    {
      styling: 'bootstrap',
      uiLibrary: 'mui',
      router: 'react-router',
      features: ['client-route-fallback'] as readonly FeatureId[],
    },
  ],
];

const ASTRO_STACKS: ReadonlyArray<readonly [string, Partial<ProjectManifest>]> = [
  ['bare', {}],
  ['one feature', { features: ['seo'] as readonly FeatureId[] }],
  ['two features', { features: ['seo', 'not-found'] as readonly FeatureId[] }],
  [
    'four features at once',
    {
      features: ['seo', 'not-found', 'accessibility', 'structured-data'] as readonly FeatureId[],
    },
  ],
];

describe('the starter composes with everything and notices none of it', () => {
  it('contributes identical layers across every React stack', () => {
    const expected = starterLayersOf(reactManifest());
    for (const [label, over] of REACT_STACKS) {
      expect(starterLayersOf(reactManifest(over)), label).toEqual(expected);
    }
  });

  it('contributes identical layers across every Astro stack', () => {
    const expected = starterLayersOf(astroManifest());
    for (const [label, over] of ASTRO_STACKS) {
      expect(starterLayersOf(astroManifest(over)), label).toEqual(expected);
    }
  });

  it('is unchanged by every feature the registry implements, one at a time', () => {
    // Exhaustive rather than a chosen list, so a feature added later is covered
    // without anyone remembering to come back here. Some combinations are
    // refused - `client-route-fallback` needs a client router, and Astro has
    // none - and a refusal is a compatibility decision made before any starter
    // is planned, which is why it counts as a pass here rather than a skip.
    const featureIds = adapters
      .implementedFeatures()
      .filter((id: string) => !isStarterId(id)) as readonly FeatureId[];
    expect(featureIds.length).toBeGreaterThan(0);

    for (const [label, build, expected] of [
      ['astro', astroManifest, starterLayersOf(astroManifest())],
      ['react', reactManifest, starterLayersOf(reactManifest())],
    ] as const) {
      for (const feature of featureIds) {
        const manifest = build({ features: [feature] });
        let layers: readonly TemplateLayerContribution[] | null = null;
        try {
          layers = starterLayersOf(manifest);
        } catch (error) {
          expect(error, `${label} + ${feature}`).toBeInstanceOf(CliError);
        }
        if (layers !== null) expect(layers, `${label} + ${feature}`).toEqual(expected);
      }
    }
  });

  it('varies with the starter and with nothing else', () => {
    // The one dimension it is allowed to respond to. Holding the stack fixed
    // and changing only the starter must change exactly one layer.
    for (const [, over] of REACT_STACKS) {
      const comingSoon = starterLayersOf(
        reactManifest({ ...over, features: [...(over.features ?? []), 'starter:coming-soon'] }),
      );
      const full = starterLayersOf(
        reactManifest({ ...over, features: [...(over.features ?? []), 'starter:full'] }),
      );
      expect(comingSoon[0]).toEqual(full[0]);
      expect(comingSoon[1]).not.toEqual(full[1]);
      expect(full[1]!.name).toBe('modes/full');
    }
  });

  it('keeps both frameworks on the same contract shape', () => {
    // Two frameworks arranging their layers identically is a coincidence. What
    // matters is that the *shape* - two layers, named and ordered the same way,
    // owned by the framework - is the contract's, while the roots are the
    // framework's alone.
    const astro = starterLayersOf(astroManifest());
    const react = starterLayersOf(reactManifest());

    expect(astro.map((layer) => [layer.name, layer.order])).toEqual(
      react.map((layer) => [layer.name, layer.order]),
    );
    expect(astro.map((layer) => layer.owner)).toEqual(['framework:astro', 'framework:astro']);
    expect(react.map((layer) => layer.owner)).toEqual(['framework:react', 'framework:react']);
    expect(astro.map((layer) => layer.root)).not.toEqual(react.map((layer) => layer.root));
    // Each framework's own reason for its own shared layer, not a generated one.
    expect(astro[0]!.reason).not.toBe(react[0]!.reason);
  });

  it('the starter layers of a stack live under that framework and nowhere else', () => {
    for (const [label, over] of REACT_STACKS) {
      for (const layer of starterLayersOf(reactManifest(over))) {
        expect(path.relative(REACT_TEMPLATE, layer.root).startsWith('..'), label).toBe(false);
      }
    }
    for (const [label, over] of ASTRO_STACKS) {
      for (const layer of starterLayersOf(astroManifest(over))) {
        expect(path.relative(ASTRO_TEMPLATE, layer.root).startsWith('..'), label).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Independence, proved structurally
// ---------------------------------------------------------------------------

describe('the contract cannot know what it composes with', () => {
  it('reads no filesystem, spawns nothing, and joins no path', () => {
    for (const module of [
      'node:fs',
      'node:child_process',
      'node:process',
      'node:os',
      'node:path',
    ]) {
      expect(STARTER_CODE.includes(`'${module}'`), `imports ${module}`).toBe(false);
    }
  });

  it('consults no adapter and no registry', () => {
    // A contract that could ask an adapter a question would end up asking which
    // framework it was, and the branch would follow within the week.
    expect(STARTER_CODE).not.toContain('adapters/');
    expect(STARTER_CODE).not.toMatch(/\bregistry\b/i);
    expect(STARTER_CODE).not.toMatch(/\bresolveProject\b/);
  });

  it('names no framework, styling system, component library, router or architecture', () => {
    const forbidden = [
      ...FRAMEWORK_IDS,
      ...BUILD_TOOL_IDS,
      ...STYLING_IDS,
      ...UI_LIBRARY_IDS,
      ...ROUTER_IDS,
      ...ARCHITECTURE_IDS,
    ].filter((id) => id !== 'none');

    for (const id of forbidden) {
      for (const quoted of [`'${id}'`, `"${id}"`, `\`${id}\``]) {
        expect(STARTER_CODE.includes(quoted), `mentions ${quoted}`).toBe(false);
      }
    }
  });

  it('names no feature other than the starters themselves', () => {
    for (const id of FEATURE_IDS.filter((feature) => !isStarterId(feature))) {
      expect(STARTER_CODE.includes(`'${id}'`), `mentions ${id}`).toBe(false);
    }
  });

  it('branches on the starter and on nothing else', () => {
    // The manifest reaches `selectStarter` as a list of feature ids and comes
    // back as one definition. Handing the whole manifest in would make every
    // other dimension reachable, and reachable is eventually read.
    expect(STARTER_CODE).not.toContain('ProjectManifest');
    expect(STARTER_CODE).not.toContain('ResolvedProject');
  });

  it('the framework adapters, not the contract, decide where layers live', () => {
    for (const file of ['astro.ts', 'react.ts']) {
      const source = readFileSync(
        path.resolve(import.meta.dirname, '..', 'src', 'adapters', file),
        'utf8',
      );
      expect(source).toContain('planStarterLayers');
      // The adapter joins its own paths; that is its half of the split.
      expect(source).toContain('path.join(templateRoot');
    }
  });
});

// ---------------------------------------------------------------------------
// Ownership and collisions
// ---------------------------------------------------------------------------

describe('layers carry ownership through composition', () => {
  it('the framework owns both of its layers', () => {
    for (const manifest of [astroManifest(), reactManifest()]) {
      const layers = starterLayersOf(manifest);
      const owners = new Set(layers.map((layer) => layer.owner));
      expect(owners.size).toBe(1);
      expect([...owners][0]).toBe(`framework:${manifest.framework}`);
    }
  });

  it('two layers from one owner stack rather than collide', () => {
    // Layering is cooperative *within* an owner: base then starter, the later
    // one winning. This is the case that must not be mistaken for a conflict.
    const layers = starterLayersOf(reactManifest({ features: ['starter:full'] }));
    expect(layers).toHaveLength(2);
    expect(new Set(layers.map((layer) => layer.owner)).size).toBe(1);
    expect(layers[0]!.order).toBeLessThan(layers[1]!.order);

    const composed = layersFrom([
      {
        owner: 'framework:react',
        dependencies: [],
        files: [],
        scripts: [],
        config: [],
        directories: [],
        templateLayers: layers,
      },
    ]);
    expect(composed.map((layer) => layer.name)).toEqual(['base', 'modes/full']);
  });

  it('two owners claiming one file is a collision, not a race', () => {
    const { project } = resolveProject(reactManifest(), adapters);
    const claim = (owner: string) => ({
      target: { kind: 'role', role: 'app.providers' } as const,
      intent: 'create' as const,
      payload: { kind: 'text', content: '' } as const,
      owner,
      order: 0,
      reason: 'test',
    });

    const contributions = [
      { ...blank('ui-library:mui'), files: [claim('ui-library:mui')] },
      { ...blank('router:react-router'), files: [claim('router:react-router')] },
    ];

    expect(() => contributedFilesOf(project, contributions)).toThrow(CliError);
    expect(() => contributedFilesOf(project, contributions)).toThrow(/both claim/);
  });

  it('reports the same collision whichever order the adapters were iterated in', () => {
    const { project } = resolveProject(reactManifest(), adapters);
    const claim = (owner: string) => ({
      target: { kind: 'role', role: 'app.providers' } as const,
      intent: 'create' as const,
      payload: { kind: 'text', content: '' } as const,
      owner,
      order: 0,
      reason: 'test',
    });
    const contributions = [
      { ...blank('ui-library:mui'), files: [claim('ui-library:mui')] },
      { ...blank('router:react-router'), files: [claim('router:react-router')] },
    ];

    const messageFor = (list: typeof contributions): string => {
      try {
        contributedFilesOf(project, list);
      } catch (error) {
        return `${(error as CliError).message} ${(error as CliError).hint ?? ''}`;
      }
      return '';
    };

    expect(messageFor(contributions)).toBe(messageFor([...contributions].reverse()));
    expect(messageFor(contributions)).toContain('ui-library:mui');
    expect(messageFor(contributions)).toContain('router:react-router');
  });
});

// ---------------------------------------------------------------------------
// The guarantee
// ---------------------------------------------------------------------------

describe('the starter guarantee is load-bearing', () => {
  it('every project requires the roles its starter guarantees', () => {
    for (const manifest of [
      reactManifest(),
      reactManifest({ features: ['starter:full'] }),
      astroManifest(),
      astroManifest({ features: ['starter:full'] }),
    ]) {
      const { project } = resolveProject(manifest, adapters);
      for (const role of selectStarter(manifest.features).guarantees) {
        expect(project.requiredRoles).toContain(role);
      }
    }
  });

  it('the architecture maps every role a starter guarantees', () => {
    // A guarantee the architecture cannot place would fail at generation time
    // with a message about a role nobody can satisfy. Checked here instead.
    for (const framework of ['astro', 'react'] as const) {
      const adapter = adapters.framework(framework);
      for (const architecture of adapter.architectureDefinitions) {
        for (const starter of starters()) {
          for (const role of starter.guarantees) {
            expect(definesRole(architecture, role), `${architecture.id} / ${role}`).toBe(true);
          }
        }
      }
    }
  });

  it('passes when the real plan produces the page', () => {
    for (const manifest of [astroManifest(), reactManifest()]) {
      const { project } = resolveProject(manifest, adapters);
      const home = resolveRole(project.architecture, 'page.home');
      expect(() =>
        assertRequiredRoles(project, operationsFor([home, ...otherRequired(project, home)])),
      ).not.toThrow();
    }
  });

  it('fails before writing anything when nothing produces it', () => {
    const { project } = resolveProject(astroManifest(), adapters);
    expect(() => assertRequiredRoles(project, [])).toThrow(CliError);
    expect(() => assertRequiredRoles(project, [])).toThrow(/page\.home/);
  });

  it('names the real path, never a fabricated one', () => {
    for (const manifest of [astroManifest(), reactManifest()]) {
      const { project } = resolveProject(manifest, adapters);
      const home = resolveRole(project.architecture, 'page.home');
      try {
        assertRequiredRoles(project, []);
        expect.unreachable('should have refused');
      } catch (error) {
        // The path in the diagnostic is the architecture's, resolved - not a
        // guess assembled from the framework id.
        expect((error as CliError).message).toContain(home);
      }
    }
  });

  it('the guaranteed page is actually generated, in both starters', () => {
    for (const manifest of [
      astroManifest(),
      astroManifest({ features: ['starter:full'] }),
      reactManifest(),
      reactManifest({ features: ['starter:full'] }),
    ]) {
      const { project } = resolveProject(manifest, adapters);
      expect(project.requiredRoles).toContain('page.home');
    }
  });
});

// ---------------------------------------------------------------------------
// No combination templates
// ---------------------------------------------------------------------------

describe('nothing here needs a directory per combination', () => {
  const directoriesUnder = (root: string): readonly string[] =>
    readdirSync(root).filter((entry) => statSync(path.join(root, entry)).isDirectory());

  it('template directories are organised by dimension, one per option', () => {
    // `templates/styling/tailwind`, not `templates/react-tailwind-starter`.
    // Each directory answers one dimension, and adding an option adds one
    // directory rather than multiplying the tree.
    const byDimension: Record<string, readonly string[]> = {
      styling: STYLING_IDS,
      'ui-library': UI_LIBRARY_IDS,
      feature: FEATURE_IDS,
    };
    for (const [dimension, ids] of Object.entries(byDimension)) {
      for (const entry of directoriesUnder(path.join(TEMPLATES_ROOT, dimension))) {
        expect(ids, `${dimension}/${entry}`).toContain(entry);
      }
    }
  });

  it('a framework contributes starters with two directories, whatever else exists', () => {
    for (const root of [ASTRO_TEMPLATE, REACT_TEMPLATE]) {
      expect([...directoriesUnder(root)].sort()).toEqual(['base', 'modes']);
      expect([...directoriesUnder(path.join(root, 'modes'))].sort()).toEqual(
        starters()
          .map((starter) => starter.layer)
          .sort(),
      );
    }
  });

  it('no starter directory names a styling system, component library or router', () => {
    // The Astro template root is V1's frozen `astro-tailwind` name, which is
    // why this looks *below* each framework root rather than at it. A real
    // combination directory would appear there.
    const forbidden = [...STYLING_IDS, ...UI_LIBRARY_IDS, ...ROUTER_IDS].filter(
      (id) => id !== 'none',
    );
    for (const root of [ASTRO_TEMPLATE, REACT_TEMPLATE]) {
      for (const entry of directoriesUnder(path.join(root, 'modes'))) {
        for (const id of forbidden) expect(entry).not.toContain(id);
      }
    }
  });

  it('the starter count does not grow with the other dimensions', () => {
    // The arithmetic this stage exists to prevent, stated as a test. The
    // combination count is what a directory-per-stack design would have to
    // carry; the real number is two per framework.
    const combinations =
      FRAMEWORK_IDS.length *
      STYLING_IDS.length *
      UI_LIBRARY_IDS.length *
      ROUTER_IDS.length *
      starters().length;
    expect(combinations).toBeGreaterThan(100);

    const onDisk = [ASTRO_TEMPLATE, REACT_TEMPLATE].flatMap((root) =>
      directoriesUnder(path.join(root, 'modes')),
    );
    expect(onDisk).toHaveLength(2 * starters().length);
    expect(starters()).toHaveLength(2);
  });

  it('a new styling system would add no starter definition', () => {
    // Stated against the contract rather than the tree: the definitions are a
    // fixed list keyed by starter id, with no dimension in the key.
    expect(starters().map((starter) => starter.id)).toEqual(
      FEATURE_IDS.filter(isStarterId).slice().sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers that need the bridge's internals
// ---------------------------------------------------------------------------

function blank(owner: string): Contribution {
  return {
    owner,
    dependencies: [],
    files: [],
    scripts: [],
    config: [],
    templateLayers: [],
    directories: [],
  };
}

function contributedFilesOf(
  project: Parameters<typeof assertRequiredRoles>[0],
  contributions: readonly Contribution[],
): unknown {
  return contributedFiles(project, contributions, () => '');
}

/** Roles the project requires beyond the one under test, resolved to paths. */
function otherRequired(
  project: Parameters<typeof assertRequiredRoles>[0],
  exclude: string,
): readonly string[] {
  return project.requiredRoles
    .map((role: FileRole) => resolveRole(project.architecture, role))
    .filter((file: string) => file !== exclude);
}
