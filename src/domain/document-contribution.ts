import type { AccessibilityContract, AccessibilityGuarantee } from './accessibility.js';
import { ACCESSIBILITY_GUARANTEES } from './accessibility.js';
import type { FileRole } from './roles.js';
import type { SeoContract } from './seo.js';
import type { OrganizationContract } from './structured-data.js';

/**
 * What an adapter can say about the generated document.
 *
 * ## Why this exists
 *
 * Stage 30 set out to build a document-shell composer and stopped. The reason
 * was specific: the provider shell composes without a payload model because a
 * provider has exactly one universal prop, `children`. Every wrapper is
 * `{ importName, from }` and the composer nests N of them knowing nothing about
 * any of them. Head entries have no `children` equivalent, so a document
 * composer has to carry a payload - and there was no model for one.
 *
 * This is that model, and nothing more. There is no composer here, no
 * collection from contributions, no architecture and no emission. Stage 32 owns
 * those; what it needs first is a truthful way to say what a document should
 * state.
 *
 * ## The shape of the problem
 *
 * The three concerns this has to carry are not the same kind of thing, and the
 * fastest way to get this wrong is to notice they all end up near `<head>` and
 * flatten them into one bag of strings:
 *
 *   - **metadata** describes *this page* to a crawler. Title, description,
 *     robots, canonical, Open Graph, Twitter.
 *   - **structured data** describes *the organisation* to a knowledge graph. It
 *     is JSON-LD - an object with its own serialisation - not `meta[name]`.
 *   - **document guarantees** are properties of the generated document itself.
 *     Some are head concerns, some are body structure, one is an attribute on
 *     `<html>`. `GUARANTEE_SURFACES` below records which is which, and the
 *     spread is the proof that "accessibility is head markup" is false.
 *
 * So this is a discriminated union, one variant per concern, each wrapping the
 * feature-level contract that already exists rather than replacing it. The
 * contracts were right; what was missing was a way to attach them to a document
 * with a scope and a stance.
 *
 * ## What is deliberately not here
 *
 * No framework type, no markup, no component reference, no HTML string, no
 * `Record<string, unknown>`. A payload that was a renderable component is what
 * Stage 30 ruled out; a payload that was a string bag is what this stage exists
 * to prevent.
 */

// ---------------------------------------------------------------------------
// Scope: which pages a statement is about
// ---------------------------------------------------------------------------

/**
 * Which of the generated document's pages a contribution speaks for.
 *
 * Stage 30 found that document statements vary per page, and that the variation
 * carries correctness weight: the generated not-found page must not be indexed,
 * and must not claim to be the organisation's home. Those are the only two
 * per-page facts in the system today, and both were expressible *only* as props
 * on a framework's own layout - so the domain could not represent them at all.
 *
 * A page is named by the semantic role it already has. `page.notFound` is the
 * generator's existing vocabulary for "the page an unmatched address reaches",
 * maps to a different file in every architecture, and names no framework. That
 * is what keeps "the 404 opts out of indexing" sayable here without anything
 * knowing what a `.astro` file is.
 */
export type DocumentScope =
  { readonly kind: 'every-page' } | { readonly kind: 'page'; readonly role: FileRole };

export const EVERY_PAGE: DocumentScope = { kind: 'every-page' };

/** A scope for one semantic page. */
export function onPage(role: FileRole): DocumentScope {
  return { kind: 'page', role };
}

/** Total order over scopes: the whole document first, then pages by role. */
export function scopeKey(scope: DocumentScope): string {
  return scope.kind === 'every-page' ? '' : `page:${scope.role}`;
}

// ---------------------------------------------------------------------------
// Stance: said, deliberately not said, or never mentioned
// ---------------------------------------------------------------------------

