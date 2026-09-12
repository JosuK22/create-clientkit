import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AdapterDeclaration, Capability } from '../src/domain/index.js';
import {
  compareNodeFloor,
  evaluateCombination,
  evaluateDeclaration,
  filterCandidates,
  formatReport,
  formatViolation,
  highestNodeFloor,
  indexCapabilities,
  mergeResolutions,
} from '../src/domain/index.js';
import { CliError } from '../src/errors.js';

/**
 * Tests for the compatibility engine.
 *
 * Deliberately written against hypothetical declarations rather than the real
 * adapters. With exactly one framework implemented, testing only Astro would
 * prove the engine works for Astro and nothing more - and the claim being made
 * is that it generalises. Fixtures are the only honest way to test that before
 * a second framework exists.
 *
 * None of these fixtures are production adapters. They exist here and nowhere
 * else.
 */

// ---------------------------------------------------------------------------
// Fixtures — hypothetical adapters, not implementations
// ---------------------------------------------------------------------------

const declaration = (
  over: Partial<AdapterDeclaration> & Pick<AdapterDeclaration, 'id' | 'kind'>,
): AdapterDeclaration => ({
  displayName: over.id,
  provides: [],
  requires: [],
  ...over,
});

/** A React-like framework. */
const reactish = declaration({
  id: 'reactish',
  kind: 'framework',
  displayName: 'Reactish',
  provides: ['react-runtime', 'jsx', 'vite-plugins'],
  minNode: '>=20.19',
});

/** An Angular-like framework: same shape, different capabilities. */
const angularish = declaration({
  id: 'angularish',
  kind: 'framework',
  displayName: 'Angularish',
  provides: ['angular-runtime', 'spa-routing', 'typescript'],
  minNode: '>=22.12.0',
});

/** A component library that genuinely needs React. */
const chakraish = declaration({
  id: 'chakraish',
  kind: 'ui-library',
  displayName: 'Chakraish',
  provides: ['css-in-js'],
  requires: [{ kind: 'requires', capability: 'react-runtime', because: 'it is built on React' }],
});

/** Needs two things at once. */
const demanding = declaration({
  id: 'demanding',
  kind: 'styling',
  displayName: 'Demanding',
  requires: [
    { kind: 'requires', capability: 'react-runtime', because: 'it ships React components' },
    { kind: 'requires', capability: 'postcss', because: 'it compiles through PostCSS' },
  ],
});

/** Happy with either of two things. */
const flexible = declaration({
  id: 'flexible',
  kind: 'styling',
  displayName: 'Flexible',
  requires: [
    {
      kind: 'requiresOneOf',
      capabilities: ['postcss', 'sass'],
      because: 'it needs a CSS preprocessor',
    },
  ],
});

/** Provides a capability and refuses to sit beside another provider of it. */
const exclusiveCss = declaration({
  id: 'exclusive-css',
  kind: 'styling',
  displayName: 'Exclusive CSS',
  provides: ['css-framework'],
  requires: [
    {
      kind: 'conflicts',
      capability: 'css-framework',
      because: 'two CSS frameworks fight over the cascade',
    },
  ],
});

const otherCss = declaration({
  id: 'other-css',
  kind: 'styling',
  displayName: 'Other CSS',
  provides: ['css-framework'],
});

describe('capability indexing', () => {
  it('records who provides what', () => {
    const index = indexCapabilities([reactish, chakraish]);
    expect(index.capabilities.has('react-runtime')).toBe(true);
    expect(index.providers.get('react-runtime')).toEqual(['framework:reactish']);
    expect(index.providers.get('css-in-js')).toEqual(['ui-library:chakraish']);
  });

  it('lists multiple providers deterministically', () => {
    const a = indexCapabilities([exclusiveCss, otherCss]);
    const b = indexCapabilities([otherCss, exclusiveCss]);
    expect(a.providers.get('css-framework')).toEqual([
      'styling:exclusive-css',
      'styling:other-css',
    ]);
    expect(a.providers.get('css-framework')).toEqual(b.providers.get('css-framework'));
  });
});

