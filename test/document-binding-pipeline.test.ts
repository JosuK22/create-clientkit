import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
import type { DocumentTarget } from '../src/domain/document-scope.js';
import { forPage, resolveDocumentForPage, SITE_TARGET } from '../src/domain/document-scope.js';
import type {
  DocumentValue,
  DocumentValueType,
  LiteralTypes,
} from '../src/domain/document-value.js';
import { boundTo, derived, literal, ownerOf } from '../src/domain/document-value.js';
import { resolveSeoContract } from '../src/domain/seo.js';
import { resolveOrganization } from '../src/domain/structured-data.js';
import type { CliError } from '../src/errors.js';
import type { SiteContext } from '../src/types.js';

/**
 * Bindings flowing through the document pipeline.
 *
 * Stages 31-33 resolve statements; Stage 35 made a value able to say who owns
 * it. This is the join: a resolved document field may now carry a literal, a
 * binding or a derivation, and every semantic rule those stages established has
 * to survive the change untouched.
 *
 * The rule most at risk is the one about precedence. Three value kinds are three
 * *representations*, not three ranks - a binding does not beat a literal and a
 * derivation does not beat either. Scope specificity decides across scopes;
 * within one scope, disagreement is still a conflict.
 */

const source = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');

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

function lit<K extends DocumentValueType>(value: DocumentValue<K> | undefined): LiteralTypes[K] {
  if (value === undefined) throw new Error('expected a value, found none');
  if (value.kind !== 'literal') throw new Error(`expected a literal, found a ${value.kind}`);
  return value.value;
}

const metaOn = (contributions: readonly DocumentContribution[], target: DocumentTarget) => {
  const document = resolveDocumentForPage(contributions, target);
  if (document.metadata?.state !== 'stated') throw new Error('expected stated metadata');
  return document.metadata.value;
};

// ---------------------------------------------------------------------------
// All three kinds survive the pipeline
// ---------------------------------------------------------------------------

describe('a resolved field can carry any of the three value kinds', () => {
  it('carries a literal', () => {
    const composed = metaOn([says(A, { title: literal('text', 'Acme Ltd') })], SITE_TARGET);
    expect(lit(composed.value.title)).toBe('Acme Ltd');
    expect(ownerOf(composed.value.title!)).toBe('generation');
  });

  it('carries a binding, unevaluated', () => {
    const composed = metaOn([says(A, { title: boundTo('text', 'site.name') })], SITE_TARGET);
    expect(composed.value.title).toEqual({
      kind: 'binding',
      type: 'text',
      binding: 'site.name',
    });
    expect(ownerOf(composed.value.title!)).toBe('project');
  });

  it('carries a derivation, unevaluated', () => {
    const composed = metaOn(
      [says(A, { canonical: derived('url', 'absolute-page-url') })],
      forPage('page.home'),
    );
    expect(composed.value.canonical).toEqual({
      kind: 'derived',
      type: 'url',
      derivation: 'absolute-page-url',
    });
    expect(ownerOf(composed.value.canonical!)).toBe('build-context');
  });

  it('never turns a binding or a derivation into a value', () => {
    /*
     * The Stage 34 failure, guarded. If the resolver ever evaluated these, the
     * generated document would freeze the project's configuration and every
     * page would share whichever path happened to be resolved.
     */
    const serialised = JSON.stringify(
      resolveDocumentForPage(
        [
          says(A, {
            title: boundTo('text', 'site.name'),
            canonical: derived('url', 'absolute-page-url'),
          }),
        ],
        forPage('page.home'),
      ),
    );
    expect(serialised).not.toContain('Acme Ltd');
    expect(serialised).not.toContain('https://acme.example');
    expect(serialised).toContain('site.name');
    expect(serialised).toContain('absolute-page-url');
  });
});

// ---------------------------------------------------------------------------
// Equality, per kind and across kinds
// ---------------------------------------------------------------------------

