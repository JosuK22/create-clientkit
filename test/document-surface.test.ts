import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AstroHeadEntry } from '../src/adapters/astro-document-surface.js';
import {
  ASTRO_DOCUMENT_OWNERSHIP,
  ASTRO_HEAD_ANCHOR,
  composeAstroDocumentHead,
} from '../src/adapters/astro-document-surface.js';
import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import type { EmissionField } from '../src/domain/document-emission.js';
import { EMISSION_FIELDS } from '../src/domain/document-emission.js';
import type { DocumentSurfaceOwnership } from '../src/domain/document-surface.js';
import {
  assertFieldsAreComposable,
  assertOwnershipIsUnambiguous,
  ownerOfField,
  templateOwnedFields,
} from '../src/domain/document-surface.js';
import type { ProjectManifest } from '../src/domain/manifest.js';
import { resolveRole } from '../src/domain/roles.js';
import type { FileOperation } from '../src/generate/files.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import type { CliError } from '../src/errors.js';

/**
 * The composition-owned Astro document surface.
 *
 * Stage 39 blocked because realized source had nowhere to render: every file
 * that owns Astro's document has its bytes captured by the V1 goldens, and V1
 * selects no features, so there was no variant path. This is the render site,
 * built on the observation that it only needs to exist when something
 * contributes to it.
 *
 * The property that matters most is the dull one: with nothing to compose, the
 * surface does nothing at all. That is why the V1 goldens - which now run
 * through this code on every Astro generation - are the proof rather than a
 * separate assertion.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const ASTRO = adapters.framework('astro').architectureDefinitions[0]!;

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

const astroManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
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
    ...over,
  }) as ProjectManifest;

const planOf = (manifest: ProjectManifest) =>
  planManifest(manifest, {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: manifest.starter,
    templateId: 'astro-tailwind',
  });

/** A contributor that means nothing, so the surface is tested and not a feature. */
const syntheticEntry: AstroHeadEntry = {
  field: 'title',
  source: '<meta name="ck-synthetic" content="surface proof" />',
  owner: 'contributor:synthetic',
};

// ---------------------------------------------------------------------------
// The default path
// ---------------------------------------------------------------------------

describe('with nothing to compose, the surface does nothing', () => {
  it('returns the operations it was given, unchanged', () => {
    const operations = planOf(astroManifest()).plan.operations;
    const composed = composeAstroDocumentHead(ASTRO, operations, []);
    // Identity, not equality: the default path performs no work at all, which
    // is the strongest form of "byte-identical" available.
    expect(composed).toBe(operations);
  });

  it('generates no document-head component', () => {
    const paths = planOf(astroManifest()).plan.operations.map((entry) => entry.path);
    expect(paths).not.toContain('src/components/DocumentHead.astro');
  });

  it('leaves the shell exactly as the template ships it', () => {
    const shell = planOf(astroManifest()).plan.operations.find(
      (entry) => entry.path === 'src/layouts/BaseLayout.astro',
    );
    if (shell?.type !== 'write') throw new Error('narrowing failed');
    expect(shell.content).toBe(
      source('templates/astro-tailwind/base/src/layouts/BaseLayout.astro'),
    );
    expect(shell.content).not.toContain('DocumentHead');
  });

  it('holds for every starter and both URL states', () => {
    for (const manifest of [
      astroManifest(),
      astroManifest({ starter: 'full' }),
      astroManifest({ site: { ...astroManifest().site, url: null } }),
    ]) {
      const paths = planOf(manifest).plan.operations.map((entry) => entry.path);
      expect(paths).not.toContain('src/components/DocumentHead.astro');
    }
  });
});

// ---------------------------------------------------------------------------
// The render path
// ---------------------------------------------------------------------------

