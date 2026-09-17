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
import {
  METADATA_FIELDS,
  resolveDocumentContributions,
} from '../src/domain/document-resolution.js';
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
 * Field-level document resolution.
 *
 * Stage 31 arbitrated whole statements, which was too coarse in one direction
 * and too quiet in the other: two owners setting disjoint metadata fields were
 * refused for disagreeing when they had not, and when they genuinely did
 * disagree the diagnostic could not say about what.
 *
 * The rule the whole layer is built around, and the one every test here is
 * ultimately protecting:
 *
 *     deterministic ordering  is not  semantic precedence
 *
 * Contributions are ordered so the output is reproducible. Nothing reads that
 * order to decide whose value wins, because nothing decides that at all.
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

/** A metadata statement that speaks to only the fields it is given. */
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

const metadataOf = (contributions: readonly DocumentContribution[], scope = EVERY_PAGE) => {
  const entry = resolveDocumentContributions(contributions).find(
    (candidate) =>
      candidate.kind === 'metadata' && JSON.stringify(candidate.scope) === JSON.stringify(scope),
  );
  if (entry?.kind !== 'metadata' || entry.metadata.state !== 'stated') {
    throw new Error('expected a stated metadata entry');
  }
  return entry.metadata.value;
};

// ---------------------------------------------------------------------------
// Generic contributors
// ---------------------------------------------------------------------------

describe('compatible claims merge', () => {
  it('combines disjoint fields from two owners', () => {
    /*
     * The case Stage 31 refused. A and B are not disagreeing - they are
     * describing different parts of one page - and a system that rejects this
     * prevents composition it has no reason to prevent.
     */
    const resolved = metadataOf([
      says(A, { title: text('Acme Ltd'), description: text('Bespoke widgets.') }),
      says(B, { canonical: urlValue('https://acme.example/') }),
    ]);

    expect(lit(resolved.value.title)).toBe('Acme Ltd');
    expect(lit(resolved.value.description)).toBe('Bespoke widgets.');
    expect(lit(resolved.value.canonical)).toBe('https://acme.example/');
  });

  it('traces every merged field to the owner that claimed it', () => {
    const resolved = metadataOf([
      says(A, { title: text('Acme Ltd') }),
      says(B, { canonical: urlValue('https://acme.example/') }),
    ]);
    expect(resolved.provenance.title?.owners).toEqual([A]);
    expect(resolved.provenance.canonical?.owners).toEqual([B]);
  });

  it('merges three owners across three fields', () => {
    const resolved = metadataOf([
      says(C, { canonical: urlValue('https://acme.example/') }),
      says(A, { title: text('Acme Ltd') }),
      says(B, { description: text('Bespoke widgets.') }),
    ]);
    expect(Object.keys(resolved.value).sort()).toEqual(['canonical', 'description', 'title']);
  });
});

describe('identical claims deduplicate', () => {
  it('collapses one field claimed twice, keeping both claimants', () => {
    const resolved = metadataOf([
      says(A, { title: text('Acme Ltd') }),
      says(B, { title: text('Acme Ltd') }),
    ]);
    expect(lit(resolved.value.title)).toBe('Acme Ltd');
    expect(resolved.provenance.title?.owners).toEqual([A, B]);
    expect(resolved.provenance.title?.reasons).toHaveLength(2);
  });

  it('collapses two identical whole contracts', () => {
    const contract = resolveSeoContract(SITE);
    const resolved = metadataOf([
      says(A, metadataFromContract(contract)),
      says(B, metadataFromContract(contract)),
    ]);
    expect(resolved.value).toEqual(metadataFromContract(contract));
    for (const field of METADATA_FIELDS) {
      expect(resolved.provenance[field]?.owners, field).toEqual([A, B]);
    }
  });

  it('collapses an identical nested social block', () => {
    const contract = resolveSeoContract(SITE);
    const resolved = metadataOf([
      says(A, { openGraph: literal('open-graph', contract.openGraph) }),
      says(B, { openGraph: literal('open-graph', contract.openGraph) }),
    ]);
    expect(lit(resolved.value.openGraph)).toEqual(contract.openGraph);
    expect(resolved.provenance.openGraph?.owners).toEqual([A, B]);
  });
});

