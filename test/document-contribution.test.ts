import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AccessibilityContract } from '../src/domain/accessibility.js';
import {
  ACCESSIBILITY_GUARANTEES,
  resolveAccessibilityContract,
} from '../src/domain/accessibility.js';
import type {
  DocumentContribution,
  DocumentScope,
  MetadataContribution,
  StructuredDataContribution,
} from '../src/domain/document-contribution.js';
import {
  canonicalDocumentContributions,
  DOCUMENT_CONTRIBUTION_KINDS,
  documentContributionIdentity,
  EVERY_PAGE,
  GUARANTEE_SURFACES,
  guaranteesOnSurface,
  onPage,
  scopeKey,
  stated,
  suppressed,
} from '../src/domain/document-contribution.js';
import type { SeoContract } from '../src/domain/seo.js';
import { resolveSeoContract } from '../src/domain/seo.js';
import type { OrganizationContract } from '../src/domain/structured-data.js';
import { resolveOrganization, serialiseOrganization } from '../src/domain/structured-data.js';
import type { CliError } from '../src/errors.js';
import type { SiteContext } from '../src/types.js';

/**
 * The document contribution payload model.
 *
 * Stage 30 stopped because a document composer needs a payload and there was no
 * model for one. This is the model, tested two ways: first with contributors
 * that mean nothing, to prove the shape is genuinely generic rather than three
 * features in a trench coat; then against the three real contracts, to prove it
 * can carry them without losing anything.
 *
 * The most important test in this file is the 404 one. It is the correctness
 * fact Stage 30 found sitting in a framework template prop, and the model
 * exists largely so that it can be said in the domain.
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

// ---------------------------------------------------------------------------
// Generic contributors, which mean nothing
// ---------------------------------------------------------------------------

/**
 * Three owners with no semantics of their own.
 *
 * Named A, B and C on purpose. If the model only worked when the owners were
 * called `feature:seo` and friends, it would be today's three features wearing
 * a type, and the next concern to arrive would not fit.
 */
const A = 'contributor:a';
const B = 'contributor:b';
const C = 'contributor:c';

const someMetadata = (title: string): SeoContract => resolveSeoContract(SITE, { pageTitle: title });

const metadataFrom = (
  owner: string,
  contract: SeoContract,
  scope: DocumentScope = EVERY_PAGE,
): MetadataContribution => ({
  kind: 'metadata',
  owner,
  reason: 'it describes the page',
  scope,
  metadata: stated(contract),
});

const jsonLdFrom = (
  owner: string,
  contract: OrganizationContract,
  scope: DocumentScope = EVERY_PAGE,
): StructuredDataContribution => ({
  kind: 'structured-data',
  owner,
  reason: 'it describes the organisation',
  scope,
  jsonLd: stated(contract),
});

