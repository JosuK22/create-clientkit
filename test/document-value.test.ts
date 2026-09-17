import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACCESSIBILITY_GUARANTEES } from '../src/domain/accessibility.js';
import { GUARANTEE_SURFACES } from '../src/domain/document-contribution.js';
import type { BindingSupport } from '../src/domain/document-value.js';
import {
  assertBindingsSupported,
  bindingOwner,
  bindingsUsedBy,
  bindingType,
  boundTo,
  derivationInputs,
  derivationType,
  derived,
  describeDocumentValue,
  DOCUMENT_BINDING_IDS,
  DOCUMENT_BINDINGS,
  DOCUMENT_DERIVATIONS,
  DOCUMENT_VALUE_TYPES,
  isDocumentBinding,
  isDocumentDerivation,
  literal,
  ownerOf,
  VALUE_OWNERS,
} from '../src/domain/document-value.js';
import {
  ASTRO_BINDING_EXPRESSIONS,
  ASTRO_BINDING_SUPPORT,
  astroExpressionFor,
} from '../src/adapters/astro-bindings.js';
import type { CliError } from '../src/errors.js';

/**
 * The binding-aware document value model.
 *
 * Stage 34 stopped because every layer below assumed a document value is a
 * fact, and Astro's document is a set of expressions evaluated at the generated
 * project's build. This is the representation that lets a value say "I am a
 * fact" or "I refer to something the project owns" without the domain becoming
 * an expression language.
 *
 * The test that matters most is the closed-vocabulary one: if an arbitrary
 * string can become a binding, this is a code-injection surface wearing a type.
 */

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

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

describe('the value vocabulary', () => {
  it('declares exactly these document types', () => {
    /*
     * Recorded, not described. Removing `open-graph` or `twitter` makes
     * `literal('open-graph', …)` a type error and nothing else - vitest does
     * not typecheck, so without this the two social types could vanish and
     * every runtime test would still pass while the Stage 32 coupling lost the
     * type that carries it.
     */
    expect([...DOCUMENT_VALUE_TYPES]).toEqual([
      'text',
      'url',
      'path',
      'language-tag',
      'asset-path',
      'twitter-card',
      'flag',
      'open-graph',
      'twitter',
    ]);
  });

  it('gives the social blocks a type no binding can satisfy', () => {
    // `BindingOfType<'open-graph'>` is `never`, so a social block can only ever
    // be a literal today. Asserted through the table the type is derived from.
    for (const binding of DOCUMENT_BINDING_IDS) {
      expect(['open-graph', 'twitter'], binding).not.toContain(bindingType(binding));
    }
  });
});

