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
 * Values assembled from other values, named rather than expressed.
 *
 * Exactly one entry, and the restraint is the point. Astro builds a canonical
 * address from the site's origin and the current page's path, and that
 * combination is the single reason Stage 34's snapshot approach lost per-page
 * canonicals. Naming it makes it representable; writing
 * `` `${SITE.url}${Astro.url.pathname}` `` would make it arbitrary code
 * wearing a data structure.
 *
 * `from` is declared so an architecture can refuse a derivation whose inputs it
 * cannot supply, rather than approximating one.
 *
 * Two further derivations exist in the shipped document and are deliberately
 * *not* modelled here - an absolute social-image URL, and a Twitter card style
 * that depends on whether an image exists. Both need forms this vocabulary does
 * not have (asset resolution, and a conditional), and inventing either to make
 * the set look complete is how a closed vocabulary stops being closed. They are
 * classified in the Stage 35 documentation and left for the stage that needs
 * them.
 */
export const DOCUMENT_DERIVATIONS = {
  'absolute-page-url': {
    type: 'url',
    from: ['site.url', 'page.path'],
  },
} as const satisfies Readonly<
  Record<string, { readonly type: DocumentValueType; readonly from: readonly DocumentBinding[] }>
>;

export type DocumentDerivation = keyof typeof DOCUMENT_DERIVATIONS;

export function derivationType(derivation: DocumentDerivation): DocumentValueType {
  return DOCUMENT_DERIVATIONS[derivation].type;
}

export function derivationInputs(derivation: DocumentDerivation): readonly DocumentBinding[] {
  return DOCUMENT_DERIVATIONS[derivation].from;
}

export type DerivationOfType<K extends DocumentValueType> = {
  [D in DocumentDerivation]: (typeof DOCUMENT_DERIVATIONS)[D]['type'] extends K ? D : never;
}[DocumentDerivation];

export function isDocumentDerivation(value: string): value is DocumentDerivation {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_DERIVATIONS, value);
}

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
  | { readonly kind: 'derived'; readonly type: K; readonly derivation: DerivationOfType<K> };

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

export function derived<K extends DocumentValueType>(
  type: K,
  derivation: DerivationOfType<K>,
): DocumentValue<K> {
  return { kind: 'derived', type, derivation };
}

/** Who decides this value at the generated project's build. */
export function ownerOf<K extends DocumentValueType>(value: DocumentValue<K>): ValueOwner {
  switch (value.kind) {
    case 'literal':
      return 'generation';
    case 'binding':
      return bindingOwner(value.binding);
    case 'derived': {
      // A derivation is owned by the least settled of its inputs: if any part
      // comes from the build, the whole value does.
      const owners = derivationInputs(value.derivation).map(bindingOwner);
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
      return [...derivationInputs(value.derivation)].sort();
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
      return `${value.type} derived from ${value.derivation}`;
  }
}
