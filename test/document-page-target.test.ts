import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  AstroDocumentComposition,
  AstroHeadEntry,
} from '../src/adapters/astro-document-surface.js';
import { composeAstroDocument } from '../src/adapters/astro-document-surface.js';
import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import type { EmissionField } from '../src/domain/document-emission.js';
import { assertHandoverIsCovered } from '../src/domain/document-handover.js';
import { SITE_TARGET, forPage } from '../src/domain/document-scope.js';
import type { ProjectManifest } from '../src/domain/manifest.js';
import { resolveRole } from '../src/domain/roles.js';
import type { FileOperation } from '../src/generate/files.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import type { CliError } from '../src/errors.js';

/**
 * Page-aware composition: a document reaching one page and no other.
 *
 * Stage 42 left the composed head in the shell, so everything it produced
 * rendered on every page - a synthetic canonical aimed at nothing in particular
 * turned up on the 404. The target was not lost by accident; the surface never
 * took one.
 *
 * The mechanism is Astro's named slot with a fallback. A page that states its
 * own document fills the slot and replaces the site's; a page that states
 * nothing - including one added after generation, which nothing here can
 * enumerate - gets the fallback. No condition, no page list, no path.
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

const astroManifest = (starter: 'coming-soon' | 'full' = 'coming-soon'): ProjectManifest =>
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
    starter,
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

const plannedOperations = (starter: 'coming-soon' | 'full' = 'coming-soon') =>
  planManifest(astroManifest(starter), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: starter,
    templateId: 'astro-tailwind',
  }).plan.operations;

/** Synthetic, and marked so, because realization is a later stage. */
const entry = (field: EmissionField, owner: string): AstroHeadEntry => ({
  field,
  source: `<meta name="ck-${field}" content="${owner}" data-ck="${owner}" />`,
  owner: `contributor:${owner}`,
  bindings: [],
});

const SITE_DOC: AstroDocumentComposition = {
  target: SITE_TARGET,
  entries: [entry('description', 'site'), entry('canonical', 'site')],
};

const NOT_FOUND_DOC: AstroDocumentComposition = {
  target: forPage('page.notFound'),
  entries: [entry('description', 'page'), entry('canonical', 'page')],
};

const compose = (
  compositions: readonly AstroDocumentComposition[],
  starter: 'coming-soon' | 'full' = 'coming-soon',
): readonly FileOperation[] =>
  composeAstroDocument(ASTRO, plannedOperations(starter), compositions);

const written = (operations: readonly FileOperation[], target: string): string => {
  const found = operations.find((operation) => operation.path === target);
  if (found?.type !== 'write') throw new Error(`nothing written at ${target}`);
  return found.content;
};

const SHELL = 'src/layouts/BaseLayout.astro';
const NOT_FOUND = 'src/pages/404.astro';
const SITE_HEAD = 'src/components/DocumentHead.astro';
const PAGE_HEAD = 'src/components/DocumentHeadPageNotFound.astro';

// ---------------------------------------------------------------------------
// The default path
// ---------------------------------------------------------------------------

describe('with nothing to compose, nothing happens', () => {
  it('returns the operations it was given', () => {
    const operations = plannedOperations();
    expect(composeAstroDocument(ASTRO, operations, [])).toBe(operations);
  });

  it('returns them even when a composition carries no entries', () => {
    // An empty document is not a document. Writing a slot and an empty
    // component for one would change V1's bytes to say nothing at all.
    const operations = plannedOperations();
    expect(composeAstroDocument(ASTRO, operations, [{ target: SITE_TARGET, entries: [] }])).toBe(
      operations,
    );
  });

  it('adds no slot to the shell', () => {
    expect(written(plannedOperations(), SHELL)).not.toContain('slot name="head"');
  });
});

// ---------------------------------------------------------------------------
// Site target
// ---------------------------------------------------------------------------

describe('a site-wide document renders in the shell', () => {
  const operations = compose([SITE_DOC]);

  it('generates the component at the mapped role', () => {
    expect(operations.map((operation) => operation.path)).toContain(
      resolveRole(ASTRO, 'app.document.head'),
    );
  });

  it('renders it as the head slot’s fallback', () => {
    /*
     * Fallback rather than plain render, which is what makes a page's own
     * document *replace* this one instead of joining it. Rendering both would
     * be the duplicate Stage 41 measured, arrived at from the other direction.
     */
    expect(written(operations, SHELL)).toContain('<slot name="head"><DocumentHead /></slot>');
  });

  it('leaves every page file alone', () => {
    // A site-wide document is the shell's business. Touching pages for it would
    // mean ClientKit had to know which pages exist.
    for (const operation of operations) {
      if (!operation.path.startsWith('src/pages/')) continue;
      if (operation.type !== 'write') continue;
      expect(operation.content, `${operation.path} was rewritten`).not.toContain('slot="head"');
    }
  });
});

