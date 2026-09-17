import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASTRO_DERIVATION_SUPPORT } from '../src/adapters/astro-derivations.js';
import type {
  DocumentContribution,
  DocumentScope,
  MetadataStatement,
} from '../src/domain/document-contribution.js';
import { EVERY_PAGE, onPage, stated, suppressed } from '../src/domain/document-contribution.js';
import type { DocumentTarget } from '../src/domain/document-scope.js';
import { forPage, resolveDocumentForPage, SITE_TARGET } from '../src/domain/document-scope.js';
import type { AnyDocumentValue, DocumentValue } from '../src/domain/document-value.js';
import {
  absolutePageUrl,
  assertDerivationInputs,
  bindingsUsedBy,
  boundTo,
  derivationParameters,
  derivationType,
  derived,
  DOCUMENT_DERIVATION_IDS,
  indexingDirective,
  literal,
  ownerOf,
  pageTitleWithSiteName,
} from '../src/domain/document-value.js';
import type { CliError } from '../src/errors.js';

/**
 * Parameterized derivations.
 *
 * Stage 36 named two document facts the vocabulary could not carry: a title
 * composed with the site's name, and a robots directive derived from the
 * project's indexing switch. Both vary per contributor, so a derivation with a
 * fixed pair of bindings could not express either.
 *
 * The answer is a *signature*, not an expression tree. A derivation declares an
 * ordered list of parameter types and a result type; a value supplies the
 * arguments. There is no concatenation node, no conditional, no operator - the
 * parts a general expression AST is made of are all absent, which is what keeps
 * this a vocabulary rather than a language.
 */

const source = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');

const codeOnly = (file: string): string =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const A = 'contributor:a';
const B = 'contributor:b';