/**
 * Three states, kept distinguishable on purpose.
 *
 * `stated` - this is what the document should say.
 * `suppressed` - somebody decided the document should *not* say this here, and
 *   said why.
 * absent - nobody contributed at all, which is the absence of a contribution
 *   rather than a value inside one.
 *
 * Collapsing the middle one into `undefined` is the mistake this shape exists
 * to prevent. "No structured data was configured" and "this page deliberately
 * suppresses structured data" produce the same document today and must not
 * produce the same *model*: the first is a project that has not set anything up,
 * the second is a correctness decision with a reason attached. A later composer
 * has to be able to tell a missing statement from a refused one, or it will
 * eventually restore a suppressed one by "filling in a gap".
 *
 * `because` is mandatory on a suppression for the reason `Constraint.because`
 * is mandatory: it is the sentence that explains the decision, and a decision
 * nobody wrote a reason for is one nobody can review.
 */
export type DocumentStance<T> =
  | { readonly state: 'stated'; readonly value: T }
  | { readonly state: 'suppressed'; readonly because: string };

export function stated<T>(value: T): DocumentStance<T> {
  return { state: 'stated', value };
}

export function suppressed<T>(because: string): DocumentStance<T> {
  return { state: 'suppressed', because };
}

// ---------------------------------------------------------------------------
// The contributions
// ---------------------------------------------------------------------------

/**
 * The vocabulary, in the order canonical output uses.
 *
 * A fixed literal rather than anything derived, for the same reason
 * `CAPABILITIES` is one: ordering that comes from a declaration is stable, and
 * ordering that comes from how a `Map` happened to be filled is not.
 */
export const DOCUMENT_CONTRIBUTION_KINDS = [
  'metadata',
  'structured-data',
  'document-guarantees',
] as const;

export type DocumentContributionKind = (typeof DOCUMENT_CONTRIBUTION_KINDS)[number];

interface DocumentContributionBase {
  /** `<kind>:<id>`, the same owner string every other contribution carries. */
  readonly owner: string;
  /** Why this adapter is saying it. Shown when two owners disagree. */
  readonly reason: string;
  readonly scope: DocumentScope;
}

/**
 * What a page should tell a crawler about itself, in whole or in part.
 *
 * Partial since Stage 32, and the widening is what makes field-level
 * resolution mean anything. Stage 31 carried a complete `SeoContract` because
 * the one contributor that exists computes a complete one - so two owners could
 * only ever agree entirely or disagree entirely, and "disjoint fields merge"
 * was a case the type could not express.
 *
 * A contributor that speaks only to the canonical address, or only to the
 * social card, is the shape this is for. The existing complete contract is
 * still a valid value, so nothing that worked stopped working.
 *
 * A *resolved* statement may therefore be partial too, and deliberately: a
 * field nobody claimed stays absent rather than being filled in. Whoever
 * eventually renders a head decides what to do with an absent field; inventing
 * one here would be fabrication.
 */
export type MetadataStatement = Partial<SeoContract>;

/** What a page should tell a crawler about itself. */
export interface MetadataContribution extends DocumentContributionBase {
  readonly kind: 'metadata';
  readonly metadata: DocumentStance<MetadataStatement>;
}

/**
 * What machines should be told about the organisation behind the site.
 *
 * Carries the contract as an object. It is never a string here and never a
 * `<script>` element: JSON-LD has a serialisation of its own
 * (`serialiseOrganization`) and an HTML representation on top of that, and both
 * belong to whatever eventually renders this - not to the statement that the
 * document should carry it.
 */
export interface StructuredDataContribution extends DocumentContributionBase {
  readonly kind: 'structured-data';
  readonly jsonLd: DocumentStance<OrganizationContract>;
}

/**
 * Properties the generated document itself must hold.
 *
 * Not metadata. `main-landmark` is a `<main>` element, `skip-link` is the first
 * thing in the body, `document-language` is an attribute on `<html>`. Calling
 * these head entries would be false about most of them - see
 * `GUARANTEE_SURFACES`.
 */
export interface DocumentGuaranteesContribution extends DocumentContributionBase {
  readonly kind: 'document-guarantees';
  readonly guarantees: DocumentStance<AccessibilityContract>;
}

export type DocumentContribution =
  MetadataContribution | StructuredDataContribution | DocumentGuaranteesContribution;

// ---------------------------------------------------------------------------
// Where a guarantee actually lands
// ---------------------------------------------------------------------------