describe('a literal states a fact', () => {
  it('carries a string, a boolean and a constrained union', () => {
    expect(literal('text', 'Acme Ltd')).toEqual({
      kind: 'literal',
      type: 'text',
      value: 'Acme Ltd',
    });
    // Narrowed before reading, because the union is the point: a bound value
    // carries no literal, and the type system says so rather than a test.
    const flag = literal('flag', true);
    if (flag.kind !== 'literal') throw new Error('narrowing failed');
    expect(flag.value).toBe(true);
    const card = literal('twitter-card', 'summary_large_image');
    if (card.kind !== 'literal') throw new Error('narrowing failed');
    expect(card.value).toBe('summary_large_image');
  });

  it('is generation-owned, because nothing downstream can change it', () => {
    expect(ownerOf(literal('text', 'Acme Ltd'))).toBe('generation');
  });

  it('depends on no binding', () => {
    expect(bindingsUsedBy(literal('url', 'https://acme.example/'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The closed vocabulary
// ---------------------------------------------------------------------------

describe('bindings are a closed vocabulary', () => {
  it('declares a type and an owner for every entry', () => {
    for (const binding of DOCUMENT_BINDING_IDS) {
      expect(DOCUMENT_VALUE_TYPES, binding).toContain(bindingType(binding));
      expect(VALUE_OWNERS, binding).toContain(bindingOwner(binding));
    }
    expect(DOCUMENT_BINDING_IDS.length).toBe(Object.keys(DOCUMENT_BINDINGS).length);
  });

  it('declares exactly these types and owners', () => {
    /*
     * The table recorded rather than described. Asserting only that each type is
     * *a* valid type passes against an implementation where every binding is
     * `text` - which would erase the whole point of typing them, since
     * `BindingOfType` is what stops a language tag being used where a URL
     * belongs. Changing any row below has to be a deliberate act.
     */
    const declared = Object.fromEntries(
      DOCUMENT_BINDING_IDS.map((binding) => [
        binding,
        `${bindingType(binding)}/${bindingOwner(binding)}`,
      ]),
    );

    expect(declared).toEqual({
      'site.name': 'text/project',
      'site.url': 'url/project',
      'site.description': 'text/project',
      'site.language': 'language-tag/project',
      'document.socialImage': 'asset-path/project',
      'document.twitterCardStyle': 'twitter-card/project',
      'document.indexingBlocked': 'flag/project',
      'page.path': 'path/build-context',
      'generator.name': 'text/build-context',
    });
  });

  it('keeps types that a plain string would have conflated', () => {
    // The distinctions that earn the type parameter: four of these are strings
    // in TypeScript and none may stand in for another.
    expect(bindingType('site.url')).toBe('url');
    expect(bindingType('page.path')).toBe('path');
    expect(bindingType('site.language')).toBe('language-tag');
    expect(bindingType('document.socialImage')).toBe('asset-path');
    expect(
      new Set([
        bindingType('site.url'),
        bindingType('page.path'),
        bindingType('site.language'),
        bindingType('document.socialImage'),
      ]).size,
    ).toBe(4);
  });

  it('rejects anything that is not in the table', () => {
    /*
     * The heart of the stage. Every string below is a plausible thing somebody
     * might reach for, and each one is source code rather than a semantic name.
     * If any were accepted, the domain would be carrying expressions.
     */
    for (const attempt of [
      'SITE.name',
      'Astro.url.pathname',
      'SEO.image',
      'foo.bar()',
      'someFunction()',
      '${anything}',
      '`${SITE.url}${Astro.url.pathname}`',
      'process.env.SECRET',
      '',
      'site.name ',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(isDocumentBinding(attempt), `"${attempt}" was accepted as a binding`).toBe(false);
    }
  });

  it('accepts exactly the declared identifiers', () => {
    for (const binding of DOCUMENT_BINDING_IDS) {
      expect(isDocumentBinding(binding), binding).toBe(true);
    }
  });

  it('names semantic concepts, never framework syntax', () => {
    /*
     * `page.path` rather than `Astro.url.pathname`. An identifier that named
     * the framework's spelling would put Astro in the domain by the back door
     * and would be wrong for every other architecture.
     */
    for (const binding of DOCUMENT_BINDING_IDS) {
      for (const forbidden of ['Astro', 'SITE', 'SEO', 'CONTACT', 'SOCIAL', 'next', 'react']) {
        expect(binding, `${binding} names ${forbidden}`).not.toContain(forbidden);
      }
      // A semantic identifier, not an expression: no calls, no interpolation.
      expect(binding).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('ownership is about authority, not knowledge', () => {
  it('treats a value ClientKit seeds as project-owned', () => {
    /*
     * The Stage 34 correction, stated as a test. `SITE.name` is written by the
     * CLI through a `{{siteName}}` token, so ClientKit knows it - and the
     * project owns it, because the developer may change it a minute later and
     * expects the document to follow. Knowing a value is not owning it.
     */
    expect(bindingOwner('site.name')).toBe('project');
    expect(bindingOwner('site.url')).toBe('project');
    expect(bindingOwner('site.description')).toBe('project');
    expect(bindingOwner('site.language')).toBe('project');
  });

  it('treats values ClientKit never sees as project-owned too', () => {
    for (const binding of [
      'document.socialImage',
      'document.twitterCardStyle',
      'document.indexingBlocked',
    ] as const) {
      expect(bindingOwner(binding), binding).toBe('project');
    }
  });

  it('treats per-build values as build-context-owned', () => {
    expect(bindingOwner('page.path')).toBe('build-context');
    expect(bindingOwner('generator.name')).toBe('build-context');
  });

  it('reports the owner of a bound value from its binding', () => {
    expect(ownerOf(boundTo('text', 'site.name'))).toBe('project');
    expect(ownerOf(boundTo('path', 'page.path'))).toBe('build-context');
  });

  it('gives a derivation the least settled of its inputs', () => {
    // site.url is project-owned and page.path is build-context-owned, so the
    // combination cannot be settled before the build.
    expect(ownerOf(derived('url', 'absolute-page-url'))).toBe('build-context');
  });
});

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

describe('derivations are named, not expressed', () => {
  it('declares a type and its inputs', () => {
    expect(derivationType('absolute-page-url')).toBe('url');
    expect(derivationInputs('absolute-page-url')).toEqual(['site.url', 'page.path']);
  });

  it('rejects anything not declared', () => {
    for (const attempt of [
      'SITE.url + Astro.url.pathname',
      '`${SITE.url}${Astro.url.pathname}`',
      'concat(site.url, page.path)',
      'absolute page url',
    ]) {
      expect(isDocumentDerivation(attempt), `"${attempt}" was accepted`).toBe(false);
    }
    expect(isDocumentDerivation('absolute-page-url')).toBe(true);
  });

  it('draws only on bindings the vocabulary knows', () => {
    for (const derivation of Object.keys(DOCUMENT_DERIVATIONS) as ['absolute-page-url']) {
      for (const input of derivationInputs(derivation)) {
        expect(isDocumentBinding(input), `${derivation} draws on ${input}`).toBe(true);
      }
    }
  });

  it('reports every binding a derived value depends on, sorted', () => {
    expect(bindingsUsedBy(derived('url', 'absolute-page-url'))).toEqual(['page.path', 'site.url']);
  });
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

describe('an architecture must be able to supply what a value refers to', () => {
  const limited: BindingSupport = {
    architecture: 'synthetic-limited',
    supports: ['site.name'],
  };

  it('accepts a value whose bindings are supported', () => {
    expect(() => assertBindingsSupported(boundTo('text', 'site.name'), limited)).not.toThrow();
    expect(() => assertBindingsSupported(literal('text', 'Acme Ltd'), limited)).not.toThrow();
  });

  it('refuses a binding the architecture cannot supply, naming both', () => {
    const message = refusal(() => assertBindingsSupported(boundTo('path', 'page.path'), limited));
    expect(message).toContain('synthetic-limited');
    expect(message).toContain('page.path');
    expect(message).toContain('build-context');
  });

  it('refuses a derivation whose inputs are not all supported', () => {
    const message = refusal(() =>
      assertBindingsSupported(derived('url', 'absolute-page-url'), limited),
    );
    expect(message).toContain('page.path');
    expect(message).toContain('site.url');
  });

  it('offers no fallback for any binding', () => {
    /*
     * Behavioural rather than lexical. An earlier version of this test grepped
     * the module for the word "fallback" and failed on the error message, which
     * is the module being explicit about the very thing being asserted - and
     * would have passed against an implementation that substituted silently
     * under a different name.
     *
     * What matters is that *every* binding is refused by an architecture that
     * supports none: no binding is quietly treated as always-available, and no
     * near-enough value is produced. Substituting the site URL for a page URL
     * emits a document that states something untrue and builds without
     * complaint, which is worse than refusing to build.
     */
    const supportsNothing: BindingSupport = { architecture: 'synthetic-empty', supports: [] };

    for (const binding of DOCUMENT_BINDING_IDS) {
      const value = boundTo(bindingType(binding), binding as never);
      expect(
        () => assertBindingsSupported(value, supportsNothing),
        `${binding} was not refused`,
      ).toThrow();
    }
    // and a literal needs nothing, so it still passes
    expect(() => assertBindingsSupported(literal('text', 'Acme'), supportsNothing)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('the representation is deterministic', () => {
  it('serialises identically for equivalent values', () => {
    const runs = [1, 2, 3].map(() =>
      JSON.stringify([
        literal('text', 'Acme Ltd'),
        boundTo('text', 'site.name'),
        derived('url', 'absolute-page-url'),
      ]),
    );
    expect(new Set(runs).size).toBe(1);
  });

  it('lists bindings in a stable order', () => {
    expect([...DOCUMENT_BINDING_IDS]).toEqual([...DOCUMENT_BINDING_IDS].sort());
    expect(bindingsUsedBy(derived('url', 'absolute-page-url'))).toEqual(
      [...bindingsUsedBy(derived('url', 'absolute-page-url'))].sort(),
    );
  });

  it('describes a value the same way every time', () => {
    expect(describeDocumentValue(boundTo('text', 'site.name'))).toBe('text bound to site.name');
    expect(describeDocumentValue(literal('url', ''))).toBe('url literal ""');
    expect(describeDocumentValue(derived('url', 'absolute-page-url'))).toBe(
      'url derived from absolute-page-url',
    );
  });
});

// ---------------------------------------------------------------------------
// Canonical, in the new representation
// ---------------------------------------------------------------------------

describe('canonical keeps its Stage 33 meaning', () => {
  it('states an empty canonical as a literal, never as a binding', () => {
    /*
     * `canonical: ''` means "emit no canonical tag" and has since Stage 32.
     * It is a stated fact about this page, so it is a literal - turning it
     * into a binding would make it track a project value and quietly acquire
     * an address the page refused.
     */
    const empty = literal('url', '');
    if (empty.kind !== 'literal') throw new Error('narrowing failed');
    expect(empty.value).toBe('');
    expect(ownerOf(empty)).toBe('generation');
    expect(bindingsUsedBy(empty)).toEqual([]);
  });

  it('expresses a page-tracking canonical as a derivation', () => {
    // The case Stage 34 could not represent: one component, N pages, N
    // canonicals. A snapshot had a value only for the roles ClientKit knew.
    const tracking = derived('url', 'absolute-page-url');
    expect(ownerOf(tracking)).toBe('build-context');
    expect(bindingsUsedBy(tracking)).toContain('page.path');
  });

  it('keeps the three states distinguishable', () => {
    // absent is the absence of a value, which this module does not encode -
    // exactly as since Stage 32, so "unsaid" has one encoding and not two.
    const stated = literal('url', 'https://acme.example/');
    const refused = literal('url', '');
    expect(JSON.stringify(stated)).not.toBe(JSON.stringify(refused));
  });
});

// ---------------------------------------------------------------------------
// The Astro mapping
// ---------------------------------------------------------------------------

describe('the Astro mapping is explicit and complete', () => {
  it('maps every binding the vocabulary declares', () => {
    for (const binding of DOCUMENT_BINDING_IDS) {
      expect(ASTRO_BINDING_EXPRESSIONS[binding], binding).toBeTruthy();
    }
    expect(Object.keys(ASTRO_BINDING_EXPRESSIONS).sort()).toEqual([...DOCUMENT_BINDING_IDS]);
  });

  it('declares support that matches the mapping', () => {
    expect([...ASTRO_BINDING_SUPPORT.supports].sort()).toEqual([...DOCUMENT_BINDING_IDS]);
    expect(ASTRO_BINDING_SUPPORT.architecture).toBe('astro-standard');
  });

  it('maps each binding to what the shipped template actually reads', () => {
    /*
     * Checked against the real template rather than against the mapping's own
     * intention. If `Seo.astro` stops reading one of these, the mapping is
     * describing a project that no longer exists.
     */
    const astro =
      source('templates/astro-tailwind/base/src/components/Seo.astro') +
      source('templates/astro-tailwind/base/src/layouts/BaseLayout.astro');

    for (const binding of DOCUMENT_BINDING_IDS) {
      expect(astro, `${binding} maps to something the template never reads`).toContain(
        astroExpressionFor(binding),
      );
    }
  });

  it('keeps the current page path semantic in the domain and Astro-shaped here', () => {
    expect(astroExpressionFor('page.path')).toBe('Astro.url.pathname');
    /*
     * And the domain has never heard of that spelling. Comments stripped: the
     * module's own documentation says "never `Astro.url.pathname`", which is
     * the doc being precise about what it excludes and would fail a scan of the
     * raw text. What must not exist is the spelling in the *code*.
     */
    expect(codeOnly('src/domain/document-value.ts')).not.toContain('Astro.url');
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the model is framework-independent', () => {
  const FILE = 'src/domain/document-value.ts';

  it('imports nothing but its own error type', () => {
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
    for (const module of ['../adapters/', '../templates/', '../features/']) {
      expect(text, `${FILE} imports ${module}`).not.toContain(module);
    }
  });

  it('branches on no framework, feature or architecture identity', () => {
    const text = codeOnly(FILE).toLowerCase();
    for (const name of ['astro', 'nextjs', 'react', 'feature:']) {
      expect(text, `${FILE} branches on ${name}`).not.toContain(`'${name}`);
    }
    expect(text).not.toMatch(/architecture\s*===\s*'/);
  });

  it('contains no evaluation mechanism', () => {
    const text = source(FILE);
    for (const token of ['eval(', 'new Function', 'Function(', 'vm.', 'require(']) {
      expect(text, `${FILE} contains ${token}`).not.toContain(token);
    }
  });

  it('keeps the dependency direction one-way', () => {
    // The Astro mapping imports the domain; the domain must not import back.
    expect(source('src/adapters/astro-bindings.ts')).toContain('../domain/document-value.js');
    expect(source(FILE)).not.toContain('astro-bindings');
  });

  it('builds no emitter', () => {
    for (const file of [
      'src/adapters/astro-document-emitter.ts',
      'src/domain/document-emitter.ts',
    ]) {
      expect(() => source(file), file).toThrow();
    }
    /*
     * Comments stripped. The module explains why Open Graph resolves as a unit
     * by pointing out that a split merge makes `<title>` and `og:title`
     * disagree - the doc being precise about a markup concern it does not
     * implement. What must not exist is markup in the code.
     */
    const text = codeOnly(FILE);
    for (const name of ['emitDocument', 'renderHead', 'serialiseHead', '<meta', '<title']) {
      expect(text, `${name} belongs to a later stage`).not.toContain(name);
    }
  });

  it('is imported by no adapter except the Astro mapping', () => {
    const bridge = source('src/adapters/bridge.ts');
    expect(bridge).not.toContain('document-value');
  });
});

// ---------------------------------------------------------------------------
// The accessibility classification, carried forward not redesigned
// ---------------------------------------------------------------------------

describe('accessibility guarantees are classified, not bound', () => {
  it('keeps the Stage 33 split intact', () => {
    const surfaces = ACCESSIBILITY_GUARANTEES.map((g) => GUARANTEE_SURFACES[g]);
    expect(surfaces.filter((s) => s === 'head')).toHaveLength(2);
    expect(surfaces.filter((s) => s === 'document-element')).toHaveLength(1);
    expect(surfaces.filter((s) => s === 'document-structure')).toHaveLength(5);
  });

  it('needs no new binding of its own', () => {
    /*
     * The one guarantee with a document-level value is `document-language`, and
     * the value it needs is the site's language - already in the vocabulary. No
     * accessibility-specific binding was added, and the five structural
     * guarantees stay outside this model entirely.
     */
    expect(isDocumentBinding('site.language')).toBe(true);
    for (const binding of DOCUMENT_BINDING_IDS) {
      expect(binding).not.toContain('landmark');
      expect(binding).not.toContain('skip');
      expect(binding).not.toContain('heading');
    }
  });
});