describe('incompatible claims conflict', () => {
  it('refuses two different titles, naming the field and both owners', () => {
    const message = refusal(() =>
      resolveDocumentContributions([
        says(A, { title: text('Acme Ltd') }),
        says(B, { title: text('Other Company') }),
      ]),
    );
    expect(message).toContain('metadata.title');
    expect(message).toContain(A);
    expect(message).toContain(B);
    expect(message).toContain('Acme Ltd');
    expect(message).toContain('Other Company');
    expect(message).toContain('every page');
  });

  it('conflicts on the field that differs, not on the whole statement', () => {
    // A and B agree about the title and differ about the canonical. The
    // diagnostic has to say canonical, or it is the Stage 31 message again.
    const message = refusal(() =>
      resolveDocumentContributions([
        says(A, { title: text('Acme Ltd'), canonical: urlValue('https://acme.example/') }),
        says(B, { title: text('Acme Ltd'), canonical: urlValue('https://other.example/') }),
      ]),
    );
    expect(message).toContain('metadata.canonical');
    expect(message).not.toContain('metadata.title');
  });

  it('refuses two different robots directives rather than combining them', () => {
    /*
     * Not concatenated, and no safety-biased winner either. Preferring
     * `noindex` would be defensible and is still invented precedence - the
     * page-specific scope below is how the 404 gets its own answer.
     */
    const message = refusal(() =>
      resolveDocumentContributions([
        says(A, { robots: text('index, follow') }),
        says(B, { robots: text('noindex, nofollow') }),
      ]),
    );
    expect(message).toContain('metadata.robots');
    expect(message).not.toContain('index, follow noindex');
  });

  it('refuses two social blocks that differ anywhere inside', () => {
    const contract = resolveSeoContract(SITE);
    const message = refusal(() =>
      resolveDocumentContributions([
        says(A, { openGraph: literal('open-graph', contract.openGraph) }),
        says(B, {
          openGraph: literal('open-graph', { ...contract.openGraph, title: 'Something else' }),
        }),
      ]),
    );
    expect(message).toContain('metadata.openGraph');
  });

  it('never resolves a conflict by picking the first or last owner', () => {
    // Both orders raise; neither silently produces a value.
    const forward = refusal(() =>
      resolveDocumentContributions([
        says(A, { title: text('One') }),
        says(B, { title: text('Two') }),
      ]),
    );
    const backward = refusal(() =>
      resolveDocumentContributions([
        says(B, { title: text('Two') }),
        says(A, { title: text('One') }),
      ]),
    );
    expect(forward).not.toBe('');
    expect(backward).not.toBe('');
    expect(forward).toBe(backward);
  });
});

// ---------------------------------------------------------------------------
// The social blocks resolve whole, and why
// ---------------------------------------------------------------------------

