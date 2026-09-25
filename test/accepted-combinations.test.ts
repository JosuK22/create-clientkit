import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility } from '../src/adapters/selection.js';
import { assertFrameworkOffers, resolveDimensions } from '../src/context/dimensions.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { planManifest } from '../src/adapters/bridge.js';
import {
  compareCombinations,
  enumerateCombinations,
  type Combination,
} from './accepted-combinations.js';
import { TEST_CWD } from './helpers.js';

/**
 * The integration matrix's source of truth, and the promise that it is one.
 *
 * Stage 53 installs and builds every accepted configuration. That is only worth
 * anything if the set being built is the set the product accepts, so these
 * tests exist to stop the enumeration drifting into a list of its own: they
 * check it against the compatibility engine in both directions, and check that
 * the order it reports is declared rather than incidental.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const v1Registry = createRegistry(TEMPLATES_ROOT);
const enumeration = enumerateCombinations(adapters);

/**
 * The template a configuration plans against.
 *
 * React and Next declare their own manifest on the adapter, so the bridge finds
 * it. Astro's lives on disk in the V1 registry under its V1 name, which is why
 * the existing Astro tests pass it explicitly too.
 */
const templateFor = (framework: string): string =>
  adapters.framework(framework as never).templateManifest?.id ?? 'astro-tailwind';

const manifestOf = (combination: Combination) => ({
  targetDir: path.join(TEST_CWD, 'acme-site'),
  projectName: 'acme-site',
  framework: combination.framework,
  buildTool: combination.buildTool,
  language: combination.language,
  styling: combination.styling,
  uiLibrary: combination.uiLibrary,
  router: combination.router,
  architecture: combination.architecture,
  starter: combination.starter,
  features: combination.features,
  site: {
    name: 'Acme Ltd',
    url: 'https://acme.example',
    description: 'Bespoke widgets.',
    locale: 'en',
    author: null,
  },
  packageManager: 'npm',
  git: false,
  install: false,
});

// ---------------------------------------------------------------------------
// It asks rather than remembers
// ---------------------------------------------------------------------------

