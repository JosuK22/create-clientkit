import type { OpenGraphContract, TwitterContract } from './seo.js';
import { CliError } from '../errors.js';

/**
 * What a document value *is*, once "the generated project owns it" is taken
 * seriously.
 *
 * ## The problem Stage 34 hit
 *
 * Every layer from Stage 31 to Stage 33 assumed a document value is a fact:
 * `title: string`, `canonical: string`. Stage 34 tried to emit those facts into
 * Astro's document and found the assumption false. Astro's head is a set of
 * *expressions* evaluated at the generated project's build:
 *
 *     const pageTitle = title ? `${title} - ${SITE.name}` : SITE.name;
 *     const canonical = origin === '' || blocked ? '' : absoluteUrl(origin, Astro.url.pathname);
 *
 * Writing resolved literals in their place freezes the head at generation time,
 * so editing `site.config.ts` stops changing the site - which is the one thing
 * the generated project's own next-steps output promises - and pages the
 * developer adds later emit no canonical at all, because a snapshot has values
 * only for the roles ClientKit knew about.
 *
 * ## The distinction that fixes it
 *
 * Ownership is about **authority at build time**, not about whether ClientKit
 * happens to know a current value. `SITE.name` is seeded by the CLI through a
 * `{{siteName}}` token, so ClientKit does know it - and it is still
 * project-owned, because the developer may change it the minute after
 * generation and expects the document to follow. A value ClientKit knows is not
 * therefore a value ClientKit may freeze.
 *
 * That is why this module exists: a document value must be able to say "this is
 * a fact" or "this refers to something the project owns", and the difference
 * has to survive into whatever eventually emits it.
 *
 * ## What this deliberately is not
 *
 * Not an expression language. A binding is a member of a closed, typed
 * vocabulary declared below - never a string of source code, never
 * `SITE.name`, never `Astro.url.pathname`, never anything that could be
 * evaluated. The vocabulary names *semantic concepts*; translating
 * `page.path` into whatever Astro writes is an architecture's job and happens
 * nowhere near here.
 *
 * Not an emitter. Stage 35 stops at the representation.
 */

// ---------------------------------------------------------------------------
// What kind of thing a value is
// ---------------------------------------------------------------------------

/**
 * The shape of a document value, used to keep bindings out of the wrong slots.
 *
 * Deliberately coarser than TypeScript's own types: these are *document*
 * kinds, and their job is to stop a language tag being used where a URL
 * belongs. `text` is not `url` is not `path`, even though all three are
 * strings, because the mistakes worth preventing are exactly the ones a plain
 * `string` would allow.
 */
export const DOCUMENT_VALUE_TYPES = [
  'text',
  'url',
  'path',
  'language-tag',
  'asset-path',
  'twitter-card',
  'flag',
  /*
   * The two social blocks, each one value rather than a set of fields.
   *
   * Stage 32 established that Open Graph and Twitter resolve as units, because
   * `resolveSeoContract` derives `openGraph.title` from `title` and
   * `openGraph.url` from `canonical` - so taking half from one owner and half
   * from another emits a document whose `<title>` and `og:title` disagree.
   * Giving each block its own value type keeps that coupling in the type
   * system rather than in a rule somebody has to remember.
   *
   * No binding and no derivation declares either type, so `BindingOfType` and
   * `DerivationOfType` resolve to `never` for both. That is deliberate and
   * load-bearing: today a social block can only be a literal, and the compiler
   * says so rather than a comment. When a stage models `og:image` properly,
   * adding a binding of this type is what will make bound blocks possible.
   */
  'open-graph',
  'twitter',
] as const;

export type DocumentValueType = (typeof DOCUMENT_VALUE_TYPES)[number];