describe('with something to compose, the surface renders it', () => {
  const composed = (
    entries: readonly AstroHeadEntry[] = [syntheticEntry],
  ): readonly FileOperation[] =>
    composeAstroDocumentHead(ASTRO, planOf(astroManifest()).plan.operations, entries);

  it('generates the component at the mapped role', () => {
    const target = resolveRole(ASTRO, 'app.document.head');
    expect(target).toBe('src/components/DocumentHead.astro');
    expect(composed().map((entry) => entry.path)).toContain(target);
  });

  it('imports it into the shell', () => {
    const shell = composed().find((entry) => entry.path === 'src/layouts/BaseLayout.astro');
    if (shell?.type !== 'write') throw new Error('narrowing failed');
    expect(shell.content).toContain("import DocumentHead from '../components/DocumentHead.astro';");
  });

  it('puts the import in the frontmatter, not in the document', () => {
    /*
     * Appending the statement anywhere at all would still satisfy "contains
     * it". Astro would render the line as text after `</html>` and fail to
     * resolve `<DocumentHead />` - a broken document that a substring assertion
     * is perfectly happy with. Where it lands is the part worth asserting.
     */
    const shell = composed().find((entry) => entry.path === 'src/layouts/BaseLayout.astro');
    if (shell?.type !== 'write') throw new Error('narrowing failed');
    const lines = shell.content.split('\n');
    const fences = lines.flatMap((line, index) => (line === '---' ? [index] : []));
    const statement = lines.indexOf("import DocumentHead from '../components/DocumentHead.astro';");
    expect(fences.length).toBeGreaterThanOrEqual(2);
    expect(statement).toBeGreaterThan(fences[0] as number);
    expect(statement).toBeLessThan(fences[1] as number);
  });

  it('renders it inside the head, after the existing tags', () => {
    /*
     * The failure Stage 39 refused to ship was a component nothing rendered.
     * Import plus render, in that order, inside the head - not merely a file on
     * disk.
     */
    const shell = composed().find((entry) => entry.path === 'src/layouts/BaseLayout.astro');
    if (shell?.type !== 'write') throw new Error('narrowing failed');
    expect(shell.content).toContain(`${ASTRO_HEAD_ANCHOR}\n    <DocumentHead />`);
    const headStart = shell.content.indexOf('<head>');
    const headEnd = shell.content.indexOf('</head>');
    const rendered = shell.content.indexOf('<DocumentHead />');
    expect(rendered).toBeGreaterThan(headStart);
    expect(rendered).toBeLessThan(headEnd);
  });

  it('puts the contributed source in the component', () => {
    const component = composed().find(
      (entry) => entry.path === 'src/components/DocumentHead.astro',
    );
    if (component?.type !== 'write') throw new Error('narrowing failed');
    expect(component.content).toContain('<meta name="ck-synthetic" content="surface proof" />');
  });

  it('never leaves a generated file unrendered', () => {
    // The two go together or neither happens.
    const operations = composed();
    const hasComponent = operations.some(
      (entry) => entry.path === 'src/components/DocumentHead.astro',
    );
    const shell = operations.find((entry) => entry.path === 'src/layouts/BaseLayout.astro');
    if (shell?.type !== 'write') throw new Error('narrowing failed');
    expect(hasComponent).toBe(shell.content.includes('<DocumentHead />'));
  });

  it('records where the shell content came from', () => {
    const shell = composed().find((entry) => entry.path === 'src/layouts/BaseLayout.astro');
    expect(shell?.origin).toContain('composed document head');
  });

  it('refuses when the anchor is missing', () => {
    const broken = planOf(astroManifest()).plan.operations.map((entry) =>
      entry.path === 'src/layouts/BaseLayout.astro' && entry.type === 'write'
        ? { ...entry, content: '---\nimport X from "y";\n---\n<html></html>' }
        : entry,
    );
    const message = refusal(() => composeAstroDocumentHead(ASTRO, broken, [syntheticEntry]));
    expect(message).toContain('could not find its place');
    expect(message).toContain('found 0');
  });

  it('refuses when the shell is not planned at all', () => {
    const without = planOf(astroManifest()).plan.operations.filter(
      (entry) => entry.path !== 'src/layouts/BaseLayout.astro',
    );
    expect(refusal(() => composeAstroDocumentHead(ASTRO, without, [syntheticEntry]))).toContain(
      'nothing to render into',
    );
  });
});

// ---------------------------------------------------------------------------
// The anchor is real
// ---------------------------------------------------------------------------

