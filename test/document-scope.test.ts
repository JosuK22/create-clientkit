import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveAccessibilityContract } from '../src/domain/accessibility.js';
import type {
  DocumentContribution,
  DocumentScope,
  MetadataStatement,
} from '../src/domain/document-contribution.js';
import {
  EVERY_PAGE,
  metadataFromContract,
  onPage,
  stated,
  suppressed,
} from '../src/domain/document-contribution.js';
import type { DocumentTarget, ResolvedPageDocument } from '../src/domain/document-scope.js';
import {
  appliesTo,
  forPage,
  resolveDocumentForPage,
  SCOPE_SPECIFICITY,
  SITE_TARGET,
} from '../src/domain/document-scope.js';
import type {
  DocumentValue,
  DocumentValueType,
  LiteralTypes,
} from '../src/domain/document-value.js';
import { literal } from '../src/domain/document-value.js';
import { resolveSeoContract } from '../src/domain/seo.js';
import { resolveOrganization } from '../src/domain/structured-data.js';
import type { CliError } from '../src/errors.js';
import type { SiteContext } from '../src/types.js';

/** Constructing a statement: the field types the vocabulary gives each field. */
const text = (value: string) => literal('text', value);
const urlValue = (value: string) => literal('url', value);

/**
 * Reading one back. Throws rather than returning undefined, so an assertion
 * that expected a literal and met a binding fails where it is written.
 */
function lit<K extends DocumentValueType>(value: DocumentValue<K> | undefined): LiteralTypes[K] {
  if (value === undefined) throw new Error('expected a value, found none');
  if (value.kind !== 'literal') throw new Error(`expected a literal, found a ${value.kind}`);
  return value.value;
}

/**
 * Document scope composition.
 *
 * Stage 32 resolved every statement and deliberately defined no relationship
 * between `every-page` and `page:<role>`, because how a page's statement
 * combines with the document's is a composition question and inventing a rule
 * for it there would have been precedence by another name.
 *
 * This is the rule. The property every test here ultimately protects is that a
 * page wins because a page is *declared* more specific, not because its scope
 * happens to sort later.
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
const C = 'contributor:c';

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

const refuses = (
  owner: string,
  because: string,
  scope: DocumentScope = EVERY_PAGE,
): DocumentContribution => ({
  kind: 'metadata',
  owner,
  reason: `${owner} refuses`,
  scope,
  metadata: suppressed(because),
});

const org = (
  owner: string,
  site: SiteContext = SITE,
  scope: DocumentScope = EVERY_PAGE,
): DocumentContribution => ({
  kind: 'structured-data',
  owner,
  reason: `${owner} describes the organisation`,
  scope,
  jsonLd: stated(resolveOrganization(site)),
});

const noOrg = (
  owner: string,
  because: string,
  scope: DocumentScope = EVERY_PAGE,
): DocumentContribution => ({
  kind: 'structured-data',
  owner,
  reason: `${owner} refuses`,
  scope,
  jsonLd: suppressed(because),
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

/** The composed metadata for a target, or a failure if it is not stated. */
const metaOn = (contributions: readonly DocumentContribution[], target: DocumentTarget) => {
  const document = resolveDocumentForPage(contributions, target);
  if (document.metadata?.state !== 'stated') {
    throw new Error('expected stated metadata');
  }
  return document.metadata.value;
};

// ---------------------------------------------------------------------------
// Generic scope semantics
// ---------------------------------------------------------------------------

describe('specificity is declared, not sorted', () => {
  it('states the rule as a number a reader can find', () => {
    /*
     * The guard against the whole stage's central risk. If a page won because
     * `page:…` sorts after `''`, the meaning would change silently the day the
     * canonical order was adjusted for an unrelated reason.
     */
    expect(SCOPE_SPECIFICITY.page).toBeGreaterThan(SCOPE_SPECIFICITY['every-page']);
  });

  it('knows which scopes speak to which targets', () => {
    expect(appliesTo(EVERY_PAGE, SITE_TARGET)).toBe(true);
    expect(appliesTo(EVERY_PAGE, forPage('page.home'))).toBe(true);
    expect(appliesTo(onPage('page.home'), forPage('page.home'))).toBe(true);
    expect(appliesTo(onPage('page.home'), forPage('page.notFound'))).toBe(false);
    // A page statement says nothing about the document as a whole.
    expect(appliesTo(onPage('page.home'), SITE_TARGET)).toBe(false);
  });
});