/** The TypeScript type each document type carries as a literal. */
export interface LiteralTypes {
  text: string;
  url: string;
  path: string;
  'language-tag': string;
  'asset-path': string;
  'twitter-card': 'summary' | 'summary_large_image';
  flag: boolean;
  'open-graph': OpenGraphContract;
  twitter: TwitterContract;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * Who decides a value at the moment the generated project is built.
 *
 * - `generation` - ClientKit resolved it and nothing downstream can change it.
 *   A literal is the truthful representation.
 * - `project` - the generated project's configuration decides it. ClientKit may
 *   have seeded the initial value and still has no authority over it.
 * - `build-context` - the generated framework or its build supplies it, per
 *   page or per run. ClientKit cannot know it even in principle.
 *
 * Three categories rather than two because the middle one is where Stage 34
 * went wrong: collapsing "ClientKit knows it" into "ClientKit owns it" is
 * precisely the error that freezes an editable document.
 */
export const VALUE_OWNERS = ['generation', 'project', 'build-context'] as const;

export type ValueOwner = (typeof VALUE_OWNERS)[number];

// ---------------------------------------------------------------------------
// The closed binding vocabulary
// ---------------------------------------------------------------------------

/**
 * Every value the document may refer to rather than state.
 *
 * Derived from what the shipped Astro document actually reads, not from what a
 * binding system might one day want - each entry below was found by reading
 * `Seo.astro`, `StructuredData.astro` and `BaseLayout.astro` and asking who
 * decides the value at build time.
 *
 * The identifiers are semantic. `page.path` is "the path of the page being
 * rendered", not `Astro.url.pathname`; an architecture that expresses it
 * differently maps it differently and the domain never learns how. Nothing here
 * is a fragment of any language.
 */
export const DOCUMENT_BINDINGS = {
  /** The site's name, as the project configures it. */
  'site.name': { type: 'text', owner: 'project' },
  /** The site's production URL, or empty when the project has not set one. */
  'site.url': { type: 'url', owner: 'project' },
  /** The site's description. */
  'site.description': { type: 'text', owner: 'project' },
  /** The language the document declares. */
  'site.language': { type: 'language-tag', owner: 'project' },
  /** The social preview image, as a project-relative path or absolute URL. */
  'document.socialImage': { type: 'asset-path', owner: 'project' },
  /** Which Twitter/X card style the project prefers when it has an image. */
  'document.twitterCardStyle': { type: 'twitter-card', owner: 'project' },
  /** The project-wide switch that keeps the whole site out of the index. */
  'document.indexingBlocked': { type: 'flag', owner: 'project' },
  /** The path of the page currently being rendered. */
  'page.path': { type: 'path', owner: 'build-context' },
  /** The name and version of the tool that built the document. */
  'generator.name': { type: 'text', owner: 'build-context' },
} as const satisfies Readonly<
  Record<string, { readonly type: DocumentValueType; readonly owner: ValueOwner }>
>;

export type DocumentBinding = keyof typeof DOCUMENT_BINDINGS;

/** Every binding id, sorted, so any listing of them is order-stable. */
export const DOCUMENT_BINDING_IDS: readonly DocumentBinding[] = (
  Object.keys(DOCUMENT_BINDINGS) as DocumentBinding[]
).sort();

/** The bindings whose value is of one document type. Compile-time filtered. */
export type BindingOfType<K extends DocumentValueType> = {
  [B in DocumentBinding]: (typeof DOCUMENT_BINDINGS)[B]['type'] extends K ? B : never;
}[DocumentBinding];

export function bindingType(binding: DocumentBinding): DocumentValueType {
  return DOCUMENT_BINDINGS[binding].type;
}

export function bindingOwner(binding: DocumentBinding): ValueOwner {
  return DOCUMENT_BINDINGS[binding].owner;
}

/**
 * Whether a string is a binding this vocabulary knows.
 *
 * The runtime half of the closed-vocabulary guarantee. The compile-time half is
 * that `DocumentBinding` is a union of literals, so `'SITE.name'` and
 * `` `${x}` `` are type errors; this catches the same thing at a boundary where
 * types have been erased.
 */
export function isDocumentBinding(value: string): value is DocumentBinding {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_BINDINGS, value);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Values assembled from other values: a named operation over typed inputs.
 *
 * Stage 35 declared one derivation whose inputs were a fixed pair of bindings.
 * Stage 36 found two document facts that shape cannot carry, because their
 * inputs vary per contributor rather than being fixed:
 *
 *   - a page title composed with the site's name, where the page part is
 *     whatever that page says it is;
 *   - an indexing directive derived from the project's own switch.
 *
 * So a derivation now declares an ordered **parameter signature** and a result
 * type, and a value supplies the arguments. That is the whole of the change.
 *
 * ## Why this is not an expression language
 *
 * A derivation names *what happens*, never *how to compute it*. There is no
 * concatenation node, no conditional node, no property access, no call, and no
 * operator of any kind - the four things a general expression tree is made of
 * are all absent, and adding them is what would turn this into one. The
 * vocabulary grows only when a real document behaviour needs a name, and each
 * name means one specific operation that an architecture knows how to realise.
 *
 * Three entries, each traced to something the shipped Astro document does.
 */
export const DOCUMENT_DERIVATIONS = {
  /**
   * An absolute address for the page being rendered, from an origin and a path.
   *
   * `origin === '' || blocked ? '' : absoluteUrl(origin, Astro.url.pathname)`.
   * The blocked half is not an input: a page that refuses a canonical says so
   * at its own scope, and specificity settles it. What is left is the join.
   */
  'absolute-page-url': { type: 'url', parameters: ['url', 'path'] },
  /**
   * A page's title, qualified by the site's name.
   *
   * `title ? \`${title} - ${SITE.name}\` : SITE.name`. The template tests
   * truthiness, so an absent page title and an empty one behave identically -
   * and this therefore makes no distinction between them either. Inventing one
   * would be modelling a behaviour the source does not have.
   */
  'page-title-with-site-name': { type: 'text', parameters: ['text', 'text'] },
  /**
   * The robots directive a page should carry, from whether indexing is blocked.
   *
   * `blocked ? 'noindex, nofollow' : 'index, follow'`, where the template's
   * `blocked` is `noindex || SEO.noindex` - a page's own opt-out *or* the
   * project's switch.
   *
   * Only the project's switch is an input here, and the disjunction is not
   * missing: a page that opts out states its own directive at its own scope,
   * and scope specificity is what combines the two. Modelling `||` as a
   * derivation would have added a boolean operator to a vocabulary that
   * deliberately has none, to express something the scope model already
   * expresses.
   */
  'indexing-directive': { type: 'text', parameters: ['flag'] },
} as const satisfies Readonly<
  Record<
    string,
    { readonly type: DocumentValueType; readonly parameters: readonly DocumentValueType[] }
  >
>;

export type DocumentDerivation = keyof typeof DOCUMENT_DERIVATIONS;

/** Every derivation id, sorted, so any listing of them is order-stable. */
export const DOCUMENT_DERIVATION_IDS: readonly DocumentDerivation[] = (
  Object.keys(DOCUMENT_DERIVATIONS) as DocumentDerivation[]
).sort();

export function derivationType(derivation: DocumentDerivation): DocumentValueType {
  return DOCUMENT_DERIVATIONS[derivation].type;
}

/** The ordered types a derivation's arguments must have. */
export function derivationParameters(derivation: DocumentDerivation): readonly DocumentValueType[] {
  return DOCUMENT_DERIVATIONS[derivation].parameters;
}

export type DerivationOfType<K extends DocumentValueType> = {
  [D in DocumentDerivation]: (typeof DOCUMENT_DERIVATIONS)[D]['type'] extends K ? D : never;
}[DocumentDerivation];

export function isDocumentDerivation(value: string): value is DocumentDerivation {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_DERIVATIONS, value);
}