const says = (
  owner: string,
  value: MetadataStatement,
  scope: DocumentScope = EVERY_PAGE,
): DocumentContribution => ({
  kind: 'metadata',
  owner,
  reason: `${owner} describes the page`,
  scope,
  metadata: stated(value),
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

const metaOn = (contributions: readonly DocumentContribution[], target: DocumentTarget) => {
  const document = resolveDocumentForPage(contributions, target);
  if (document.metadata?.state !== 'stated') throw new Error('expected stated metadata');
  return document.metadata.value;
};

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

describe('page-title-with-site-name', () => {
  it('composes a page title with the site name', () => {
    const value = pageTitleWithSiteName(literal('text', 'Page not found'));
    expect(value.kind).toBe('derived');
    if (value.kind !== 'derived') throw new Error('narrowing failed');
    expect(value.derivation).toBe('page-title-with-site-name');
    expect(value.inputs).toEqual([literal('text', 'Page not found'), boundTo('text', 'site.name')]);
  });

  it('makes no distinction between an absent and an empty page title', () => {
    /*
     * Verified against the template, not assumed. `Seo.astro` reads
     * `title ? … : SITE.name` - a truthiness test, so `undefined` and `''`
     * behave identically there. Modelling a distinction the source does not
     * make would be inventing behaviour, so an empty page title is simply the
     * way to say the page adds nothing.
     */
    const astro = source('templates/astro-tailwind/base/src/components/Seo.astro');
    expect(astro).toContain('title ? `${title} - ${SITE.name}` : SITE.name');

    const empty = pageTitleWithSiteName(literal('text', ''));
    expect(empty.kind).toBe('derived');
    if (empty.kind !== 'derived') throw new Error('narrowing failed');
    expect(empty.inputs[0]).toEqual(literal('text', ''));
  });

  it('keeps the site name live rather than freezing it', () => {
    // The whole point. A resolved title that had baked in "Acme Ltd" would
    // stop following the project's configuration, which is Stage 34's failure.
    const value = pageTitleWithSiteName(literal('text', 'Page not found'));
    expect(bindingsUsedBy(value)).toEqual(['site.name']);
    expect(JSON.stringify(value)).not.toContain('Acme Ltd');
  });

  it('is project-owned, because half of it still belongs to the project', () => {
    /*
     * Not `generation`, even though ClientKit knows the page title and seeds
     * the site name. The composed value is evaluated in the generated project
     * from a value the developer may change, so the project owns the result.
     */
    expect(ownerOf(pageTitleWithSiteName(literal('text', 'Page not found')))).toBe('project');
  });

  it('reports ownership through a nested derivation', () => {
    /*
     * Nesting is permitted - a derivation's arguments are values, so one may be
     * another derivation - and ownership has to see through it. Here the only
     * unsettled thing is buried two levels down: an inner title composed with
     * the build's generator name. A rule that looked at direct inputs alone
     * would call the whole value generation-owned and hand a later emitter
     * permission to freeze it.
     */
    const inner = derived(
      'page-title-with-site-name',
      literal('text', 'X'),
      boundTo('text', 'generator.name'),
    );
    expect(ownerOf(inner)).toBe('build-context');

    const outer = derived('page-title-with-site-name', inner, literal('text', 'Y'));
    expect(ownerOf(outer)).toBe('build-context');
    // and the binding underneath is still reported to an architecture
    expect(bindingsUsedBy(outer)).toEqual(['generator.name']);
  });

  it('is generation-owned only when every input is', () => {
    // A title composed from two literals settles at generation time, and the
    // rule reports that rather than assuming a derivation is always dynamic.
    const bothLiteral = derived(
      'page-title-with-site-name',
      literal('text', 'Page not found'),
      literal('text', 'Acme Ltd'),
    );
    expect(ownerOf(bothLiteral)).toBe('generation');
  });

  it('flows through the pipeline unevaluated', () => {
    const composed = metaOn(
      [says(A, { title: pageTitleWithSiteName(literal('text', '')) })],
      forPage('page.home'),
    );
    expect(composed.value.title?.kind).toBe('derived');
    expect(JSON.stringify(composed)).toContain('site.name');
    expect(JSON.stringify(composed)).not.toContain('Acme Ltd');
  });
});

// ---------------------------------------------------------------------------
// Robots
// ---------------------------------------------------------------------------

describe('indexing-directive', () => {
  it('derives the directive from the project switch alone', () => {
    const value = indexingDirective();
    expect(value.kind).toBe('derived');
    if (value.kind !== 'derived') throw new Error('narrowing failed');
    expect(value.derivation).toBe('indexing-directive');
    expect(value.inputs).toEqual([boundTo('flag', 'document.indexingBlocked')]);
    expect(derivationType('indexing-directive')).toBe('text');
  });

  it('leaves the page-level opt-out to scope, as the template does', () => {
    /*
     * The template computes `blocked = noindex || SEO.noindex` - a page's own
     * opt-out *or* the project's switch. Only the switch is an input here, and
     * the disjunction is not missing: the page states its own directive at its
     * own scope and specificity combines them.
     *
     * Modelling `||` would have added a boolean operator to a vocabulary that
     * deliberately has none, to express something the scope model already
     * expresses. Verified against the source rather than asserted.
     */
    const astro = source('templates/astro-tailwind/base/src/components/Seo.astro');
    expect(astro).toContain('const blocked = noindex || SEO.noindex;');
    expect(astro).toContain("const robots = blocked ? 'noindex, nofollow' : 'index, follow';");

    expect(derivationParameters('indexing-directive')).toEqual(['flag']);
  });

  it('is overridden by a page that states its own directive', () => {
    const contributions = [
      says(A, { robots: indexingDirective() }),
      says(B, { robots: literal('text', 'noindex, nofollow') }, onPage('page.notFound')),
    ];
    const page = metaOn(contributions, forPage('page.notFound'));
    expect(page.value.robots).toEqual(literal('text', 'noindex, nofollow'));
    // and the site keeps tracking the switch
    expect(metaOn(contributions, SITE_TARGET).value.robots?.kind).toBe('derived');
  });

  it('is inherited by a page that says nothing about indexing', () => {
    // The template's default `noindex = false` means "say nothing", not "say
    // index" - a page that omits it still follows the project switch. Absence
    // is how the model says nothing, so inheritance reproduces that exactly.
    const composed = metaOn(
      [
        says(A, { robots: indexingDirective() }),
        says(B, { title: literal('text', 'Home') }, onPage('page.home')),
      ],
      forPage('page.home'),
    );
    expect(composed.value.robots?.kind).toBe('derived');
  });

  it('invents no directive of its own', () => {
    const value = indexingDirective();
    expect(JSON.stringify(value)).not.toContain('noindex');
    expect(JSON.stringify(value)).not.toContain('index, follow');
  });

  it('is project-owned', () => {
    expect(ownerOf(indexingDirective())).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// Canonical
// ---------------------------------------------------------------------------

describe('absolute-page-url survived the change', () => {
  it('keeps its meaning with an explicit signature', () => {
    expect(derivationType('absolute-page-url')).toBe('url');
    expect(derivationParameters('absolute-page-url')).toEqual(['url', 'path']);
    expect(bindingsUsedBy(absolutePageUrl())).toEqual(['page.path', 'site.url']);
    expect(ownerOf(absolutePageUrl())).toBe('build-context');
  });

  it('is still overridden by an empty canonical at a page', () => {
    const contributions = [
      says(A, { canonical: absolutePageUrl() }),
      says(B, { canonical: literal('url', '') }, onPage('page.notFound')),
    ];
    expect(metaOn(contributions, forPage('page.notFound')).value.canonical).toEqual(
      literal('url', ''),
    );
    expect(metaOn(contributions, SITE_TARGET).value.canonical?.kind).toBe('derived');
  });

  it('still reaches a page nobody enumerated', () => {
    // `FileRole` is closed, so a developer's own page cannot be named. It is
    // covered by the every-page derivation, which is never evaluated.
    const contributions = [says(A, { canonical: absolutePageUrl() })];
    for (const target of [SITE_TARGET, forPage('page.home'), forPage('page.notFound')]) {
      expect(metaOn(contributions, target).value.canonical).toEqual(absolutePageUrl());
    }
  });
});

// ---------------------------------------------------------------------------
// Equality and conflicts
// ---------------------------------------------------------------------------

describe('derivation equality is structural', () => {
  it('deduplicates identical derivations from two owners', () => {
    const composed = metaOn(
      [says(A, { robots: indexingDirective() }), says(B, { robots: indexingDirective() })],
      SITE_TARGET,
    );
    expect(composed.provenance.robots?.owners).toEqual([A, B]);
  });

  it('ignores key order when comparing', () => {
    /*
     * Structural, not textual. A value assembled with its keys in another order
     * is the same statement, and comparing serialised source would call it a
     * disagreement.
     */
    const reordered = {
      inputs: [boundTo('flag', 'document.indexingBlocked')],
      derivation: 'indexing-directive',
      type: 'text',
      kind: 'derived',
    } as unknown as DocumentValue<'text'>;

    expect(() =>
      resolveDocumentForPage(
        [says(A, { robots: indexingDirective() }), says(B, { robots: reordered })],
        SITE_TARGET,
      ),
    ).not.toThrow();
  });

  it('treats argument order as part of the meaning', () => {
    /*
     * `f(a, b)` is not `f(b, a)`. A title composed as "A - B" says something
     * different from "B - A", so the canonical form that makes key order
     * irrelevant must leave *array* order alone. Sorting arguments to make
     * comparison tidier would silently merge two different statements.
     */
    const forward = derived(
      'page-title-with-site-name',
      literal('text', 'Alpha'),
      literal('text', 'Beta'),
    );
    const backward = derived(
      'page-title-with-site-name',
      literal('text', 'Beta'),
      literal('text', 'Alpha'),
    );

    const message = refusal(() =>
      resolveDocumentForPage(
        [says(A, { title: forward }), says(B, { title: backward })],
        SITE_TARGET,
      ),
    );
    expect(message).toContain('metadata.title');
  });

  it('conflicts when the same derivation has different inputs', () => {
    const message = refusal(() =>
      resolveDocumentForPage(
        [
          says(A, { title: pageTitleWithSiteName(literal('text', 'One')) }),
          says(B, { title: pageTitleWithSiteName(literal('text', 'Two')) }),
        ],
        SITE_TARGET,
      ),
    );
    expect(message).toContain('metadata.title');
    expect(message).toContain(A);
    expect(message).toContain(B);
  });

  it('conflicts when different derivations produce the same type', () => {
    const message = refusal(() =>
      resolveDocumentForPage(
        [
          says(A, { title: pageTitleWithSiteName(literal('text', 'One')) }),
          says(B, { title: indexingDirective() }),
        ],
        SITE_TARGET,
      ),
    );
    expect(message).toContain('metadata.title');
  });

  it('conflicts with a literal at the same scope, with no kind precedence', () => {
    const message = refusal(() =>
      resolveDocumentForPage(
        [
          says(A, { title: pageTitleWithSiteName(literal('text', 'One')) }),
          says(B, { title: literal('text', 'Acme') }),
        ],
        SITE_TARGET,
      ),
    );
    expect(message).toContain('metadata.title');
  });
});

// ---------------------------------------------------------------------------
// Scope and stance
// ---------------------------------------------------------------------------

describe('derivations obey the existing scope and stance rules', () => {
  const at = onPage('page.notFound');

  it('a page literal overrides an inherited derivation without conflicting', () => {
    expect(() =>
      resolveDocumentForPage(
        [
          says(A, { title: pageTitleWithSiteName(literal('text', '')) }),
          says(B, { title: literal('text', 'Page not found - Acme Ltd') }, at),
        ],
        forPage('page.notFound'),
      ),
    ).not.toThrow();
  });

  it('a page suppression beats an inherited derivation', () => {
    const document = resolveDocumentForPage(
      [
        says(A, { robots: indexingDirective() }),
        {
          kind: 'metadata',
          owner: B,
          reason: 'this page states nothing',
          scope: at,
          metadata: suppressed('this page states nothing'),
        },
      ],
      forPage('page.notFound'),
    );
    expect(document.metadata?.state).toBe('suppressed');
  });

  it('an unrelated page does not see another page derivation', () => {
    const contributions = [says(A, { robots: indexingDirective() }, onPage('page.home'))];
    expect(
      resolveDocumentForPage(contributions, forPage('page.notFound')).metadata,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The 404, unchanged
// ---------------------------------------------------------------------------

describe('the 404 result is unchanged by the new derivations', () => {
  const at = onPage('page.notFound');

  const contributions: DocumentContribution[] = [
    says('feature:seo', {
      title: pageTitleWithSiteName(literal('text', '')),
      robots: indexingDirective(),
      canonical: absolutePageUrl(),
    }),
    says(
      'feature:seo',
      {
        title: literal('text', 'Page not found - Acme Ltd'),
        robots: literal('text', 'noindex, nofollow'),
        canonical: literal('url', ''),
      },
      at,
    ),
    {
      kind: 'structured-data',
      owner: 'feature:structured-data',
      reason: 'an unmatched address is not the organisation home',
      scope: at,
      jsonLd: suppressed('an unmatched address is not the organisation home'),
    },
  ];

  it('keeps every page-stated fact a literal', () => {
    /*
     * The page states its own title, so it stays literal - the site-wide
     * derivation does not reach down and make it dynamic. Scope specificity
     * decides, exactly as before the derivations existed.
     */
    const composed = metaOn(contributions, forPage('page.notFound'));
    expect(composed.value.title).toEqual(literal('text', 'Page not found - Acme Ltd'));
    expect(composed.value.robots).toEqual(literal('text', 'noindex, nofollow'));
    expect(composed.value.canonical).toEqual(literal('url', ''));
  });

  it('keeps the structured-data suppression', () => {
    expect(
      resolveDocumentForPage(contributions, forPage('page.notFound')).structuredData?.state,
    ).toBe('suppressed');
  });

  it('leaves the site on its derivations', () => {
    const site = metaOn(contributions, SITE_TARGET);
    expect(site.value.title?.kind).toBe('derived');
    expect(site.value.robots?.kind).toBe('derived');
    expect(site.value.canonical?.kind).toBe('derived');
  });
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

describe('a derivation cannot carry executable code', () => {
  it('refuses an id that is not in the vocabulary', () => {
    const invented = {
      kind: 'derived',
      type: 'text',
      derivation: '`${SITE.name}`',
      inputs: [],
    } as unknown as AnyDocumentValue;
    expect(refusal(() => assertDerivationInputs(invented))).not.toBe('');
  });

  it('refuses arguments of the wrong type', () => {
    const wrong = {
      kind: 'derived',
      type: 'text',
      derivation: 'indexing-directive',
      inputs: [boundTo('text', 'site.name')],
    } as unknown as AnyDocumentValue;
    expect(refusal(() => assertDerivationInputs(wrong))).toContain('expects flag at position 0');
  });

  it('validates nested arguments too', () => {
    const nested = {
      kind: 'derived',
      type: 'text',
      derivation: 'page-title-with-site-name',
      inputs: [
        {
          kind: 'derived',
          type: 'text',
          derivation: 'indexing-directive',
          inputs: [literal('text', 'not a flag')],
        },
        boundTo('text', 'site.name'),
      ],
    } as unknown as AnyDocumentValue;
    expect(refusal(() => assertDerivationInputs(nested))).toContain('expects flag at position 0');
  });

  it('has no operator, node kind or expression vocabulary', () => {
    /*
     * The guard against this becoming a general AST. A derivation names an
     * operation; the moment concatenation, conditionals or property access
     * appear as *nodes*, ClientKit has a language rather than a vocabulary.
     */
    const text = codeOnly('src/domain/document-value.ts');
    for (const node of [
      "'concat'",
      "'conditional'",
      "'binary'",
      "'property-access'",
      "'call'",
      "'reference'",
      "'ternary'",
    ]) {
      expect(text, `document-value.ts declares a ${node} node`).not.toContain(node);
    }
  });

  it('evaluates nothing and reads nothing', () => {
    const text = source('src/domain/document-value.ts');
    for (const token of ['eval(', 'new Function', 'Function(', 'vm.', 'require(', 'import(']) {
      expect(text, `contains ${token}`).not.toContain(token);
    }
    for (const module of [
      'node:fs',
      'node:path',
      'node:process',
      'node:os',
      'node:child_process',
    ]) {
      expect(text, `imports ${module}`).not.toContain(`'${module}'`);
    }
  });

  it('carries no framework expression', () => {
    const text = codeOnly('src/domain/document-value.ts');
    for (const token of ['Astro.url', 'SITE.name', 'SITE.url', 'SEO.noindex', 'SEO.image']) {
      expect(text, `contains ${token}`).not.toContain(token);
    }
  });
});

// ---------------------------------------------------------------------------
// The Astro boundary
// ---------------------------------------------------------------------------

describe('Astro declares which derivations it can realise', () => {
  it('supports every derivation the vocabulary declares', () => {
    expect([...ASTRO_DERIVATION_SUPPORT.supports].sort()).toEqual([...DOCUMENT_DERIVATION_IDS]);
    expect(ASTRO_DERIVATION_SUPPORT.architecture).toBe('astro-standard');
  });

  it('holds no realization, because that is the emitter', () => {
    // Support is a list; how Astro spells an operation is emitter work and is
    // deliberately not here.
    const text = source('src/adapters/astro-derivations.ts');
    for (const token of ['`${', 'SITE.name', 'Astro.url', '? ', 'noindex, nofollow']) {
      expect(text, `astro-derivations.ts contains ${token}`).not.toContain(token);
    }
  });

  it('keeps the domain unaware of it', () => {
    expect(source('src/domain/document-value.ts')).not.toContain('astro-derivations');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('derived values resolve deterministically', () => {
  const all: DocumentContribution[] = [
    says(A, { title: pageTitleWithSiteName(literal('text', '')) }),
    says(A, { robots: indexingDirective() }),
    says(B, { canonical: absolutePageUrl() }),
  ];

  const render = (order: readonly DocumentContribution[]): string =>
    JSON.stringify([
      resolveDocumentForPage(order, SITE_TARGET),
      resolveDocumentForPage(order, forPage('page.home')),
      resolveDocumentForPage(order, forPage('page.notFound')),
    ]);

  it('is identical under all six permutations', () => {
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => order.map((index) => all[index]!) as DocumentContribution[]);
    expect(new Set(permutations.map(render)).size).toBe(1);
  });

  it('is byte-identical across repeated runs', () => {
    expect(new Set([1, 2, 3].map(() => render(all))).size).toBe(1);
  });

  it('serialises a derivation identically every time', () => {
    const runs = [1, 2, 3].map(() =>
      JSON.stringify([
        absolutePageUrl(),
        indexingDirective(),
        pageTitleWithSiteName(literal('text', 'X')),
      ]),
    );
    expect(new Set(runs).size).toBe(1);
  });
});