describe('the anchor matches the shipped shell', () => {
  it('appears exactly once in the template', () => {
    const shell = source('templates/astro-tailwind/base/src/layouts/BaseLayout.astro');
    expect(shell.split(ASTRO_HEAD_ANCHOR).length - 1).toBe(1);
  });

  it('sits inside the head', () => {
    const shell = source('templates/astro-tailwind/base/src/layouts/BaseLayout.astro');
    const at = shell.indexOf(ASTRO_HEAD_ANCHOR);
    expect(at).toBeGreaterThan(shell.indexOf('<head>'));
    expect(at).toBeLessThan(shell.indexOf('</head>'));
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('ownership is declared per field', () => {
  it('gives Astro the fields where composition loses nothing', () => {
    expect([...ASTRO_DOCUMENT_OWNERSHIP.composed]).toEqual([
      'title',
      'description',
      'robots',
      'canonical',
      'open-graph',
    ]);
  });

  it('leaves Twitter and structured data with the template, with reasons', () => {
    /*
     * Stage 39's finding, encoded. `Seo.astro` upgrades `twitter:card` once a
     * social image exists and emits `twitter:image`; `StructuredData.astro`
     * emits email, telephone, sameAs and location. The semantic contracts model
     * none of those, so composing these fields would be a regression wearing a
     * refactor.
     */
    expect([...templateOwnedFields(ASTRO_DOCUMENT_OWNERSHIP)]).toEqual([
      'twitter',
      'structured-data',
    ]);
    expect(ASTRO_DOCUMENT_OWNERSHIP.templateOwnedBecause.twitter).toContain('twitter:image');
    expect(ASTRO_DOCUMENT_OWNERSHIP.templateOwnedBecause['structured-data']).toContain('sameAs');
  });

  it('answers who owns each field', () => {
    expect(ownerOfField(ASTRO_DOCUMENT_OWNERSHIP, 'title')).toBe('composition');
    expect(ownerOfField(ASTRO_DOCUMENT_OWNERSHIP, 'twitter')).toBe('template');
    expect(ownerOfField(ASTRO_DOCUMENT_OWNERSHIP, 'structured-data')).toBe('template');
  });

  it('accounts for every field in the vocabulary', () => {
    const accounted = [
      ...ASTRO_DOCUMENT_OWNERSHIP.composed,
      ...templateOwnedFields(ASTRO_DOCUMENT_OWNERSHIP),
    ].sort();
    expect(accounted).toEqual([...EMISSION_FIELDS].sort());
  });

  it('is internally consistent', () => {
    expect(() => assertOwnershipIsUnambiguous(ASTRO_DOCUMENT_OWNERSHIP)).not.toThrow();
  });
});

describe('a field cannot be owned twice', () => {
  it('refuses a declaration claiming both sides', () => {
    const contradictory: DocumentSurfaceOwnership = {
      architecture: 'synthetic-contradictory',
      composed: ['title', 'twitter'],
      templateOwnedBecause: { twitter: 'the template already emits it' },
    };
    const message = refusal(() => assertOwnershipIsUnambiguous(contradictory));
    expect(message).toContain('twitter');
    expect(message).toContain('two of it');
  });

  it('refuses a field outside the vocabulary', () => {
    const bogus = {
      architecture: 'synthetic-bogus',
      composed: ['title', 'favicon'],
      templateOwnedBecause: {},
    } as unknown as DocumentSurfaceOwnership;
    expect(refusal(() => assertOwnershipIsUnambiguous(bogus))).toContain('favicon');
  });

  it('refuses a contribution aimed at a template-owned field', () => {
    /*
     * The duplicate this whole model exists to prevent: two `twitter:card`
     * elements in one document, one from `Seo.astro` and one composed.
     */
    const message = refusal(() =>
      assertFieldsAreComposable(ASTRO_DOCUMENT_OWNERSHIP, ['title', 'twitter']),
    );
    expect(message).toContain('twitter');
    // Phrased without spanning the hint's line wrap.
    expect(message).toContain('would build without complaint');
    expect(message).not.toContain('title');
  });

  it('refuses it through the composer too', () => {
    const entries: AstroHeadEntry[] = [
      {
        field: 'twitter',
        source: '<meta name="twitter:card" content="x" />',
        owner: 'contributor:x',
      },
    ];
    const message = refusal(() =>
      composeAstroDocumentHead(ASTRO, planOf(astroManifest()).plan.operations, entries),
    );
    expect(message).toContain('twitter');
    expect(message).toContain('astro-standard');
  });

  it('accepts every field it does own', () => {
    expect(() =>
      assertFieldsAreComposable(ASTRO_DOCUMENT_OWNERSHIP, [...ASTRO_DOCUMENT_OWNERSHIP.composed]),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('composition is deterministic', () => {
  const entries: AstroHeadEntry[] = [
    { field: 'title', source: '<meta name="a" content="1" />', owner: 'contributor:b' },
    { field: 'canonical', source: '<meta name="b" content="2" />', owner: 'contributor:a' },
    { field: 'description', source: '<meta name="c" content="3" />', owner: 'contributor:c' },
  ];

  const render = (order: readonly AstroHeadEntry[]): string =>
    JSON.stringify(composeAstroDocumentHead(ASTRO, planOf(astroManifest()).plan.operations, order));

  it('is identical under all six permutations', () => {
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => order.map((index) => entries[index]!));
    expect(new Set(permutations.map(render)).size).toBe(1);
  });

  it('is byte-identical across repeated runs', () => {
    expect(new Set([1, 2, 3].map(() => render(entries))).size).toBe(1);
  });

  it('orders entries by field then owner, never by arrival', () => {
    const composed = composeAstroDocumentHead(
      ASTRO,
      planOf(astroManifest()).plan.operations,
      entries,
    ).find((entry) => entry.path === 'src/components/DocumentHead.astro');
    if (composed?.type !== 'write') throw new Error('narrowing failed');
    const order = ['a', 'b', 'c'].map((name) => composed.content.indexOf(`name="${name}"`));
    // canonical < description < title alphabetically, so b, c, a.
    expect(order[1]).toBeLessThan(order[2]!);
    expect(order[2]).toBeLessThan(order[0]!);
  });
});

// ---------------------------------------------------------------------------
// The existing document is untouched
// ---------------------------------------------------------------------------

describe('existing template behaviour survives', () => {
  const shellOf = (entries: readonly AstroHeadEntry[]): string => {
    const found = composeAstroDocumentHead(
      ASTRO,
      planOf(astroManifest()).plan.operations,
      entries,
    ).find((entry) => entry.path === 'src/layouts/BaseLayout.astro');
    if (found?.type !== 'write') throw new Error('narrowing failed');
    return found.content;
  };

  it('keeps every existing head tag when composing', () => {
    const shell = shellOf([syntheticEntry]);
    for (const kept of ['<Seo title={title}', 'StructuredData', 'theme-color', 'favicon.svg']) {
      expect(shell, `composition removed ${kept}`).toContain(kept);
    }
  });

  it('keeps the project-owned values dynamic', () => {
    // Nothing here freezes SITE or THEME into the shell.
    const shell = shellOf([syntheticEntry]);
    expect(shell).toContain('lang={SITE.locale}');
    expect(shell).not.toContain('lang="en-GB"');
    expect(shell).not.toContain('Acme Ltd');
  });

  it('keeps the template-owned image behaviour in Seo.astro', () => {
    const seo = source('templates/astro-tailwind/base/src/components/Seo.astro');
    for (const kept of ['og:image', 'twitter:image', 'SEO.twitterCard']) {
      expect(seo, `Stage 40 removed ${kept}`).toContain(kept);
    }
  });

  it('keeps the template-owned organisation fields', () => {
    const structured = source('templates/astro-tailwind/base/src/components/StructuredData.astro');
    for (const kept of ['CONTACT.email', 'CONTACT.phone', 'CONTACT.location', 'sameAs']) {
      expect(structured, `Stage 40 removed ${kept}`).toContain(kept);
    }
  });

  it('leaves the 404 exactly as it was', () => {
    const notFound = source('templates/astro-tailwind/base/src/pages/404.astro');
    expect(notFound).toContain('noindex={true}');
    expect(notFound).toContain('structuredData={false}');
  });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('the semantic layer stayed architecture-independent', () => {
  for (const file of [
    'src/domain/document-value.ts',
    'src/domain/document-emission.ts',
    'src/domain/document-resolution.ts',
    'src/domain/document-scope.ts',
    'src/domain/document-surface.ts',
  ]) {
    it(`${file} names no Astro concept`, () => {
      const text = codeOnly(file);
      for (const token of ['Astro', '.astro', 'astro:', 'SITE.', 'BaseLayout']) {
        expect(text, `${file} mentions ${token}`).not.toContain(token);
      }
    });
  }

  it('the ownership model holds no Astro knowledge', () => {
    const text = source('src/domain/document-surface.ts');
    for (const module of ['../adapters/', '../templates/', 'node:fs', 'node:path']) {
      expect(text, `document-surface.ts imports ${module}`).not.toContain(module);
    }
  });

  it('the Astro surface writes no files', () => {
    const text = source('src/adapters/astro-document-surface.ts');
    for (const token of ['writeFileSync', 'mkdirSync', 'node:fs', 'child_process', 'process.env']) {
      expect(text, `astro-document-surface.ts uses ${token}`).not.toContain(token);
    }
  });

  it('implements no Stage 39 realization', () => {
    for (const file of [
      'src/adapters/astro-document-emitter.ts',
      'src/adapters/astro-realization.ts',
    ]) {
      expect(() => source(file), file).toThrow();
    }
    // The surface accepts already-realized source; it does not produce any.
    const text = source('src/adapters/astro-document-surface.ts');
    for (const token of ['buildDocumentEmission', 'DocumentEmissionPlan', 'bindingsUsedBy']) {
      expect(text, `astro-document-surface.ts does realization: ${token}`).not.toContain(token);
    }
  });

  it('contributes no production document entry', () => {
    // Nothing in the codebase produces an AstroHeadEntry outside tests, so the
    // surface is inert in production - which is why generated output is
    // unchanged.
    const bridge = source('src/adapters/bridge.ts');
    expect(bridge).toContain('composeAstroDocumentHead(project.architecture, merged, [])');
  });
});

// ---------------------------------------------------------------------------
// What the shipped template already emits
// ---------------------------------------------------------------------------

/**
 * Where each document field is already spelled in the template that ships.
 *
 * Read off `Seo.astro` and `StructuredData.astro` rather than assumed. These
 * are the tags a composed realization would be competing with, so the mapping
 * is the fact everything below rests on.
 */
const TEMPLATE_EMITS: Readonly<Record<EmissionField, { file: string; marker: string }>> = {
  title: { file: 'components/Seo.astro', marker: '<title>' },
  description: { file: 'components/Seo.astro', marker: '<meta name="description"' },
  robots: { file: 'components/Seo.astro', marker: '<meta name="robots"' },
  canonical: { file: 'components/Seo.astro', marker: '<link rel="canonical"' },
  'open-graph': { file: 'components/Seo.astro', marker: 'property="og:title"' },
  twitter: { file: 'components/Seo.astro', marker: 'name="twitter:card"' },
  'structured-data': {
    file: 'components/StructuredData.astro',
    marker: 'application/ld+json',
  },
};

describe('the shipped template already emits every document field', () => {
  const shipped = (file: string): string => source(`templates/astro-tailwind/base/src/${file}`);

  it.each(EMISSION_FIELDS)('emits %s', (field) => {
    const { file, marker } = TEMPLATE_EMITS[field];
    expect(shipped(file), `${file} no longer emits ${field}`).toContain(marker);
  });

  it('emits the fields the ownership model calls composition-owned', () => {
    /*
     * Stage 41's finding, pinned so it cannot be rediscovered by building it.
     *
     * `ASTRO_DOCUMENT_OWNERSHIP` says the composed surface may emit title,
     * description, robots, canonical and open-graph. The template emits all
     * five today, unconditionally, for every page. So a realization that took
     * the declaration at its word would not replace those tags - it would add
     * a second set beside them. A real build of exactly that produced two
     * <title> elements and two <link rel="canonical"> with different values on
     * the home page, and a canonical on the 404 where the template
     * deliberately emits none, and it built without complaint.
     *
     * Nothing here is a judgement about which side should own them. It records
     * that both sides currently claim them, which is the thing a future
     * realization has to resolve before it writes a single tag.
     */
    for (const field of ASTRO_DOCUMENT_OWNERSHIP.composed) {
      const { file, marker } = TEMPLATE_EMITS[field];
      expect(shipped(file), `${field} is declared composed but ${file} emits it`).toContain(marker);
    }
  });

  it('gives a realization no field it could emit alone', () => {
    // The set difference a Stage 41 emitter would have needed: fields the
    // composed surface owns and the template does not already spell. It is
    // empty, which is why realization is blocked rather than partial.
    const emittedByTemplate = EMISSION_FIELDS.filter((field) => {
      const { file, marker } = TEMPLATE_EMITS[field];
      return shipped(file).includes(marker);
    });
    const available = ASTRO_DOCUMENT_OWNERSHIP.composed.filter(
      (field) => !emittedByTemplate.includes(field),
    );
    expect(available).toEqual([]);
  });
});