/**
 * The arguments one derivation takes, typed position by position.
 *
 * A mapped tuple over the declared parameter list, so supplying a `url` where
 * the first parameter is `text` is a compile error rather than something a
 * runtime check has to notice.
 */
type ValuesOf<T extends readonly DocumentValueType[]> = {
  -readonly [I in keyof T]: DocumentValue<T[I]>;
};

export type DerivationArguments<D extends DocumentDerivation> = ValuesOf<
  (typeof DOCUMENT_DERIVATIONS)[D]['parameters']
>;

// ---------------------------------------------------------------------------
// The value
// ---------------------------------------------------------------------------

/**
 * A document value: stated outright, referred to, or assembled.
 *
 * Parameterised by the *document* type rather than the TypeScript type, which
 * is what lets `BindingOfType` reject `site.name` where a URL belongs at
 * compile time instead of by inspecting a string at runtime.
 *
 * Absence is not represented here. A field nobody claimed is absent from the
 * statement that would have carried it, exactly as it has been since Stage 32,
 * and adding a fourth case for it would give "unsaid" two encodings.
 */
export type DocumentValue<K extends DocumentValueType> =
  | { readonly kind: 'literal'; readonly type: K; readonly value: LiteralTypes[K] }
  | { readonly kind: 'binding'; readonly type: K; readonly binding: BindingOfType<K> }
  | {
      readonly kind: 'derived';
      readonly type: K;
      readonly derivation: DerivationOfType<K>;
      /**
       * The arguments, in the order the derivation declares them.
       *
       * Typed as values rather than as bindings, so an argument may itself be
       * a literal, a binding or another derivation. Nesting is therefore
       * possible and is not forbidden - a title whose site-name half is itself
       * derived is a coherent thing to say.
       *
       * A cycle cannot be built. Values are immutable and assembled
       * bottom-up, so a value would have to contain itself before it existed;
       * there is no reference, no name and no lookup for one to close through.
       * The same reason Stage 27's wrapper ordering needs no cycle detection.
       */
      readonly inputs: readonly AnyDocumentValue[];
    };

