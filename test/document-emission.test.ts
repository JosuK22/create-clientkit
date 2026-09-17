import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASTRO_REALIZATION } from '../src/adapters/astro-derivations.js';
import { resolveAccessibilityContract } from '../src/domain/accessibility.js';
import type {
  DocumentContribution,
  DocumentScope,
  MetadataStatement,
} from '../src/domain/document-contribution.js';
import { EVERY_PAGE, onPage, stated, suppressed } from '../src/domain/document-contribution.js';
import type {
  DocumentEmissionItem,
  DocumentEmissionPlan,
  RealizationSupport,
} from '../src/domain/document-emission.js';
import {
  assertPlanRealizable,
  bindingsRequiredBy,
  buildDocumentEmission,
  derivationsRequiredBy,
  describeEmissionPlan,
  EMISSION_FIELDS,
} from '../src/domain/document-emission.js';
import type { DocumentTarget } from '../src/domain/document-scope.js';
import { forPage, resolveDocumentForPage, SITE_TARGET } from '../src/domain/document-scope.js';
import type { AnyDocumentValue } from '../src/domain/document-value.js';
import {
  absolutePageUrl,
  boundTo,
  derived,
  indexingDirective,
  literal,
  pageTitleWithSiteName,
} from '../src/domain/document-value.js';
import { resolveSeoContract } from '../src/domain/seo.js';
import { resolveOrganization } from '../src/domain/structured-data.js';
import type { CliError } from '../src/errors.js';
import type { SiteContext } from '../src/types.js';

/**
 * The emission boundary.
 *
 * Everything to the left of this IR is semantics - what the document says,
 * which scope won, who disagreed. Everything to the right is spelling. The IR
 * exists so neither side has to know the other, and the two properties worth
 * protecting are that it carries no markup and evaluates nothing.
 */

const source = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');

const codeOnly = (file: string): string =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const SITE: SiteContext = {
  name: 'Acme Ltd',
  url: 'https://acme.example',
  description: 'Bespoke widgets for discerning clients.',
  locale: 'en-GB',
  author: null,
};

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

const planFor = (
  contributions: readonly DocumentContribution[],
  target: DocumentTarget = SITE_TARGET,
): DocumentEmissionPlan => buildDocumentEmission(resolveDocumentForPage(contributions, target));

const item = (plan: DocumentEmissionPlan, field: string): DocumentEmissionItem | undefined =>
  plan.items.find((candidate) => candidate.field === field);