describe('requirements are enforced from capabilities alone', () => {
  it('accepts a consumer whose requirement is provided', () => {
    expect(evaluateCombination([reactish, chakraish]).compatible).toBe(true);
  });

  it('rejects the same consumer when nothing provides the capability', () => {
    const report = evaluateCombination([angularish, chakraish]);
    expect(report.compatible).toBe(false);
    expect(report.violations).toHaveLength(1);
    const violation = report.violations[0]!;
    expect(violation.kind).toBe('missing-capability');
    expect(violation.adapter).toBe('ui-library:chakraish');
    expect(violation.kind === 'missing-capability' && violation.missing).toEqual(['react-runtime']);
  });

  it('no fixture names another adapter — the property that makes this scale', () => {
    // If a declaration referenced an adapter id, adding a framework would mean
    // editing unrelated adapters and the design would be a matrix in disguise.
    const ids = new Set(
      [reactish, angularish, chakraish, demanding, flexible, exclusiveCss, otherCss].map(
        (entry) => entry.id,
      ),
    );
    for (const entry of [chakraish, demanding, flexible, exclusiveCss]) {
      const serialised = JSON.stringify(entry.requires);
      for (const id of ids) {
        expect(serialised.includes(id), `${entry.id} names ${id}`).toBe(false);
      }
    }
  });

  it('rejects when only some of several requirements are met', () => {
    // reactish provides react-runtime but not postcss.
    const report = evaluateCombination([reactish, demanding]);
    expect(report.compatible).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(
      report.violations[0]!.kind === 'missing-capability' && report.violations[0]!.missing,
    ).toEqual(['postcss']);
  });

  it('accepts once every requirement is met, from any provider', () => {
    const postcssProvider = declaration({
      id: 'postcss-provider',
      kind: 'build-tool',
      provides: ['postcss'],
    });
    expect(evaluateCombination([reactish, postcssProvider, demanding]).compatible).toBe(true);
  });

  it('satisfies requiresOneOf from either alternative', () => {
    const withPostcss = declaration({ id: 'p', kind: 'build-tool', provides: ['postcss'] });
    const withSass = declaration({ id: 's', kind: 'build-tool', provides: ['sass'] });
    expect(evaluateCombination([withPostcss, flexible]).compatible).toBe(true);
    expect(evaluateCombination([withSass, flexible]).compatible).toBe(true);
    expect(evaluateCombination([reactish, flexible]).compatible).toBe(false);
  });

  it('treats two providers of one capability as satisfying a single requirement', () => {
    const alsoReact = declaration({ id: 'also', kind: 'feature', provides: ['react-runtime'] });
    const report = evaluateCombination([reactish, alsoReact, chakraish]);
    expect(report.compatible).toBe(true);
    expect(report.index.providers.get('react-runtime')).toHaveLength(2);
  });
});

describe('conflicts', () => {
  it('an exclusive provider is happy alone', () => {
    // The subtle case: exclusiveCss both provides css-framework and conflicts
    // with it. Without excluding its own contribution it would reject itself.
    expect(evaluateCombination([exclusiveCss]).compatible).toBe(true);
  });

  it('rejects a second provider of the conflicting capability', () => {
    const report = evaluateCombination([exclusiveCss, otherCss]);
    expect(report.compatible).toBe(false);
    const violation = report.violations[0]!;
    expect(violation.kind).toBe('conflicting-capability');
    expect(violation.kind === 'conflicting-capability' && violation.providedBy).toEqual([
      'styling:other-css',
    ]);
  });
});