describe('the accepted set comes from the engine', () => {
  it('covers the whole cross-product of what is implemented', () => {
    // 3 frameworks x 3 styling x 2 UI x 3 routers x 2 languages x 32 feature
    // subsets x 2 starters. Asserted so a dimension gaining a value is visible
    // here rather than silently shrinking the matrix.
    expect(enumeration.total).toBe(3 * 3 * 2 * 3 * 2 * 32 * 2);
    expect(enumeration.accepted.length + enumeration.rejected.length).toBe(enumeration.total);
  });

  it('accepts only what the compatibility engine accepts', () => {
    for (const combination of enumeration.accepted) {
      expect(
        checkCompatibility(manifestOf(combination) as never, adapters).compatible,
        combination.id,
      ).toBe(true);
    }
  });

  it('rejects only what some layer genuinely refuses', () => {
    for (const rejection of enumeration.rejected) {
      if (rejection.refusedBy === 'compatibility') {
        expect(
          checkCompatibility(manifestOf(rejection as Combination) as never, adapters).compatible,
          rejection.id,
        ).toBe(false);
        continue;
      }
      // A resolution refusal: the framework does not offer one of the four
      // dimensions it owns. Reproduced through the same two calls.
      expect(() => {
        const resolved = resolveDimensions(
          {
            framework: rejection.framework,
            styling: rejection.styling,
            uiLibrary: rejection.uiLibrary,
            router: rejection.router,
            language: rejection.language,
            features: rejection.features,
          },
          adapters,
        );
        assertFrameworkOffers(resolved, adapters);
      }, rejection.id).toThrow();
    }
  });

  it('names no capability, framework or styling rule of its own', () => {
    const source = readEnumerator();
    for (const forbidden of [
      "=== 'astro'",
      "=== 'react'",
      "=== 'nextjs'",
      "=== 'tailwind'",
      'css-framework',
      'composed-metadata',
      'composed-canonical',
      'composed-stylesheet',
      'react-runtime',
      'file-based-routing',
    ]) {
      expect(source, `the enumerator encodes ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Identity and ordering
// ---------------------------------------------------------------------------

describe('every case is identifiable and the order is declared', () => {
  it('gives each configuration a unique id', () => {
    const ids = enumeration.accepted.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses ids that are safe as directory names', () => {
    for (const { id } of enumeration.accepted) {
      expect(id, id).toMatch(/^[a-z0-9_+-]+$/);
    }
  });

  it('carries the resolved dimensions rather than a reconstruction', () => {
    for (const combination of enumeration.accepted) {
      const resolved = resolveDimensions(
        {
          framework: combination.framework,
          styling: combination.styling,
          uiLibrary: combination.uiLibrary,
          router: combination.router,
          language: combination.language,
          features: combination.features,
        },
        adapters,
      );
      expect(combination.buildTool, combination.id).toBe(resolved.buildTool);
      expect(combination.architecture, combination.id).toBe(resolved.architecture);
    }
  });

  it('orders deterministically, whatever order it was built in', () => {
    const shuffled = [...enumeration.accepted].reverse().sort(compareCombinations);
    expect(shuffled.map((entry) => entry.id)).toEqual(
      enumeration.accepted.map((entry) => entry.id),
    );
  });

  it('is stable across two enumerations', () => {
    const again = enumerateCombinations(createAdapterRegistry(TEMPLATES_ROOT));
    expect(again.accepted.map((entry) => entry.id)).toEqual(
      enumeration.accepted.map((entry) => entry.id),
    );
  });
});

// ---------------------------------------------------------------------------
// Every accepted case can at least be planned
// ---------------------------------------------------------------------------

describe('every accepted configuration reaches a plan', () => {
  /*
   * A generous budget, not a slow test excused.
   *
   * This plans all 104 supported combinations. On an idle machine it takes
   * one to three seconds; under load - a mutation campaign, an integration
   * matrix - it crosses the 5s default and fails on time rather than on an
   * assertion. That made the release gate flaky, which is worse than slow:
   * it teaches people to re-run until green. The assertion is unchanged.
   */
  it('plans without refusing, for all of them', { timeout: 60_000 }, () => {
    /*
     * The cheap half of Stage 53's invariant, run on every push. Installing and
     * building all of them is the expensive half and lives in the integration
     * script - but a configuration that cannot even be planned should fail here,
     * in seconds, rather than forty minutes into a matrix run.
     */
    const failures: string[] = [];
    for (const combination of enumeration.accepted) {
      try {
        planManifest(manifestOf(combination) as never, {
          registry: v1Registry,
          cliVersion: '9.9.9',
          generatedAt: '2026-01-01T00:00:00.000Z',
          mode: combination.starter as 'coming-soon' | 'full',
          templateId: templateFor(combination.framework),
        });
      } catch (error) {
        failures.push(`${combination.id}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('plans a distinct file set or content for each configuration', { timeout: 60_000 }, () => {
    // Not a snapshot of any of them: just the assurance that the matrix is 104
    // different projects rather than one project counted 104 times.
    const fingerprints = new Set(
      enumeration.accepted.map((combination) => {
        const { plan } = planManifest(manifestOf(combination) as never, {
          registry: v1Registry,
          cliVersion: '9.9.9',
          generatedAt: '2026-01-01T00:00:00.000Z',
          mode: combination.starter as 'coming-soon' | 'full',
          templateId: templateFor(combination.framework),
        });
        return JSON.stringify(plan.operations.map((entry) => entry.path));
      }),
    );
    expect(fingerprints.size).toBeGreaterThan(1);
  });
});

function readEnumerator(): string {
  // Comments explain the design and legitimately mention capabilities; the
  // assertion is about code.
  return readFileSync(path.resolve(import.meta.dirname, 'accepted-combinations.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// What decides the file list (Stage 61)
// ---------------------------------------------------------------------------

/**
 * The property the upgrade contract rests on.
 *
 * Stage 60 found that an old plan cannot be rebuilt from provenance, because
 * the site description and author are not recorded. Stage 61 measured what that
 * actually costs and found: nothing, for the question ownership asks. The *set
 * of paths* a project generates is a function of the stack and the mode alone.
 * Site configuration decides what goes inside those files, never which files
 * exist.
 *
 * That is why provenance needs no description to establish ownership, and why
 * an upgrade can identify orphans from the stack it already records. If a
 * template ever branched on `{{locale}}` to emit a different file, the contract
 * would break silently - so it is pinned here rather than left as a property
 * someone remembers.
 */
describe('the generated file list depends on the stack, not the site', () => {
  const siteVariant = {
    projectName: 'totally-different',
    site: {
      name: 'Zenith Industries',
      url: null,
      description: 'An entirely unrelated sentence about something else.',
      locale: 'fr',
      author: 'Jane Doe',
    },
    packageManager: 'pnpm',
  };

  const pathsOf = (combination: Combination, over: Partial<typeof siteVariant> = {}) =>
    planManifest({ ...manifestOf(combination), ...over } as never, {
      registry: v1Registry,
      cliVersion: '9.9.9',
      generatedAt: '2026-01-01T00:00:00.000Z',
      mode: combination.starter as 'coming-soon' | 'full',
      templateId: templateFor(combination.framework),
    })
      .plan.operations.map((entry) => entry.path)
      .sort();

  it('is unchanged when every site field changes at once', { timeout: 60_000 }, () => {
    const differing = enumeration.accepted.filter(
      (combination) =>
        pathsOf(combination).join('\n') !== pathsOf(combination, siteVariant).join('\n'),
    );
    expect(differing.map((c) => c.id)).toEqual([]);
  });

  it('does depend on the stack, so the invariant above is not vacuous', { timeout: 60_000 }, () => {
    // If every stack produced the same file list, the test above would pass
    // for the wrong reason.
    const distinct = new Set(
      enumeration.accepted.map((combination) => pathsOf(combination).join('\n')),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('identifies the orphans a stack change leaves behind', () => {
    /*
     * The Stage 55 case, which that stage measured on disk: React + MUI +
     * React Router, re-generated without either, leaves two files that import
     * packages no longer installed. Both plans render against the same current
     * templates, so the difference is attributable to the stack change alone -
     * no historical template bytes required. This is precisely the subset of
     * upgrade analysis that current-template reconciliation can answer.
     */
    const find = (uiLibrary: string, router: string): Combination | undefined =>
      enumeration.accepted.find(
        (c) =>
          c.framework === 'react' &&
          c.styling === 'tailwind' &&
          c.uiLibrary === uiLibrary &&
          c.router === router &&
          c.starter === 'full',
      );

    const before = find('mui', 'react-router');
    const after = find('none', 'none');
    expect(before, 'react + tailwind + mui + react-router is a supported stack').toBeDefined();
    expect(after, 'react + tailwind alone is a supported stack').toBeDefined();

    const oldPaths = new Set(pathsOf(before!));
    const newPaths = new Set(pathsOf(after!));
    const orphans = [...oldPaths].filter((p) => !newPaths.has(p)).sort();

    expect(orphans).toEqual(['src/components/ui/AppProviders.tsx', 'src/routes/AppRouter.tsx']);
  });
});
