import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { composeAstroDocument } from '../src/adapters/astro-document-surface.js';
import { realizeAstroDocument } from '../src/adapters/astro-document-realization.js';
import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { resolveProject } from '../src/adapters/selection.js';
import type { DocumentContribution } from '../src/domain/document-contribution.js';
import { EVERY_PAGE, onPage } from '../src/domain/document-contribution.js';
import { buildDocumentEmission, describeEmissionPlan } from '../src/domain/document-emission.js';
import { SITE_TARGET, forPage, resolveDocumentForPage } from '../src/domain/document-scope.js';
import { literal } from '../src/domain/document-value.js';
import type { FeatureId, ProjectManifest } from '../src/domain/index.js';
import type { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * More than one contributor, one document.
 *
 * Stage 44 proved the pipeline end to end with a single production feature,
 * which leaves the question this file exists for: is the architecture actually
 * compositional, or does it merely work when nobody else is talking?
 *
 * The answer has to come from real features. Two of them now state documents -
 * SEO says what a page's address is, structured data says the not-found page
 * describes no organisation - and they meet at the same target without either
 * knowing the other exists.
 *
 * What is deliberately *not* proved by real features is two owners stating the
 * same field at the same scope. No two production features truthfully do that
 * today, so agreement and conflict are exercised through the production
 * resolver with a second owner invented here, in a test, where inventing one is
 * allowed.
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

const manifest = (features: readonly FeatureId[]): ProjectManifest =>
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
      url: 'https://acme.example',
      description: 'Bespoke widgets.',
      locale: 'en-GB',
      author: null,
    },
    packageManager: 'npm',
    git: true,
    install: true,
  }) as ProjectManifest;

const planOf = (features: readonly FeatureId[]) =>
  planManifest(manifest(features), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'coming-soon',
    templateId: 'astro-tailwind',
  });

/** What the real adapters contribute, read from the adapters themselves. */
const documentsOf = (features: readonly FeatureId[]): readonly DocumentContribution[] => {
  const { project, selection } = resolveProject(manifest(features), adapters);
  return selection.adapters.flatMap(({ adapter }) => adapter.contribute(project).documents ?? []);
};

const BOTH: readonly FeatureId[] = ['seo', 'structured-data'];

/** The production pipeline, exactly as the bridge runs it. */
const planFor = (documents: readonly DocumentContribution[], target: typeof SITE_TARGET) =>
  buildDocumentEmission(resolveDocumentForPage(documents, target));

const NOT_FOUND = forPage('page.notFound');

// ---------------------------------------------------------------------------
// Two real contributors
// ---------------------------------------------------------------------------

