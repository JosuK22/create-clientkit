import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASTRO_DERIVATION_REALIZATIONS,
  realizeAstroDocument,
} from '../src/adapters/astro-document-realization.js';
import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { resolveProject } from '../src/adapters/selection.js';
import { buildDocumentEmission } from '../src/domain/document-emission.js';
import { DOCUMENT_DERIVATION_IDS } from '../src/domain/document-value.js';
import { absolutePageUrl, literal } from '../src/domain/document-value.js';
import { SITE_TARGET, forPage, resolveDocumentForPage } from '../src/domain/document-scope.js';
import type { DocumentContribution } from '../src/domain/document-contribution.js';
import { EVERY_PAGE, onPage } from '../src/domain/document-contribution.js';
import type { FeatureId, ProjectManifest } from '../src/domain/index.js';
import type { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * The production document, from a feature's statement to Astro source.
 *
 * Stages 31 to 43 built each link of this and proved it with synthetic data.
 * Stage 44 is the first time a real feature's document reaches a real generated
 * project, so what is under test is the join: that a value the SEO feature
 * states as a derivation arrives in the output as an expression the project
 * evaluates, at the right target, without anything in between deciding it
 * early.
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

const manifest = (features: readonly FeatureId[], url: string | null = 'https://acme.example') =>
  ({
    targetDir: path.join(TEST_CWD, 'acme-site'),
    projectName: 'acme-site',
    framework: 'astro',
    buildTool: 'astro',
    language: 'ts',
    styling: 'tailwind',
    uiLibrary: 'none',
    router: 'file-based',
    architecture: 'astro-standard',
    starter: 'coming-soon',
    features,
    site: {
      name: 'Acme Ltd',
      url,
      description: 'Bespoke widgets.',
      locale: 'en-GB',
      author: null,
    },
    packageManager: 'npm',
    git: true,
    install: true,
  }) as ProjectManifest;

const planOf = (features: readonly FeatureId[], url: string | null = 'https://acme.example') =>
  planManifest(manifest(features, url), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'coming-soon',
    templateId: 'astro-tailwind',
  });

const fileIn = (features: readonly FeatureId[], target: string): string | undefined => {
  const found = planOf(features).plan.operations.find((entry) => entry.path === target);
  return found?.type === 'write' ? found.content : undefined;
};

const SITE_HEAD = 'src/components/DocumentHead.astro';
const PAGE_HEAD = 'src/components/DocumentHeadPageNotFound.astro';
const METADATA = 'src/components/Seo.astro';

/** What the SEO feature actually contributes, read from the adapter. */
const seoDocuments = (): readonly DocumentContribution[] => {
  const { project } = resolveProject(manifest(['seo']), adapters);
  return adapters.feature('seo').contribute(project).documents ?? [];
};

// ---------------------------------------------------------------------------
// The contributor
// ---------------------------------------------------------------------------

