import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import ts from 'typescript';

import { documentTargets, planManifest } from '../src/adapters/bridge.js';
import type { DocumentRealizer } from '../src/adapters/document-realizers.js';
import {
  NEXT_DOCUMENT_REALIZER,
  selectDocumentRealizer,
} from '../src/adapters/document-realizers.js';
import { applyNextDocument, NEXT_REALIZATION } from '../src/adapters/next-document-realization.js';
import { NEXTJS_ARCHITECTURE } from '../src/adapters/nextjs.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility } from '../src/adapters/selection.js';
import type {
  DocumentEmissionItem,
  DocumentEmissionPlan,
} from '../src/domain/document-emission.js';
import { SITE_TARGET, forPage } from '../src/domain/document-scope.js';
import { absolutePageUrl, boundTo, literal } from '../src/domain/document-value.js';
import type { FeatureId, ProjectManifest } from '../src/domain/index.js';
import type { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * Next's canonical, and the line it does not cross.
 *
 * Astro spells a canonical as an expression a page evaluates. Next takes a
 * declaration - an origin plus a relative address - and resolves the route
 * itself. The same semantic value, two shapes, which is why realization is a
 * per-architecture concern and not a shared emitter.
 *
 * What most of this file is about is the second half: that adding one field to
 * one framework did not quietly add the other six.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const source = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');

const codeOnly = (file: string): string =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    const cli = error as CliError;
    return `${cli.message}\n${cli.hint ?? ''}`;
  }
  return '';
};

const nextManifest = (
  features: readonly FeatureId[],
  url: string | null = 'https://acme.example',
): ProjectManifest =>
  ({
    targetDir: path.join(TEST_CWD, 'acme-site'),
    projectName: 'acme-site',
    framework: 'nextjs',
    buildTool: 'next',
    language: 'ts',
    styling: 'tailwind',
    uiLibrary: 'none',
    router: 'file-based',
    architecture: 'next-app',
    starter: 'full',
    features,
    site: { name: 'Acme Ltd', url, description: 'Bespoke widgets.', locale: 'en-GB', author: null },
    packageManager: 'npm',
    git: true,
    install: true,
  }) as ProjectManifest;

const planNext = (features: readonly FeatureId[], url: string | null = 'https://acme.example') =>
  planManifest(nextManifest(features, url), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'full',
  });

const fileIn = (
  features: readonly FeatureId[],
  target: string,
  url: string | null = 'https://acme.example',
): string => {
  const found = planNext(features, url).plan.operations.find((entry) => entry.path === target);
  if (found?.type !== 'write') throw new Error(`nothing written at ${target}`);
  return found.content;
};

const LAYOUT = 'app/layout.tsx';
const NOT_FOUND = 'app/not-found.tsx';

const plannedOperations = () => planNext([]).plan.operations;
const architecture = () => NEXTJS_ARCHITECTURE;

const PROVENANCE = { owners: [], reasons: [] } as const;