const guaranteesFrom = (
  owner: string,
  contract: AccessibilityContract,
  scope: DocumentScope = EVERY_PAGE,
): DocumentContribution => ({
  kind: 'document-guarantees',
  owner,
  reason: 'it states what the document holds',
  scope,
  guarantees: stated(contract),
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

describe('the model is generic', () => {
  it('carries three kinds that are not each other', () => {
    expect([...DOCUMENT_CONTRIBUTION_KINDS]).toEqual([
      'metadata',
      'structured-data',
      'document-guarantees',
    ]);
    expect(new Set(DOCUMENT_CONTRIBUTION_KINDS).size).toBe(3);
  });

  it('identifies a statement by what it is about, not by who said it', () => {
    /*
     * Owner-free identity is what makes a collision detectable at all. Were the
     * owner part of it, every contribution would be unique and two adapters
     * describing one page differently would both be kept.
     */
    const a = metadataFrom(A, someMetadata('One'));
    const b = metadataFrom(B, someMetadata('One'));
    expect(documentContributionIdentity(a)).toBe(documentContributionIdentity(b));

    const scoped = metadataFrom(A, someMetadata('One'), onPage('page.notFound'));
    expect(documentContributionIdentity(scoped)).not.toBe(documentContributionIdentity(a));
  });

  it('keeps statements of different kinds about one page apart', () => {
    const entries = canonicalDocumentContributions([
      metadataFrom(A, someMetadata('One')),
      jsonLdFrom(B, resolveOrganization(SITE)),
      guaranteesFrom(C, resolveAccessibilityContract(SITE)),
    ]);
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'metadata',
      'structured-data',
      'document-guarantees',
    ]);
  });

  it('de-duplicates an identical statement and keeps every claimant', () => {
    // The `collectClaims` rule, inherited rather than reinvented: agreement is
    // cooperation, and "why is this here?" has as many answers as claimants.
    const contract = someMetadata('One');
    const entries = canonicalDocumentContributions([
      metadataFrom(A, contract),
      metadataFrom(C, contract),
      metadataFrom(B, contract),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.owners).toEqual([A, B, C]);
  });

  it('refuses two owners describing one statement differently', () => {
    const message = refusal(() =>
      canonicalDocumentContributions([
        metadataFrom(A, someMetadata('One')),
        metadataFrom(B, someMetadata('Two')),
      ]),
    );
    expect(message).toContain('metadata');
    expect(message).toContain(A);
    expect(message).toContain(B);
    expect(message).toContain('every page');
  });

  it('refuses a disagreement about whether to say anything at all', () => {
    /*
     * The case a two-state model cannot even express. One owner states the
     * organisation, another says it must not appear - that is a real
     * disagreement and must surface as one, not resolve to whichever ran first.
     */
    const message = refusal(() =>
      canonicalDocumentContributions([
        jsonLdFrom(A, resolveOrganization(SITE)),
        {
          kind: 'structured-data',
          owner: B,
          reason: 'this page must make no organisation claim',
          scope: EVERY_PAGE,
          jsonLd: suppressed('it is not the organisation home'),
        },
      ]),
    );
    expect(message).toContain('structured-data');
    expect(message).toContain('suppressed');
  });

  it('lets the same kind differ between scopes without conflicting', () => {
    const entries = canonicalDocumentContributions([
      jsonLdFrom(A, resolveOrganization(SITE)),
      {
        kind: 'structured-data',
        owner: A,
        reason: 'an unmatched address is not the organisation home',
        scope: onPage('page.notFound'),
        jsonLd: suppressed('an unmatched address is not the organisation home'),
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => scopeKey(entry.scope))).toEqual(['', 'page:page.notFound']);
  });
});

// ---------------------------------------------------------------------------
// Three states, not two
// ---------------------------------------------------------------------------

describe('stated, suppressed and absent stay distinguishable', () => {
  it('distinguishes a refusal from a silence', () => {
    const absent = canonicalDocumentContributions([]);
    expect(absent).toHaveLength(0);

    const [entry] = canonicalDocumentContributions([
      {
        kind: 'structured-data',
        owner: A,
        reason: 'suppressed here',
        scope: EVERY_PAGE,
        jsonLd: suppressed('nothing to claim'),
      },
    ]);
    expect(entry?.kind).toBe('structured-data');
    if (entry?.kind !== 'structured-data') throw new Error('narrowing failed');
    expect(entry.jsonLd.state).toBe('suppressed');
    // A suppression is a decision, so it carries the reason for the decision.
    if (entry.jsonLd.state !== 'suppressed') throw new Error('narrowing failed');
    expect(entry.jsonLd.because).toBe('nothing to claim');
  });

  it('never represents a suppression as an absent value', () => {
    /*
     * The mistake the three-state shape exists to prevent. If suppression were
     * `undefined`, a later composer filling in a missing statement would
     * silently restore one somebody deliberately refused.
     */
    const suppression = suppressed<OrganizationContract>('no claim here');
    expect(suppression).not.toBeUndefined();
    expect('value' in suppression).toBe(false);
    expect(suppression.state).toBe('suppressed');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('canonical form is deterministic', () => {
  const all: DocumentContribution[] = [
    metadataFrom(A, someMetadata('One')),
    jsonLdFrom(B, resolveOrganization(SITE)),
    guaranteesFrom(C, resolveAccessibilityContract(SITE)),
  ];

  it('is identical under every permutation', () => {
    const permutations: DocumentContribution[][] = [
      [all[0]!, all[1]!, all[2]!],
      [all[1]!, all[2]!, all[0]!],
      [all[2]!, all[0]!, all[1]!],
      [all[2]!, all[1]!, all[0]!],
      [all[1]!, all[0]!, all[2]!],
      [all[0]!, all[2]!, all[1]!],
    ];
    const rendered = permutations.map((order) =>
      JSON.stringify(canonicalDocumentContributions(order)),
    );
    expect(new Set(rendered).size).toBe(1);
  });

  it('orders by the vocabulary, not by arrival', () => {
    // Reversing the input must not reverse the output.
    const forward = canonicalDocumentContributions(all).map((entry) => entry.kind);
    const backward = canonicalDocumentContributions([...all].reverse()).map((entry) => entry.kind);
    expect(forward).toEqual(backward);
    expect(forward).toEqual([...DOCUMENT_CONTRIBUTION_KINDS]);
  });

  it('orders claimants and reasons independently of arrival', () => {
    const contract = someMetadata('One');
    const one = canonicalDocumentContributions([
      metadataFrom(C, contract),
      metadataFrom(A, contract),
      metadataFrom(B, contract),
    ]);
    const two = canonicalDocumentContributions([
      metadataFrom(B, contract),
      metadataFrom(C, contract),
      metadataFrom(A, contract),
    ]);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one[0]?.owners).toEqual([A, B, C]);
  });

  it('is byte-identical across repeated runs', () => {
    const runs = [1, 2, 3].map(() => JSON.stringify(canonicalDocumentContributions(all)));
    expect(new Set(runs).size).toBe(1);
  });

  it('sorts scopes deterministically within one kind', () => {
    const entries = canonicalDocumentContributions([
      metadataFrom(A, someMetadata('Not found'), onPage('page.notFound')),
      metadataFrom(A, someMetadata('Home'), onPage('page.home')),
      metadataFrom(A, someMetadata('Site')),
    ]);
    expect(entries.map((entry) => scopeKey(entry.scope))).toEqual([
      '',
      'page:page.home',
      'page:page.notFound',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The three real contracts, carried without loss
// ---------------------------------------------------------------------------

describe('SEO is representable without semantic loss', () => {
  it('carries the whole contract, field for field', () => {
    const contract = resolveSeoContract(SITE);
    const [entry] = canonicalDocumentContributions([metadataFrom('feature:seo', contract)]);
    if (entry?.kind !== 'metadata') throw new Error('narrowing failed');
    if (entry.metadata.state !== 'stated') throw new Error('narrowing failed');

    // Round-trip, not a spot check: nothing may be dropped on the way in.
    expect(entry.metadata.value).toEqual(contract);
    expect(JSON.stringify(entry.metadata.value)).toBe(JSON.stringify(contract));
    for (const field of ['title', 'description', 'robots', 'canonical', 'openGraph', 'twitter']) {
      expect(entry.metadata.value, field).toHaveProperty(field);
    }
  });

  it('keeps Open Graph and Twitter as structures, not flattened strings', () => {
    const contract = resolveSeoContract(SITE);
    const [entry] = canonicalDocumentContributions([metadataFrom('feature:seo', contract)]);
    if (entry?.kind !== 'metadata' || entry.metadata.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(typeof entry.metadata.value.openGraph).toBe('object');
    expect(entry.metadata.value.openGraph.locale).toBe('en_GB');
    expect(typeof entry.metadata.value.twitter).toBe('object');
  });
});

describe('structured data stays structured', () => {
  it('carries the Organization object, not markup', () => {
    const contract = resolveOrganization(SITE);
    const [entry] = canonicalDocumentContributions([
      jsonLdFrom('feature:structured-data', contract),
    ]);
    if (entry?.kind !== 'structured-data' || entry.jsonLd.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(entry.jsonLd.value).toEqual(contract);
    expect(entry.jsonLd.value['@type']).toBe('Organization');
    expect(entry.jsonLd.value['@context']).toBe('https://schema.org');
    expect(typeof entry.jsonLd.value).toBe('object');
  });

  it('is never a script element or an HTML string anywhere in the model', () => {
    const contract = resolveOrganization(SITE);
    const serialised = JSON.stringify(
      canonicalDocumentContributions([jsonLdFrom('feature:structured-data', contract)]),
    );
    expect(serialised).not.toContain('<script');
    expect(serialised).not.toContain('application/ld+json');
    // Serialisation still exists, and still belongs to the contract module.
    expect(serialiseOrganization(contract)).toContain('"@type":"Organization"');
  });

  it('is not reachable as a metadata field', () => {
    // The flattening this stage exists to prevent: there is no path from a
    // metadata statement to an Organization.
    const contract = resolveSeoContract(SITE);
    const [entry] = canonicalDocumentContributions([metadataFrom('feature:seo', contract)]);
    if (entry?.kind !== 'metadata' || entry.metadata.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(JSON.stringify(entry.metadata.value)).not.toContain('schema.org');
    expect(JSON.stringify(entry.metadata.value)).not.toContain('@type');
  });
});

describe('accessibility stays a document guarantee', () => {
  it('carries the whole contract, including the out-of-scope half', () => {
    const contract = resolveAccessibilityContract(SITE);
    const [entry] = canonicalDocumentContributions([
      guaranteesFrom('feature:accessibility', contract),
    ]);
    if (entry?.kind !== 'document-guarantees' || entry.guarantees.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(entry.guarantees.value).toEqual(contract);
    // The honest half survives too. A model that carried only the promises
    // would turn a bounded claim into an unbounded one.
    expect(entry.guarantees.value.outOfScope).toContain('wcag-conformance');
    expect(entry.guarantees.value.documentLanguage).toBe('en-GB');
    expect(entry.guarantees.value.documentLanguageValid).toBe(true);
  });

  it('is not head markup, and the classification proves it', () => {
    /*
     * The evidence against the simplification a later stage will be tempted by.
     * Five of eight guarantees are body structure and one is an attribute on
     * the root element; only two are head entries.
     */
    expect(guaranteesOnSurface('head')).toEqual(['document-title', 'scalable-viewport']);
    expect(guaranteesOnSurface('document-element')).toEqual(['document-language']);
    expect(guaranteesOnSurface('document-structure')).toEqual([
      'main-landmark',
      'skip-link',
      'contentinfo-landmark',
      'primary-heading',
      'navigation-landmark-when-present',
    ]);
    expect(guaranteesOnSurface('document-structure').length).toBeGreaterThan(
      guaranteesOnSurface('head').length,
    );
  });

  it('classifies every guarantee exactly once', () => {
    for (const guarantee of ACCESSIBILITY_GUARANTEES) {
      expect(GUARANTEE_SURFACES[guarantee], guarantee).toBeDefined();
    }
    const counted = (['document-element', 'head', 'document-structure'] as const).flatMap(
      (surface) => guaranteesOnSurface(surface),
    );
    expect([...counted].sort()).toEqual([...ACCESSIBILITY_GUARANTEES].sort());
  });

  it('is not reachable as a metadata field', () => {
    const contract = resolveAccessibilityContract(SITE);
    const [entry] = canonicalDocumentContributions([
      guaranteesFrom('feature:accessibility', contract),
    ]);
    if (entry?.kind !== 'document-guarantees') throw new Error('narrowing failed');
    expect(JSON.stringify(entry)).not.toContain('meta name');
    expect(JSON.stringify(entry)).not.toContain('<meta');
  });
});

// ---------------------------------------------------------------------------
// The 404, which is why this stage exists
// ---------------------------------------------------------------------------

describe('the not-found page keeps both of its opt-outs', () => {
  /*
   * Stage 30's finding, said in the domain. These two facts lived only as props
   * on a framework's own layout - `noindex={true}` and `structuredData={false}`
   * - and a composed shell that could not carry them would have indexed a 404
   * and claimed it was the organisation's home. Both build, both pass a casual
   * review, and both are wrong.
   *
   * Nothing below names a framework, a file or a template.
   */
  const notFound = onPage('page.notFound');

  const contributions: DocumentContribution[] = [
    {
      kind: 'metadata',
      owner: 'feature:seo',
      reason: 'what an unmatched address should tell a crawler',
      scope: notFound,
      metadata: stated(
        resolveSeoContract(SITE, {
          pageTitle: 'Page not found',
          noindex: true,
        }),
      ),
    },
    {
      kind: 'structured-data',
      owner: 'feature:structured-data',
      reason: 'an unmatched address is not the organisation home',
      scope: notFound,
      jsonLd: suppressed('an unmatched address is not the organisation home'),
    },
  ];

  it('says the page must not be indexed', () => {
    const [entry] = canonicalDocumentContributions(contributions);
    if (entry?.kind !== 'metadata' || entry.metadata.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(entry.metadata.value.robots).toBe('noindex, nofollow');
    // And a blocked page claims no canonical address, which is the other half
    // of the same decision.
    expect(entry.metadata.value.canonical).toBe('');
    expect(entry.metadata.value.openGraph.url).toBe('');
    expect(entry.metadata.value.title).toBe('Page not found - Acme Ltd');
  });

  it('says the page must make no organisation claim', () => {
    const entry = canonicalDocumentContributions(contributions).find(
      (candidate) => candidate.kind === 'structured-data',
    );
    if (entry?.kind !== 'structured-data') throw new Error('narrowing failed');
    expect(entry.jsonLd.state).toBe('suppressed');
    if (entry.jsonLd.state !== 'suppressed') throw new Error('narrowing failed');
    expect(entry.jsonLd.because).toContain('not the organisation home');
  });

  it('keeps those statements separate from every other page', () => {
    /*
     * The scoping that makes the whole thing work: the site still states its
     * organisation everywhere else. A model that could only say one thing per
     * kind would have to choose between the 404 being correct and the site
     * having structured data at all.
     */
    const entries = canonicalDocumentContributions([
      ...contributions,
      jsonLdFrom('feature:structured-data', resolveOrganization(SITE)),
      metadataFrom('feature:seo', resolveSeoContract(SITE)),
    ]);
    expect(entries).toHaveLength(4);

    const siteWide = entries.find(
      (entry) => entry.kind === 'structured-data' && entry.scope.kind === 'every-page',
    );
    if (siteWide?.kind !== 'structured-data') throw new Error('narrowing failed');
    expect(siteWide.jsonLd.state).toBe('stated');

    const indexable = entries.find(
      (entry) => entry.kind === 'metadata' && entry.scope.kind === 'every-page',
    );
    if (indexable?.kind !== 'metadata' || indexable.metadata.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(indexable.metadata.value.robots).toBe('index, follow');
  });

  it('is expressed with no framework-specific field', () => {
    // The scope is a semantic role the generator already had, and the payload
    // is the contract the feature already computed. Nothing here is Astro.
    const serialised = JSON.stringify(contributions);
    for (const name of ['astro', 'Astro', '404.astro', 'BaseLayout', 'nextjs', 'tsx']) {
      expect(serialised, `the 404 statement mentions ${name}`).not.toContain(name);
    }
    expect(scopeKey(notFound)).toBe('page:page.notFound');
  });
});

// ---------------------------------------------------------------------------
// No fabrication
// ---------------------------------------------------------------------------

describe('the model invents nothing', () => {
  const bare: SiteContext = {
    name: 'Acme Ltd',
    url: null,
    description: '',
    locale: 'en',
    author: null,
  };

  it('carries absence through unchanged', () => {
    const contract = resolveSeoContract(bare);
    const [entry] = canonicalDocumentContributions([metadataFrom('feature:seo', contract)]);
    if (entry?.kind !== 'metadata' || entry.metadata.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(entry.metadata.value.canonical).toBe('');
    expect(entry.metadata.value.description).toBe('');
    expect(entry.metadata.value.openGraph.url).toBe('');
    // A bare primary subtag is not a valid og:locale, and stays omitted.
    expect(entry.metadata.value.openGraph.locale).toBe('');
  });

  it('omits an absent organisation field rather than filling it', () => {
    const contract = resolveOrganization(bare);
    const [entry] = canonicalDocumentContributions([
      jsonLdFrom('feature:structured-data', contract),
    ]);
    if (entry?.kind !== 'structured-data' || entry.jsonLd.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect('url' in entry.jsonLd.value).toBe(false);
    expect('description' in entry.jsonLd.value).toBe(false);
    expect(JSON.stringify(entry)).not.toContain('example.com');
    expect(JSON.stringify(entry)).not.toContain('localhost');
  });

  it('adds no value of its own to any contract it carries', () => {
    // The model is a wrapper, and a wrapper that added a field would be
    // inventing one. Compared key-for-key against what the contract produced.
    const contract = resolveSeoContract(bare);
    const [entry] = canonicalDocumentContributions([metadataFrom('feature:seo', contract)]);
    if (entry?.kind !== 'metadata' || entry.metadata.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(Object.keys(entry.metadata.value).sort()).toEqual(Object.keys(contract).sort());
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the model is architecture-neutral by construction', () => {
  const FILE = 'src/domain/document-contribution.ts';

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

  it('imports no adapter, template or registry module', () => {
    const text = source(FILE);
    for (const module of ['../adapters/', '../templates/', './adapters']) {
      expect(text, `${FILE} imports ${module}`).not.toContain(module);
    }
  });

  it('names no framework, architecture or feature in its logic', () => {
    const text = codeOnly(FILE).toLowerCase();
    for (const name of ['astro', 'nextjs', 'react', 'seo', 'mui', 'bootstrap', 'tailwind']) {
      expect(text, `${FILE} branches on ${name}`).not.toContain(`'${name}'`);
    }
    expect(text).not.toMatch(/framework\s*[=!]==/);
  });

  it('carries no markup, component reference or framework type', () => {
    /*
     * Comments stripped, because the module explains what it excludes - it says
     * JSON-LD is "never a `<script>` element here", which is the doc being
     * precise and would fail a scan of the raw text. What must not exist is a
     * markup token in the *types*, so the types are what gets scanned.
     */
    const text = codeOnly(FILE);
    for (const token of ['ReactNode', 'JSX', '<script', '<meta', '<html', 'importName', 'tsx']) {
      expect(text, `${FILE} mentions ${token} in the payload`).not.toContain(token);
    }
  });

  it('uses no untyped bag as its payload', () => {
    const text = codeOnly(FILE);
    expect(text).not.toContain('Record<string, unknown>');
    expect(text).not.toContain('Record<string, string>');
    expect(text).not.toContain('Record<string, any>');
    expect(text).not.toContain(': any');
  });
});

// ---------------------------------------------------------------------------
// Nothing was wired up
// ---------------------------------------------------------------------------

describe('the model is not yet connected to anything', () => {
  it('is imported by no adapter', () => {
    /*
     * Stage 31 ends at the payload. The features still contribute their
     * `ConfigContribution` claims exactly as they did, which is why no
     * generated file moves - and this asserts that rather than trusting it.
     */
    const adapters = path.resolve(import.meta.dirname, '..', 'src', 'adapters');
    for (const file of readFileSync(path.join(adapters, '..', 'domain', 'index.ts'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('document-contribution'))) {
      expect(file).toContain('./document-contribution.js');
    }
    const bridge = source('src/adapters/bridge.ts');
    expect(bridge).not.toContain('document-contribution');
    expect(bridge).not.toContain('canonicalDocumentContributions');
  });

  it('builds no composer', () => {
    const text = source('src/domain/document-contribution.ts');
    for (const name of [
      'collectDocumentContributions',
      'resolveDocumentComposition',
      'emitDocumentShell',
    ]) {
      expect(text, `${name} belongs to a later stage`).not.toContain(name);
    }
  });
});