describe('two production features state documents', () => {
  it('both contribute, and neither names the other', () => {
    const documents = documentsOf(BOTH);
    expect(documents.map((entry) => entry.owner).sort()).toEqual([
      'feature:seo',
      'feature:seo',
      'feature:structured-data',
    ]);
    expect(codeOnly('src/adapters/structured-data.ts')).not.toContain('seo');
    expect(codeOnly('src/adapters/seo.ts')).not.toContain('structured-data');
  });

  it('both reach the same emission plan', () => {
    /*
     * The join under test. One target, one plan, two owners - and the plan
     * carries what each said without either being folded into the other.
     */
    const plan = planFor(documentsOf(BOTH), NOT_FOUND);
    expect(describeEmissionPlan(plan)).toBe(
      ['the "page.notFound" page', 'canonical: literal', 'structured-data: suppressed'].join('\n'),
    );
  });

  it('composes disjoint fields rather than merging them', () => {
    // Stage 32's field-level rule, now with two owners: each states a
    // different part of the document and both survive intact.
    const plan = planFor(documentsOf(BOTH), NOT_FOUND);
    const fields = plan.items.map((item) => item.field);
    expect(fields).toEqual(['canonical', 'structured-data']);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('leaves the site target to the contributor that speaks about it', () => {
    const plan = planFor(documentsOf(BOTH), SITE_TARGET);
    expect(describeEmissionPlan(plan)).toBe(['the site', 'canonical: derived'].join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Each alone
// ---------------------------------------------------------------------------

describe('each contributor stands on its own', () => {
  it('structured data alone composes nothing', () => {
    /*
     * Its only statement is a refusal, and a refusal renders nothing - so the
     * project is untouched and identical to having no feature at all. A
     * page-scoped statement that *did* render would be refused instead, because
     * the template gives a field up for the whole project and every other page
     * would silently lose it.
     */
    const withIt = planOf(['structured-data']).plan.operations;
    expect(withIt.map((entry) => entry.path)).not.toContain('src/components/DocumentHead.astro');
    const shell = withIt.find((entry) => entry.path === 'src/layouts/BaseLayout.astro');
    expect(shell?.origin).toBe('base');
  });

  it('SEO alone composes exactly what Stage 44 established', () => {
    const paths = planOf(['seo']).plan.operations.map((entry) => entry.path);
    expect(paths).toContain('src/components/DocumentHead.astro');
    expect(paths).toContain('src/components/DocumentHeadPageNotFound.astro');
  });

  it('together they compose the same files SEO does', () => {
    // Structured data adds a statement, not a tag. The file set is proof that
    // a second contributor did not quietly widen the composition.
    const both = planOf(BOTH).plan.operations.map((entry) => entry.path);
    const seoOnly = planOf(['seo']).plan.operations.map((entry) => entry.path);
    expect(both).toEqual(seoOnly);
  });
});

// ---------------------------------------------------------------------------
// Agreement and conflict at one identity
// ---------------------------------------------------------------------------

describe('two owners at the same identity', () => {
  const seoCanonical = documentsOf(['seo']).filter(
    (entry) => entry.scope.kind === 'page',
  ) as readonly DocumentContribution[];

  /** A second owner, invented here because no production pair does this yet. */
  const otherOwner = (value: ReturnType<typeof literal<'url'>>): DocumentContribution => ({
    kind: 'metadata',
    owner: 'feature:test-only',
    reason: 'a second opinion about the same field',
    scope: onPage('page.notFound'),
    metadata: { state: 'stated', value: { canonical: value } },
  });

  it('deduplicates an identical statement into one item', () => {
    /*
     * The property that matters for output: two owners saying the same thing
     * is not a disagreement, and must not become two tags.
     */
    const plan = planFor([...seoCanonical, otherOwner(literal('url', ''))], NOT_FOUND);
    expect(plan.items.filter((item) => item.field === 'canonical')).toHaveLength(1);
  });

  it('records both owners on the one item', () => {
    // Deduplicated, not discarded: the provenance still names everyone who
    // said it, which is what a diagnostic needs.
    const plan = planFor([...seoCanonical, otherOwner(literal('url', ''))], NOT_FOUND);
    const [item] = plan.items;
    if (item?.state !== 'stated') throw new Error('narrowing failed');
    expect([...item.provenance.owners].sort()).toEqual(['feature:seo', 'feature:test-only']);
  });

  it('produces exactly one entry through realization', () => {
    const realized = realizeAstroDocument(
      planFor([...seoCanonical, otherOwner(literal('url', ''))], NOT_FOUND),
    );
    expect(realized.entries).toHaveLength(1);
  });

  it('refuses a differing statement rather than choosing', () => {
    const message = refusal(() =>
      planFor(
        [...seoCanonical, otherOwner(literal('url', 'https://elsewhere.example/'))],
        NOT_FOUND,
      ),
    );
    expect(message).toContain('disagree about metadata.canonical');
    expect(message).toContain('the "page.notFound" page');
    expect(message).toContain('feature:seo');
    expect(message).toContain('feature:test-only');
    expect(message).toContain('nothing here picks a winner');
  });

  it('names both values in the refusal', () => {
    const message = refusal(() =>
      planFor(
        [...seoCanonical, otherOwner(literal('url', 'https://elsewhere.example/'))],
        NOT_FOUND,
      ),
    );
    expect(message).toContain('elsewhere.example');
  });

  it('refuses a statement that meets a suppression', () => {
    // Stage 31's rule, unchanged: one owner saying it and another refusing it
    // is a disagreement, not a precedence question.
    const suppressed: DocumentContribution = {
      kind: 'metadata',
      owner: 'feature:test-only',
      reason: 'says nothing may be said',
      scope: onPage('page.notFound'),
      metadata: { state: 'suppressed', because: 'not on this page' },
    };
    expect(refusal(() => planFor([...seoCanonical, suppressed], NOT_FOUND))).toContain('disagree');
  });
});

// ---------------------------------------------------------------------------
// Order independence
// ---------------------------------------------------------------------------

describe('the result does not depend on who contributed first', () => {
  const forward = documentsOf(BOTH);
  const backward = [...documentsOf(BOTH)].reverse();

  it('produces identical plans for every target', () => {
    for (const target of [SITE_TARGET, NOT_FOUND, forPage('page.home')]) {
      expect(
        describeEmissionPlan(planFor(backward, target)),
        describeEmissionPlan(planFor(forward, target)),
      ).toBe(describeEmissionPlan(planFor(forward, target)));
    }
  });

  it('produces byte-identical operations', () => {
    const operations = (documents: readonly DocumentContribution[]) => {
      const base = planOf([]);
      const compositions = [SITE_TARGET, NOT_FOUND].map((target) =>
        realizeAstroDocument(planFor(documents, target)),
      );
      return JSON.stringify(
        composeAstroDocument(base.project.architecture, base.plan.operations, compositions),
      );
    };
    expect(operations(backward)).toBe(operations(forward));
  });

  it('produces an identical refusal either way', () => {
    /*
     * Equality of diagnostics, not merely of exit status. A message that named
     * whichever owner happened to be first would be a winner by another name.
     */
    const other: DocumentContribution = {
      kind: 'metadata',
      owner: 'feature:test-only',
      reason: 'a second opinion',
      scope: onPage('page.notFound'),
      metadata: {
        state: 'stated',
        value: { canonical: literal('url', 'https://elsewhere.example/') },
      },
    };
    const seoPage = documentsOf(['seo']).filter((entry) => entry.scope.kind === 'page');
    const one = refusal(() => planFor([...seoPage, other], NOT_FOUND));
    const two = refusal(() => planFor([other, ...seoPage], NOT_FOUND));
    expect(one).toBe(two);
    expect(one).not.toBe('');
  });

  it('generates identical projects across repeated runs', () => {
    expect(JSON.stringify(planOf(BOTH).plan.operations)).toBe(
      JSON.stringify(planOf(BOTH).plan.operations),
    );
  });

  it('does not depend on the order the features were selected', () => {
    const forwardPlan = JSON.stringify(planOf(['seo', 'structured-data']).plan.operations);
    const backwardPlan = JSON.stringify(planOf(['structured-data', 'seo']).plan.operations);
    expect(backwardPlan).toBe(forwardPlan);
  });
});

// ---------------------------------------------------------------------------
// Scope, with more than one voice
// ---------------------------------------------------------------------------

describe('specificity holds across contributors', () => {
  it('gives a normal page the every-page statement', () => {
    const plan = planFor(documentsOf(BOTH), forPage('page.home'));
    const [item] = plan.items;
    if (item?.state !== 'stated' || item.field !== 'canonical') throw new Error('narrowing failed');
    expect(item.value.kind).toBe('derived');
  });

  it('gives the not-found page its own, from a different contributor', () => {
    const plan = planFor(documentsOf(BOTH), NOT_FOUND);
    const [canonical] = plan.items;
    if (canonical?.state !== 'stated' || canonical.field === 'structured-data') {
      throw new Error('narrowing failed');
    }
    expect(canonical.value).toEqual(literal('url', ''));
    expect(plan.items[1]?.state).toBe('suppressed');
  });

  it('never broadens a page statement into the site', () => {
    const plan = planFor(documentsOf(BOTH), SITE_TARGET);
    expect(plan.items.map((item) => item.field)).toEqual(['canonical']);
    const [item] = plan.items;
    if (item?.state !== 'stated' || item.field === 'structured-data') {
      throw new Error('narrowing failed');
    }
    expect(item.value.kind).toBe('derived');
  });

  it('keeps each target on the composition that carries it', () => {
    for (const target of [SITE_TARGET, NOT_FOUND]) {
      expect(realizeAstroDocument(planFor(documentsOf(BOTH), target)).target).toEqual(target);
    }
  });
});

// ---------------------------------------------------------------------------
// The bridge grew no second resolver
// ---------------------------------------------------------------------------

describe('one pipeline, whoever contributed', () => {
  it('branches on no feature identity', () => {
    const bridge = codeOnly('src/adapters/bridge.ts');
    for (const name of [
      'feature:seo',
      'feature:structured-data',
      "=== 'seo'",
      "=== 'structured-data'",
    ]) {
      expect(bridge, `bridge.ts branches on ${name}`).not.toContain(name);
    }
  });

  it('keeps the domain unaware of any architecture', () => {
    for (const file of [
      'src/domain/document-contribution.ts',
      'src/domain/document-resolution.ts',
      'src/domain/document-scope.ts',
      'src/domain/document-emission.ts',
      'src/domain/document-handover.ts',
    ]) {
      const code = codeOnly(file);
      for (const leak of ['../adapters/', '../templates/', 'Astro.', 'astro-']) {
        expect(code, `${file} imports ${leak}`).not.toContain(leak);
      }
    }
  });

  it('collects contributions without reading who sent them', () => {
    const bridge = codeOnly('src/adapters/bridge.ts');
    expect(bridge).toContain('contributions.flatMap((entry) => entry.documents ?? [])');
  });
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe('a conflict stops before anything is produced', () => {
  it('throws while planning, so no operation exists to apply', () => {
    /*
     * Planning is pure and separate from applying, so a refusal here cannot
     * leave a half-written project: there is nothing written until the plan is
     * complete, and an incomplete plan is never returned.
     */
    const other: DocumentContribution = {
      kind: 'metadata',
      owner: 'feature:test-only',
      reason: 'a second opinion',
      scope: EVERY_PAGE,
      metadata: {
        state: 'stated',
        value: { canonical: literal('url', 'https://elsewhere.example/') },
      },
    };
    const documents = [...documentsOf(['seo']), other];
    let operations: unknown;
    expect(() => {
      operations = realizeAstroDocument(planFor(documents, SITE_TARGET));
    }).toThrow();
    expect(operations).toBeUndefined();
  });

  it('leaves the planned operations untouched when composition refuses', () => {
    // `composeAstroDocument` returns new operations and never mutates what it
    // was given, so a refusal cannot have changed the project either.
    const base = planOf([]);
    const before = JSON.stringify(base.plan.operations);
    const impossible = [realizeAstroDocument(planFor(documentsOf(['seo']), NOT_FOUND))];
    expect(() =>
      composeAstroDocument(base.project.architecture, base.plan.operations, impossible),
    ).toThrow();
    expect(JSON.stringify(base.plan.operations)).toBe(before);
  });
});
