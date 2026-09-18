import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AstroHeadEntry } from '../src/adapters/astro-document-surface.js';
import {
  ASTRO_DOCUMENT_OWNERSHIP,
  ASTRO_SEO_HANDOVER,
  composeAstroDocumentHead,
} from '../src/adapters/astro-document-surface.js';
import {
  ASTRO_BINDING_EXPRESSIONS,
  ASTRO_BINDING_REALIZATIONS,
  astroExpressionFor,
  astroImportsFor,
  collectAstroImports,
  dedupeAstroImports,
  renderAstroImports,
} from '../src/adapters/astro-bindings.js';
import {
  ASTRO_SEO_HANDOVER_FIELDS,
  ASTRO_SEO_SEGMENTS,
  renderAstroSeoSource,
} from '../src/adapters/astro-seo-source.js';
import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import type { EmissionField } from '../src/domain/document-emission.js';
import { EMISSION_FIELDS } from '../src/domain/document-emission.js';
import { assertHandoverIsPossible, fieldsToHandOver } from '../src/domain/document-handover.js';
import type { DocumentBinding } from '../src/domain/document-value.js';
import { DOCUMENT_BINDING_IDS } from '../src/domain/document-value.js';
import type { ProjectManifest } from '../src/domain/manifest.js';
import { resolveRole } from '../src/domain/roles.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import type { CliError } from '../src/errors.js';

/**
 * Field-level handover: a template giving up one tag at a time.
 *
 * Stage 41 measured what happens without it. Stage 40's declaration said the
 * composition owned `title`; `Seo.astro` emitted one anyway; a real build
 * produced two, plus two canonicals disagreeing with each other and a canonical
 * on a `noindex` page. Ownership existed only as an opinion.
 *
 * So the property under test is not "the composition can emit a title". It is
 * that the template *stops* in the same step, and that everything richer than
 * the semantic model - Twitter's image, the card upgrade, Open Graph's image
 * and locale, the organisation's contact fields - survives untouched.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const ASTRO = adapters.framework('astro').architectureDefinitions[0]!;

const source = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');

const SHIPPED_SEO = source('templates/astro-tailwind/base/src/components/Seo.astro');

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

const astroManifest = (): ProjectManifest =>
  ({
    targetDir: path.join(path.parse(process.cwd()).root, 'ck-test', 'site'),
    projectName: 'site',
    framework: 'astro',
    buildTool: 'astro',
    language: 'ts',
    styling: 'tailwind',
    uiLibrary: 'none',
    router: 'file-based',
    architecture: 'astro-standard',
    starter: 'coming-soon',
    features: [],
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

const plannedOperations = () =>
  planManifest(astroManifest(), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'coming-soon',
    templateId: 'astro-tailwind',
  }).plan.operations;

/** The tag each field is recognised by in the rendered component. */
const TAG: Readonly<Record<EmissionField, string>> = {
  title: '<title>',
  description: '<meta name="description"',
  robots: '<meta name="robots"',
  canonical: '<link rel="canonical"',
  'open-graph': 'property="og:title"',
  twitter: 'name="twitter:card"',
  'structured-data': 'application/ld+json',
};

/** The real markup each field is emitted as, for the duplicate-count test. */
const REAL_TAG: Readonly<Record<string, string>> = {
  title: '<title>{SITE.name}</title>',
  description: '<meta name="description" content="x" />',
  robots: '<meta name="robots" content="index, follow" />',
  canonical: '<link rel="canonical" href="https://x.example/" />',
  'open-graph': '<meta property="og:title" content="x" />',
};

const COMPOSABLE: readonly EmissionField[] = [
  'title',
  'description',
  'robots',
  'canonical',
  'open-graph',
];

const entryFor = (
  field: EmissionField,
  bindings: readonly DocumentBinding[] = [],
): AstroHeadEntry => ({
  field,
  source: `<meta name="ck-handover" content="${field}" />`,
  owner: 'contributor:synthetic',
  bindings,
});