describe('every-page applies everywhere', () => {
  const contributions = [
    says(A, { title: text('Acme Ltd'), description: text('Bespoke widgets.') }),
  ];

  it('reaches every page and the site', () => {
    for (const target of [SITE_TARGET, forPage('page.home'), forPage('page.notFound')]) {
      expect(lit(metaOn(contributions, target).value.title)).toBe('Acme Ltd');
    }
  });
});

describe('a page statement reaches only its own page', () => {
  const contributions = [says(A, { title: text('Home') }, onPage('page.home'))];

  it('applies to its page', () => {
    expect(lit(metaOn(contributions, forPage('page.home')).value.title)).toBe('Home');
  });

  it('does not reach another page', () => {
    expect(
      resolveDocumentForPage(contributions, forPage('page.notFound')).metadata,
    ).toBeUndefined();
  });

  it('does not reach the site', () => {
    expect(resolveDocumentForPage(contributions, SITE_TARGET).metadata).toBeUndefined();
  });
});

describe('a page overlays the document field by field', () => {
  const contributions = [
    says(A, { title: text('Acme Ltd'), description: text('Bespoke widgets.') }),
    says(B, { title: text('Page not found') }, onPage('page.notFound')),
  ];

  it('takes the page value for the field it states', () => {
    expect(lit(metaOn(contributions, forPage('page.notFound')).value.title)).toBe('Page not found');
  });

  it('inherits every field the page does not state', () => {
    /*
     * Model B - a page replacing the whole statement - would drop the
     * description here, which is exactly the return to whole-statement
     * semantics Stage 32 was written to prevent.
     */
    expect(lit(metaOn(contributions, forPage('page.notFound')).value.description)).toBe(
      'Bespoke widgets.',
    );
  });

  it('leaves the document itself untouched', () => {
    expect(lit(metaOn(contributions, SITE_TARGET).value.title)).toBe('Acme Ltd');
  });

  it('leaves an unrelated page untouched', () => {
    expect(lit(metaOn(contributions, forPage('page.home')).value.title)).toBe('Acme Ltd');
  });
});

// ---------------------------------------------------------------------------
// Every stance combination
// ---------------------------------------------------------------------------

