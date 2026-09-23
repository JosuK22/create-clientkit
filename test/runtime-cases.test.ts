import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAdapterRegistry } from '../src/adapters/registry.js';
import { findTemplatesRoot } from '../src/templates/registry.js';
import { enumerateCombinations } from './accepted-combinations.js';
import { runtimeMatrix, type Contract } from './runtime-cases.js';

/**
 * The runtime matrix's selection, checked without serving anything.
 *
 * Running the matrix takes half an hour and a browser. What can be checked in
 * milliseconds - and therefore on every push - is the part that decides whether
 * that half hour is worth anything: that the reduction from 104 configurations
 * to a handful still touches every runtime dimension the product supports, and
 * that no case claims a contract its own stack does not have.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const matrix = runtimeMatrix(adapters);
const accepted = enumerateCombinations(adapters).accepted;

describe('the runtime matrix covers what the product supports', () => {
  it('leaves no required tuple uncovered', () => {
    const missing = matrix.required.filter((tuple) => !matrix.covered.includes(tuple));
    expect(missing).toEqual([]);
  });

  it('touches every framework, starter, styling, UI library and router that is accepted', () => {
    for (const entry of accepted) {
      for (const [dimension, value] of [
        ['starter', entry.starter],
        ['styling', entry.styling],
        ['uiLibrary', entry.uiLibrary],
        ['router', entry.router],
      ] as const) {
        expect(matrix.covered, `${entry.framework} ${dimension}=${value}`).toContain(
          `${entry.framework}:${dimension}=${value}`,
        );
      }
    }
  });

  it('serves every feature at least once in every architecture that accepts it', () => {
    for (const entry of accepted) {
      for (const feature of entry.features) {
        expect(matrix.covered, `${entry.framework} ${feature}`).toContain(
          `${entry.framework}:feature=${feature}`,
        );
      }
    }
  });

  it('serves every feature alone at least once, so a contract is attributable', () => {
    const singles = new Set(
      accepted
        .filter((entry) => entry.features.length === 1)
        .map((entry) => `${entry.framework}:only-feature=${entry.features[0]}`),
    );
    for (const tuple of singles) expect(matrix.covered).toContain(tuple);
  });

  it('serves each framework with and without a configured URL', () => {
    for (const framework of [...new Set(accepted.map((entry) => entry.framework))]) {
      expect(
        matrix.cases.some(
          (entry) => entry.combination.framework === framework && entry.url === 'configured',
        ),
      ).toBe(true);
      expect(
        matrix.cases.some(
          (entry) => entry.combination.framework === framework && entry.url === 'url-less',
        ),
      ).toBe(true);
    }
  });
});

describe('no case claims a contract its stack does not have', () => {
  const requires: Record<Contract, (entry: (typeof matrix.cases)[number]) => boolean> = {
    'home-200': () => true,
    'no-runtime-errors': () => true,
    'not-found-404': (entry) => entry.combination.router === 'file-based',
    'added-route-200': (entry) => entry.addedRoutes.length > 0,
    'canonical-present': (entry) =>
      entry.combination.features.includes('seo') && entry.url === 'configured',
    'canonical-added-route': (entry) =>
      entry.combination.features.includes('seo') && entry.addedRoutes.length > 0,
    'canonical-absent-on-404': (entry) =>
      entry.combination.features.includes('seo') && entry.combination.router === 'file-based',
    'canonical-absent-url-less': (entry) =>
      entry.combination.features.includes('seo') && entry.url === 'url-less',
    'json-ld-present': (entry) => entry.combination.features.includes('structured-data'),
    'json-ld-absent-on-404': (entry) => entry.combination.features.includes('structured-data'),
    'accessibility-structure': (entry) => entry.combination.features.includes('accessibility'),
    'stylesheet-loads': (entry) => entry.combination.styling !== 'none',
    'mui-renders': (entry) => entry.combination.uiLibrary === 'mui',
    'router-route-loads': (entry) => entry.combination.router === 'react-router',
    'client-fallback-200': (entry) => entry.combination.features.includes('client-route-fallback'),
  };

  it('derives each contract from the configuration', () => {
    for (const entry of matrix.cases) {
      for (const contract of entry.contracts) {
        expect(requires[contract](entry), `${entry.id} claims ${contract}`).toBe(true);
      }
    }
  });

  it('never expects a canonical from a framework that cannot realize one', () => {
    // React has no document realization; a canonical contract there would be a
    // test asserting something the architecture was never given.
    for (const entry of matrix.cases) {
      if (entry.combination.framework !== 'react') continue;
      expect(entry.contracts).not.toContain('canonical-present');
      expect(entry.contracts).not.toContain('canonical-added-route');
    }
  });

  it('never expects an HTTP 404 from a client-side router', () => {
    /*
     * The Stage 13 distinction, kept in the matrix itself: a client fallback is
     * a rendered view on a 200, and a case that demanded a 404 from it would be
     * encoding the confusion the feature exists to avoid.
     */
    for (const entry of matrix.cases) {
      if (!entry.contracts.includes('client-fallback-200')) continue;
      expect(entry.contracts).not.toContain('not-found-404');
    }
  });
});

describe('the selection is deterministic', () => {
  it('produces the same cases in the same order twice', () => {
    const again = runtimeMatrix(createAdapterRegistry(TEMPLATES_ROOT));
    expect(again.cases.map((entry) => entry.id)).toEqual(matrix.cases.map((entry) => entry.id));
  });

  it('gives every case a unique id', () => {
    const ids = matrix.cases.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the matrix small enough to serve and large enough to mean something', () => {
    expect(matrix.cases.length).toBeGreaterThanOrEqual(10);
    expect(matrix.cases.length).toBeLessThanOrEqual(30);
  });
});
