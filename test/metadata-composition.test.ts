import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject } from '../src/adapters/selection.js';
import type { Capability } from '../src/domain/capabilities.js';
import { CAPABILITY_CONTRACTS, surfacesOf } from '../src/domain/capability-contract.js';
import type { FeatureId } from '../src/domain/dimensions.js';
import type { ProjectManifest } from '../src/domain/manifest.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';

/**
 * What `composed-metadata` actually does, pinned.
 *
 * Stage 29 asked whether Next could truthfully provide this capability, and
 * found the question rested on a false premise. The capability is named for a
 * composition mechanism that does not exist: a metadata feature contributes a
 * claim, the planner collects it and refuses two that disagree, and then
 * nothing turns a claim into file content - on any framework, Astro included.
 *
 * That was invisible because nothing asserted it. Stage 22 reasoned from
 * "`--features seo` on Next produced a byte-identical project" to "Next lacks
 * this capability" without noticing the same sentence is true of Astro; the
 * conclusion was right and the stated reason was not. These tests exist so the
 * next reader inherits the measurement rather than the story.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const v1Registry = createRegistry(TEMPLATES_ROOT);

const METADATA_FEATURES = ['seo', 'structured-data', 'accessibility'] as const;

const base = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  ({
    targetDir: path.join(path.parse(process.cwd()).root, 'ck-test', 'site'),
    projectName: 'site',
    framework: 'astro',
    buildTool: 'astro',
    language: 'ts',
    styling: 'tailwind',
    uiLibrary: 'none',
    router: 'file-based',
    architecture: 'astro-standard',
    starter: 'coming-soon',
    features: [],
    site: {
      name: 'Acme Ltd',
      url: 'https://acme.example',
      description: 'Bespoke widgets for discerning clients.',
      locale: 'en-GB',
      author: null,
    },
    packageManager: 'npm',
    git: true,
    install: true,
    ...over,
  }) as ProjectManifest;

const nextManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  base({
    framework: 'nextjs',
    buildTool: 'next',
    architecture: 'next-app',
    styling: 'none',
    ...over,
  });

const planOf = (manifest: ProjectManifest) =>
  planManifest(manifest, {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: manifest.starter,
    ...(manifest.framework === 'astro' ? { templateId: 'astro-tailwind' } : {}),
  });

/** Every written path mapped to its content, so two plans can be compared. */
const filesOf = (manifest: ProjectManifest): Map<string, string> => {
  const map = new Map<string, string>();
  for (const operation of planOf(manifest).plan.operations) {
    // `.client-site.json` records which features were selected, so it is the
    // one file that legitimately differs and the one this comparison excludes.
    if (operation.path === '.client-site.json') continue;
    map.set(operation.path, 'content' in operation ? (operation.content as string) : '(copy)');
  }
  return map;
};

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

describe('metadata features compose into no file', () => {
  it('Astro generates the same project with and without all three', () => {
    /*
     * The measurement the capability's old definition contradicted. If a later
     * stage builds a real composition mechanism this test is the one that
     * should fail first, and its failure is good news - but it must be a
     * decision somebody made, not a drift nobody noticed.
     */
    const without = filesOf(base());
    const withAll = filesOf(base({ features: [...METADATA_FEATURES] as FeatureId[] }));

    expect([...withAll.keys()].sort()).toEqual([...without.keys()].sort());
    for (const [file, content] of withAll) {
      expect(without.get(file), `${file} differs`).toBe(content);
    }
  });

  it('holds for each feature on its own', () => {
    const without = filesOf(base());
    for (const feature of METADATA_FEATURES) {
      const withOne = filesOf(base({ features: [feature] as FeatureId[] }));
      expect([...withOne.keys()].sort(), feature).toEqual([...without.keys()].sort());
      for (const [file, content] of withOne) {
        expect(without.get(file), `${feature} changed ${file}`).toBe(content);
      }
    }
  });

  it('no adapter contributes a file at the metadata surface', () => {
    /*
     * The structural reason for the measurement above. `app.layout` is where
     * every metadata claim is addressed, and nothing writes a file there - so
     * there is no content for a claim to end up in, whoever composes it.
     */
    const manifest = base({ features: [...METADATA_FEATURES] as FeatureId[] });
    const { project, selection } = resolveProject(manifest, adapters);
    const files = selection.adapters.flatMap(({ adapter }) => adapter.contribute(project).files);
    expect(
      files.filter((file) => file.target.kind === 'role' && file.target.role === 'app.layout'),
    ).toEqual([]);
  });

  it('the three features contribute claims and nothing else', () => {
    const manifest = base({ features: [...METADATA_FEATURES] as FeatureId[] });
    const { project } = resolveProject(manifest, adapters);

    for (const id of METADATA_FEATURES) {
      const contribution = adapters.feature(id).contribute(project);
      expect(contribution.files, id).toEqual([]);
      expect(contribution.dependencies, id).toEqual([]);
      expect(contribution.scripts, id).toEqual([]);
      expect(contribution.templateLayers, id).toEqual([]);
      // One config claim, addressed at the shared shell role.
      expect(contribution.config, id).toHaveLength(1);
      expect(contribution.config[0]?.target, id).toBe('app.layout');
    }
  });
});