/**
 * The part of the document each guarantee is about.
 *
 * Recorded because the single most tempting simplification available to a later
 * stage is "accessibility is just more head tags", and this is the evidence that
 * it is not: of the eight guarantees, five are body structure and one is an
 * attribute on the root element.
 *
 * A classification, not a rendering instruction. Nothing here says how a
 * landmark is produced.
 */
export const GUARANTEE_SURFACES: Readonly<
  Record<AccessibilityGuarantee, 'document-element' | 'head' | 'document-structure'>
> = {
  'document-language': 'document-element',
  'document-title': 'head',
  'scalable-viewport': 'head',
  'main-landmark': 'document-structure',
  'skip-link': 'document-structure',
  'contentinfo-landmark': 'document-structure',
  'primary-heading': 'document-structure',
  'navigation-landmark-when-present': 'document-structure',
};

/** Every guarantee that lands on one surface, in vocabulary order. */
export function guaranteesOnSurface(
  surface: 'document-element' | 'head' | 'document-structure',
): readonly AccessibilityGuarantee[] {
  return ACCESSIBILITY_GUARANTEES.filter((guarantee) => GUARANTEE_SURFACES[guarantee] === surface);
}

// ---------------------------------------------------------------------------
// Identity and canonical form
// ---------------------------------------------------------------------------

/**
 * What makes two contributions the same statement.
 *
 * Kind and scope, not owner: two adapters describing the metadata of the same
 * page are making one statement about one thing, and whether they agree is the
 * question `canonicalDocumentContributions` answers. Including the owner would
 * make every contribution unique and there would be no collisions to detect.
 */
export function documentContributionIdentity(contribution: DocumentContribution): string {
  return `${contribution.kind}|${scopeKey(contribution.scope)}`;
}

/** The payload of any variant, for comparison. One switch, exhaustive. */
export function stanceOf(contribution: DocumentContribution): DocumentStance<unknown> {
  switch (contribution.kind) {
    case 'metadata':
      return contribution.metadata;
    case 'structured-data':
      return contribution.jsonLd;
    case 'document-guarantees':
      return contribution.guarantees;
  }
}

const kindRank = (kind: DocumentContributionKind): number =>
  DOCUMENT_CONTRIBUTION_KINDS.indexOf(kind);

/**
 * Every contribution that speaks to one identity, in canonical order.
 *
 * Grouping only. Stage 31 arbitrated here and threw when two owners said
 * anything different about one statement, which was too coarse: two owners
 * setting disjoint metadata fields were refused for disagreeing when they had
 * not. Stage 32 moved arbitration to `resolveDocumentContributions`, so this is
 * the step before it and has no opinion about whether a group agrees.
 *
 * Order comes from the vocabulary, then the scope, then the owner - a
 * declaration rather than arrival order. Nothing downstream may read that
 * order as precedence; it exists so the same input always produces the same
 * output and the same diagnostic.
 */
export interface DocumentContributionGroup {
  readonly kind: DocumentContributionKind;
  readonly scope: DocumentScope;
  /** At least one, in canonical order. */
  readonly contributions: readonly DocumentContribution[];
}

export function groupDocumentContributions(
  contributions: readonly DocumentContribution[],
): readonly DocumentContributionGroup[] {
  const byIdentity = new Map<string, DocumentContribution[]>();

  const ordered = [...contributions].sort(
    (a, b) =>
      kindRank(a.kind) - kindRank(b.kind) ||
      (scopeKey(a.scope) < scopeKey(b.scope)
        ? -1
        : scopeKey(a.scope) > scopeKey(b.scope)
          ? 1
          : 0) ||
      (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0),
  );

  for (const contribution of ordered) {
    const identity = documentContributionIdentity(contribution);
    const existing = byIdentity.get(identity);
    if (existing === undefined) byIdentity.set(identity, [contribution]);
    else existing.push(contribution);
  }

  return [...byIdentity.values()].map((group) => {
    const [first] = group;
    if (first === undefined) throw new Error('unreachable: empty group');
    return { kind: first.kind, scope: first.scope, contributions: group };
  });
}
/** `every page` or `the page.notFound page`, for a diagnostic. */
export function describeScope(scope: DocumentScope): string {
  return scope.kind === 'every-page' ? 'every page' : `the "${scope.role}" page`;
}