describe('capability chains resolve without an ordering', () => {
  it('A provides X, B requires X and provides Y, C requires Y', () => {
    const a = declaration({ id: 'a', kind: 'framework', provides: ['vite-plugins'] });
    const b = declaration({
      id: 'b',
      kind: 'styling',
      provides: ['postcss'],
      requires: [{ kind: 'requires', capability: 'vite-plugins', because: 'it is a build plugin' }],
    });
    const c = declaration({
      id: 'c',
      kind: 'ui-library',
      requires: [{ kind: 'requires', capability: 'postcss', because: 'it ships PostCSS sources' }],
    });
    expect(evaluateCombination([a, b, c]).compatible).toBe(true);
  });

  it('is order-independent', () => {
    const a = declaration({ id: 'a', kind: 'framework', provides: ['vite-plugins'] });
    const b = declaration({
      id: 'b',
      kind: 'styling',
      requires: [{ kind: 'requires', capability: 'vite-plugins', because: 'plugin' }],
    });
    // Reversed input must give the same verdict: the engine unions everything
    // before judging anything, so resolution order cannot change compatibility.
    expect(evaluateCombination([a, b]).compatible).toBe(evaluateCombination([b, a]).compatible);
    expect(evaluateCombination([angularish, chakraish]).violations).toEqual(
      evaluateCombination([chakraish, angularish]).violations,
    );
  });

  it('breaks the chain when the middle link is removed', () => {
    const a = declaration({ id: 'a', kind: 'framework', provides: ['vite-plugins'] });
    const c = declaration({
      id: 'c',
      kind: 'ui-library',
      requires: [{ kind: 'requires', capability: 'postcss', because: 'it ships PostCSS sources' }],
    });
    expect(evaluateCombination([a, c]).compatible).toBe(false);
  });
});

describe('filtering a dimension to its valid options', () => {
  it('narrows frameworks to those satisfying an already-chosen UI library', () => {
    // The architecture's headline example. Choosing Chakra removes Angular from
    // the framework list, and no rule anywhere mentions both.
    const result = filterCandidates(
      [
        { value: 'reactish', declaration: reactish },
        { value: 'angularish', declaration: angularish },
      ],
      [chakraish],
    );
    expect(result.eligible).toEqual(['reactish']);
    expect(result.rejected.map((entry) => entry.value)).toEqual(['angularish']);
    expect(result.rejected[0]!.violations[0]!.adapter).toBe('ui-library:chakraish');
  });

  it('leaves every option when nothing constrains it', () => {
    const result = filterCandidates(
      [
        { value: 'reactish', declaration: reactish },
        { value: 'angularish', declaration: angularish },
      ],
      [],
    );
    expect(result.eligible).toEqual(['reactish', 'angularish']);
    expect(result.rejected).toEqual([]);
  });

  it('rejects a candidate that would break something already selected', () => {
    // Not just "is the candidate satisfied" - the whole combination is judged.
    const result = filterCandidates([{ value: 'other', declaration: otherCss }], [exclusiveCss]);
    expect(result.eligible).toEqual([]);
    expect(result.rejected[0]!.violations[0]!.kind).toBe('conflicting-capability');
  });

  it('is deterministic', () => {
    const candidates = [
      { value: 'reactish', declaration: reactish },
      { value: 'angularish', declaration: angularish },
    ];
    expect(filterCandidates(candidates, [chakraish])).toEqual(
      filterCandidates(candidates, [chakraish]),
    );
  });
});

describe('adding a framework requires no edit to existing consumers', () => {
  it('a new provider is accepted and a non-provider still rejected, declarations untouched', () => {
    // The scalability claim, tested directly. A Vue-like framework arrives; the
    // Chakra-like declaration is not modified, and both verdicts stay correct.
    const vueish = declaration({
      id: 'vueish',
      kind: 'framework',
      displayName: 'Vueish',
      provides: ['vue-runtime' as Capability, 'vite-plugins'],
    });

    const before = JSON.stringify(chakraish);
    expect(evaluateCombination([vueish, chakraish]).compatible).toBe(false);
    expect(evaluateCombination([reactish, chakraish]).compatible).toBe(true);
    expect(JSON.stringify(chakraish)).toBe(before);

    // And a consumer written for the new runtime works immediately.
    const vueOnly = declaration({
      id: 'vue-ui',
      kind: 'ui-library',
      requires: [
        { kind: 'requires', capability: 'vue-runtime' as Capability, because: 'built on Vue' },
      ],
    });
    expect(evaluateCombination([vueish, vueOnly]).compatible).toBe(true);
    expect(evaluateCombination([reactish, vueOnly]).compatible).toBe(false);
  });
});