const valueOf = (plan: DocumentEmissionPlan, field: string): AnyDocumentValue => {
  const found = item(plan, field);
  if (found === undefined || found.state !== 'stated' || found.field === 'structured-data') {
    throw new Error(`expected a stated value for ${field}`);
  }
  return found.value;
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('the IR carries one item per stated fact', () => {
  it('carries a literal title', () => {
    const plan = planFor([says(A, { title: literal('text', 'Acme Ltd') })]);
    expect(valueOf(plan, 'title')).toEqual(literal('text', 'Acme Ltd'));
  });

  it('carries a derived title, unevaluated', () => {
    const plan = planFor([says(A, { title: pageTitleWithSiteName(literal('text', '')) })]);
    expect(valueOf(plan, 'title')).toEqual(pageTitleWithSiteName(literal('text', '')));
  });

  it('carries a description', () => {
    const plan = planFor([says(A, { description: boundTo('text', 'site.description') })]);
    expect(valueOf(plan, 'description')).toEqual(boundTo('text', 'site.description'));
  });

  it('carries a literal and a derived robots', () => {
    expect(
      valueOf(planFor([says(A, { robots: literal('text', 'noindex, nofollow') })]), 'robots'),
    ).toEqual(literal('text', 'noindex, nofollow'));
    expect(valueOf(planFor([says(A, { robots: indexingDirective() })]), 'robots')).toEqual(
      indexingDirective(),
    );
  });

  it('carries the social blocks whole', () => {
    const contract = resolveSeoContract(SITE);
    const plan = planFor([
      says(A, {
        openGraph: literal('open-graph', contract.openGraph),
        twitter: literal('twitter', contract.twitter),
      }),
    ]);
    expect(valueOf(plan, 'open-graph')).toEqual(literal('open-graph', contract.openGraph));
    expect(valueOf(plan, 'twitter')).toEqual(literal('twitter', contract.twitter));
  });

  it('carries structured data as a whole object', () => {
    const plan = planFor([
      {
        kind: 'structured-data',
        owner: A,
        reason: 'the organisation',
        scope: EVERY_PAGE,
        jsonLd: stated(resolveOrganization(SITE)),
      },
    ]);
    const found = item(plan, 'structured-data');
    if (found?.state !== 'stated' || found.field !== 'structured-data') {
      throw new Error('narrowing failed');
    }
    expect(found.organization).toEqual(resolveOrganization(SITE));
  });

  it('emits nothing for a field nobody claimed', () => {
    const plan = planFor([says(A, { title: literal('text', 'Acme Ltd') })]);
    expect(plan.items.map((entry) => entry.field)).toEqual(['title']);
    expect(item(plan, 'canonical')).toBeUndefined();
  });

  it('emits nothing at all for a document nobody described', () => {
    expect(planFor([]).items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Preservation
// ---------------------------------------------------------------------------

describe('the IR evaluates nothing', () => {
  it('keeps a binding a binding', () => {
    const plan = planFor([says(A, { title: boundTo('text', 'site.name') })]);
    expect(valueOf(plan, 'title').kind).toBe('binding');
    expect(JSON.stringify(plan)).not.toContain('Acme Ltd');
  });

  it('keeps a derivation derived, with its arguments intact', () => {
    const plan = planFor([says(A, { canonical: absolutePageUrl() })]);
    const value = valueOf(plan, 'canonical');
    expect(value).toEqual(absolutePageUrl());
    if (value.kind !== 'derived') throw new Error('narrowing failed');
    expect(value.inputs).toHaveLength(2);
  });

  it('keeps a nested derivation structured', () => {
    const nested = derived(
      'page-title-with-site-name',
      pageTitleWithSiteName(literal('text', 'Inner')),
      boundTo('text', 'site.name'),
    );
    const plan = planFor([says(A, { title: nested })]);
    const value = valueOf(plan, 'title');
    if (value.kind !== 'derived') throw new Error('narrowing failed');
    const inner = value.inputs[0];
    if (inner?.kind !== 'derived') throw new Error('nested derivation was flattened');
    expect(inner.derivation).toBe('page-title-with-site-name');
  });

  it('never turns a dynamic value into an address', () => {
    const plan = planFor([
      says(A, { canonical: absolutePageUrl(), title: pageTitleWithSiteName(literal('text', '')) }),
    ]);
    const serialised = JSON.stringify(plan);
    expect(serialised).not.toContain('https://acme.example');
    expect(serialised).not.toContain('Acme Ltd');
    expect(serialised).toContain('absolute-page-url');
    expect(serialised).toContain('site.name');
  });
});

// ---------------------------------------------------------------------------
// Absence and suppression
// ---------------------------------------------------------------------------

describe('absence and suppression stay apart', () => {
  it('turns a suppressed statement into suppressed items, not missing ones', () => {
    /*
     * The distinction that has been load-bearing since Stage 31. An absent
     * field is one nobody mentioned; a suppressed field is one somebody
     * refused. An emitter that saw the second as the first would be free to
     * fill it in.
     */
    const plan = planFor([
      {
        kind: 'metadata',
        owner: A,
        reason: 'this page states nothing',
        scope: EVERY_PAGE,
        metadata: suppressed('this page states nothing'),
      },
    ]);
    const title = item(plan, 'title');
    expect(title?.state).toBe('suppressed');
    if (title?.state !== 'suppressed') throw new Error('narrowing failed');
    expect(title.becauses).toEqual(['this page states nothing']);
    // Every metadata field is refused, and structured data is untouched.
    expect(plan.items.map((entry) => entry.field)).not.toContain('structured-data');
  });

  it('carries a suppressed organisation', () => {
    const plan = planFor([
      {
        kind: 'structured-data',
        owner: A,
        reason: 'not the organisation home',
        scope: EVERY_PAGE,
        jsonLd: suppressed('not the organisation home'),
      },
    ]);
    const found = item(plan, 'structured-data');
    expect(found?.state).toBe('suppressed');
  });

  it('never gives a suppressed item a value', () => {
    const plan = planFor([
      {
        kind: 'metadata',
        owner: A,
        reason: 'nothing here',
        scope: EVERY_PAGE,
        metadata: suppressed('nothing here'),
      },
    ]);
    for (const entry of plan.items) {
      expect('value' in entry, `${entry.field} carries a value while suppressed`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical
// ---------------------------------------------------------------------------

describe('canonical keeps all four states', () => {
  it('absent produces no item', () => {
    expect(item(planFor([says(A, { title: literal('text', 'X') })]), 'canonical')).toBeUndefined();
  });

  it('an empty literal produces an item that states emptiness', () => {
    // Not absence: the page said it has no canonical, which is a claim.
    const plan = planFor([says(A, { canonical: literal('url', '') })]);
    expect(valueOf(plan, 'canonical')).toEqual(literal('url', ''));
  });

  it('a URL literal produces a fixed canonical', () => {
    const plan = planFor([says(A, { canonical: literal('url', 'https://acme.example/') })]);
    expect(valueOf(plan, 'canonical')).toEqual(literal('url', 'https://acme.example/'));
  });

  it('a derivation produces a dynamic canonical', () => {
    const plan = planFor([says(A, { canonical: absolutePageUrl() })]);
    expect(valueOf(plan, 'canonical').kind).toBe('derived');
  });

  it('keeps the four distinguishable from one another', () => {
    const rendered = [
      JSON.stringify(item(planFor([says(A, { title: literal('text', 'X') })]), 'canonical')),
      JSON.stringify(item(planFor([says(A, { canonical: literal('url', '') })]), 'canonical')),
      JSON.stringify(
        item(
          planFor([says(A, { canonical: literal('url', 'https://acme.example/') })]),
          'canonical',
        ),
      ),
      JSON.stringify(item(planFor([says(A, { canonical: absolutePageUrl() })]), 'canonical')),
    ];
    expect(new Set(rendered).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('items are ordered by the vocabulary', () => {
  const everything: MetadataStatement = {
    twitter: literal('twitter', resolveSeoContract(SITE).twitter),
    canonical: absolutePageUrl(),
    title: literal('text', 'Acme Ltd'),
    openGraph: literal('open-graph', resolveSeoContract(SITE).openGraph),
    robots: indexingDirective(),
    description: boundTo('text', 'site.description'),
  };

  it('orders every field the same way regardless of how it was written', () => {
    const plan = planFor([
      says(A, everything),
      {
        kind: 'structured-data',
        owner: B,
        reason: 'the organisation',
        scope: EVERY_PAGE,
        jsonLd: stated(resolveOrganization(SITE)),
      },
    ]);
    /*
     * Against a written-out list, not against `EMISSION_FIELDS`. Comparing the
     * built plan to the constant it is built from is self-referential: reorder
     * the constant and both sides move together, so the assertion holds while
     * the output changes. This is what a reordering mutation has to fail.
     */
    expect(plan.items.map((entry) => entry.field)).toEqual([
      'title',
      'description',
      'robots',
      'canonical',
      'open-graph',
      'twitter',
      'structured-data',
    ]);
  });

  it('declares exactly these fields, in this order', () => {
    expect([...EMISSION_FIELDS]).toEqual([
      'title',
      'description',
      'robots',
      'canonical',
      'open-graph',
      'twitter',
      'structured-data',
    ]);
  });

  it('is identical under all six contribution permutations', () => {
    const parts: DocumentContribution[] = [
      says(A, { title: literal('text', 'Acme Ltd') }),
      says(A, { canonical: absolutePageUrl() }),
      says(B, { robots: indexingDirective() }),
    ];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => order.map((index) => parts[index]!) as DocumentContribution[]);

    const rendered = permutations.map((order) => JSON.stringify(planFor(order)));
    expect(new Set(rendered).size).toBe(1);
  });

  it('is byte-identical across repeated construction', () => {
    const parts = [says(A, { title: literal('text', 'Acme Ltd') })];
    expect(new Set([1, 2, 3].map(() => JSON.stringify(planFor(parts)))).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe('provenance is carried for diagnostics, not arbitration', () => {
  it('names the owners of a stated field', () => {
    const plan = planFor([
      says(A, { title: literal('text', 'Acme Ltd') }),
      says(B, { title: literal('text', 'Acme Ltd') }),
    ]);
    const title = item(plan, 'title');
    if (title?.state !== 'stated') throw new Error('narrowing failed');
    expect(title.provenance.owners).toEqual([A, B]);
  });

  it('carries no contribution, scope or conflict machinery', () => {
    /*
     * An emitter must not be able to re-run arbitration, and cannot: the plan
     * holds facts and owners, not the graph that produced them.
     */
    const plan = planFor([says(A, { title: literal('text', 'Acme Ltd') })]);
    const serialised = JSON.stringify(plan);
    for (const leaked of ['every-page', 'scopeKey', 'specificity', 'contributions']) {
      expect(serialised, `plan carries ${leaked}`).not.toContain(leaked);
    }
  });
});

// ---------------------------------------------------------------------------
// The realization contract
// ---------------------------------------------------------------------------

describe('an architecture is held to what it can spell', () => {
  const limited: RealizationSupport = {
    architecture: 'synthetic-limited',
    bindings: ['site.name'],
    derivations: [],
  };

  it('reports what a plan needs', () => {
    const plan = planFor([
      says(A, { canonical: absolutePageUrl(), title: pageTitleWithSiteName(literal('text', '')) }),
    ]);
    expect(bindingsRequiredBy(plan)).toEqual(['page.path', 'site.name', 'site.url']);
    expect(derivationsRequiredBy(plan)).toEqual(['absolute-page-url', 'page-title-with-site-name']);
  });

  it('separates what is needed from what merely exists', () => {
    // A plan of literals needs nothing, even though the vocabulary is large.
    const plan = planFor([says(A, { title: literal('text', 'Acme Ltd') })]);
    expect(bindingsRequiredBy(plan)).toEqual([]);
    expect(derivationsRequiredBy(plan)).toEqual([]);
    expect(() =>
      assertPlanRealizable(plan, { architecture: 'x', bindings: [], derivations: [] }),
    ).not.toThrow();
  });

  it('accepts a plan Astro can realise', () => {
    const plan = planFor([
      says(A, {
        title: pageTitleWithSiteName(literal('text', '')),
        robots: indexingDirective(),
        canonical: absolutePageUrl(),
      }),
    ]);
    expect(() => assertPlanRealizable(plan, ASTRO_REALIZATION)).not.toThrow();
  });

  it('refuses an unsupported binding, naming field, value and architecture', () => {
    const plan = planFor([says(A, { description: boundTo('text', 'site.description') })]);
    const message = refusal(() => assertPlanRealizable(plan, limited));
    expect(message).toContain('synthetic-limited');
    expect(message).toContain('site.description');
    expect(message).toContain('description');
    expect(message).toContain('no fallback');
  });

  it('refuses an unsupported derivation, naming its signature', () => {
    const plan = planFor([says(A, { canonical: absolutePageUrl() })]);
    const message = refusal(() =>
      assertPlanRealizable(plan, {
        architecture: 'synthetic-no-derivations',
        bindings: ['site.url', 'page.path'],
        derivations: [],
      }),
    );
    expect(message).toContain('absolute-page-url');
    expect(message).toContain('(url, path) -> url');
    expect(message).toContain('synthetic-no-derivations');
  });

  it('names the page it was preparing', () => {
    const plan = planFor(
      [says(A, { description: boundTo('text', 'site.description') })],
      forPage('page.notFound'),
    );
    expect(refusal(() => assertPlanRealizable(plan, limited))).toContain('page.notFound');
  });

  it('drops nothing and substitutes nothing when it refuses', () => {
    // The failure mode this exists to prevent: an unsupported value quietly
    // vanishing, or becoming a near-enough one, and the document building.
    const plan = planFor([says(A, { description: boundTo('text', 'site.description') })]);
    expect(() => assertPlanRealizable(plan, limited)).toThrow();
    expect(valueOf(plan, 'description')).toEqual(boundTo('text', 'site.description'));
  });
});

// ---------------------------------------------------------------------------
// Malformed values
// ---------------------------------------------------------------------------

describe('malformed values are refused, not walked forever', () => {
  const planWith = (value: unknown): DocumentEmissionPlan => ({
    target: SITE_TARGET,
    items: [
      {
        field: 'title',
        state: 'stated',
        value: value as AnyDocumentValue,
        provenance: { owners: [A], reasons: [] },
      },
    ],
  });

  it('refuses a binding that is not in the vocabulary', () => {
    const message = refusal(() =>
      assertPlanRealizable(
        planWith({ kind: 'binding', type: 'text', binding: 'SITE.name' }),
        ASTRO_REALIZATION,
      ),
    );
    expect(message).toContain('not a binding this vocabulary knows');
  });

  it('refuses a derivation that is not in the vocabulary', () => {
    const message = refusal(() =>
      assertPlanRealizable(
        planWith({ kind: 'derived', type: 'text', derivation: '`${SITE.name}`', inputs: [] }),
        ASTRO_REALIZATION,
      ),
    );
    expect(message).toContain('not a derivation this vocabulary knows');
  });

  it('refuses arguments of the wrong type or count', () => {
    expect(
      refusal(() =>
        assertPlanRealizable(
          planWith({
            kind: 'derived',
            type: 'text',
            derivation: 'indexing-directive',
            inputs: [literal('text', 'not a flag')],
          }),
          ASTRO_REALIZATION,
        ),
      ),
    ).toContain('expects flag at position 0');

    expect(
      refusal(() =>
        assertPlanRealizable(
          planWith({
            kind: 'derived',
            type: 'text',
            derivation: 'page-title-with-site-name',
            inputs: [literal('text', 'only one')],
          }),
          ASTRO_REALIZATION,
        ),
      ),
    ).toContain('takes 2 input(s)');
  });

  it('refuses a value nested past any honest depth', () => {
    /*
     * A cycle cannot be constructed - values are immutable and built bottom-up,
     * and JSON cannot express one - so this is not a cycle detector. What it
     * guards is a value that arrived through an erased cast, where an unbounded
     * walk would hang instead of failing. The deepest thing the vocabulary can
     * honestly express is two levels.
     */
    let deep: AnyDocumentValue = literal('text', 'bottom');
    for (let index = 0; index < 20; index += 1) {
      deep = derived('page-title-with-site-name', deep, boundTo('text', 'site.name'));
    }
    expect(refusal(() => assertPlanRealizable(planWith(deep), ASTRO_REALIZATION))).toContain(
      'nests more than',
    );
  });

  it('accepts a value nested within it', () => {
    const shallow = derived(
      'page-title-with-site-name',
      pageTitleWithSiteName(literal('text', 'Inner')),
      boundTo('text', 'site.name'),
    );
    expect(() => assertPlanRealizable(planWith(shallow), ASTRO_REALIZATION)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The 404
// ---------------------------------------------------------------------------

describe('the not-found page emits what it resolved to', () => {
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
      reason: 'the organisation',
      scope: EVERY_PAGE,
      jsonLd: stated(resolveOrganization(SITE)),
    },
    {
      kind: 'structured-data',
      owner: 'feature:structured-data',
      reason: 'an unmatched address is not the organisation home',
      scope: at,
      jsonLd: suppressed('an unmatched address is not the organisation home'),
    },
  ];

  it('emits the page-stated literals', () => {
    const plan = planFor(contributions, forPage('page.notFound'));
    expect(valueOf(plan, 'title')).toEqual(literal('text', 'Page not found - Acme Ltd'));
    expect(valueOf(plan, 'robots')).toEqual(literal('text', 'noindex, nofollow'));
    expect(valueOf(plan, 'canonical')).toEqual(literal('url', ''));
  });

  it('emits a suppressed organisation for that page', () => {
    const plan = planFor(contributions, forPage('page.notFound'));
    expect(item(plan, 'structured-data')?.state).toBe('suppressed');
  });

  it('emits the site with its derivations intact', () => {
    const plan = planFor(contributions, SITE_TARGET);
    expect(valueOf(plan, 'title').kind).toBe('derived');
    expect(valueOf(plan, 'robots').kind).toBe('derived');
    expect(valueOf(plan, 'canonical').kind).toBe('derived');
    expect(item(plan, 'structured-data')?.state).toBe('stated');
  });

  it('keeps the home page separate from both', () => {
    const home = planFor(contributions, forPage('page.home'));
    expect(valueOf(home, 'robots').kind).toBe('derived');
    expect(item(home, 'structured-data')?.state).toBe('stated');
    expect(JSON.stringify(home)).not.toContain('Page not found');
  });

  it('is realisable by Astro at every target', () => {
    for (const target of [SITE_TARGET, forPage('page.home'), forPage('page.notFound')]) {
      expect(() =>
        assertPlanRealizable(planFor(contributions, target), ASTRO_REALIZATION),
      ).not.toThrow();
    }
  });

  it('describes itself stably', () => {
    expect(describeEmissionPlan(planFor(contributions, forPage('page.notFound')))).toBe(
      [
        'the "page.notFound" page',
        'title: literal',
        'robots: literal',
        'canonical: literal',
        'structured-data: suppressed',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// A page nobody enumerated
// ---------------------------------------------------------------------------

describe('a page ClientKit never heard of still emits a correct address', () => {
  it('keeps the derivation unevaluated at every target', () => {
    const contributions = [says(A, { canonical: absolutePageUrl() })];
    for (const target of [SITE_TARGET, forPage('page.home'), forPage('page.notFound')]) {
      expect(valueOf(planFor(contributions, target), 'canonical')).toEqual(absolutePageUrl());
    }
  });

  it('fabricates no address anywhere in the plan', () => {
    const serialised = JSON.stringify(planFor([says(A, { canonical: absolutePageUrl() })]));
    for (const invented of ['https://acme.example', 'example.com', 'localhost']) {
      expect(serialised, `fabricated ${invented}`).not.toContain(invented);
    }
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('accessibility contributes no emission item', () => {
  it('emits nothing for a document guarantee', () => {
    /*
     * Deliberate, and the reason matters. Its one valued fact is the document's
     * language, and the shipped Astro layout writes that as `lang={SITE.locale}`
     * - a binding. `AccessibilityContract` holds a generation-time snapshot of
     * the same value, so emitting it would freeze what the project owns, which
     * is precisely the Stage 34 failure. Representing it truthfully needs a
     * binding-aware accessibility contract, which is still deferred.
     */
    const plan = planFor([
      {
        kind: 'document-guarantees',
        owner: A,
        reason: 'what the document holds',
        scope: EVERY_PAGE,
        guarantees: stated(resolveAccessibilityContract(SITE)),
      },
    ]);
    expect(plan.items).toEqual([]);
  });

  it('never carries a guarantee list into the IR', () => {
    const plan = planFor([
      {
        kind: 'document-guarantees',
        owner: A,
        reason: 'what the document holds',
        scope: EVERY_PAGE,
        guarantees: stated(resolveAccessibilityContract(SITE)),
      },
      says(A, { title: literal('text', 'Acme Ltd') }),
    ]);
    const serialised = JSON.stringify(plan);
    for (const guarantee of ['skip-link', 'main-landmark', 'wcag-conformance', 'en-GB']) {
      expect(serialised, `IR carries ${guarantee}`).not.toContain(guarantee);
    }
  });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('the IR is semantic and architecture-independent', () => {
  const FILE = 'src/domain/document-emission.ts';

  it('carries no markup and no source', () => {
    const text = codeOnly(FILE);
    for (const token of ['<meta', '<title', '<link', '<script', '<html', 'innerHTML']) {
      expect(text, `${FILE} contains ${token}`).not.toContain(token);
    }
    // The forbidden field names, which would each be source in disguise.
    for (const field of ['html:', 'markup:', 'source:', 'expression:', 'code:']) {
      expect(text, `${FILE} declares a ${field} field`).not.toContain(field);
    }
  });

  it('imports no framework, filesystem or adapter module', () => {
    const text = source(FILE);
    for (const module of [
      'node:fs',
      'node:path',
      'node:process',
      'node:os',
      'node:child_process',
    ]) {
      expect(text, `imports ${module}`).not.toContain(`'${module}'`);
    }
    for (const module of ['react', 'next', 'astro', '@mui', 'tailwind', 'vite']) {
      expect(text.toLowerCase(), `imports ${module}`).not.toContain(`from '${module}`);
    }
    for (const module of ['../adapters/', '../templates/', '../features/']) {
      expect(text, `imports ${module}`).not.toContain(module);
    }
  });

  it('evaluates nothing', () => {
    const text = source(FILE);
    for (const token of ['eval(', 'new Function', 'Function(', 'vm.', 'require(', 'import(']) {
      expect(text, `contains ${token}`).not.toContain(token);
    }
  });

  it('carries no framework expression', () => {
    const text = codeOnly(FILE);
    for (const token of ['Astro.url', 'SITE.name', 'SITE.url', 'SEO.noindex']) {
      expect(text, `contains ${token}`).not.toContain(token);
    }
  });

  it('builds no emitter', () => {
    for (const file of [
      'src/adapters/astro-document-emitter.ts',
      'src/domain/document-emitter.ts',
      'src/adapters/astro-head.ts',
    ]) {
      expect(() => source(file), file).toThrow();
    }
  });

  it('is imported by no adapter except the Astro support declaration', () => {
    const bridge = source('src/adapters/bridge.ts');
    expect(bridge).not.toContain('document-emission');
  });

  it('keeps the Astro declaration free of spelling', () => {
    // It says what Astro supports, never how Astro writes it.
    const text = source('src/adapters/astro-derivations.ts');
    for (const token of ['`${', 'Astro.url', 'noindex, nofollow', '<meta']) {
      expect(text, `astro-derivations.ts contains ${token}`).not.toContain(token);
    }
  });
});