describe('equality is structural, and kind is not authority', () => {
  const pairs: readonly (readonly [string, MetadataStatement, MetadataStatement])[] = [
    ['identical literals', { title: literal('text', 'X') }, { title: literal('text', 'X') }],
    [
      'identical bindings',
      { title: boundTo('text', 'site.name') },
      { title: boundTo('text', 'site.name') },
    ],
    [
      'identical derivations',
      { canonical: derived('url', 'absolute-page-url') },
      { canonical: derived('url', 'absolute-page-url') },
    ],
  ];

  for (const [label, first, second] of pairs) {
    it(`${label} deduplicate, keeping both claimants`, () => {
      const composed = metaOn([says(A, first), says(B, second)], SITE_TARGET);
      const field = 'title' in first ? 'title' : 'canonical';
      expect(composed.provenance[field]?.owners).toEqual([A, B]);
    });
  }

  const clashes: readonly (readonly [string, MetadataStatement, MetadataStatement, string])[] = [
    [
      'differing literals',
      { title: literal('text', 'X') },
      { title: literal('text', 'Y') },
      'metadata.title',
    ],
    [
      'differing bindings',
      { title: boundTo('text', 'site.name') },
      { title: boundTo('text', 'site.description') },
      'metadata.title',
    ],
    [
      'literal versus binding',
      { title: literal('text', 'Acme Ltd') },
      { title: boundTo('text', 'site.name') },
      'metadata.title',
    ],
    [
      'literal versus derived',
      { canonical: literal('url', 'https://acme.example/') },
      { canonical: derived('url', 'absolute-page-url') },
      'metadata.canonical',
    ],
    [
      'binding versus derived',
      { canonical: boundTo('url', 'site.url') },
      { canonical: derived('url', 'absolute-page-url') },
      'metadata.canonical',
    ],
  ];

  for (const [label, first, second, field] of clashes) {
    it(`${label} conflict at the same scope`, () => {
      /*
       * No kind precedence. "A literal is more definite than a binding" is a
       * plausible-sounding rule and would be invented authority - the two
       * owners genuinely disagree about what the document should say, and one
       * of them has to withdraw.
       */
      const message = refusal(() =>
        resolveDocumentForPage([says(A, first), says(B, second)], SITE_TARGET),
      );
      expect(message, label).toContain(field);
      expect(message, label).toContain(A);
      expect(message, label).toContain(B);
    });

    it(`${label} conflicts whichever order it arrives in`, () => {
      const forward = refusal(() =>
        resolveDocumentForPage([says(A, first), says(B, second)], SITE_TARGET),
      );
      const backward = refusal(() =>
        resolveDocumentForPage([says(B, second), says(A, first)], SITE_TARGET),
      );
      expect(forward).toBe(backward);
    });
  }
});

// ---------------------------------------------------------------------------
// Scope, across kinds
// ---------------------------------------------------------------------------