/** One site-scoped plan carrying a single item, which is all Next realizes. */
const sitePlan = (item: DocumentEmissionItem): DocumentEmissionPlan => ({
  target: SITE_TARGET,
  items: [item],
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('Next is chosen for Next', () => {
  it('is registered under its own architecture', () => {
    expect(selectDocumentRealizer('next-app')).toBe(NEXT_DOCUMENT_REALIZER);
    expect(NEXT_DOCUMENT_REALIZER.support).toBe(NEXT_REALIZATION);
  });

  it('declares only what a canonical needs', () => {
    expect(NEXT_REALIZATION.bindings).toEqual(['site.url', 'page.path']);
    expect(NEXT_REALIZATION.derivations).toEqual(['absolute-page-url']);
  });

  it('is never selected for another architecture', () => {
    expect(selectDocumentRealizer('astro-standard')).not.toBe(NEXT_DOCUMENT_REALIZER);
  });
});

// ---------------------------------------------------------------------------
// The generated declarations
// ---------------------------------------------------------------------------

describe('the canonical is declared, not computed', () => {
  it('extends the root layout for the site document', () => {
    const layout = fileIn(['seo'], LAYOUT);
    expect(layout).toContain('metadataBase: SITE.url ? new URL(SITE.url) : null,');
    expect(layout).toContain("alternates: { canonical: SITE.url ? './' : null },");
  });

  it('keeps the title and description the template already stated', () => {
    // Untouched: they are the framework's, by Stage 47's rule.
    const layout = fileIn(['seo'], LAYOUT);
    expect(layout).toContain('title: SITE.name,');
    expect(layout).toContain('description: SITE.description,');
  });

  it('declares the not-found page as claiming no address', () => {
    const page = fileIn(['seo'], NOT_FOUND);
    expect(page).toContain('alternates: { canonical: null },');
    expect(page).toContain("import type { Metadata } from 'next';");
  });

  it('writes no address into the source', () => {
    /*
     * The whole point. ClientKit has the URL in the manifest and could have
     * written it; declaring the mechanism instead is what lets the project own
     * the value afterwards.
     */
    for (const file of [LAYOUT, NOT_FOUND]) {
      expect(fileIn(['seo'], file), file).not.toContain('acme.example');
    }
  });

  it('guards on the configured URL rather than inventing an origin', () => {
    // Measured before it was written: with only `metadataBase` guarded, a
    // URL-less project emitted relative canonicals. Astro omits the tag
    // entirely when no origin is configured, and both should say the same.
    const layout = fileIn(['seo'], LAYOUT, null);
    expect(layout).toContain("canonical: SITE.url ? './' : null");
    for (const fabricated of ['localhost', 'example.com', 'http://']) {
      expect(layout, fabricated).not.toContain(fabricated);
    }
  });

  it('touches nothing when the feature is not selected', () => {
    expect(fileIn([], LAYOUT)).not.toContain('metadataBase');
    expect(fileIn([], NOT_FOUND)).not.toContain('metadata');
  });

  it('records where each file came from', () => {
    const layout = planNext(['seo']).plan.operations.find((entry) => entry.path === LAYOUT);
    expect(layout?.origin).toContain('composed canonical');
  });
});

// ---------------------------------------------------------------------------
// The four value states
// ---------------------------------------------------------------------------

describe('the canonical states stay distinct', () => {
  const realize = (item: DocumentEmissionItem) =>
    applyNextDocument(architecture(), plannedOperations(), [sitePlan(item)]);

  it('realizes a derived address as a declaration', () => {
    const operations = realize({
      field: 'canonical',
      state: 'stated',
      value: absolutePageUrl(),
      provenance: PROVENANCE,
    });
    const layout = operations.find((entry) => entry.path === LAYOUT);
    expect(layout?.type === 'write' ? layout.content : '').toContain('metadataBase');
  });

  it('realizes an explicitly empty address as a refusal to claim one', () => {
    const operations = realize({
      field: 'canonical',
      state: 'stated',
      value: literal('url', ''),
      provenance: PROVENANCE,
    });
    const layout = operations.find((entry) => entry.path === LAYOUT);
    expect(layout?.type === 'write' ? layout.content : '').toContain(
      'alternates: { canonical: null },',
    );
  });

  it('realizes a literal address as that address', () => {
    const operations = realize({
      field: 'canonical',
      state: 'stated',
      value: literal('url', 'https://elsewhere.example/'),
      provenance: PROVENANCE,
    });
    const layout = operations.find((entry) => entry.path === LAYOUT);
    expect(layout?.type === 'write' ? layout.content : '').toContain(
      'alternates: { canonical: "https://elsewhere.example/" },',
    );
  });

  it('treats absence as nothing to declare', () => {
    /*
     * Byte-identity rather than "no metadataBase". Absence and suppression are
     * different states, and the failure worth catching is the one that turns
     * the first into the second - which writes `canonical: null` and would sail
     * past a test looking only for the derived spelling.
     */
    const before = plannedOperations();
    const after = applyNextDocument(architecture(), before, [{ target: SITE_TARGET, items: [] }]);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('honours a suppression by declaring nothing', () => {
    const before = plannedOperations();
    const after = applyNextDocument(architecture(), before, [
      {
        target: SITE_TARGET,
        items: [
          { field: 'canonical', state: 'suppressed', becauses: ['no'], provenance: PROVENANCE },
        ],
      },
    ]);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

describe('targets reach their own files', () => {
  const canonical = {
    field: 'canonical' as const,
    state: 'stated' as const,
    value: absolutePageUrl(),
    provenance: PROVENANCE,
  };

  it('sends the site document to the root layout', () => {
    const operations = applyNextDocument(architecture(), plannedOperations(), [
      { target: SITE_TARGET, items: [canonical] },
    ]);
    const changed = operations.filter((entry) => entry.origin?.includes('composed canonical'));
    expect(changed.map((entry) => entry.path)).toEqual([LAYOUT]);
  });

  it('sends a page document to that page', () => {
    const operations = applyNextDocument(architecture(), plannedOperations(), [
      {
        target: forPage('page.notFound'),
        items: [{ ...canonical, value: literal('url', '') }],
      },
    ]);
    const changed = operations.filter((entry) => entry.origin?.includes('composed canonical'));
    expect(changed.map((entry) => entry.path)).toEqual([NOT_FOUND]);
  });

  it('never turns a page target into the site', () => {
    const operations = applyNextDocument(architecture(), plannedOperations(), [
      {
        target: forPage('page.notFound'),
        items: [{ ...canonical, value: literal('url', '') }],
      },
    ]);
    const layout = operations.find((entry) => entry.path === LAYOUT);
    expect(layout?.type === 'write' ? layout.content : '').not.toContain('alternates');
  });

  it('refuses a role the architecture does not map', () => {
    const message = refusal(() =>
      applyNextDocument(architecture(), plannedOperations(), [
        { target: forPage('app.entry'), items: [canonical] },
      ]),
    );
    expect(message).toContain('app.entry');
  });

  it('refuses when the file it would declare in is not planned', () => {
    const without = plannedOperations().filter((entry) => entry.path !== LAYOUT);
    const message = refusal(() =>
      applyNextDocument(architecture(), without, [{ target: SITE_TARGET, items: [canonical] }]),
    );
    expect(message).toContain('no file to be declared in');
  });
});

// ---------------------------------------------------------------------------
// What Next will not realize
// ---------------------------------------------------------------------------

describe('one field, and the rest refused by name', () => {
  it.each(['title', 'description', 'robots', 'open-graph'] as const)(
    'refuses %s rather than dropping it',
    (field) => {
      const message = refusal(() =>
        applyNextDocument(architecture(), plannedOperations(), [
          {
            target: SITE_TARGET,
            items: [
              { field, state: 'stated', value: literal('text', 'x'), provenance: PROVENANCE },
            ],
          },
        ]),
      );
      expect(message).toContain(`cannot realize ${field}`);
      expect(message).toContain('None of them is dropped quietly');
    },
  );

  it('refuses a derivation it has no declaration form for', () => {
    const message = refusal(() =>
      applyNextDocument(architecture(), plannedOperations(), [
        {
          target: SITE_TARGET,
          items: [
            {
              field: 'canonical',
              state: 'stated',
              value: {
                kind: 'derived',
                type: 'url',
                derivation: 'absolute-page-url',
                inputs: [literal('url', 'https://x.example'), boundTo('path', 'page.path')],
              },
              provenance: PROVENANCE,
            },
          ],
        },
      ]),
    );
    expect(message).toContain('cannot realize this canonical');
    expect(message).toContain('whole');
  });

  it('refuses a canonical that is a bare binding', () => {
    const message = refusal(() =>
      applyNextDocument(architecture(), plannedOperations(), [
        {
          target: SITE_TARGET,
          items: [
            {
              field: 'canonical',
              state: 'stated',
              value: boundTo('url', 'site.url'),
              provenance: PROVENANCE,
            },
          ],
        },
      ]),
    );
    expect(message).toContain('bound canonical');
  });

  it('generates no arbitrary source', () => {
    const code = codeOnly('src/adapters/next-document-realization.ts');
    for (const forbidden of ['eval(', 'new Function', 'vm.', 'require(']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('names no route anywhere', () => {
    const code = codeOnly('src/adapters/next-document-realization.ts');
    for (const route of ["'/404'", '_not-found', 'pathname']) {
      expect(code, route).not.toContain(route);
    }
  });
});

// ---------------------------------------------------------------------------
// The capability boundary
// ---------------------------------------------------------------------------

describe('Next gained a canonical and nothing else', () => {
  it('accepts SEO', () => {
    expect(checkCompatibility(nextManifest(['seo']), adapters).compatible).toBe(true);
  });

  it.each(['structured-data', 'accessibility'] as const)('still refuses %s', (feature) => {
    const report = checkCompatibility(nextManifest([feature]), adapters);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('composed-metadata');
  });

  it('still lacks the broad capability', () => {
    expect(adapters.framework('nextjs').declaration.provides).not.toContain('composed-metadata');
    expect(adapters.framework('nextjs').declaration.provides).toContain('composed-canonical');
  });

  it('composes exactly two files for SEO', () => {
    const withSeo = planNext(['seo']).plan.operations;
    const changed = withSeo.filter((entry) => entry.origin?.includes('composed canonical'));
    expect(changed.map((entry) => entry.path).sort()).toEqual([LAYOUT, NOT_FOUND]);
  });

  it('adds no file to the project', () => {
    const withSeo = planNext(['seo']).plan.operations.map((entry) => entry.path);
    const without = planNext([]).plan.operations.map((entry) => entry.path);
    expect(withSeo).toEqual(without);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('realization is deterministic', () => {
  it('produces identical operations across runs', () => {
    expect(JSON.stringify(planNext(['seo']).plan.operations)).toBe(
      JSON.stringify(planNext(['seo']).plan.operations),
    );
  });

  it('does not depend on the order the plans arrived in', () => {
    const site = {
      target: SITE_TARGET,
      items: [
        {
          field: 'canonical' as const,
          state: 'stated' as const,
          value: absolutePageUrl(),
          provenance: PROVENANCE,
        },
      ],
    };
    const page = {
      target: forPage('page.notFound'),
      items: [
        {
          field: 'canonical' as const,
          state: 'stated' as const,
          value: literal('url', ''),
          provenance: PROVENANCE,
        },
      ],
    };
    const forward = JSON.stringify(
      applyNextDocument(architecture(), plannedOperations(), [site, page]),
    );
    const backward = JSON.stringify(
      applyNextDocument(architecture(), plannedOperations(), [page, site]),
    );
    expect(backward).toBe(forward);
  });

  it('reads no clock, environment or filesystem', () => {
    const code = codeOnly('src/adapters/next-document-realization.ts');
    for (const token of ['Date.now', 'Math.random', 'process.', 'readFileSync', 'globalThis']) {
      expect(code, token).not.toContain(token);
    }
  });

  it('holds no mutable module state', () => {
    const code = codeOnly('src/adapters/next-document-realization.ts');
    expect(code).not.toMatch(/^let /m);
    expect(code).not.toMatch(/^var /m);
  });
});

// ---------------------------------------------------------------------------
// Where the declarations land
// ---------------------------------------------------------------------------

describe('the declaration lands somewhere that compiles', () => {
  /**
   * Both mutations this section exists for were survivors first.
   *
   * Asserting that the composed file *contains* the right declaration is not
   * enough: an anchor pointed at the default export produces a file containing
   * every expected string and no valid TypeScript at all. What has to hold is
   * where the declaration went, and that the result still parses.
   */

  const syntaxErrors = (file: string): readonly string[] =>
    ts
      .transpileModule(fileIn(['seo'], file), {
        reportDiagnostics: true,
        fileName: file,
        compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext },
      })
      .diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')) ?? [];

  it.each([LAYOUT, NOT_FOUND])('%s still parses once composed', (file) => {
    expect(syntaxErrors(file)).toEqual([]);
  });

  it('declares below the imports and above the page', () => {
    const page = fileIn(['seo'], NOT_FOUND);
    const importLine = page.indexOf('import { CONTACT, NAV }');
    const declaration = page.indexOf('export const metadata');
    const component = page.indexOf('export default function NotFound');
    expect(importLine).toBeGreaterThanOrEqual(0);
    expect(declaration).toBeGreaterThan(importLine);
    expect(component).toBeGreaterThan(declaration);
  });

  it('extends the layout inside the export it already had', () => {
    const layout = fileIn(['seo'], LAYOUT);
    // One metadata export, not a second one appended beside the first.
    expect(layout.split('export const metadata').length - 1).toBe(1);
    expect(layout.indexOf('metadataBase')).toBeGreaterThan(layout.indexOf('export const metadata'));
    expect(layout.indexOf('metadataBase')).toBeLessThan(layout.indexOf('title: SITE.name'));
  });
});

// ---------------------------------------------------------------------------
// Which targets are asked about
// ---------------------------------------------------------------------------

describe('the site is asked about first', () => {
  const everyPage = { kind: 'every-page' } as const;
  const onPage = (role: string) => ({ kind: 'page', role }) as const;
  const doc = (scope: unknown) =>
    ({
      kind: 'metadata',
      owner: 'test',
      reason: 'because',
      scope,
      metadata: { state: 'stated', value: { canonical: absolutePageUrl() } },
    }) as never;

  it('puts the site ahead of the pages it composes with', () => {
    // The order is the contract, not an accident of how the list is built: a
    // page's document composes over the site's, so the site has to be resolved
    // first for "more specific wins" to mean anything.
    const targets = documentTargets([doc(everyPage), doc(onPage('page.notFound'))]);
    expect(targets[0]).toEqual(SITE_TARGET);
  });

  it('orders the pages by role rather than by contribution order', () => {
    const forward = documentTargets([doc(onPage('page.notFound')), doc(onPage('app.page.home'))]);
    const backward = documentTargets([doc(onPage('app.page.home')), doc(onPage('page.notFound'))]);
    expect(forward).toEqual(backward);
    expect(forward.map((t) => (t.kind === 'page' ? t.role : 'site'))).toEqual([
      'site',
      'app.page.home',
      'page.notFound',
    ]);
  });

  it('names no target when nothing speaks about the document', () => {
    expect(documentTargets([])).toEqual([]);
  });

  it('hands the realizer the plans in that order', () => {
    /*
     * Asserting `documentTargets` alone left a survivor: reversing the list at
     * the call site passed the whole suite, because each target today writes to
     * a different file and the operations are sorted afterwards. Unobservable
     * in the output is not the same as unimportant - two targets resolving to
     * one file would compose in whatever order they arrived - so the contract
     * is pinned where it is actually used.
     */
    const spy = vi.spyOn(NEXT_DOCUMENT_REALIZER as { apply: DocumentRealizer['apply'] }, 'apply');
    try {
      planNext(['seo']);
      expect(spy).toHaveBeenCalledOnce();
      const plans = spy.mock.calls[0]?.[2] ?? [];
      expect(
        plans.map((plan) => (plan.target.kind === 'page' ? plan.target.role : 'site')),
      ).toEqual(['site', 'page.notFound']);
    } finally {
      spy.mockRestore();
    }
  });
});