/** A value of some type, for a position whose type is decided elsewhere. */
export type AnyDocumentValue = { [K in DocumentValueType]: DocumentValue<K> }[DocumentValueType];

export function literal<K extends DocumentValueType>(
  type: K,
  value: LiteralTypes[K],
): DocumentValue<K> {
  return { kind: 'literal', type, value };
}

export function boundTo<K extends DocumentValueType>(
  type: K,
  binding: BindingOfType<K>,
): DocumentValue<K> {
  return { kind: 'binding', type, binding };
}

export function derived<D extends DocumentDerivation>(
  derivation: D,
  ...inputs: DerivationArguments<D>
): DocumentValue<(typeof DOCUMENT_DERIVATIONS)[D]['type']> {
  const value = {
    kind: 'derived',
    type: DOCUMENT_DERIVATIONS[derivation].type,
    derivation,
    inputs: inputs as readonly AnyDocumentValue[],
  };
  return value as unknown as DocumentValue<(typeof DOCUMENT_DERIVATIONS)[D]['type']>;
}

/**
 * The three standard constructions, named so call sites read as intentions.
 *
 * Ergonomics only: each is exactly the `derived` call it wraps, and nothing
 * here is part of the vocabulary. They exist because the arguments for these
 * three are always the same, and spelling them out at every call site invites
 * one of them to drift.
 */
export function absolutePageUrl(): DocumentValue<'url'> {
  return derived('absolute-page-url', boundTo('url', 'site.url'), boundTo('path', 'page.path'));
}

/** @param pageTitle empty means the page adds nothing, exactly as the template reads it. */
export function pageTitleWithSiteName(pageTitle: DocumentValue<'text'>): DocumentValue<'text'> {
  return derived('page-title-with-site-name', pageTitle, boundTo('text', 'site.name'));
}

export function indexingDirective(): DocumentValue<'text'> {
  return derived('indexing-directive', boundTo('flag', 'document.indexingBlocked'));
}

/**
 * Refuses arguments that do not match a derivation's declared signature.
 *
 * The runtime half of the guarantee `DerivationArguments` makes at compile
 * time, for boundaries where types have been erased - a value read back from
 * JSON, or built by something that cast its way past the checker.
 */