describe('scope specificity decides across scopes, whatever the kinds', () => {
  const at = onPage('page.notFound');

  it('a page literal overrides an inherited binding', () => {
    const contributions = [
      says(A, { title: boundTo('text', 'site.name') }),
      says(B, { title: literal('text', 'Page not found') }, at),
    ];
    expect(lit(metaOn(contributions, forPage('page.notFound')).value.title)).toBe('Page not found');
    // and the document keeps the binding
    expect(metaOn(contributions, SITE_TARGET).value.title?.kind).toBe('binding');
  });

  it('a page empty canonical overrides an inherited derivation', () => {
    /*
     * The case the whole line of stages exists for. The site tracks each page's
     * address; the not-found page states it has none, and that statement wins
     * without the resolver comparing a derivation to a literal to decide.
     */
    const contributions = [
      says(A, { canonical: derived('url', 'absolute-page-url') }),
      says(B, { canonical: literal('url', '') }, at),
    ];
    expect(lit(metaOn(contributions, forPage('page.notFound')).value.canonical)).toBe('');
    expect(metaOn(contributions, SITE_TARGET).value.canonical?.kind).toBe('derived');
  });

  it('an unstated field inherits its binding', () => {
    const contributions = [
      says(A, {
        title: boundTo('text', 'site.name'),
        description: boundTo('text', 'site.description'),
      }),
      says(B, { title: literal('text', 'Page not found') }, at),
    ];
    const composed = metaOn(contributions, forPage('page.notFound'));
    expect(composed.value.description).toEqual({
      kind: 'binding',
      type: 'text',
      binding: 'site.description',
    });
    expect(composed.provenance.description?.from).toEqual(EVERY_PAGE);
  });

  it('an unstated field inherits its derivation', () => {
    const contributions = [
      says(A, { canonical: derived('url', 'absolute-page-url') }),
      says(B, { title: literal('text', 'Home') }, onPage('page.home')),
    ];
    const composed = metaOn(contributions, forPage('page.home'));
    expect(composed.value.canonical?.kind).toBe('derived');
    expect(composed.provenance.canonical?.from).toEqual(EVERY_PAGE);
  });

  it('a page-only binding does not reach another page', () => {
    const contributions = [says(A, { title: boundTo('text', 'site.name') }, onPage('page.home'))];
    expect(
      resolveDocumentForPage(contributions, forPage('page.notFound')).metadata,
    ).toBeUndefined();
    expect(metaOn(contributions, forPage('page.home')).value.title?.kind).toBe('binding');
  });

  it('a cross-scope override is never a conflict', () => {
    expect(() =>
      resolveDocumentForPage(
        [
          says(A, { canonical: derived('url', 'absolute-page-url') }),
          says(B, { canonical: literal('url', '') }, at),
        ],
        forPage('page.notFound'),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pages ClientKit has never heard of
// ---------------------------------------------------------------------------

describe('a page ClientKit does not know still gets a correct address', () => {
  it('covers unknown pages through an unevaluated every-page derivation', () => {
    /*
     * The Stage 34 blocker, guarded at the semantic layer.
     *
     * `FileRole` is a closed vocabulary - `page.home` and `page.notFound` are
     * the only pages the generator can name - so a developer's `/contact` page
     * can never be *named* here. That is not a gap: the statement that covers
     * it is scoped to every page and carries a derivation, so the address is
     * computed per page at the project's build, for pages nobody enumerated.
     *
     * A literal canonical could not do this. That is precisely why Stage 34's
     * snapshot emitter would have left user-added pages with no canonical at
     * all.
     */
    const contributions = [says(A, { canonical: derived('url', 'absolute-page-url') })];

    for (const target of [SITE_TARGET, forPage('page.home'), forPage('page.notFound')]) {
      const composed = metaOn(contributions, target);
      // Identical and unevaluated at every target: nothing page-specific was
      // baked in, so a page outside the vocabulary resolves the same way.
      expect(composed.value.canonical).toEqual({
        kind: 'derived',
        type: 'url',
        derivation: 'absolute-page-url',
      });
    }
  });

  it('never fabricates a URL for any target', () => {
    const serialised = JSON.stringify([
      resolveDocumentForPage(
        [says(A, { canonical: derived('url', 'absolute-page-url') })],
        SITE_TARGET,
      ),
      resolveDocumentForPage(
        [says(A, { canonical: derived('url', 'absolute-page-url') })],
        forPage('page.home'),
      ),
    ]);
    for (const invented of ['https://acme.example', 'example.com', 'localhost', '/contact', '/']) {
      expect(serialised, `fabricated ${invented}`).not.toContain(`"${invented}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Stance is unchanged
// ---------------------------------------------------------------------------

describe('stance still outranks representation', () => {
  const at = onPage('page.notFound');

  it('a page suppression beats an inherited binding', () => {
    const document = resolveDocumentForPage(
      [
        says(A, { title: boundTo('text', 'site.name') }),
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

  it('a stated binding at a page beats an inherited suppression', () => {
    const document = resolveDocumentForPage(
      [
        {
          kind: 'metadata',
          owner: A,
          reason: 'the document states nothing',
          scope: EVERY_PAGE,
          metadata: suppressed('the document states nothing'),
        },
        says(B, { title: boundTo('text', 'site.name') }, at),
      ],
      forPage('page.notFound'),
    );
    expect(document.metadata?.state).toBe('stated');
    if (document.metadata?.state !== 'stated') throw new Error('narrowing failed');
    expect(document.metadata.value.value.title?.kind).toBe('binding');
  });

  it('a suppression is never represented as a value', () => {
    const document = resolveDocumentForPage(
      [
        {
          kind: 'metadata',
          owner: A,
          reason: 'nothing here',
          scope: EVERY_PAGE,
          metadata: suppressed('nothing here'),
        },
      ],
      SITE_TARGET,
    );
    expect(document.metadata?.state).toBe('suppressed');
    expect(JSON.stringify(document)).not.toContain('"kind":"literal"');
  });

  it('an absent field stays absent rather than becoming a binding', () => {
    const composed = metaOn([says(A, { title: boundTo('text', 'site.name') })], SITE_TARGET);
    expect('canonical' in composed.value).toBe(false);
    expect('description' in composed.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The 404, binding-aware
// ---------------------------------------------------------------------------

describe('the not-found page, with a binding-aware site statement', () => {
  const at = onPage('page.notFound');

  const contributions: DocumentContribution[] = [
    // The site tracks its own configuration and each page's address.
    says('feature:seo', {
      title: boundTo('text', 'site.name'),
      description: boundTo('text', 'site.description'),
      robots: literal('text', 'index, follow'),
      canonical: derived('url', 'absolute-page-url'),
    }),
    // The not-found page states its own facts.
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
      reason: 'what machines should be told about the organisation',
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

  it('resolves the page to the expected semantic state', () => {
    const composed = metaOn(contributions, forPage('page.notFound'));
    expect(lit(composed.value.robots)).toBe('noindex, nofollow');
    expect(lit(composed.value.canonical)).toBe('');
    expect(lit(composed.value.title)).toBe('Page not found - Acme Ltd');
    // The description was never stated by the page, so it inherits - still a
    // binding, still unevaluated.
    expect(composed.value.description?.kind).toBe('binding');
  });

  it('suppresses the organisation on that page only', () => {
    const page = resolveDocumentForPage(contributions, forPage('page.notFound'));
    expect(page.structuredData?.state).toBe('suppressed');

    const site = resolveDocumentForPage(contributions, SITE_TARGET);
    expect(site.structuredData?.state).toBe('stated');
  });

  it('leaves the site tracking its own address', () => {
    const site = metaOn(contributions, SITE_TARGET);
    expect(site.value.canonical).toEqual({
      kind: 'derived',
      type: 'url',
      derivation: 'absolute-page-url',
    });
    expect(lit(site.value.robots)).toBe('index, follow');
  });

  it('leaves the home page indexable and tracking its address', () => {
    const home = metaOn(contributions, forPage('page.home'));
    expect(lit(home.value.robots)).toBe('index, follow');
    expect(home.value.canonical?.kind).toBe('derived');
    expect(home.value.title?.kind).toBe('binding');
  });

  it('names no framework in any resolved target', () => {
    const serialised = JSON.stringify([
      resolveDocumentForPage(contributions, SITE_TARGET),
      resolveDocumentForPage(contributions, forPage('page.home')),
      resolveDocumentForPage(contributions, forPage('page.notFound')),
    ]);
    for (const name of ['astro', 'Astro', 'nextjs', 'SITE.', 'Astro.url']) {
      expect(serialised, `mentions ${name}`).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// The lift from a generation-time contract
// ---------------------------------------------------------------------------

describe('a contract lifts into all-literal statements', () => {
  it('produces one literal per field, losing nothing', () => {
    const contract = resolveSeoContract(SITE);
    const statement = metadataFromContract(contract);

    expect(Object.keys(statement).sort()).toEqual(Object.keys(contract).sort());
    expect(lit(statement.title)).toBe(contract.title);
    expect(lit(statement.canonical)).toBe(contract.canonical);
    expect(lit(statement.openGraph)).toEqual(contract.openGraph);
    expect(lit(statement.twitter)).toEqual(contract.twitter);
    for (const value of Object.values(statement)) {
      expect(value.kind).toBe('literal');
    }
  });

  it('keeps the social blocks whole', () => {
    // One value, never six - so a contributor cannot set half a block, and the
    // Stage 32 coupling survives the change of representation.
    const statement = metadataFromContract(resolveSeoContract(SITE));
    expect(lit(statement.openGraph).title).toBe(lit(statement.title));
    expect(statement.openGraph?.type).toBe('open-graph');
  });

  it('carries an empty canonical as a stated literal', () => {
    const bare: SiteContext = {
      name: 'Acme Ltd',
      url: null,
      description: '',
      locale: 'en',
      author: null,
    };
    const statement = metadataFromContract(resolveSeoContract(bare));
    expect(lit(statement.canonical)).toBe('');
    expect(statement.canonical?.kind).toBe('literal');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('mixed value kinds resolve deterministically', () => {
  const all: DocumentContribution[] = [
    says(A, { title: boundTo('text', 'site.name') }),
    says(A, { canonical: derived('url', 'absolute-page-url') }),
    says(B, { title: literal('text', 'Page not found') }, onPage('page.notFound')),
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

  it('orders fields by the vocabulary regardless of kind', () => {
    const composed = metaOn(all, forPage('page.home'));
    expect(Object.keys(composed.value)).toEqual(['title', 'canonical']);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('the pipeline stayed pure', () => {
  for (const file of [
    'src/domain/document-contribution.ts',
    'src/domain/document-resolution.ts',
    'src/domain/document-scope.ts',
  ]) {
    it(`${file} imports no framework or filesystem module`, () => {
      const text = source(file);
      for (const module of [
        'node:fs',
        'node:path',
        'node:process',
        'node:os',
        'node:child_process',
      ]) {
        expect(text, `${file} imports ${module}`).not.toContain(`'${module}'`);
      }
      for (const module of ['react', 'next', 'astro', '@mui', 'tailwind', 'vite']) {
        expect(text.toLowerCase(), `${file} imports ${module}`).not.toContain(`from '${module}`);
      }
      for (const module of ['../adapters/', '../templates/', '../features/']) {
        expect(text, `${file} imports ${module}`).not.toContain(module);
      }
    });

    it(`${file} evaluates nothing`, () => {
      const text = source(file);
      for (const token of ['eval(', 'new Function', 'Function(', 'vm.', 'require(', 'import(']) {
        expect(text, `${file} contains ${token}`).not.toContain(token);
      }
    });

    it(`${file} carries no framework expression`, () => {
      const text = source(file);
      for (const token of ['Astro.url', 'SITE.name', 'SITE.url', 'SEO.image']) {
        expect(text, `${file} contains ${token}`).not.toContain(token);
      }
    });
  }

  it('builds no emitter', () => {
    for (const file of [
      'src/adapters/astro-document-emitter.ts',
      'src/domain/document-emitter.ts',
    ]) {
      expect(() => source(file), file).toThrow();
    }
  });

  it('is imported by no adapter', () => {
    const bridge = source('src/adapters/bridge.ts');
    for (const module of ['document-value', 'document-scope', 'document-resolution']) {
      expect(bridge, `bridge.ts imports ${module}`).not.toContain(module);
    }
  });
});