describe('a production feature states a document', () => {
  it('contributes one statement for every page and one for the not-found page', () => {
    const documents = seoDocuments();
    expect(documents.map((entry) => entry.scope)).toEqual([EVERY_PAGE, onPage('page.notFound')]);
    expect(documents.every((entry) => entry.owner === 'feature:seo')).toBe(true);
    expect(documents.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('states the canonical as a derivation, never a computed address', () => {
    /*
     * The whole point. ClientKit knows the site URL - it is in the manifest -
     * and could have written the address here. Doing so would freeze what the
     * project owns, which is the failure Stage 34 stopped for, so the value
     * says what it *is* rather than what it currently evaluates to.
     */
    const [everyPage] = seoDocuments();
    if (everyPage?.kind !== 'metadata' || everyPage.metadata.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(everyPage.metadata.value.canonical).toEqual(absolutePageUrl());
    expect(JSON.stringify(everyPage.metadata.value)).not.toContain('acme.example');
  });

  it('states the not-found canonical as an explicit empty claim', () => {
    // Stage 38's state B: the page claims no canonical address, which is not
    // the same as saying nothing about one.
    const [, notFound] = seoDocuments();
    if (notFound?.kind !== 'metadata' || notFound.metadata.state !== 'stated') {
      throw new Error('narrowing failed');
    }
    expect(notFound.metadata.value.canonical).toEqual(literal('url', ''));
  });

  it('names no framework in the code that states it', () => {
    const code = codeOnly('src/adapters/seo.ts').toLowerCase();
    for (const name of ['astro', 'react', 'next', '.astro', 'baselayout']) {
      expect(code, `seo.ts names ${name}`).not.toContain(name);
    }
  });

  it('does not use the literal contract helper for the document', () => {
    // `metadataFromContract` is the faithful translation of a contract with no
    // bindings in it. This contributor has bindings, so it states them.
    expect(codeOnly('src/adapters/seo.ts')).not.toContain('metadataFromContract');
  });
});

// ---------------------------------------------------------------------------
// Through the pipeline
// ---------------------------------------------------------------------------

describe('the statement survives resolution and emission', () => {
  const planFor = (target: Parameters<typeof resolveDocumentForPage>[1]) =>
    buildDocumentEmission(resolveDocumentForPage(seoDocuments(), target));

  it('resolves the site to the derived address', () => {
    const plan = planFor(SITE_TARGET);
    expect(plan.items).toHaveLength(1);
    const [item] = plan.items;
    if (item?.state !== 'stated' || item.field !== 'canonical') throw new Error('narrowing failed');
    expect(item.value.kind).toBe('derived');
  });

  it('resolves the not-found page to the empty claim, by specificity', () => {
    /*
     * Not by ordering, and not by the Astro layer: the page scope is more
     * specific than every-page, so Stage 33's rule picks it. Nothing about
     * "404" appears in any generated condition.
     */
    const plan = planFor(forPage('page.notFound'));
    const [item] = plan.items;
    if (item?.state !== 'stated' || item.field !== 'canonical') throw new Error('narrowing failed');
    expect(item.value).toEqual(literal('url', ''));
  });

  it('leaves an unrelated page with the site-wide statement', () => {
    const plan = planFor(forPage('page.home'));
    const [item] = plan.items;
    if (item?.state !== 'stated' || item.field !== 'canonical') throw new Error('narrowing failed');
    expect(item.value.kind).toBe('derived');
  });
});

// ---------------------------------------------------------------------------
// Realization
// ---------------------------------------------------------------------------

describe('Astro realizes the plan without evaluating it', () => {
  const realize = (target: Parameters<typeof resolveDocumentForPage>[1]) =>
    realizeAstroDocument(buildDocumentEmission(resolveDocumentForPage(seoDocuments(), target)));

  it('keeps the target the plan carried', () => {
    expect(realize(SITE_TARGET).target).toEqual(SITE_TARGET);
    expect(realize(forPage('page.notFound')).target).toEqual(forPage('page.notFound'));
  });

  it('spells the derivation with the project’s own helpers', () => {
    const [entry] = realize(SITE_TARGET).entries;
    expect(entry?.source).toContain('absoluteUrl(siteOrigin(SITE.url), Astro.url.pathname)');
  });

  it('declares what the expression needs in scope', () => {
    // The binding brings SITE; the derivation brings the helpers. Stage 41's
    // ReferenceError came from knowing only the first.
    const [entry] = realize(SITE_TARGET).entries;
    expect(entry?.bindings).toEqual(['page.path', 'site.url']);
    // The derivation's own helpers first, then whatever its arguments need -
    // the surface de-duplicates, so `SITE` arriving from both the binding list
    // and the argument produces one import.
    expect(entry?.imports).toEqual([
      { role: 'lib.urls', named: 'absoluteUrl' },
      { role: 'lib.urls', named: 'siteOrigin' },
      { role: 'config.site', named: 'SITE' },
    ]);
  });

  it('renders nothing for a claim of no address', () => {
    // Statically known, so the guard is decided here rather than shipped as
    // `{"" !== '' && ...}` for the project to evaluate forever.
    const [entry] = realize(forPage('page.notFound')).entries;
    expect(entry?.source).toBe('');
    expect(entry?.field).toBe('canonical');
  });

  it('never writes an address into the source', () => {
    for (const target of [SITE_TARGET, forPage('page.notFound'), forPage('page.home')]) {
      for (const entry of realize(target).entries) {
        expect(entry.source, `${entry.field} was frozen`).not.toContain('acme.example');
      }
    }
  });

  it('realizes every derivation the vocabulary declares', () => {
    expect(Object.keys(ASTRO_DERIVATION_REALIZATIONS).sort()).toEqual([...DOCUMENT_DERIVATION_IDS]);
  });

  it('refuses a field it cannot spell, by name and with a reason', () => {
    const message = refusal(() =>
      realizeAstroDocument({
        target: SITE_TARGET,
        items: [
          {
            field: 'twitter',
            state: 'stated',
            value: literal('twitter', { card: 'summary', title: 'x', description: 'y' }),
            provenance: { owners: [], reasons: [] },
          },
        ],
      }),
    );
    expect(message).toContain('cannot realize twitter');
    expect(message).toContain('template-owned');
  });

  it('honours a suppression by emitting nothing for it', () => {
    const realized = realizeAstroDocument({
      target: SITE_TARGET,
      items: [
        {
          field: 'canonical',
          state: 'suppressed',
          becauses: ['no'],
          provenance: { owners: [], reasons: [] },
        },
      ],
    });
    expect(realized.entries).toEqual([]);
  });

  it('escapes a literal so it cannot end the expression it sits in', () => {
    /*
     * No contributor states a quote today, which is exactly why this is worth
     * pinning: the difference between quoting a literal and interpolating it is
     * invisible until one does, and then it is broken source rather than a
     * wrong value.
     */
    const realized = realizeAstroDocument({
      target: SITE_TARGET,
      items: [
        {
          field: 'description',
          state: 'stated',
          value: literal('text', 'He said "hi" </script>'),
          provenance: { owners: [], reasons: [] },
        },
      ],
    });
    expect(realized.entries[0]?.source).toContain('\\"hi\\"');
    expect(realized.entries[0]?.source).not.toContain('said "hi"');
  });

  it('generates no arbitrary source', () => {
    const code = codeOnly('src/adapters/astro-document-realization.ts');
    for (const forbidden of ['eval(', 'new Function', 'vm.', 'require(']) {
      expect(code, `the realization uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// The generated project
// ---------------------------------------------------------------------------

describe('the generated project carries the realized document', () => {
  it('generates both components when SEO is selected', () => {
    expect(fileIn(['seo'], SITE_HEAD)).toBeDefined();
    expect(fileIn(['seo'], PAGE_HEAD)).toBeDefined();
  });

  it('generates neither when it is not', () => {
    expect(fileIn([], SITE_HEAD)).toBeUndefined();
    expect(fileIn([], PAGE_HEAD)).toBeUndefined();
  });

  it('imports both the binding and the derivation context', () => {
    const head = fileIn(['seo'], SITE_HEAD) ?? '';
    expect(head).toContain("import { SITE } from '../config/site.config.ts';");
    expect(head).toContain("import { absoluteUrl, siteOrigin } from '../lib/seo.ts';");
  });

  it('puts the imports in the frontmatter', () => {
    const lines = (fileIn(['seo'], SITE_HEAD) ?? '').split('\n');
    const fences = lines.flatMap((line, index) => (line === '---' ? [index] : []));
    for (const statement of lines.filter((line) => line.startsWith('import '))) {
      const at = lines.indexOf(statement);
      expect(at).toBeGreaterThan(fences[0] as number);
      expect(at).toBeLessThan(fences[1] as number);
    }
  });

  it('leaves the not-found component empty of markup', () => {
    const page = fileIn(['seo'], PAGE_HEAD) ?? '';
    expect(page).not.toContain('<link');
    expect(page).not.toContain("!== ''");
  });

  it('hands canonical off the template and nothing else', () => {
    const metadata = fileIn(['seo'], METADATA) ?? '';
    expect(metadata).not.toContain('<link rel="canonical"');
    for (const kept of [
      '<title>',
      '<meta name="description"',
      '<meta name="robots"',
      'property="og:title"',
      'property="og:image"',
      'property="og:locale"',
      'name="twitter:card"',
      'name="twitter:image"',
    ]) {
      expect(metadata, `${kept} was lost`).toContain(kept);
    }
  });

  it('keeps the canonical const the template still needs for og:url', () => {
    expect(fileIn(['seo'], METADATA) ?? '').toContain('const canonical =');
  });

  it('leaves structured data exactly as shipped', () => {
    expect(fileIn(['seo'], 'src/components/StructuredData.astro')).toBe(
      source('templates/astro-tailwind/base/src/components/StructuredData.astro'),
    );
  });

  it('renders the site document as the shell’s fallback', () => {
    expect(fileIn(['seo'], 'src/layouts/BaseLayout.astro') ?? '').toContain(
      '<slot name="head"><DocumentHead /></slot>',
    );
  });

  it('renders the page document from the not-found page only', () => {
    expect(fileIn(['seo'], 'src/pages/404.astro') ?? '').toContain(
      '<Fragment slot="head"><DocumentHeadPageNotFound /></Fragment>',
    );
    expect(fileIn(['seo'], 'src/pages/index.astro') ?? '').not.toContain('slot="head"');
  });

  it('names no route anywhere in the generated project', () => {
    for (const file of [SITE_HEAD, PAGE_HEAD, 'src/layouts/BaseLayout.astro']) {
      const content = fileIn(['seo'], file) ?? '';
      expect(content, `${file} names a route`).not.toMatch(/['"]\/404['"]/);
    }
  });

  it('works the same with no site URL configured', () => {
    // The helpers answer '' for an unset origin, so the tag is omitted by the
    // project at its own build rather than by ClientKit at generation.
    const head = planOf(['seo'], null).plan.operations.find((e) => e.path === SITE_HEAD);
    expect(head?.type === 'write' ? head.content : '').toContain(
      'absoluteUrl(siteOrigin(SITE.url)',
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('generation is deterministic', () => {
  it('produces identical operations across runs', () => {
    const once = JSON.stringify(planOf(['seo']).plan.operations);
    const twice = JSON.stringify(planOf(['seo']).plan.operations);
    expect(once).toBe(twice);
  });

  it('does not depend on the order the contributions were stated', () => {
    const documents = seoDocuments();
    const forward = JSON.stringify(
      realizeAstroDocument(buildDocumentEmission(resolveDocumentForPage(documents, SITE_TARGET))),
    );
    const backward = JSON.stringify(
      realizeAstroDocument(
        buildDocumentEmission(resolveDocumentForPage([...documents].reverse(), SITE_TARGET)),
      ),
    );
    expect(forward).toBe(backward);
  });

  it('reads no clock, environment or randomness', () => {
    for (const file of [
      'src/adapters/astro-document-realization.ts',
      'src/domain/document-handover.ts',
    ]) {
      const code = codeOnly(file);
      for (const token of ['Date.now', 'Math.random', 'process.env', 'readFileSync']) {
        expect(code, `${file} uses ${token}`).not.toContain(token);
      }
    }
  });
});
