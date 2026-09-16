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
import type { StarterDefinition, StarterId } from '../src/domain/starter.js';
import {
  LEGACY_STARTER_PREFIX,
  STARTERS,
  STARTER_IDS,
  createStarterRegistry,
  planStarterLayers,
  selectStarter,
  starterFromMode,
} from '../src/domain/starter.js';
import { CliError } from '../src/errors.js';
import type { FileOperation } from '../src/generate/files.js';
import { findTemplatesRoot } from '../src/templates/registry.js';
import { TEMPLATE_MODES } from '../src/types.js';
import { TEST_CWD } from './helpers.js';

/**
 * The starter contract.
 *
 * Two claims, and the second is the one Stage 21 added.
 *
 * The first is Stage 20's: *nothing* about what a starter contributes depends
 * on the framework that renders it, the styling system next to it, the
 * component library above it, the router under it or the features beside it.
 * If that holds, a third framework contributes starters by naming two
 * directories; if it does not, the system grows a directory per combination and
 * the arithmetic ends the project.
 *
 * The second is that the *identity* generalises. `coming-soon` and `full` are
 * the only starters that ship, and a hypothetical third must be expressible -
 * registered, selected, described, planned - without a line of framework code
 * changing. That is proved below by building one that does not ship.
 *
 * So the sharp tests here are the invariance ones, not the positive ones. A
 * test asserting "coming-soon produces a home page" would pass just as happily
 * in a world full of `react-tailwind-mui-starter` directories.
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

const definition = (over: Partial<StarterDefinition> = {}): StarterDefinition => ({
  id: 'coming-soon',
  displayName: 'Name',
  description: 'description',
  guarantees: ['page.home'],
  ...over,
});

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

/** Two adapters claiming one role, which the composer must refuse. */
function collidingContributions(): readonly Contribution[] {
  const claim = (owner: string) => ({
    target: { kind: 'role', role: 'app.providers' } as const,
    intent: 'create' as const,
    payload: { kind: 'text', content: '' } as const,
    owner,
    order: 0,
    reason: 'test',
  });

  return [
    { ...blank('ui-library:mui'), files: [claim('ui-library:mui')] },
    { ...blank('router:react-router'), files: [claim('router:react-router')] },
  ];
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('a starter is an identity, not a stack', () => {
  it('ships exactly the two that exist', () => {
    expect(STARTER_IDS).toEqual(['coming-soon', 'full']);
    expect(STARTERS.all().map((starter) => starter.id)).toEqual(['coming-soon', 'full']);
  });

  it('is not a feature, and no feature is a starter', () => {
    // The Stage 21 correction, stated where it will fail loudest. The starter
    // lived in `FEATURE_IDS` from Stage 1, which made seven separate places
    // filter it back out of lists it did not belong in.
    for (const id of FEATURE_IDS) {
      expect(id.startsWith(LEGACY_STARTER_PREFIX), `${id} is a starter in disguise`).toBe(false);
      expect(STARTERS.has(id), `${id} is registered as a starter`).toBe(false);
    }
    for (const starter of STARTERS.all()) {
      expect(FEATURE_IDS as readonly string[], `${starter.id} is a feature`).not.toContain(
        starter.id,
      );
    }
  });

  it('names an experience, never a technology', () => {
    // `react-tailwind-portfolio` is the failure mode. An id that contains a
    // framework, styling system, component library or router is a combination
    // wearing an identity's clothes.
    const technologies = [
      ...FRAMEWORK_IDS,
      ...BUILD_TOOL_IDS,
      ...STYLING_IDS,
      ...UI_LIBRARY_IDS,
      ...ROUTER_IDS,
      ...ARCHITECTURE_IDS,
    ].filter((id) => id !== 'none');

    for (const starter of STARTERS.all()) {
      for (const technology of technologies) {
        expect(starter.id, `${starter.id} names ${technology}`).not.toContain(technology);
      }
    }
  });

  it('carries only fields that do something', () => {
    for (const starter of STARTERS.all()) {
      expect(STARTER_IDS as readonly string[]).toContain(starter.id);
      expect(starter.displayName.length).toBeGreaterThan(0);
      expect(starter.description.length).toBeGreaterThan(0);
      expect(starter.guarantees.length).toBeGreaterThan(0);
      // No `layer`, no `root`, no `framework`, no `extends`. The first two were
      // real until Stage 21 and were the framework's business all along; the
      // last would be starter inheritance, which is out of scope and should be
      // decided on its own evidence rather than smuggled in as an unused field.
      expect(Object.keys(starter).sort()).toEqual([
        'description',
        'displayName',
        'guarantees',
        'id',
      ]);
    }
  });

  it('guarantees semantic roles, never concrete paths', () => {
    for (const starter of STARTERS.all()) {
      for (const role of starter.guarantees) {
        expect(FILE_ROLES as readonly string[]).toContain(role);
        // A role, not a path. `src/pages/index.astro` here would be Astro's
        // layout leaking into a contract two other frameworks answer to.
        expect(role).not.toMatch(/[/\\.](astro|tsx|jsx|ts|js|html)$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the registry validates what it is given', () => {
  it('refuses an empty registry', () => {
    expect(() => createStarterRegistry([])).toThrow(CliError);
  });

  it('refuses a starter with no id', () => {
    // An id is what the manifest carries and what a framework maps to a
    // directory. A blank one resolves to `modes/` - a real directory, wrong
    // for every starter - so it has to fail here rather than there.
    expect(() => createStarterRegistry([definition({ id: '' as StarterId })])).toThrow(/empty id/);
    expect(() => createStarterRegistry([definition({ id: '  ' as StarterId })])).toThrow(
      /empty id/,
    );
  });

  it('refuses two starters sharing an id', () => {
    expect(() => createStarterRegistry([definition(), definition()])).toThrow(/share the id/);
  });

  it('refuses a starter that guarantees nothing', () => {
    // The quiet failure this check exists for: it would select, plan and
    // generate perfectly, and produce a project with nothing in it.
    expect(() => createStarterRegistry([definition({ guarantees: [] })])).toThrow(
      /guarantees nothing/,
    );
  });

  it('refuses a guarantee that is not a role', () => {
    expect(() =>
      createStarterRegistry([definition({ guarantees: ['src/pages/index.astro' as FileRole] })]),
    ).toThrow(/unknown role/);
  });

  it('refuses a duplicated guarantee', () => {
    expect(() =>
      createStarterRegistry([definition({ guarantees: ['page.home', 'page.home'] })]),
    ).toThrow(/twice/);
  });

  it('refuses a starter with no name or no description', () => {
    expect(() => createStarterRegistry([definition({ displayName: '  ' })])).toThrow(
      /display name/,
    );
    expect(() => createStarterRegistry([definition({ description: '' })])).toThrow(/description/);
  });

  it('cannot be extended by a caller after construction', () => {
    const registry = createStarterRegistry([definition()]);
    const all = registry.all() as StarterDefinition[];
    expect(() => all.push(definition({ id: 'full' }))).toThrow();
    expect(registry.all()).toHaveLength(1);
  });

  it('refuses an unknown id by name, and says what exists', () => {
    expect(() => STARTERS.get('portfolio')).toThrow(/Unknown starter "portfolio"/);
    try {
      STARTERS.get('portfolio');
      expect.unreachable('should have refused');
    } catch (error) {
      const hint = (error as CliError).hint ?? '';
      for (const starter of STARTERS.all()) expect(hint).toContain(starter.id);
    }
  });

  it('never answers an unknown id with a real starter', () => {
    // The regression Stage 20 found and this stage must keep out. The
    // predecessor answered `coming-soon` for both an unknown id and an
    // ambiguous selection, which are two different mistakes and neither is a
    // coming-soon project.
    for (const wrong of ['portfolio', 'marketing', 'saas', 'FULL', 'full ', '']) {
      expect(() => STARTERS.get(wrong), wrong).toThrow(CliError);
    }
  });
});

// ---------------------------------------------------------------------------
// Selection, and the one mapping from --mode
// ---------------------------------------------------------------------------

describe('there is exactly one starter resolution path', () => {
  it('maps every mode to a starter', () => {
    for (const mode of TEMPLATE_MODES) {
      expect(STARTERS.has(starterFromMode(mode)), mode).toBe(true);
    }
  });

  it('maps the two modes to the two starters, distinctly', () => {
    expect(starterFromMode('coming-soon')).toBe('coming-soon');
    expect(starterFromMode('full')).toBe('full');
    expect(new Set(TEMPLATE_MODES.map(starterFromMode)).size).toBe(TEMPLATE_MODES.length);
  });

  it('is the only place a mode becomes a starter', () => {
    // Two functions used to make this mapping independently - one for the V1
    // bridge, one for the V2 resolver - which is two chances to disagree about
    // what `full` means. Both call this one now, and the sources say so.
    for (const file of ['src/domain/manifest.ts', 'src/context/dimensions.ts']) {
      const source = readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, `${file} maps mode itself`).not.toMatch(/mode === 'full'/);
      expect(code, `${file} does not use the shared mapping`).toContain('starterFromMode(');
    }
  });

  it('selects by id, with no list to search', () => {
    expect(selectStarter('full').id).toBe('full');
    expect(selectStarter('coming-soon').id).toBe('coming-soon');
  });

  it('cannot be handed two starters, because a manifest has one field', () => {
    // Stage 20 needed a runtime refusal here, because the starter travelled in
    // a list. It is a single field now, so "two starters were selected" stopped
    // being a case to handle and became unrepresentable.
    const manifest = reactManifest({ starter: 'full' });
    expect(typeof manifest.starter).toBe('string');
    expect(Array.isArray(manifest.starter)).toBe(false);
  });

  it('defaults to coming-soon, which is what V1 does', () => {
    expect(starterFromMode('coming-soon')).toBe('coming-soon');
    expect(reactManifest().starter).toBe('coming-soon');
  });
});

// ---------------------------------------------------------------------------
// Future extensibility, proved without shipping anything
// ---------------------------------------------------------------------------

/**
 * A starter that does not exist, and must not.
 *
 * The whole point of the generalisation: if this works end to end with no
 * framework code aware of it, then `portfolio`, `marketing`, `saas` and the
 * rest are a definition plus one id each - not a matrix of directories.
 */
const PORTFOLIO: StarterDefinition = {
  id: 'portfolio' as StarterId,
  displayName: 'Portfolio',
  description: 'a work-first home page - hypothetical, and not registered',
  guarantees: ['page.home'],
};

describe('a starter that does not ship yet needs no framework code', () => {
  const extended = createStarterRegistry([...STARTERS.all(), PORTFOLIO]);

  it('validates', () => {
    expect(extended.has('portfolio')).toBe(true);
    expect(extended.all()).toHaveLength(STARTERS.all().length + 1);
  });

  it('selects', () => {
    expect(selectStarter('portfolio' as StarterId, extended)).toEqual(PORTFOLIO);
  });

  it('carries its metadata', () => {
    const starter = extended.get('portfolio');
    expect(starter.displayName).toBe('Portfolio');
    expect(starter.description.length).toBeGreaterThan(0);
    expect(starter.guarantees).toEqual(['page.home']);
  });

  it('plans its layers, with no case for it anywhere', () => {
    const layers = planStarterLayers({
      starter: extended.get('portfolio'),
      owner: 'framework:astro',
      roots: { base: '/templates/base', starter: '/templates/modes/portfolio' },
      baseReason: 'the shared project',
    });
    expect(layers.map((layer) => layer.name)).toEqual(['base', 'modes/portfolio']);
    expect(layers[1]!.reason).toContain('portfolio');
    expect(layers[1]!.root).toBe('/templates/modes/portfolio');
  });

  it('is planned by exactly the same code path as a shipped starter', () => {
    // Structural rather than behavioural, and deliberately so: the claim is
    // that nothing branches, and the way to show it is that the two produce
    // identical shapes from identical input.
    const shape = (starter: StarterDefinition) =>
      planStarterLayers({
        starter,
        owner: 'framework:astro',
        roots: { base: 'b', starter: 's' },
        baseReason: 'reason',
      }).map((layer) => ({ order: layer.order, owner: layer.owner, root: layer.root }));

    expect(shape(PORTFOLIO)).toEqual(shape(STARTERS.get('full')));
  });

  it('is not registered as a production option', () => {
    // The stage adds extensibility, not a product feature.
    expect(STARTERS.has('portfolio')).toBe(false);
    expect(STARTER_IDS as readonly string[]).not.toContain('portfolio');
    expect(() => STARTERS.get('portfolio')).toThrow(CliError);
  });

  it('would still need a framework to write its content', () => {
    // Honest limit, stated as a test rather than as prose: the contract can
    // describe and plan a starter whose content nobody has written. What it
    // cannot do is invent that content, and the framework still owns it.
    expect(extended.get('portfolio').guarantees).toEqual(['page.home']);
    expect(readdirSync(path.join(ASTRO_TEMPLATE, 'modes'))).not.toContain('portfolio');
  });
});

// ---------------------------------------------------------------------------
// The contract is data, not a framework
// ---------------------------------------------------------------------------

describe('the starter contract is data, not a framework', () => {
  it('plans layers for a framework that does not exist', () => {
    const layers = planStarterLayers({
      starter: STARTERS.get('full'),
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
    const layers = planStarterLayers({
      starter: STARTERS.get('coming-soon'),
      owner: 'framework:fictional',
      roots: { base: 'a', starter: 'b' },
      baseReason: 'why',
    });
    expect(layers.map((layer) => layer.root)).toEqual(['a', 'b']);
  });

  it('gives every layer an owner and a reason', () => {
    for (const starter of STARTERS.all()) {
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
    const layers = planStarterLayers({
      starter: STARTERS.get('full'),
      owner: 'framework:fictional',
      roots: { base: 'a', starter: 'b' },
      baseReason: 'the shared part',
    });
    expect(layers[0]!.order).toBeLessThan(layers[1]!.order);
    expect(layers.map((layer) => layer.name)).toEqual(['base', 'modes/full']);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('starter selection and planning are deterministic', () => {
  it('selects the same definition twice', () => {
    for (const id of STARTER_IDS) {
      expect(selectStarter(id)).toEqual(selectStarter(id));
      expect(JSON.stringify(selectStarter(id))).toBe(JSON.stringify(selectStarter(id)));
    }
  });

  it('returns an identical plan for identical input', () => {
    const input = {
      starter: STARTERS.get('full'),
      owner: 'framework:fictional',
      roots: { base: 'a', starter: 'b' },
      baseReason: 'the shared part',
    };
    expect(planStarterLayers(input)).toEqual(planStarterLayers(input));
    // Field order too: the plan is rendered, diffed and snapshotted.
    expect(JSON.stringify(planStarterLayers(input))).toBe(JSON.stringify(planStarterLayers(input)));
  });

  it('enumerates in a stable order', () => {
    expect(STARTERS.all()).toEqual(STARTERS.all());
    expect(STARTERS.all().map((starter) => starter.id)).toEqual([...STARTER_IDS]);
  });

  it('produces the same layers through the adapter twice', () => {
    for (const manifest of [reactManifest(), astroManifest({ starter: 'full' })]) {
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
    const featureIds = adapters.implementedFeatures() as readonly FeatureId[];
    expect(featureIds.length).toBeGreaterThan(0);

    for (const [label, build, expected] of [
      ['astro', astroManifest, starterLayersOf(astroManifest())],
      ['react', reactManifest, starterLayersOf(reactManifest())],
    ] as const) {
      for (const feature of featureIds) {
        let layers: readonly TemplateLayerContribution[] | null = null;
        try {
          layers = starterLayersOf(build({ features: [feature] }));
        } catch (error) {
          expect(error, `${label} + ${feature}`).toBeInstanceOf(CliError);
        }
        if (layers !== null) expect(layers, `${label} + ${feature}`).toEqual(expected);
      }
    }
  });

  it('varies with the starter and with nothing else', () => {
    for (const [, over] of REACT_STACKS) {
      const comingSoon = starterLayersOf(reactManifest({ ...over, starter: 'coming-soon' }));
      const full = starterLayersOf(reactManifest({ ...over, starter: 'full' }));
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

  it('consults no adapter registry, no planner and no CLI parser', () => {
    // A contract that could ask an adapter a question would end up asking which
    // framework it was, and the branch would follow within the week.
    expect(STARTER_CODE).not.toContain('adapters/');
    expect(STARTER_CODE).not.toContain('generate/');
    expect(STARTER_CODE).not.toContain('context/');
    expect(STARTER_CODE).not.toMatch(/\bcreateAdapterRegistry\b/);
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

  it('names no feature', () => {
    for (const id of FEATURE_IDS) {
      expect(STARTER_CODE.includes(`'${id}'`), `mentions ${id}`).toBe(false);
    }
  });

  it('never sees a manifest, so no other dimension is even reachable', () => {
    expect(STARTER_CODE).not.toContain('ProjectManifest');
    expect(STARTER_CODE).not.toContain('ResolvedProject');
  });

  it('no framework adapter branches on which starter was selected', () => {
    /*
     * The claim the whole stage rests on: a starter that does not exist yet
     * needs no framework code. A framework cannot prove that by generating one
     * - it has no content for it - so the guard is that nothing in composition
     * compares against a starter id.
     *
     * `supportedModes` in React's template manifest is a declaration of what
     * the V1 template registry offers, not a branch, which is why this looks
     * for comparisons rather than for the strings.
     */
    for (const file of ['astro.ts', 'react.ts']) {
      const code = readFileSync(
        path.resolve(import.meta.dirname, '..', 'src', 'adapters', file),
        'utf8',
      )
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      for (const pattern of [
        /\.starter\s*[=!]==/,
        /starter\.id\s*[=!]==/,
        /[=!]==\s*['"`](coming-soon|full)['"`]/,
        /switch\s*\(\s*(project\.manifest\.starter|starter\.id)\s*\)/,
      ]) {
        expect(code, `${file} branches on the starter: ${pattern}`).not.toMatch(pattern);
      }
    }
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
    const layers = starterLayersOf(reactManifest({ starter: 'full' }));
    expect(layers).toHaveLength(2);
    expect(new Set(layers.map((layer) => layer.owner)).size).toBe(1);
    expect(layers[0]!.order).toBeLessThan(layers[1]!.order);

    const composed = layersFrom([{ ...blank('framework:react'), templateLayers: layers }]);
    expect(composed.map((layer) => layer.name)).toEqual(['base', 'modes/full']);
  });

  it('two owners claiming one file is a collision, not a race', () => {
    const { project } = resolveProject(reactManifest(), adapters);
    const contributions = collidingContributions();
    expect(() => contributedFiles(project, contributions, () => '')).toThrow(CliError);
    expect(() => contributedFiles(project, contributions, () => '')).toThrow(/both claim/);
  });

  it('reports the same collision whichever order the adapters were iterated in', () => {
    const { project } = resolveProject(reactManifest(), adapters);
    const contributions = collidingContributions();

    const messageFor = (list: readonly Contribution[]): string => {
      try {
        contributedFiles(project, list, () => '');
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
      reactManifest({ starter: 'full' }),
      astroManifest(),
      astroManifest({ starter: 'full' }),
    ]) {
      const { project } = resolveProject(manifest, adapters);
      for (const role of selectStarter(manifest.starter).guarantees) {
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
        for (const starter of STARTERS.all()) {
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
      const required = project.requiredRoles.map((role: FileRole) =>
        resolveRole(project.architecture, role),
      );
      expect(() => assertRequiredRoles(project, operationsFor(required))).not.toThrow();
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
});

// ---------------------------------------------------------------------------
// No combination explosion
// ---------------------------------------------------------------------------

describe('the number of starters is independent of every other dimension', () => {
  const directoriesUnder = (root: string): readonly string[] =>
    readdirSync(root).filter((entry) => statSync(path.join(root, entry)).isDirectory());

  it('is a model invariant, not a filesystem count', () => {
    // The arithmetic this stage exists to prevent, stated against the model.
    // Every dimension below could double and `STARTERS` would not gain an
    // entry, because nothing in a definition refers to any of them.
    const stacks =
      FRAMEWORK_IDS.length *
      BUILD_TOOL_IDS.length *
      STYLING_IDS.length *
      UI_LIBRARY_IDS.length *
      ROUTER_IDS.length *
      ARCHITECTURE_IDS.length;
    expect(stacks).toBeGreaterThan(1000);
    expect(STARTERS.all()).toHaveLength(2);

    const serialised = JSON.stringify(STARTERS.all());
    for (const id of [
      ...FRAMEWORK_IDS,
      ...BUILD_TOOL_IDS,
      ...STYLING_IDS,
      ...UI_LIBRARY_IDS,
      ...ROUTER_IDS,
      ...ARCHITECTURE_IDS,
      ...FEATURE_IDS,
    ].filter((id) => id !== 'none')) {
      expect(serialised, `a definition mentions ${id}`).not.toContain(id);
    }
  });

  it('a new dimension option would add no starter definition', () => {
    // Stated by construction: adding one to the registry is what it takes to
    // gain a starter, and no styling system, component library or router can.
    const extended = createStarterRegistry([...STARTERS.all()]);
    expect(extended.all()).toHaveLength(STARTERS.all().length);
  });

  it('template directories are organised by dimension, one per option', () => {
    // `templates/styling/tailwind`, not `templates/react-tailwind-starter`.
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
        STARTERS.all()
          .map((starter) => starter.id)
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
});