describe('Open Graph and Twitter resolve as units', () => {
  it('does not let one owner set the title and another the social title', () => {
    /*
     * The correctness rule behind the compound treatment. `resolveSeoContract`
     * derives `openGraph.title` from `title`, so taking each from a different
     * owner would emit a document whose <title> and og:title disagree - valid
     * HTML, a clean build, and wrong in the only place it matters.
     *
     * Merging them is still allowed when they are disjoint claims; what is
     * asserted here is that the block is never merged *into*, so a partial
     * social block cannot be assembled from two owners.
     */
    const contract = resolveSeoContract(SITE);
    const resolved = metadataOf([
      says(A, { title: text(contract.title) }),
      says(B, { openGraph: literal('open-graph', contract.openGraph) }),
    ]);
    expect(lit(resolved.value.openGraph)).toEqual(contract.openGraph);
    expect(lit(resolved.value.openGraph).title).toBe(contract.title);
    // One owner owns the whole block.
    expect(resolved.provenance.openGraph?.owners).toEqual([B]);
  });

  it('treats a social block as one field, never as six', () => {
    expect([...METADATA_FIELDS]).toEqual([
      'title',
      'description',
      'robots',
      'canonical',
      'openGraph',
      'twitter',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('scope is part of identity', () => {
  it('keeps a page title separate from the site title', () => {
    const contributions = [
      says(A, { title: text('Acme Ltd') }),
      says(A, { title: text('Page not found') }, onPage('page.notFound')),
    ];
    expect(lit(metadataOf(contributions).value.title)).toBe('Acme Ltd');
    expect(lit(metadataOf(contributions, onPage('page.notFound')).value.title)).toBe(
      'Page not found',
    );
  });

  it('does not let a site-wide claim conflict with a page claim', () => {
    expect(() =>
      resolveDocumentContributions([
        says(A, { robots: text('index, follow') }),
        says(B, { robots: text('noindex, nofollow') }, onPage('page.notFound')),
      ]),
    ).not.toThrow();
  });

  it('resolves each scope independently, with no inheritance', () => {
    /*
     * Deliberate. How a page's statement relates to the document's is a
     * composition question, and inventing a rule for it here would be
     * precedence by another name. Each scope resolves on its own and a later
     * composer decides.
     */
    const entries = resolveDocumentContributions([
      says(A, { title: text('Acme Ltd'), description: text('Bespoke widgets.') }),
      says(A, { title: text('Page not found') }, onPage('page.notFound')),
    ]);
    const page = entries.find((entry) => entry.scope.kind === 'page');
    if (page?.kind !== 'metadata' || page.metadata.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    // The description is not inherited from the site-wide statement.
    expect(page.metadata.value.value.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stance
// ---------------------------------------------------------------------------

describe('stance resolution', () => {
  const org = resolveOrganization(SITE);

  const orgFrom = (owner: string, scope: DocumentScope = EVERY_PAGE): DocumentContribution => ({
    kind: 'structured-data',
    owner,
    reason: `${owner} describes the organisation`,
    scope,
    jsonLd: stated(org),
  });

  const refusedFrom = (
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

  it('stated + stated identical deduplicates', () => {
    const [entry] = resolveDocumentContributions([orgFrom(A), orgFrom(B)]);
    if (entry?.kind !== 'structured-data' || entry.jsonLd.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(entry.jsonLd.value).toEqual(org);
    expect(entry.owners).toEqual([A, B]);
  });

  it('stated + suppressed is a conflict', () => {
    const message = refusal(() =>
      resolveDocumentContributions([orgFrom(A), refusedFrom(B, 'not the organisation home')]),
    );
    expect(message).toContain('structured-data');
    expect(message).toContain('(suppressed)');
    expect(message).toContain(A);
    expect(message).toContain(B);
  });

  it('suppressed + suppressed agrees, keeping both reasons', () => {
    /*
     * Two owners refusing to state something agree about the document even if
     * they explain it differently, so the reason is provenance rather than
     * semantic content - the treatment `reason` gets everywhere else.
     */
    const [entry] = resolveDocumentContributions([
      refusedFrom(A, 'an unmatched address is not the organisation home'),
      refusedFrom(B, 'this page makes no organisation claim'),
    ]);
    if (entry?.kind !== 'structured-data' || entry.jsonLd.state !== 'suppressed') {
      throw new Error('narrowing failed');
    }
    expect(entry.jsonLd.becauses).toHaveLength(2);
    expect(entry.owners).toEqual([A, B]);
  });

  it('absent contributes nothing at all', () => {
    expect(resolveDocumentContributions([])).toEqual([]);
    // And an absent field stays absent rather than becoming a value.
    const resolved = metadataOf([says(A, { title: text('Acme Ltd') })]);
    expect('description' in resolved.value).toBe(false);
    expect(resolved.provenance.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Structured data and accessibility are not metadata
// ---------------------------------------------------------------------------

describe('structured data resolves as one organisation', () => {
  it('refuses two different organisations rather than merging them', () => {
    const message = refusal(() =>
      resolveDocumentContributions([
        {
          kind: 'structured-data',
          owner: A,
          reason: 'a',
          scope: EVERY_PAGE,
          jsonLd: stated(resolveOrganization(SITE)),
        },
        {
          kind: 'structured-data',
          owner: B,
          reason: 'b',
          scope: EVERY_PAGE,
          jsonLd: stated(resolveOrganization({ ...SITE, name: 'Other Ltd' })),
        },
      ]),
    );
    expect(message).toContain('structured-data');
    // Named as a whole, not as a field: the granularity is the object.
    expect(message).not.toContain('structured-data.name');
  });

  it('never deep-merges two organisation objects', () => {
    const bare = resolveOrganization({ ...SITE, url: null });
    const full = resolveOrganization(SITE);
    // `full` has a url, `bare` does not. A deep merge would produce one object
    // carrying the union; the resolver refuses instead.
    expect(
      refusal(() =>
        resolveDocumentContributions([
          {
            kind: 'structured-data',
            owner: A,
            reason: 'a',
            scope: EVERY_PAGE,
            jsonLd: stated(bare),
          },
          {
            kind: 'structured-data',
            owner: B,
            reason: 'b',
            scope: EVERY_PAGE,
            jsonLd: stated(full),
          },
        ]),
      ),
    ).not.toBe('');
  });
});

describe('accessibility resolves as one contract', () => {
  const contract = resolveAccessibilityContract(SITE);

  const guaranteesFrom = (owner: string, value = contract): DocumentContribution => ({
    kind: 'document-guarantees',
    owner,
    reason: `${owner} states what the document holds`,
    scope: EVERY_PAGE,
    guarantees: stated(value),
  });

  it('deduplicates identical guarantees', () => {
    const [entry] = resolveDocumentContributions([guaranteesFrom(A), guaranteesFrom(B)]);
    if (entry?.kind !== 'document-guarantees' || entry.guarantees.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(entry.guarantees.value).toEqual(contract);
    expect(entry.owners).toEqual([A, B]);
  });

  it('refuses two different document languages', () => {
    const message = refusal(() =>
      resolveDocumentContributions([
        guaranteesFrom(A),
        guaranteesFrom(B, resolveAccessibilityContract({ ...SITE, locale: 'de' })),
      ]),
    );
    expect(message).toContain('document-guarantees');
  });

  it('does not union guarantees from separate owners', () => {
    /*
     * A guarantee is a promise about generated output. Unioning promises would
     * let two owners jointly assert something neither verified, so a partial
     * list is a disagreement rather than a contribution to a set.
     */
    const fewer = { ...contract, guarantees: contract.guarantees.slice(0, 2) };
    expect(
      refusal(() => resolveDocumentContributions([guaranteesFrom(A), guaranteesFrom(B, fewer)])),
    ).not.toBe('');
  });

  it('is never resolved through the metadata field machinery', () => {
    const [entry] = resolveDocumentContributions([guaranteesFrom(A)]);
    if (entry?.kind !== 'document-guarantees') throw new Error('narrowing failed');
    expect('provenance' in (entry.guarantees as object)).toBe(false);
    expect(JSON.stringify(entry)).not.toContain('openGraph');
  });
});

// ---------------------------------------------------------------------------
// The 404
// ---------------------------------------------------------------------------

describe('the not-found page survives resolution', () => {
  const notFound = onPage('page.notFound');

  const contributions: DocumentContribution[] = [
    says('feature:seo', metadataFromContract(resolveSeoContract(SITE))),
    says(
      'feature:seo',
      metadataFromContract(
        resolveSeoContract(SITE, { pageTitle: 'Page not found', noindex: true }),
      ),
      notFound,
    ),
    {
      kind: 'structured-data',
      owner: 'feature:structured-data',
      reason: 'what machines should be told about the organisation',
      scope: EVERY_PAGE,
      jsonLd: stated(resolveOrganization(SITE)),
    },
    {
      kind: 'structured-data',
      owner: 'feature:structured-data',
      reason: 'an unmatched address is not the organisation home',
      scope: notFound,
      jsonLd: suppressed('an unmatched address is not the organisation home'),
    },
  ];

  it('keeps noindex on the page and index on the site', () => {
    expect(lit(metadataOf(contributions, notFound).value.robots)).toBe('noindex, nofollow');
    expect(lit(metadataOf(contributions).value.robots)).toBe('index, follow');
  });

  it('keeps the page free of a canonical address', () => {
    expect(lit(metadataOf(contributions, notFound).value.canonical)).toBe('');
    expect(lit(metadataOf(contributions).value.canonical)).toBe('https://acme.example/');
  });

  it('keeps the structured-data suppression on the page only', () => {
    const entries = resolveDocumentContributions(contributions);

    const onNotFound = entries.find(
      (entry) => entry.kind === 'structured-data' && entry.scope.kind === 'page',
    );
    if (onNotFound?.kind !== 'structured-data') throw new Error('narrowing failed');
    expect(onNotFound.jsonLd.state).toBe('suppressed');

    const siteWide = entries.find(
      (entry) => entry.kind === 'structured-data' && entry.scope.kind === 'every-page',
    );
    if (siteWide?.kind !== 'structured-data' || siteWide.jsonLd.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(siteWide.jsonLd.value['@type']).toBe('Organization');
    expect(siteWide.jsonLd.value.name).toBe('Acme Ltd');
  });

  it('resolves the same however the contributions arrive', () => {
    const forward = JSON.stringify(resolveDocumentContributions(contributions));
    const backward = JSON.stringify(resolveDocumentContributions([...contributions].reverse()));
    expect(forward).toBe(backward);
  });

  it('names no framework anywhere in the resolved result', () => {
    const serialised = JSON.stringify(resolveDocumentContributions(contributions));
    for (const name of ['astro', 'Astro', '404.astro', 'BaseLayout', 'nextjs', 'tsx', '.astro']) {
      expect(serialised, `the resolved 404 mentions ${name}`).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('resolution is permutation-independent', () => {
  const all: DocumentContribution[] = [
    says(A, { title: text('Acme Ltd') }),
    says(B, { description: text('Bespoke widgets.') }),
    says(C, { canonical: urlValue('https://acme.example/') }),
  ];

  it('is identical under all six permutations', () => {
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => order.map((index) => all[index]!) as DocumentContribution[]);

    const rendered = permutations.map((order) =>
      JSON.stringify(resolveDocumentContributions(order)),
    );
    expect(new Set(rendered).size).toBe(1);
  });

  it('orders resolved fields by the vocabulary, not by arrival', () => {
    const forward = Object.keys(metadataOf(all).value);
    const backward = Object.keys(metadataOf([...all].reverse()).value);
    expect(forward).toEqual(backward);
    expect(forward).toEqual(['title', 'description', 'canonical']);
  });

  it('is byte-identical across repeated runs', () => {
    const runs = [1, 2, 3].map(() => JSON.stringify(resolveDocumentContributions(all)));
    expect(new Set(runs).size).toBe(1);
  });

  it('produces the same conflict message however the input is ordered', () => {
    const one = refusal(() =>
      resolveDocumentContributions([
        says(A, { title: text('One') }),
        says(C, { title: text('Two') }),
      ]),
    );
    const two = refusal(() =>
      resolveDocumentContributions([
        says(C, { title: text('Two') }),
        says(A, { title: text('One') }),
      ]),
    );
    expect(one).toBe(two);
  });
});

// ---------------------------------------------------------------------------
// No fabrication
// ---------------------------------------------------------------------------

describe('the resolver invents nothing', () => {
  const bare: SiteContext = {
    name: 'Acme Ltd',
    url: null,
    description: '',
    locale: 'en',
    author: null,
  };

  it('leaves an unclaimed field absent', () => {
    const resolved = metadataOf([says(A, { title: text('Acme Ltd') })]);
    for (const field of METADATA_FIELDS) {
      if (field === 'title') continue;
      expect(field in resolved.value, field).toBe(false);
    }
  });

  it('never manufactures a domain', () => {
    const resolved = metadataOf([says(A, metadataFromContract(resolveSeoContract(bare)))]);
    expect(lit(resolved.value.canonical)).toBe('');
    expect(JSON.stringify(resolved)).not.toContain('example.com');
    expect(JSON.stringify(resolved)).not.toContain('localhost');
  });

  it('never manufactures an organisation field', () => {
    const [entry] = resolveDocumentContributions([
      {
        kind: 'structured-data',
        owner: A,
        reason: 'a',
        scope: EVERY_PAGE,
        jsonLd: stated(resolveOrganization(bare)),
      },
    ]);
    if (entry?.kind !== 'structured-data' || entry.jsonLd.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect('url' in entry.jsonLd.value).toBe(false);
    expect('description' in entry.jsonLd.value).toBe(false);
  });

  it('adds no key of its own to a resolved statement', () => {
    const contract = resolveSeoContract(SITE);
    const resolved = metadataOf([says(A, metadataFromContract(contract))]);
    expect(Object.keys(resolved.value).sort()).toEqual(Object.keys(contract).sort());
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the resolver is framework- and feature-independent', () => {
  const FILE = 'src/domain/document-resolution.ts';

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

  it('branches on no framework or feature identity', () => {
    const text = codeOnly(FILE).toLowerCase();
    for (const name of ['astro', 'nextjs', 'react', 'seo', 'structured-data', 'accessibility']) {
      expect(text, `${FILE} branches on ${name}`).not.toContain(`'feature:${name}'`);
    }
    expect(text).not.toMatch(/framework\s*[=!]==/);
    expect(text).not.toMatch(/owner\s*===\s*'/);
  });

  it('carries no markup and no untyped bag as its result', () => {
    const text = codeOnly(FILE);
    for (const token of ['ReactNode', 'JSX', '<script', '<meta', '<html', 'innerHTML']) {
      expect(text, `${FILE} mentions ${token}`).not.toContain(token);
    }
    expect(text).not.toContain('Record<string, string>');
    expect(text).not.toContain(': any');
  });

  it('is imported by no adapter', () => {
    // Stage 32 still ends at the domain. Nothing generated changes.
    const bridge = source('src/adapters/bridge.ts');
    expect(bridge).not.toContain('document-resolution');
    expect(bridge).not.toContain('resolveDocumentContributions');
  });

  it('builds no emitter', () => {
    const text = source(FILE);
    for (const name of ['emitDocumentShell', 'renderHead', 'serialiseHead']) {
      expect(text, `${name} belongs to a later stage`).not.toContain(name);
    }
  });
});