// ---------------------------------------------------------------------------
// Page target
// ---------------------------------------------------------------------------

describe('a page document renders in that page', () => {
  const operations = compose([SITE_DOC, NOT_FOUND_DOC]);

  it('generates a component named from the role', () => {
    expect(operations.map((operation) => operation.path)).toContain(PAGE_HEAD);
  });

  it('renders it from the page that owns the role', () => {
    const page = written(operations, NOT_FOUND);
    expect(page).toContain('<Fragment slot="head"><DocumentHeadPageNotFound /></Fragment>');
    expect(page).toContain("import DocumentHeadPageNotFound from '../components/");
  });

  it('puts the fragment inside the layout element', () => {
    const page = written(operations, NOT_FOUND);
    const opening = page.indexOf('<BaseLayout');
    const fragment = page.indexOf('<Fragment slot="head">');
    const closing = page.indexOf('</BaseLayout>');
    expect(fragment).toBeGreaterThan(opening);
    expect(fragment).toBeLessThan(closing);
  });

  it('puts the import in the page’s frontmatter', () => {
    const lines = written(operations, NOT_FOUND).split('\n');
    const fences = lines.flatMap((line, index) => (line === '---' ? [index] : []));
    const statement = lines.findIndex((line) => line.startsWith('import DocumentHeadPage'));
    expect(statement).toBeGreaterThan(fences[0] as number);
    expect(statement).toBeLessThan(fences[1] as number);
  });

  it('does not put the page document anywhere else', () => {
    /*
     * The Stage 42 defect, as an assertion. Exactly one file may render the
     * not-found document, and it is the not-found page.
     */
    const places = operations.filter(
      (operation) =>
        operation.type === 'write' && operation.content.includes('DocumentHeadPageNotFound'),
    );
    // Only the page names the component. The component itself carries the head
    // entries and never its own name, so it is checked for separately.
    expect(places.map((operation) => operation.path)).toEqual([NOT_FOUND]);
    expect(operations.map((operation) => operation.path)).toContain(PAGE_HEAD);
  });

  it('keeps the site document out of that page', () => {
    // The 404 fills the slot, so the fallback never renders there. Nothing in
    // the page refers to the site-wide component.
    expect(written(operations, NOT_FOUND)).not.toContain('<DocumentHead />');
  });

  it('is refused without a site document behind it', () => {
    /*
     * There is no such thing as "every page has its own": a page added after
     * generation always exists and always has none. Without a fallback it
     * would render a document missing whatever the template gave up, so the
     * slot never has an empty fallback and this configuration never happens.
     */
    expect(refusal(() => compose([NOT_FOUND_DOC]))).toContain('no site-wide document');
  });

  it('holds for both starters, whose pages differ in shape', () => {
    // coming-soon and full ship different index pages, and the 404 spells its
    // layout invocation across five lines. The anchor is the closing tag, so
    // none of that matters - which is the point of choosing it.
    for (const starter of ['coming-soon', 'full'] as const) {
      const page = written(compose([SITE_DOC, NOT_FOUND_DOC], starter), NOT_FOUND);
      expect(page, starter).toContain('<Fragment slot="head">');
    }
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('a page document reaches one page only', () => {
  const operations = compose([SITE_DOC, NOT_FOUND_DOC]);

  it('never appears in the shell', () => {
    expect(written(operations, SHELL)).not.toContain('DocumentHeadPageNotFound');
  });

  it('never appears in another page', () => {
    for (const operation of operations) {
      if (!operation.path.startsWith('src/pages/')) continue;
      if (operation.path === NOT_FOUND || operation.type !== 'write') continue;
      expect(operation.content, operation.path).not.toContain('slot="head"');
    }
  });

  it('carries its own values, not the site’s', () => {
    expect(written(operations, PAGE_HEAD)).toContain('data-ck="page"');
    expect(written(operations, PAGE_HEAD)).not.toContain('data-ck="site"');
    expect(written(operations, SITE_HEAD)).toContain('data-ck="site"');
    expect(written(operations, SITE_HEAD)).not.toContain('data-ck="page"');
  });
});

// ---------------------------------------------------------------------------
// Targets that cannot be honoured
// ---------------------------------------------------------------------------

describe('a target that cannot be reached is refused', () => {
  it('refuses a role the architecture does not map', () => {
    /*
     * The tempting fallback is to render it in the shell, which would broaden
     * exactly the scope the target was chosen to narrow. So it refuses.
     */
    const message = refusal(() =>
      compose([
        SITE_DOC,
        {
          target: forPage('app.entry'),
          entries: [entry('description', 'x'), entry('canonical', 'x')],
        },
      ]),
    );
    expect(message).toContain('no page for the role');
    expect(message).toContain('app.entry');
  });

  it('refuses a page nothing plans', () => {
    const without = plannedOperations().filter((operation) => operation.path !== NOT_FOUND);
    const message = refusal(() => composeAstroDocument(ASTRO, without, [SITE_DOC, NOT_FOUND_DOC]));
    expect(message).toContain('no page to render in');
  });

  it('refuses a page whose layout element appears twice', () => {
    // Two closing tags means two places the fragment could go, and choosing
    // either would put the page's document somewhere nobody picked.
    const doubled = plannedOperations().map((operation) =>
      operation.type === 'write' && operation.path === NOT_FOUND
        ? { ...operation, content: `${operation.content}\n<BaseLayout></BaseLayout>\n` }
        : operation,
    );
    const message = refusal(() => composeAstroDocument(ASTRO, doubled, [SITE_DOC, NOT_FOUND_DOC]));
    expect(message).toContain('could not find its place');
    expect(message).toContain('found 2');
  });

  it('refuses a page that does not import the layout', () => {
    const stripped = plannedOperations().map((operation) =>
      operation.type === 'write' && operation.path === NOT_FOUND
        ? {
            ...operation,
            content: operation.content.replace(
              "import BaseLayout from '../layouts/BaseLayout.astro';",
              "import Other from '../components/Footer.astro';",
            ),
          }
        : operation,
    );
    const message = refusal(() => composeAstroDocument(ASTRO, stripped, [SITE_DOC, NOT_FOUND_DOC]));
    expect(message).toContain('does not import the layout');
  });

  it('follows the page’s own name for the layout', () => {
    /*
     * The anchor is the closing tag, so the name matters. A page free to
     * import the layout as anything must still be found, and assuming
     * `BaseLayout` would quietly fail on a page that did not.
     */
    const renamed = plannedOperations().map((operation) =>
      operation.type === 'write' && operation.path === NOT_FOUND
        ? {
            ...operation,
            content: operation.content
              .replace(
                "import BaseLayout from '../layouts/BaseLayout.astro';",
                "import Shell from '../layouts/BaseLayout.astro';",
              )
              .replace('<BaseLayout', '<Shell')
              .replace('</BaseLayout>', '</Shell>'),
          }
        : operation,
    );
    const page = written(
      composeAstroDocument(ASTRO, renamed, [SITE_DOC, NOT_FOUND_DOC]),
      NOT_FOUND,
    );
    expect(page).toContain(
      '<Fragment slot="head"><DocumentHeadPageNotFound /></Fragment>\n</Shell>',
    );
  });

  it('refuses two documents for the same target', () => {
    // Merging them would be arbitration, which finished before the
    // architecture was involved.
    const message = refusal(() => compose([SITE_DOC, SITE_DOC]));
    expect(message).toContain('both target the site');
  });

  it('refuses two documents for the same page', () => {
    const message = refusal(() => compose([SITE_DOC, NOT_FOUND_DOC, NOT_FOUND_DOC]));
    expect(message).toContain('both target');
    expect(message).toContain('page.notFound');
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe('a handover no document covers is refused', () => {
  it('refuses a target that omits a handed-over field', () => {
    /*
     * Measured before it was guarded. A first real build composed `description`
     * site-wide and `description` plus `canonical` for the 404; both pages
     * looked right and the home page silently lost its canonical, because the
     * template had already given the field up for the whole project.
     */
    const message = refusal(() =>
      compose([{ target: SITE_TARGET, entries: [entry('description', 'site')] }, NOT_FOUND_DOC]),
    );
    expect(message).toContain('does not state canonical');
    expect(message).toContain('replaces the site-wide one');
  });

  it('refuses page documents with no site document behind them', () => {
    const message = refusal(() =>
      assertHandoverIsCovered(
        ['canonical'],
        [{ target: forPage('page.notFound'), fields: ['canonical'] }],
      ),
    );
    expect(message).toContain('no site-wide document');
  });

  it('accepts a complete set', () => {
    expect(() =>
      assertHandoverIsCovered(
        ['description', 'canonical'],
        [
          { target: SITE_TARGET, fields: ['canonical', 'description'] },
          { target: forPage('page.notFound'), fields: ['description', 'canonical'] },
        ],
      ),
    ).not.toThrow();
  });

  it('says nothing when nothing was handed over', () => {
    expect(() => assertHandoverIsCovered([], [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// What the template keeps
// ---------------------------------------------------------------------------

describe('page-awareness changes no ownership', () => {
  const operations = compose([SITE_DOC, NOT_FOUND_DOC]);
  const metadata = written(operations, 'src/components/Seo.astro');

  it.each([
    ['the Twitter card upgrade', "SEO.twitterCard : 'summary'"],
    ['the Twitter image', 'name="twitter:image"'],
    ['og:image', 'property="og:image"'],
    ['og:locale', 'property="og:locale"'],
    ['og:type', 'property="og:type"'],
    ['og:site_name', 'property="og:site_name"'],
    ['the title', '<title>'],
    ['robots', '<meta name="robots"'],
  ])('keeps %s with the template', (_label, marker) => {
    expect(metadata).toContain(marker);
  });

  it('hands over only what was composed', () => {
    expect(metadata).not.toContain('<meta name="description"');
    expect(metadata).not.toContain('<link rel="canonical"');
  });

  it('leaves the 404’s own props alone', () => {
    const page = written(operations, NOT_FOUND);
    expect(page).toContain('noindex={true}');
    expect(page).toContain('structuredData={false}');
  });

  it('leaves structured data untouched', () => {
    const structured = written(operations, 'src/components/StructuredData.astro');
    expect(structured).toBe(
      source('templates/astro-tailwind/base/src/components/StructuredData.astro'),
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism and state
// ---------------------------------------------------------------------------

describe('routing is deterministic and stateless', () => {
  it('produces identical operations twice', () => {
    expect(JSON.stringify(compose([SITE_DOC, NOT_FOUND_DOC]))).toBe(
      JSON.stringify(compose([SITE_DOC, NOT_FOUND_DOC])),
    );
  });

  it('does not depend on the order the compositions arrived in', () => {
    expect(JSON.stringify(compose([SITE_DOC, NOT_FOUND_DOC]))).toBe(
      JSON.stringify(compose([NOT_FOUND_DOC, SITE_DOC])),
    );
  });

  it('does not depend on the order the entries arrived in', () => {
    const reversed: AstroDocumentComposition = {
      target: SITE_TARGET,
      entries: [...SITE_DOC.entries].reverse(),
    };
    expect(JSON.stringify(compose([reversed, NOT_FOUND_DOC]))).toBe(
      JSON.stringify(compose([SITE_DOC, NOT_FOUND_DOC])),
    );
  });

  it('orders entries by field, not by arrival', () => {
    // canonical before description, whichever way they were handed in.
    const component = written(compose([SITE_DOC, NOT_FOUND_DOC]), SITE_HEAD);
    expect(component.indexOf('ck-canonical')).toBeLessThan(component.indexOf('ck-description'));
  });

  it('returns the operations ordered by path', () => {
    // The rewritten files come out of a map, whose order is insertion order -
    // a property of which target happened to be processed first. Sorting by
    // path makes the result a function of the set alone.
    const paths = compose([SITE_DOC, NOT_FOUND_DOC]).map((operation) => operation.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it('keeps no state between calls', () => {
    // Composing a page target first must not change what the site-only call
    // produces afterwards.
    compose([SITE_DOC, NOT_FOUND_DOC]);
    const after = compose([SITE_DOC]);
    expect(JSON.stringify(after)).toBe(JSON.stringify(compose([SITE_DOC])));
  });

  it('holds no mutable module state', () => {
    const text = codeOnly('src/adapters/astro-document-surface.ts');
    // Every top-level binding is a const; nothing accumulates across calls.
    expect(text).not.toMatch(/^let /m);
    expect(text).not.toMatch(/^var /m);
    expect(text).not.toContain('process.env');
    expect(text).not.toContain('globalThis');
  });
});

// ---------------------------------------------------------------------------
// No page list anywhere
// ---------------------------------------------------------------------------

describe('nothing enumerates pages', () => {
  it('names no route in the composer', () => {
    const text = codeOnly('src/adapters/astro-document-surface.ts');
    for (const route of ["'/404'", "'/contact'", "'/index'", 'pathname']) {
      expect(text, `the composer names ${route}`).not.toContain(route);
    }
  });

  it('derives the component path from the architecture, not a literal', () => {
    const text = codeOnly('src/adapters/astro-document-surface.ts');
    expect(text).not.toContain("'src/components/");
    expect(text).toContain("resolveRole(architecture, 'app.document.head')");
  });

  it('derives the component name from the role alone', () => {
    // page.notFound -> DocumentHeadPageNotFound, with no table in between.
    const operations = compose([SITE_DOC, NOT_FOUND_DOC]);
    expect(operations.map((operation) => operation.path)).toContain(PAGE_HEAD);
  });

  it('consumes no emission plan', () => {
    // Stage 43 transports already-resolved entries; it does not produce them.
    const text = source('src/adapters/astro-document-surface.ts');
    for (const token of [
      'DocumentEmissionPlan',
      'buildDocumentEmission',
      'resolveDocumentForPage',
    ]) {
      expect(text, `the composer does realization: ${token}`).not.toContain(token);
    }
  });
});