// ---------------------------------------------------------------------------
// What the mechanism does deliver
// ---------------------------------------------------------------------------

describe('the claims are collected and arbitrated, which is the real value', () => {
  it('records every claim on the plan, by owner', () => {
    const planned = planOf(base({ features: [...METADATA_FEATURES] as FeatureId[] }));
    expect(planned.metadata.map((claim) => claim.owner)).toEqual(['feature:seo']);
    expect(planned.structuredData.map((claim) => claim.owner)).toEqual(['feature:structured-data']);
    expect(planned.accessibility.map((claim) => claim.owner)).toEqual(['feature:accessibility']);
  });

  it('puts each feature on its own slot, so three describe one shell without colliding', () => {
    const manifest = base({ features: [...METADATA_FEATURES] as FeatureId[] });
    const { project, selection } = resolveProject(manifest, adapters);
    const slots = selection.adapters
      .flatMap(({ adapter }) => adapter.contribute(project).config)
      .filter((entry) => entry.target === 'app.layout')
      .map((entry) => entry.at)
      .sort();
    expect(slots).toEqual(['accessibility', 'metadata', 'structured-data']);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('is deterministic across feature order and repeated runs', () => {
    const orders: FeatureId[][] = [
      ['seo', 'structured-data', 'accessibility'],
      ['accessibility', 'seo', 'structured-data'],
      ['structured-data', 'accessibility', 'seo'],
    ] as FeatureId[][];

    const rendered = orders.map((features) => {
      const planned = planOf(base({ features }));
      return JSON.stringify({
        metadata: planned.metadata,
        structuredData: planned.structuredData,
        accessibility: planned.accessibility,
        files: [...filesOf(base({ features }))].sort(),
      });
    });
    expect(new Set(rendered).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Coverage, which is what the capability truthfully distinguishes
// ---------------------------------------------------------------------------

describe('what each shipped shell actually states', () => {
  const layoutOf = (manifest: ProjectManifest, file: string): string =>
    filesOf(manifest).get(file) ?? '(missing)';

  /**
   * Comments stripped, because Next's layout explains its own absences.
   *
   * Its doc comment says "There is no canonical URL, no Open Graph block and no
   * social card" - which is the file being honest, and would fail a naive scan
   * for the word `canonical`. What is being measured is what the head *states*,
   * so the prose has to go before counting.
   */
  const codeOf = (manifest: ProjectManifest, file: string): string =>
    layoutOf(manifest, file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('Next states a title, a description and a language, and no more', () => {
    /*
     * The honest gap, measured rather than asserted. Next's head is real and
     * server-rendered - that is `document-metadata`, which Next does provide.
     * What is absent is the rest of the contract the features describe.
     */
    const layout = codeOf(nextManifest(), 'app/layout.tsx');
    expect(layout).toContain('export const metadata');
    expect(layout).toContain('title: SITE.name');
    expect(layout).toContain('description: SITE.description');
    expect(layout).toContain('lang={SITE.locale');

    for (const absent of ['canonical', 'openGraph', 'twitter', 'robots', 'application/ld+json']) {
      expect(layout, `Next's layout unexpectedly states ${absent}`).not.toContain(absent);
    }
  });

  it('Astro states the whole contract, from its own template', () => {
    // Shipped unconditionally and driven by site.config.ts - which is why
    // selecting the features changes nothing, and why the coverage is there.
    const seo = layoutOf(base(), 'src/components/Seo.astro');
    for (const tag of ['canonical', 'og:title', 'og:description', 'twitter:card', 'robots']) {
      expect(seo, `Astro's head does not state ${tag}`).toContain(tag);
    }
  });
});

// ---------------------------------------------------------------------------
// The boundary, unchanged
// ---------------------------------------------------------------------------

describe('Next remains without the capability', () => {
  it('does not declare it', () => {
    expect(adapters.framework('nextjs').declaration.provides).not.toContain('composed-metadata');
  });

  it('refuses all three features, naming the capability', () => {
    for (const feature of METADATA_FEATURES) {
      const report = checkCompatibility(
        nextManifest({ features: [feature] as FeatureId[] }),
        adapters,
      );
      expect(report.compatible, feature).toBe(false);
      expect(JSON.stringify(report.violations), feature).toContain('composed-metadata');
    }
  });

  it('refuses every combination of them', () => {
    const combinations: FeatureId[][] = [
      ['seo', 'structured-data'],
      ['seo', 'accessibility'],
      ['structured-data', 'accessibility'],
      ['seo', 'structured-data', 'accessibility'],
    ] as FeatureId[][];

    for (const features of combinations) {
      const label = features.join('+');
      const report = checkCompatibility(nextManifest({ features }), adapters);
      expect(report.compatible, label).toBe(false);
      expect(JSON.stringify(report.violations), label).toContain('composed-metadata');
    }
  });

  it('writes nothing when refused', () => {
    for (const feature of METADATA_FEATURES) {
      let planned = false;
      try {
        planOf(nextManifest({ features: [feature] as FeatureId[] }));
        planned = true;
      } catch {
        // expected
      }
      expect(planned, `${feature} produced a plan`).toBe(false);
    }
  });

  it('keeps the other Next boundaries where they were', () => {
    const cases: readonly (readonly [string, ProjectManifest, string])[] = [
      ['react-router', nextManifest({ router: 'react-router' }), 'file-based-routing'],
      [
        'client-route-fallback',
        nextManifest({ features: ['client-route-fallback'] as FeatureId[] }),
        'client-side-routing',
      ],
    ];
    for (const [label, manifest, because] of cases) {
      const report = checkCompatibility(manifest, adapters);
      expect(report.compatible, label).toBe(false);
      expect(JSON.stringify(report.violations), label).toContain(because);
    }
    // not-found is refused by the architecture rather than a capability.
    let message = '';
    try {
      resolveProject(nextManifest({ features: ['not-found'] as FeatureId[] }), adapters);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('page.notFound');
  });
});

describe('Astro keeps every metadata combination it had', () => {
  const combinations: FeatureId[][] = [
    ['seo'],
    ['structured-data'],
    ['accessibility'],
    ['seo', 'structured-data'],
    ['seo', 'accessibility'],
    ['structured-data', 'accessibility'],
    ['seo', 'structured-data', 'accessibility'],
  ] as FeatureId[][];

  for (const features of combinations) {
    it(`astro + ${features.join(' + ')} still resolves and plans`, () => {
      const manifest = base({ features });
      expect(checkCompatibility(manifest, adapters).compatible).toBe(true);
      expect(() => planOf(manifest)).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// The Stage 28 contract, untouched
// ---------------------------------------------------------------------------

describe('the capability contract still holds', () => {
  it('keeps composed-metadata a data surface at app.layout', () => {
    expect(CAPABILITY_CONTRACTS['composed-metadata'].category).toBe('composition');
    expect(surfacesOf('composed-metadata')).toEqual([{ role: 'app.layout', via: 'data' }]);
  });

  it('is not granted by Next mapping the layout', () => {
    // The Stage 28 point, restated here because Stage 29 is exactly the case
    // that tempts someone to read the structural check as sufficient.
    const next = adapters.framework('nextjs');
    expect(next.architectureDefinitions[0]?.roles['app.layout']).toBeDefined();
    expect(next.templateOwnedRoles ?? []).not.toContain('app.layout');
    expect(next.declaration.provides).not.toContain('composed-metadata');
  });

  it('is declared by the architecture, never by a feature', () => {
    for (const id of METADATA_FEATURES) {
      const declaration = adapters.feature(id).declaration;
      expect(declaration.provides, id).toEqual([]);
      expect(JSON.stringify(declaration.requires), id).toContain('composed-metadata');
    }
    expect(adapters.framework('astro').declaration.provides).toContain(
      'composed-metadata' satisfies Capability,
    );
  });

  it('keeps the features free of any framework name', () => {
    for (const id of METADATA_FEATURES) {
      const declaration = JSON.stringify(adapters.feature(id).declaration);
      for (const name of ['nextjs', 'astro', 'react']) {
        expect(declaration, `${id} names ${name}`).not.toContain(name);
      }
    }
  });
});