// ---------------------------------------------------------------------------
// The default path
// ---------------------------------------------------------------------------

describe('with nothing handed over, the component is the shipped one', () => {
  it('reproduces the template byte for byte', () => {
    /*
     * The load-bearing assertion of the whole mechanism. The segment model is a
     * decomposition of a real file, and this is what stops it becoming a
     * second, drifting copy of it: render everything and you get the original,
     * exactly, or this fails.
     */
    expect(renderAstroSeoSource([])).toBe(SHIPPED_SEO);
  });

  it('still emits all seven fields', () => {
    const rendered = renderAstroSeoSource([]);
    for (const field of EMISSION_FIELDS) {
      if (field === 'structured-data') continue;
      expect(rendered, `${field} missing`).toContain(TAG[field]);
    }
  });

  it('is never rendered on the default path at all', () => {
    // The V1 path copies the template; it does not go through the model. So the
    // goldens are proof of the default, and this module only matters when
    // something composes.
    const planned = plannedOperations().find(
      (operation) => operation.path === 'src/components/Seo.astro',
    );
    if (planned?.type !== 'write') throw new Error('narrowing failed');
    expect(planned.content).toBe(SHIPPED_SEO);
    expect(planned.origin).not.toContain('handed over');
  });
});

// ---------------------------------------------------------------------------
// Field by field
// ---------------------------------------------------------------------------