describe('diagnostics', () => {
  it('explains a missing capability in the constraint author’s own words', () => {
    const report = evaluateCombination([angularish, chakraish]);
    const text = formatReport(report);
    expect(text).toContain('Chakraish');
    expect(text).toContain('it is built on React');
    expect(text).toContain('react-runtime');
    // and says what the stack does offer, which is the actionable half
    expect(text).toContain('angular-runtime');
  });

  it('names the other provider in a conflict', () => {
    const report = evaluateCombination([exclusiveCss, otherCss]);
    expect(formatViolation(report.violations[0]!)).toContain('styling:other-css');
    expect(formatViolation(report.violations[0]!)).toContain('two CSS frameworks fight');
  });

  it('leaks no internal structure into user-facing text', () => {
    const text = formatReport(evaluateCombination([angularish, chakraish]));
    expect(text).not.toContain('{');
    expect(text).not.toContain('[object');
    expect(text).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  });

  it('says so plainly when everything fits', () => {
    expect(formatReport(evaluateCombination([reactish, chakraish]))).toBe('Compatible.');
  });
});

describe('resolution merging', () => {
  it('combines capabilities and extensions from several adapters', () => {
    const merged = mergeResolutions([
      {
        owner: 'framework:a',
        resolution: { extensions: { component: '.astro' }, minNode: '>=20.19' },
      },
      { owner: 'language:b', resolution: { extensions: { source: '.ts', config: '.mjs' } } },
    ]);
    expect(merged.extensions).toEqual({ source: '.ts', component: '.astro', config: '.mjs' });
    expect(merged.minNode).toBe('>=20.19');
  });

  it('refuses to silently pick a winner when adapters disagree', () => {
    // The case the prompt singles out: two adapters, two answers, no last-one-wins.
    expect(() =>
      mergeResolutions([
        { owner: 'framework:a', resolution: { extensions: { component: '.astro' } } },
        { owner: 'framework:b', resolution: { extensions: { component: '.tsx' } } },
      ]),
    ).toThrow(CliError);

    try {
      mergeResolutions([
        { owner: 'framework:a', resolution: { extensions: { component: '.astro' } } },
        { owner: 'framework:b', resolution: { extensions: { component: '.tsx' } } },
      ]);
    } catch (error) {
      const cli = error as CliError & { hint?: string };
      const text = `${cli.message} ${cli.hint ?? ''}`;
      expect(text).toContain('framework:a');
      expect(text).toContain('framework:b');
      expect(text).toContain('.astro');
      expect(text).toContain('.tsx');
    }
  });

  it('accepts agreement on the same value', () => {
    expect(() =>
      mergeResolutions([
        { owner: 'a', resolution: { extensions: { source: '.ts' } } },
        { owner: 'b', resolution: { extensions: { source: '.ts' } } },
      ]),
    ).not.toThrow();
  });

  it('takes the highest Node floor numerically, not alphabetically', () => {
    // String sort would put >=9.0.0 above >=22.12.0. It does not here.
    expect(highestNodeFloor(['>=22.12.0', '>=9.0.0'])).toBe('>=22.12.0');
    expect(compareNodeFloor('>=22.12.0', '>=9.0.0')).toBeGreaterThan(0);
    expect(compareNodeFloor('>=20.19', '>=22.12.0')).toBeLessThan(0);
    expect(compareNodeFloor('>=20.19', '>=20.19')).toBe(0);
    expect(highestNodeFloor([])).toBeUndefined();
  });
});

describe('the engine stays pure', () => {
  it('does not mutate the declarations it is given', () => {
    const before = JSON.stringify([reactish, chakraish]);
    evaluateCombination([reactish, chakraish]);
    evaluateDeclaration(chakraish, indexCapabilities([reactish]));
    filterCandidates([{ value: 'x', declaration: reactish }], [chakraish]);
    expect(JSON.stringify([reactish, chakraish])).toBe(before);
  });

  it('compatibility and resolution code import no filesystem or process API', () => {
    const dir = path.resolve(import.meta.dirname, '..', 'src', 'domain');
    for (const file of ['compatibility.ts', 'resolution.ts']) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const module of [
        'node:fs',
        'node:child_process',
        'node:process',
        'node:os',
        'node:path',
      ]) {
        expect(source.includes(`'${module}'`), `${file} imports ${module}`).toBe(false);
      }
    }
    // and the whole domain layer still holds the line
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      expect(source.includes("'node:fs'"), `${file} imports node:fs`).toBe(false);
    }
  });
});