export function assertDerivationInputs(value: AnyDocumentValue): void {
  if (value.kind !== 'derived') return;

  const expected = derivationParameters(value.derivation);
  if (value.inputs.length !== expected.length) {
    throw new CliError(
      `"${value.derivation}" takes ${expected.length} input(s), not ${value.inputs.length}.`,
      {
        hint: `It is declared as (${expected.join(', ')}) -> ${derivationType(value.derivation)}.`,
      },
    );
  }

  expected.forEach((type, index) => {
    const input = value.inputs[index];
    if (input === undefined || input.type !== type) {
      throw new CliError(
        `"${value.derivation}" expects ${type} at position ${index}, found ${input?.type ?? 'nothing'}.`,
        {
          hint: `It is declared as (${expected.join(', ')}) -> ${derivationType(value.derivation)}.`,
        },
      );
    }
    assertDerivationInputs(input);
  });
}

/** Who decides this value at the generated project's build. */
export function ownerOf<K extends DocumentValueType>(value: DocumentValue<K>): ValueOwner {
  switch (value.kind) {
    case 'literal':
      return 'generation';
    case 'binding':
      return bindingOwner(value.binding);
    case 'derived': {
      /*
       * The least settled of its inputs, and the rule survives parameters
       * unchanged: a value is only as settled as its least settled ingredient.
       * A title composed from a generation-time page title and a project-owned
       * site name is project-owned, because the project can still change half
       * of it - and freezing it would be exactly the Stage 34 mistake.
       *
       * Recursive, so a nested derivation reports through its own inputs.
       */
      const owners = value.inputs.map((input) => ownerOf(input));
      if (owners.includes('build-context')) return 'build-context';
      return owners.includes('project') ? 'project' : 'generation';
    }
  }
}

/** Every binding a value depends on, sorted. Empty for a literal. */
export function bindingsUsedBy<K extends DocumentValueType>(
  value: DocumentValue<K>,
): readonly DocumentBinding[] {
  switch (value.kind) {
    case 'literal':
      return [];
    case 'binding':
      return [value.binding];
    case 'derived':
      // Every binding anywhere beneath it, de-duplicated and sorted, so an
      // architecture is asked for the whole set a value depends on.
      return [...new Set(value.inputs.flatMap((input) => bindingsUsedBy(input)))].sort();
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * What one architecture can actually supply.
 *
 * Declared per architecture and checked, because the alternative is an
 * architecture quietly substituting something close enough. There is no
 * fallback: a framework with no notion of the current page's path cannot
 * approximate `page.path` with the site URL or an empty string, because both
 * produce a document that states something untrue and builds cleanly.
 */
export interface BindingSupport {
  /** Identifies the architecture in a diagnostic. Never branched on. */
  readonly architecture: string;
  readonly supports: readonly DocumentBinding[];
}

/**
 * Refuses a value whose bindings an architecture cannot supply.
 *
 * Names the architecture, the binding and what the binding means, so the
 * refusal says which capability is missing rather than that something failed.
 */
export function assertBindingsSupported<K extends DocumentValueType>(
  value: DocumentValue<K>,
  support: BindingSupport,
): void {
  const available = new Set(support.supports);
  const missing = bindingsUsedBy(value).filter((binding) => !available.has(binding));
  if (missing.length === 0) return;

  const lines = missing.map(
    (binding) => `  - ${binding} (${bindingOwner(binding)}-owned ${bindingType(binding)})`,
  );

  throw new CliError(`"${support.architecture}" cannot supply ${missing.join(', ')}.`, {
    hint: [
      ...lines,
      '',
      'A document value may only refer to something the architecture can',
      'actually produce. There is no fallback here on purpose: substituting a',
      'near-enough value would emit a document that states something untrue',
      'and builds without complaint.',
    ].join('\n'),
  });
}

/** A stable, comparable rendering of a value, for tests and diagnostics. */
export function describeDocumentValue<K extends DocumentValueType>(
  value: DocumentValue<K>,
): string {
  switch (value.kind) {
    case 'literal':
      return `${value.type} literal ${JSON.stringify(value.value)}`;
    case 'binding':
      return `${value.type} bound to ${value.binding}`;
    case 'derived':
      return `${value.type} derived from ${value.derivation}(${value.inputs
        .map((input) => describeDocumentValue(input))
        .join(', ')})`;
  }
}