describe('each composition-owned field hands over independently', () => {
  it.each(COMPOSABLE)('removes only %s', (field) => {
    const rendered = renderAstroSeoSource([field]);
    expect(rendered, `${field} still emitted`).not.toContain(TAG[field]);
    for (const other of EMISSION_FIELDS) {
      if (other === field || other === 'structured-data') continue;
      expect(rendered, `${other} lost with ${field}`).toContain(TAG[other]);
    }
  });

  it('is not a single switch', () => {
    // Five fields, five distinct results: a mechanism that handed the block
    // over as a unit would produce the same source for every one of them.
    const rendered = COMPOSABLE.map((field) => renderAstroSeoSource([field]));
    expect(new Set(rendered).size).toBe(COMPOSABLE.length);
  });

  it('removes exactly the fields asked for, for every combination', () => {
    for (let mask = 0; mask < 1 << COMPOSABLE.length; mask += 1) {
      const handedOver = COMPOSABLE.filter((_, index) => (mask & (1 << index)) !== 0);
      const rendered = renderAstroSeoSource(handedOver);
      for (const field of EMISSION_FIELDS) {
        if (field === 'structured-data') continue;
        const expected = !handedOver.includes(field);
        expect(rendered.includes(TAG[field]), `${field} with [${handedOver.join(',')}]`).toBe(
          expected,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The frontmatter has to follow the markup
// ---------------------------------------------------------------------------

describe('the frontmatter goes with the tags that needed it', () => {
  /**
   * What each frontmatter binding needs in scope, stated here independently of
   * the segment model so the two have to agree.
   *
   * `noUnusedLocals` is on in the generated project, so a const left behind is
   * a compile error and a const taken too early is a missing name. Both were
   * measured: stripping the five tags naively left four unused locals, and a
   * first attempt at the dependency closure dropped `absoluteUrl` while the
   * canonical const that calls it stayed for `og:url`.
   */
  const NEEDS: readonly (readonly [string, string])[] = [
    // The import fragment, not the bare name: `absoluteUrl` also appears inside
    // the canonical const that calls it, so looking for the identifier alone
    // cannot tell whether the import survived.
    ['const canonical', '{ absoluteUrl,'],
    ['const canonical', 'const blocked'],
    ['const canonical', 'const origin'],
    ['const robots', 'const blocked'],
    ['const blocked', 'noindex = false'],
  ];

  it('never leaves a name used but not declared', () => {
    for (let mask = 0; mask < 1 << COMPOSABLE.length; mask += 1) {
      const handedOver = COMPOSABLE.filter((_, index) => (mask & (1 << index)) !== 0);
      const rendered = renderAstroSeoSource(handedOver);
      for (const [dependent, dependency] of NEEDS) {
        if (!rendered.includes(dependent)) continue;
        expect(rendered.includes(dependency), `${dependent} needs ${dependency}`).toBe(true);
      }
    }
  });

  it('never leaves a declaration nothing reads', () => {
    // The mirror image. Each of these is declared only for the tags listed, so
    // when all of them are gone the declaration has to go too.
    const ONLY_FOR: readonly (readonly [string, readonly EmissionField[]])[] = [
      ['const robots', ['robots']],
      ['const ogLocale', ['open-graph']],
      ["type = 'website'", ['open-graph']],
      ['const canonical', ['canonical', 'open-graph']],
      ['{ absoluteUrl,', ['canonical', 'open-graph']],
      ['const blocked', ['robots', 'canonical', 'open-graph']],
      ['noindex = false', ['robots', 'canonical', 'open-graph']],
    ];

    for (let mask = 0; mask < 1 << COMPOSABLE.length; mask += 1) {
      const handedOver = COMPOSABLE.filter((_, index) => (mask & (1 << index)) !== 0);
      const rendered = renderAstroSeoSource(handedOver);
      for (const [declaration, servedFields] of ONLY_FOR) {
        const anyoneLeft = servedFields.some((field) => !handedOver.includes(field));
        expect(
          rendered.includes(declaration),
          `${declaration} with [${handedOver.join(',')}]`,
        ).toBe(anyoneLeft);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// What the template keeps
// ---------------------------------------------------------------------------

describe('the richer template behaviour survives every handover', () => {
  const ALL = renderAstroSeoSource(COMPOSABLE);

  it.each([
    ['the Twitter card upgrade', "content={socialImage !== '' ? SEO.twitterCard : 'summary'}"],
    ['the Twitter image', 'name="twitter:image"'],
    ['the Twitter title', 'name="twitter:title"'],
    ['the Twitter description', 'name="twitter:description"'],
  ])('keeps %s', (_label, marker) => {
    expect(ALL).toContain(marker);
  });

  it.each([
    ['og:image', 'property="og:image"'],
    ['og:locale', 'property="og:locale"'],
    ['og:type', 'property="og:type"'],
    ['og:site_name', 'property="og:site_name"'],
  ])('keeps %s while Open Graph is the template’s', (_label, marker) => {
    // Open Graph is one field in the vocabulary and several tags in the
    // template. While it stays, every one of them stays.
    expect(renderAstroSeoSource(['title', 'description', 'robots', 'canonical'])).toContain(marker);
  });

  it('gives up og:image only because the whole block went with it', () => {
    // And when Open Graph does go, the image goes with it rather than being
    // orphaned - it is part of that block, not a separate claim.
    expect(ALL).not.toContain('property="og:image"');
    expect(ALL).toContain('name="twitter:image"');
  });

  it('never touches structured data', () => {
    const structured = source('templates/astro-tailwind/base/src/components/StructuredData.astro');
    for (const marker of [
      "organization['email']",
      "organization['telephone']",
      "organization['sameAs']",
      "organization['location']",
    ]) {
      expect(structured).toContain(marker);
    }
    // Nothing in the handover model mentions the component at all.
    for (const segment of ASTRO_SEO_SEGMENTS) {
      expect(segment.source).not.toContain('ld+json');
    }
  });

  it('leaves the 404 to say what it always said', () => {
    const notFound = source('templates/astro-tailwind/base/src/pages/404.astro');
    expect(notFound).toContain('noindex={true}');
    expect(notFound).toContain('structuredData={false}');
    // The page passes props to the layout; handover changes neither.
    expect(renderAstroSeoSource([])).toContain('noindex = false');
  });
});

// ---------------------------------------------------------------------------
// Ownership and capability have to agree
// ---------------------------------------------------------------------------

describe('a field cannot be claimed unless the template can release it', () => {
  it('holds for Astro as it is declared today', () => {
    expect(() =>
      assertHandoverIsPossible(ASTRO_DOCUMENT_OWNERSHIP, ASTRO_SEO_HANDOVER),
    ).not.toThrow();
  });

  it('reads the capability off the model rather than restating it', () => {
    expect([...ASTRO_SEO_HANDOVER.surrenderable].sort()).toEqual([...COMPOSABLE].sort());
    expect(ASTRO_SEO_HANDOVER.surrenderable).toBe(ASTRO_SEO_HANDOVER_FIELDS);
  });

  it('refuses a claim the template cannot honour', () => {
    /*
     * Exactly the configuration Stage 41 found in the tree: ownership claiming
     * a field the component goes on emitting. It is now a refusal at the point
     * the two declarations meet.
     */
    const message = refusal(() =>
      assertHandoverIsPossible(
        { ...ASTRO_DOCUMENT_OWNERSHIP, composed: [...COMPOSABLE, 'twitter'] },
        ASTRO_SEO_HANDOVER,
      ),
    );
    expect(message).toContain('twitter');
    expect(message).toContain('cannot stop emitting');
  });

  it('allows a template that can release more than is claimed', () => {
    // The asymmetry is deliberate: a capability nobody has claimed is a
    // decision not yet taken, not a contradiction.
    expect(() =>
      assertHandoverIsPossible(
        { ...ASTRO_DOCUMENT_OWNERSHIP, composed: ['title'] },
        ASTRO_SEO_HANDOVER,
      ),
    ).not.toThrow();
  });
});

describe('choosing what to hand over', () => {
  it('returns the fields in vocabulary order, whatever order they arrived in', () => {
    expect(
      fieldsToHandOver(ASTRO_DOCUMENT_OWNERSHIP, ASTRO_SEO_HANDOVER, [
        'canonical',
        'title',
        'robots',
      ]),
    ).toEqual(['title', 'robots', 'canonical']);
  });

  it('de-duplicates', () => {
    expect(
      fieldsToHandOver(ASTRO_DOCUMENT_OWNERSHIP, ASTRO_SEO_HANDOVER, ['title', 'title']),
    ).toEqual(['title']);
  });

  it('refuses a field the composition does not own', () => {
    const message = refusal(() =>
      fieldsToHandOver(ASTRO_DOCUMENT_OWNERSHIP, ASTRO_SEO_HANDOVER, ['twitter']),
    );
    expect(message).toContain('cannot hand over twitter');
    expect(message).toContain('silently missing');
  });

  it('refuses a field the template cannot release', () => {
    const message = refusal(() =>
      fieldsToHandOver(
        { ...ASTRO_DOCUMENT_OWNERSHIP, composed: [...COMPOSABLE, 'structured-data'] },
        ASTRO_SEO_HANDOVER,
        ['structured-data'],
      ),
    );
    expect(message).toContain('no way to stop emitting structured-data');
  });
});

// ---------------------------------------------------------------------------
// End to end, through the surface
// ---------------------------------------------------------------------------

describe('composing a field takes it off the template', () => {
  const composeWith = (entries: readonly AstroHeadEntry[]) =>
    composeAstroDocumentHead(ASTRO, plannedOperations(), entries);

  const written = (
    entries: readonly AstroHeadEntry[],
    role: 'app.document.metadata' | 'app.document.head',
  ) => {
    const target = resolveRole(ASTRO, role);
    const operation = composeWith(entries).find((entry) => entry.path === target);
    if (operation?.type !== 'write') throw new Error(`nothing written at ${target}`);
    return operation;
  };

  it.each(COMPOSABLE)('%s leaves the template when it is composed', (field) => {
    const metadata = written([entryFor(field)], 'app.document.metadata');
    expect(metadata.content).not.toContain(TAG[field]);
    expect(metadata.origin).toContain(`${field} handed over`);
  });

  it('puts it in the composed head in the same step', () => {
    const head = written([entryFor('title')], 'app.document.head');
    expect(head.content).toContain('content="title"');
  });

  it('never has a field in both places', () => {
    /*
     * The Stage 41 defect, as an assertion. Composing a field and leaving the
     * template emitting it is the one outcome the mechanism exists to prevent,
     * and a build cannot tell you about it - it succeeds.
     */
    for (const field of COMPOSABLE) {
      // The entry emits the real tag, so the count is meaningful: exactly one
      // Astro component in the project may carry it.
      const operations = composeWith([
        { field, source: REAL_TAG[field] as string, owner: 'contributor:synthetic', bindings: [] },
      ]);
      const places = operations.filter(
        (operation) =>
          operation.type === 'write' &&
          operation.path.endsWith('.astro') &&
          operation.content.includes(TAG[field]),
      );
      expect(
        places.map((operation) => operation.path),
        `${field} is emitted from ${places.length} components`,
      ).toEqual(['src/components/DocumentHead.astro']);
    }
  });

  it('keeps the untouched fields in the template', () => {
    const metadata = written([entryFor('title'), entryFor('canonical')], 'app.document.metadata');
    for (const kept of ['description', 'robots', 'open-graph', 'twitter'] as const) {
      expect(metadata.content, `${kept} was lost`).toContain(TAG[kept]);
    }
  });

  it('hands over all five at once when all five are composed', () => {
    const metadata = written(
      COMPOSABLE.map((field) => entryFor(field)),
      'app.document.metadata',
    );
    for (const field of COMPOSABLE) expect(metadata.content).not.toContain(TAG[field]);
    expect(metadata.content).toContain(TAG.twitter);
  });

  it('refuses when there is no component to hand over from', () => {
    // Without this the composer would read `.content` off nothing and fail with
    // a TypeError, which says where it broke rather than what was missing.
    const without = plannedOperations().filter(
      (operation) => operation.path !== 'src/components/Seo.astro',
    );
    const message = refusal(() => composeAstroDocumentHead(ASTRO, without, [entryFor('title')]));
    expect(message).toContain('no component to be handed over from');
    expect(message).toContain('src/components/Seo.astro');
  });

  it('refuses to hand over from a component it does not recognise', () => {
    const tampered = plannedOperations().map((operation) =>
      operation.type === 'write' && operation.path === 'src/components/Seo.astro'
        ? { ...operation, content: `${operation.content}\n<meta name="extra" />\n` }
        : operation,
    );
    const message = refusal(() => composeAstroDocumentHead(ASTRO, tampered, [entryFor('title')]));
    expect(message).toContain('not the component the handover model describes');
  });

  it('leaves the default path untouched', () => {
    const operations = plannedOperations();
    expect(composeAstroDocumentHead(ASTRO, operations, [])).toBe(operations);
  });
});

// ---------------------------------------------------------------------------
// Bindings: how it is spelled, and what makes the spelling work
// ---------------------------------------------------------------------------

describe('a binding realization carries its own context', () => {
  it('covers every binding in the vocabulary', () => {
    expect(Object.keys(ASTRO_BINDING_REALIZATIONS).sort()).toEqual([...DOCUMENT_BINDING_IDS]);
  });

  it('agrees with the expression table rather than restating it', () => {
    for (const binding of DOCUMENT_BINDING_IDS) {
      expect(ASTRO_BINDING_REALIZATIONS[binding].expression).toBe(
        ASTRO_BINDING_EXPRESSIONS[binding],
      );
    }
  });

  it('names a role for every imported symbol, never a path', () => {
    for (const binding of DOCUMENT_BINDING_IDS) {
      for (const entry of astroImportsFor(binding)) {
        expect(() => resolveRole(ASTRO, entry.role)).not.toThrow();
        expect(entry.named).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      }
    }
  });

  it('asks for nothing when the expression is an Astro global', () => {
    // `Astro.url.pathname` and `Astro.generator` are ambient in a component, so
    // requiring an import for them would emit one that does not exist.
    expect(astroImportsFor('page.path')).toEqual([]);
    expect(astroImportsFor('generator.name')).toEqual([]);
  });

  it('knows that the site bindings need the configuration in scope', () => {
    // The Stage 41 failure, stated as the thing that fixes it: the expression
    // `SITE.name` is useless without the import that defines `SITE`.
    expect(astroExpressionFor('site.name')).toBe('SITE.name');
    expect(astroImportsFor('site.name')).toEqual([{ role: 'config.site', named: 'SITE' }]);
  });
});

describe('imports are gathered deterministically', () => {
  it('produces one import for two bindings that share a symbol', () => {
    expect(collectAstroImports(['site.name', 'site.url', 'site.description'])).toEqual([
      { role: 'config.site', named: 'SITE' },
    ]);
  });

  it('keeps distinct symbols from one module apart', () => {
    expect(collectAstroImports(['site.name', 'document.indexingBlocked'])).toEqual([
      { role: 'config.site', named: 'SEO' },
      { role: 'config.site', named: 'SITE' },
    ]);
  });

  it('does not depend on the order the bindings arrived in', () => {
    const forward = collectAstroImports(['site.name', 'document.socialImage', 'page.path']);
    const backward = collectAstroImports(['page.path', 'document.socialImage', 'site.name']);
    expect(forward).toEqual(backward);
  });

  it('is stable across every permutation of a set', () => {
    const bindings: readonly DocumentBinding[] = [
      'site.url',
      'document.twitterCardStyle',
      'site.language',
    ];
    const permutations = [
      [bindings[0]!, bindings[1]!, bindings[2]!],
      [bindings[0]!, bindings[2]!, bindings[1]!],
      [bindings[1]!, bindings[0]!, bindings[2]!],
      [bindings[1]!, bindings[2]!, bindings[0]!],
      [bindings[2]!, bindings[0]!, bindings[1]!],
      [bindings[2]!, bindings[1]!, bindings[0]!],
    ];
    const rendered = permutations.map((order) => JSON.stringify(collectAstroImports(order)));
    expect(new Set(rendered).size).toBe(1);
  });

  it('refuses a symbol claimed by two modules', () => {
    /*
     * Nothing in today's vocabulary imports two different modules, so this goes
     * through `dedupeAstroImports` directly - the reason that function is
     * separate. An earlier version of this test re-implemented the check
     * inline and therefore proved nothing: a mutation that deleted the real
     * guard passed it.
     */
    const message = refusal(() =>
      dedupeAstroImports([
        { role: 'config.site', named: 'SITE' },
        { role: 'app.layout', named: 'SITE' },
      ]),
    );
    expect(message).toContain('imported from both');
    expect(message).toContain('reading the wrong module');
  });

  it('accepts the same symbol twice from one module', () => {
    expect(
      dedupeAstroImports([
        { role: 'config.site', named: 'SITE' },
        { role: 'config.site', named: 'SITE' },
      ]),
    ).toEqual([{ role: 'config.site', named: 'SITE' }]);
  });

  it('renders one statement per module', () => {
    const statements = renderAstroImports(
      collectAstroImports(['site.name', 'document.indexingBlocked']),
      () => '../config/site.config.ts',
    );
    expect(statements).toEqual(["import { SEO, SITE } from '../config/site.config.ts';"]);
  });

  it('renders nothing for bindings that need nothing', () => {
    expect(renderAstroImports(collectAstroImports(['page.path']), () => 'x')).toEqual([]);
  });
});

describe('the composed head gets the imports its entries need', () => {
  const head = (bindings: readonly DocumentBinding[]) => {
    const operations = composeAstroDocumentHead(ASTRO, plannedOperations(), [
      {
        field: 'title',
        source: `<title>{${astroExpressionFor('site.name')}}</title>`,
        owner: 'contributor:synthetic',
        bindings,
      },
    ]);
    const target = resolveRole(ASTRO, 'app.document.head');
    const operation = operations.find((entry) => entry.path === target);
    if (operation?.type !== 'write') throw new Error('narrowing failed');
    return operation.content;
  };

  it('writes the import the expression depends on', () => {
    /*
     * Stage 41's probe emitted `{SITE.name}` with no import and the build
     * failed with `ReferenceError: SITE is not defined`. This is that, fixed.
     */
    expect(head(['site.name'])).toContain("import { SITE } from '../config/site.config.ts';");
  });

  it('puts it inside the frontmatter', () => {
    const lines = head(['site.name']).split('\n');
    const fences = lines.flatMap((line, index) => (line === '---' ? [index] : []));
    const statement = lines.indexOf("import { SITE } from '../config/site.config.ts';");
    expect(statement).toBeGreaterThan(fences[0] as number);
    expect(statement).toBeLessThan(fences[1] as number);
  });

  it('writes no import when nothing needs one', () => {
    expect(head([])).not.toContain('import');
  });

  it('resolves the specifier relative to the component, not the project', () => {
    // The component lives in src/components, the configuration in src/config,
    // so the specifier has to climb one level. A project-relative path would
    // compile to nothing.
    expect(head(['site.name'])).toContain("'../config/site.config.ts'");
    expect(head(['site.name'])).not.toContain("'src/config/site.config.ts'");
  });
});

// ---------------------------------------------------------------------------
// Closed, still
// ---------------------------------------------------------------------------

describe('the realization vocabulary stays closed', () => {
  it('builds no expression from anything but its own constants', () => {
    const text = source('src/adapters/astro-bindings.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of ['eval(', 'new Function', 'vm.', 'require(']) {
      expect(text, `astro-bindings.ts uses ${forbidden}`).not.toContain(forbidden);
    }
    // No expression is assembled: every one is a literal in the table.
    expect(text).not.toMatch(/expression:\s*`[^`]*\$\{/);
  });

  it('builds no source from anything but its own segments', () => {
    // The segments carry the template's own source, which legitimately contains
    // a .replace call of its own - so the subject is the renderer's body, not
    // the data it concatenates.
    const text = source('src/adapters/astro-seo-source.ts');
    const body = text.slice(text.indexOf('export function renderAstroSeoSource'));
    expect(body).toContain('.filter(');
    expect(body).toContain(".join('')");
    for (const surgery of ['replace(', 'RegExp', 'match(', 'slice(', 'indexOf(']) {
      expect(body, `the renderer does source surgery: ${surgery}`).not.toContain(surgery);
    }
  });

  it('keeps the domain free of Astro', () => {
    // Comments may explain what Astro does; the code may not know. Prose is
    // stripped first, which is the difference between a module that documents
    // its motivation and one that depends on a framework.
    const text = codeOnly('src/domain/document-handover.ts');
    for (const astroism of ['Astro', 'astro', 'SITE', 'SEO', 'frontmatter']) {
      expect(text, `document-handover.ts names ${astroism}`).not.toContain(astroism);
    }
  });

  it('implements no realization', () => {
    // Stage 42 moves ownership; it does not spell a document. Nothing here
    // reads an emission plan or performs a derivation.
    const text = source('src/adapters/astro-document-surface.ts');
    for (const token of ['DocumentEmissionPlan', 'buildDocumentEmission', 'absolute-page-url']) {
      expect(text, `the surface does realization: ${token}`).not.toContain(token);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('handover is deterministic', () => {
  it('renders the same source twice', () => {
    expect(renderAstroSeoSource(['title', 'canonical'])).toBe(
      renderAstroSeoSource(['title', 'canonical']),
    );
  });

  it('does not depend on the order the fields were given', () => {
    expect(renderAstroSeoSource(['canonical', 'title'])).toBe(
      renderAstroSeoSource(['title', 'canonical']),
    );
  });

  it('produces identical operations under every permutation of the entries', () => {
    const entries = [entryFor('title', ['site.name']), entryFor('canonical', ['site.url'])];
    const a = JSON.stringify(composeAstroDocumentHead(ASTRO, plannedOperations(), entries));
    const b = JSON.stringify(
      composeAstroDocumentHead(ASTRO, plannedOperations(), [entries[1]!, entries[0]!]),
    );
    expect(a).toBe(b);
  });
});