describe('stance combinations across scopes', () => {
  const page = forPage('page.notFound');
  const at = onPage('page.notFound');

  it('stated + stated overlays', () => {
    const value = metaOn(
      [says(A, { title: text('Site') }), says(B, { title: text('Page') }, at)],
      page,
    ).value;
    expect(lit(value.title)).toBe('Page');
  });

  it('stated + suppressed suppresses', () => {
    /*
     * The mandatory case. Inheriting anyway would restore precisely what the
     * page refused, which is the failure the three-state stance was introduced
     * to make impossible.
     */
    const document = resolveDocumentForPage(
      [says(A, { title: text('Site') }), refuses(B, 'this page states nothing', at)],
      page,
    );
    expect(document.metadata?.state).toBe('suppressed');
  });

  it('suppressed + stated states', () => {
    const document = resolveDocumentForPage(
      [refuses(A, 'the document states nothing'), says(B, { title: text('Page') }, at)],
      page,
    );
    expect(document.metadata?.state).toBe('stated');
    if (document.metadata?.state !== 'stated') throw new Error('narrowing failed');
    expect(lit(document.metadata.value.value.title)).toBe('Page');
    // And nothing from the suppressed document layer leaked in.
    expect(document.metadata.value.value.description).toBeUndefined();
  });

  it('suppressed + suppressed suppresses', () => {
    const document = resolveDocumentForPage([refuses(A, 'document'), refuses(B, 'page', at)], page);
    expect(document.metadata?.state).toBe('suppressed');
  });

  it('absent + stated states', () => {
    expect(lit(metaOn([says(B, { title: text('Page') }, at)], page).value.title)).toBe('Page');
  });

  it('absent + suppressed suppresses', () => {
    const document = resolveDocumentForPage([refuses(B, 'page', at)], page);
    expect(document.metadata?.state).toBe('suppressed');
  });

  it('stated + absent inherits', () => {
    expect(lit(metaOn([says(A, { title: text('Site') })], page).value.title)).toBe('Site');
  });

  it('suppressed + absent stays suppressed', () => {
    // A refusal is inherited like anything else. Treating it as a gap would
    // make an inherited refusal quietly become "nothing was said".
    const document = resolveDocumentForPage([refuses(A, 'document')], page);
    expect(document.metadata?.state).toBe('suppressed');
  });

  it('absent + absent says nothing', () => {
    expect(resolveDocumentForPage([], page).metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-page isolation
// ---------------------------------------------------------------------------

describe('pages cannot reach each other', () => {
  const contributions = [
    says(A, { title: text('Acme Ltd'), description: text('Bespoke widgets.') }),
    says(B, { title: text('Home') }, onPage('page.home')),
    refuses(C, 'an unmatched address states nothing', onPage('page.notFound')),
  ];

  it('resolves three targets independently', () => {
    expect(lit(metaOn(contributions, SITE_TARGET).value.title)).toBe('Acme Ltd');
    expect(lit(metaOn(contributions, forPage('page.home')).value.title)).toBe('Home');
    expect(resolveDocumentForPage(contributions, forPage('page.notFound')).metadata?.state).toBe(
      'suppressed',
    );
  });

  it('does not let one page suppression reach another page', () => {
    expect(lit(metaOn(contributions, forPage('page.home')).value.description)).toBe(
      'Bespoke widgets.',
    );
  });

  it('does not let one page override reach another page', () => {
    // page.home states a title; page.notFound must not see it.
    const document = resolveDocumentForPage(contributions, forPage('page.notFound'));
    expect(JSON.stringify(document)).not.toContain('Home');
  });

  it('keeps the site free of every page statement', () => {
    const site = resolveDocumentForPage(contributions, SITE_TARGET);
    expect(JSON.stringify(site)).not.toContain('Home');
    expect(site.metadata?.state).toBe('stated');
  });
});

// ---------------------------------------------------------------------------
// Conflicts are still conflicts
// ---------------------------------------------------------------------------

describe('specificity never arbitrates between owners', () => {
  it('still refuses two owners disagreeing at the same scope', () => {
    const message = refusal(() =>
      resolveDocumentForPage(
        [says(A, { title: text('One') }), says(B, { title: text('Two') })],
        forPage('page.home'),
      ),
    );
    expect(message).toContain('metadata.title');
    expect(message).toContain(A);
    expect(message).toContain(B);
  });

  it('still refuses two owners disagreeing at the same page scope', () => {
    const at = onPage('page.home');
    const message = refusal(() =>
      resolveDocumentForPage(
        [says(A, { title: text('One') }, at), says(B, { title: text('Two') }, at)],
        forPage('page.home'),
      ),
    );
    expect(message).toContain('metadata.title');
  });

  it('does not treat a cross-scope override as a conflict', () => {
    expect(() =>
      resolveDocumentForPage(
        [says(A, { title: text('Site') }), says(B, { title: text('Page') }, onPage('page.home'))],
        forPage('page.home'),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

describe('structured data composes as a whole object', () => {
  it('is suppressed on a page that refuses it', () => {
    const document = resolveDocumentForPage(
      [
        org(A),
        noOrg(B, 'an unmatched address is not the organisation home', onPage('page.notFound')),
      ],
      forPage('page.notFound'),
    );
    expect(document.structuredData?.state).toBe('suppressed');
  });

  it('survives on every other page', () => {
    const contributions = [org(A), noOrg(B, 'not the organisation home', onPage('page.notFound'))];
    const home = resolveDocumentForPage(contributions, forPage('page.home'));
    expect(home.structuredData?.state).toBe('stated');
    if (home.structuredData?.state !== 'stated') throw new Error('narrowing failed');
    expect(home.structuredData.value['@type']).toBe('Organization');
  });

  it('replaces rather than merges when a page states a different organisation', () => {
    const document = resolveDocumentForPage(
      [org(A), org(A, { ...SITE, name: 'Other Ltd' }, onPage('page.home'))],
      forPage('page.home'),
    );
    if (document.structuredData?.state !== 'stated') throw new Error('narrowing failed');
    expect(document.structuredData.value.name).toBe('Other Ltd');
    // No deep merge: the page's object is the object, whole.
    expect(document.structuredData.value.url).toBe('https://acme.example');
  });

  it('de-duplicates an identical organisation at both scopes', () => {
    const document = resolveDocumentForPage(
      [org(A), org(A, SITE, onPage('page.home'))],
      forPage('page.home'),
    );
    if (document.structuredData?.state !== 'stated') throw new Error('narrowing failed');
    expect(document.structuredData.value).toEqual(resolveOrganization(SITE));
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('document guarantees are document-wide', () => {
  const contract = resolveAccessibilityContract(SITE);

  const guarantees = (owner: string, scope: DocumentScope = EVERY_PAGE): DocumentContribution => ({
    kind: 'document-guarantees',
    owner,
    reason: `${owner} states what the document holds`,
    scope,
    guarantees: stated(contract),
  });

  it('applies to every target', () => {
    for (const target of [SITE_TARGET, forPage('page.home'), forPage('page.notFound')]) {
      const document = resolveDocumentForPage([guarantees(A)], target);
      expect(document.guarantees?.state).toBe('stated');
    }
  });

  it('refuses a guarantee scoped to one page', () => {
    /*
     * Stage 31 recorded this as a suspicion and left it; the contract settles
     * it. Every guarantee is documented as holding on *every page* and is
     * checked against real built HTML, so a page that opted out would leave the
     * promise false for the whole project while still building.
     */
    const message = refusal(() =>
      resolveDocumentForPage([guarantees(A, onPage('page.notFound'))], forPage('page.notFound')),
    );
    expect(message).toContain('cannot be scoped to one page');
    expect(message).toContain(A);
  });

  it('refuses a page-scoped suppression of a guarantee', () => {
    const suppressedGuarantee: DocumentContribution = {
      kind: 'document-guarantees',
      owner: B,
      reason: 'this page opts out',
      scope: onPage('page.notFound'),
      guarantees: suppressed('this page opts out'),
    };
    const message = refusal(() =>
      resolveDocumentForPage([guarantees(A), suppressedGuarantee], forPage('page.notFound')),
    );
    expect(message).toContain('cannot be scoped to one page');
  });

  it('cannot silently remove a guarantee from a page', () => {
    // The point of the refusal: the bounded claim survives whole or not at all.
    const suppressedGuarantee: DocumentContribution = {
      kind: 'document-guarantees',
      owner: B,
      reason: 'this page opts out',
      scope: onPage('page.home'),
      guarantees: suppressed('this page opts out'),
    };
    expect(() =>
      resolveDocumentForPage([guarantees(A), suppressedGuarantee], forPage('page.home')),
    ).toThrow();
  });

  it('keeps the bounded contract intact when it is stated correctly', () => {
    const document = resolveDocumentForPage([guarantees(A)], forPage('page.home'));
    if (document.guarantees?.state !== 'stated') throw new Error('narrowing failed');
    expect(document.guarantees.value).toEqual(contract);
    // Both halves survive: the promises and the honest out-of-scope list.
    expect(document.guarantees.value.outOfScope).toContain('wcag-conformance');
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe('provenance survives inheritance', () => {
  const contributions = [
    says(A, { title: text('Acme Ltd'), description: text('Bespoke widgets.') }),
    says(B, { title: text('Page not found') }, onPage('page.notFound')),
  ];

  it('says an inherited field came from the document', () => {
    const composed = metaOn(contributions, forPage('page.notFound'));
    expect(composed.provenance.description?.from).toEqual(EVERY_PAGE);
    expect(composed.provenance.description?.owners).toEqual([A]);
  });

  it('says an overridden field came from the page', () => {
    const composed = metaOn(contributions, forPage('page.notFound'));
    expect(composed.provenance.title?.from).toEqual(onPage('page.notFound'));
    expect(composed.provenance.title?.owners).toEqual([B]);
  });

  it('keeps every claimant of a de-duplicated field', () => {
    const composed = metaOn(
      [says(A, { title: text('Acme Ltd') }), says(B, { title: text('Acme Ltd') })],
      forPage('page.home'),
    );
    expect(composed.provenance.title?.owners).toEqual([A, B]);
    expect(composed.provenance.title?.from).toEqual(EVERY_PAGE);
  });
});

// ---------------------------------------------------------------------------
// The real 404
// ---------------------------------------------------------------------------

describe('the not-found page, through the real contracts', () => {
  const at = onPage('page.notFound');

  const contributions: DocumentContribution[] = [
    says('feature:seo', metadataFromContract(resolveSeoContract(SITE))),
    says(
      'feature:seo',
      metadataFromContract(
        resolveSeoContract(SITE, { pageTitle: 'Page not found', noindex: true }),
      ),
      at,
    ),
    org('feature:structured-data'),
    noOrg('feature:structured-data', 'an unmatched address is not the organisation home', at),
  ];

  it('is not indexed', () => {
    expect(
      lit(metaOn(contributions, at.kind === 'page' ? forPage(at.role) : SITE_TARGET).value.robots),
    ).toBe('noindex, nofollow');
  });

  it('claims no canonical address', () => {
    /*
     * `canonical: urlValue('')` is a statement, not a gap. The contract means "emit no
     * canonical tag" by it - the generated Seo component does
     * `canonical !== '' && <link rel="canonical">` - so the page's empty value
     * overrides the inherited address rather than falling through to it.
     *
     * Absence is how a contributor says nothing, and `Partial<SeoContract>`
     * keeps the two apart. That is what made this rule definable at all.
     */
    expect(lit(metaOn(contributions, forPage('page.notFound')).value.canonical)).toBe('');
  });

  it('carries its own title', () => {
    expect(lit(metaOn(contributions, forPage('page.notFound')).value.title)).toBe(
      'Page not found - Acme Ltd',
    );
  });

  it('makes no organisation claim', () => {
    const document = resolveDocumentForPage(contributions, forPage('page.notFound'));
    expect(document.structuredData?.state).toBe('suppressed');
  });

  it('leaves the site indexable, canonical and described', () => {
    const site = metaOn(contributions, SITE_TARGET);
    expect(lit(site.value.robots)).toBe('index, follow');
    expect(lit(site.value.canonical)).toBe('https://acme.example/');
    const document = resolveDocumentForPage(contributions, SITE_TARGET);
    if (document.structuredData?.state !== 'stated') throw new Error('narrowing failed');
    expect(document.structuredData.value.name).toBe('Acme Ltd');
  });

  it('leaves the home page indexable and claiming the organisation', () => {
    const home = resolveDocumentForPage(contributions, forPage('page.home'));
    if (home.metadata?.state !== 'stated') throw new Error('narrowing failed');
    expect(lit(home.metadata.value.value.robots)).toBe('index, follow');
    expect(home.structuredData?.state).toBe('stated');
  });

  it('names no framework anywhere in the result', () => {
    const serialised = JSON.stringify([
      resolveDocumentForPage(contributions, SITE_TARGET),
      resolveDocumentForPage(contributions, forPage('page.home')),
      resolveDocumentForPage(contributions, forPage('page.notFound')),
    ]);
    for (const name of ['astro', 'Astro', '404.astro', 'BaseLayout', 'nextjs', 'tsx']) {
      expect(serialised, `the composed document mentions ${name}`).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('composition is permutation-independent', () => {
  const all: DocumentContribution[] = [
    says(A, { title: text('Acme Ltd') }),
    says(B, { description: text('Bespoke widgets.') }),
    says(C, { canonical: urlValue('') }, onPage('page.notFound')),
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

  it('is identical with the scope declarations reversed', () => {
    expect(render(all)).toBe(render([...all].reverse()));
  });

  it('is byte-identical across repeated runs', () => {
    expect(new Set([1, 2, 3].map(() => render(all))).size).toBe(1);
  });

  it('orders composed fields by the vocabulary, not by layer', () => {
    const forward = Object.keys(metaOn(all, forPage('page.notFound')).value);
    const backward = Object.keys(metaOn([...all].reverse(), forPage('page.notFound')).value);
    expect(forward).toEqual(backward);
    expect(forward).toEqual(['title', 'description', 'canonical']);
  });
});

// ---------------------------------------------------------------------------
// No fabrication
// ---------------------------------------------------------------------------

describe('composition invents nothing', () => {
  it('leaves a field nobody claimed absent at every target', () => {
    const contributions = [says(A, { title: text('Acme Ltd') })];
    for (const target of [SITE_TARGET, forPage('page.home'), forPage('page.notFound')]) {
      const composed = metaOn(contributions, target);
      expect('canonical' in composed.value, JSON.stringify(target)).toBe(false);
      expect('description' in composed.value).toBe(false);
    }
  });

  it('never manufactures a domain for a page', () => {
    const bare: SiteContext = {
      name: 'Acme Ltd',
      url: null,
      description: '',
      locale: 'en',
      author: null,
    };
    const composed = metaOn(
      [
        says(A, metadataFromContract(resolveSeoContract(bare))),
        says(B, { title: text('Page not found') }, onPage('page.notFound')),
      ],
      forPage('page.notFound'),
    );
    expect(lit(composed.value.canonical)).toBe('');
    expect(JSON.stringify(composed)).not.toContain('example.com');
    expect(JSON.stringify(composed)).not.toContain('localhost');
  });

  it('adds no key of its own to a composed statement', () => {
    const contract = resolveSeoContract(SITE);
    const composed = metaOn([says(A, metadataFromContract(contract))], forPage('page.home'));
    expect(Object.keys(composed.value).sort()).toEqual(Object.keys(contract).sort());
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the scope resolver is framework- and feature-independent', () => {
  const FILE = 'src/domain/document-scope.ts';

  it('imports no filesystem, process or framework module', () => {
    const text = source(FILE);
    for (const module of [
      'node:fs',
      'node:path',
      'node:process',
      'node:os',
      'node:child_process',
    ]) {
      expect(text, `${FILE} imports ${module}`).not.toContain(`'${module}'`);
    }
    for (const module of ['react', 'next', 'astro', '@mui', 'tailwind', 'vite']) {
      expect(text.toLowerCase(), `${FILE} imports ${module}`).not.toContain(`from '${module}`);
    }
  });

  it('imports no adapter, template or feature module', () => {
    const text = source(FILE);
    for (const module of ['../adapters/', '../templates/', '../features/']) {
      expect(text, `${FILE} imports ${module}`).not.toContain(module);
    }
  });

  it('branches on no framework, feature or owner identity', () => {
    const text = codeOnly(FILE).toLowerCase();
    for (const name of ['astro', 'nextjs', 'react', 'feature:']) {
      expect(text, `${FILE} branches on ${name}`).not.toContain(`'${name}`);
    }
    expect(text).not.toMatch(/framework\s*[=!]==/);
    expect(text).not.toMatch(/owner\s*===\s*'/);
  });

  it('introduces no routing vocabulary', () => {
    /*
     * The scope vocabulary stays semantic. A routing-aware scope system is a
     * different problem and would need its own stage.
     */
    const text = codeOnly(FILE);
    for (const token of ['pathname', 'RegExp', 'glob', 'match(', 'route', 'URL(']) {
      expect(text, `${FILE} mentions ${token}`).not.toContain(token);
    }
  });

  it('carries no markup and no untyped bag', () => {
    const text = codeOnly(FILE);
    for (const token of ['ReactNode', 'JSX', '<script', '<meta', '<html']) {
      expect(text, `${FILE} mentions ${token}`).not.toContain(token);
    }
    expect(text).not.toContain('Record<string, string>');
    expect(text).not.toContain(': any');
  });

  it('is resolved per target by the bridge, and builds no shell', () => {
    // Stage 33 asserted nothing imported this. Stage 44 connected it: the
    // bridge asks for one target at a time and never composes scopes itself.
    const bridge = source('src/adapters/bridge.ts');
    expect(bridge).toContain('resolveDocumentForPage(documents, target)');
    const text = source(FILE);
    for (const name of ['emitDocumentShell', 'renderHead', 'serialise']) {
      expect(text, `${name} belongs to a later stage`).not.toContain(name);
    }
  });
});

/** Every target resolves to the documented shape. */
const _shape: (document: ResolvedPageDocument) => DocumentTarget = (document) => document.target;
void _shape;
