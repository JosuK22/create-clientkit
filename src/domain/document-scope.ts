import type { AccessibilityContract } from './accessibility.js';
import type { DocumentContribution, DocumentScope } from './document-contribution.js';
import { describeScope } from './document-contribution.js';
import type {
  MetadataField,
  Provenance,
  ResolvedDocumentContribution,
  ResolvedMetadata,
  ResolvedStance,
} from './document-resolution.js';
import { METADATA_FIELDS, resolveDocumentContributions } from './document-resolution.js';
import type { FileRole } from './roles.js';
import type { OrganizationContract } from './structured-data.js';
import { CliError } from '../errors.js';

/**
 * What one page's document actually says, once scope is taken into account.
 *
 * ## The question Stage 32 left open
 *
 * Stage 32 resolves every statement about the document and stops. It produces
 * one entry per `(kind, scope)` and deliberately defines no relationship
 * between them, because how a page's statement combines with the document's is
 * a composition question and inventing a rule for it there would have been
 * precedence by another name.
 *
 * This is that rule, made explicit.
 *
 * ## Specificity is declared, not sorted
 *
 * The distinction this layer exists to protect:
 *
 *     deterministic ordering  ≠  semantic precedence
 *
 * A page-scoped statement takes precedence over a site-wide one because
 * `SCOPE_SPECIFICITY` says a page is more specific than the document, and for
 * no other reason. It is emphatically *not* because `page:…` sorts after `''`
 * in the canonical order - that order exists so output is reproducible, and a
 * rule that rode on it would silently change meaning the day the ordering was
 * adjusted for an unrelated reason.
 *
 * Within one scope nothing changed: two owners disagreeing about a field is
 * still a conflict, and specificity never resolves it. Scope composition
 * combines *different* scopes; it is not a general winner mechanism.
 */

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/**
 * The page being asked about.
 *
 * Distinct from `DocumentScope` even though the two have the same shape,
 * because they answer different questions: a scope is what a contribution
 * *declares it applies to*, a target is what somebody is *asking for*. Keeping
 * them apart means a contribution's scope cannot be passed where a target
 * belongs and quietly resolve to something plausible.
 *
 * A page is named by the semantic role it already has - never a route, a
 * pathname, a URL or a file. That vocabulary is deliberately not extended here:
 * a routing-aware scope system is a different problem and would need its own
 * stage.
 */
export type DocumentTarget =
  { readonly kind: 'site' } | { readonly kind: 'page'; readonly role: FileRole };

export const SITE_TARGET: DocumentTarget = { kind: 'site' };

/** The target for one semantic page. */
export function forPage(role: FileRole): DocumentTarget {
  return { kind: 'page', role };
}

export function describeTarget(target: DocumentTarget): string {
  return target.kind === 'site' ? 'the site' : `the "${target.role}" page`;
}

/**
 * How specific a scope is, as a declared number rather than a sort position.
 *
 * Higher wins. Two entries today, and the gap between them is deliberate: a
 * future scope that sits between the document and a page has somewhere to go
 * without renumbering, and adding one is a decision somebody has to write down
 * here rather than a consequence of where it lands alphabetically.
 */
export const SCOPE_SPECIFICITY = {
  'every-page': 0,
  page: 10,
} as const;

/** Whether a contribution's scope has anything to say about this target. */
export function appliesTo(scope: DocumentScope, target: DocumentTarget): boolean {
  if (scope.kind === 'every-page') return true;
  return target.kind === 'page' && scope.role === target.role;
}

const specificityOf = (scope: DocumentScope): number =>
  scope.kind === 'every-page' ? SCOPE_SPECIFICITY['every-page'] : SCOPE_SPECIFICITY.page;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Where a resolved value came from, including which scope it was stated at. */
export interface ComposedProvenance extends Provenance {
  readonly from: DocumentScope;
}

/**
 * A page's metadata, with each field traceable to the scope it came from.
 *
 * The inheritance has to stay visible. "This page's description came from the
 * site-wide statement and its title from the page's own" is the sentence a
 * diagnostic needs, and a result that merged the two into an anonymous object
 * could not produce it.
 */
export interface ComposedMetadata {
  readonly value: ResolvedMetadata['value'];
  readonly provenance: Readonly<Partial<Record<MetadataField, ComposedProvenance>>>;
}

/**
 * Everything one page's document states.
 *
 * Each kind is optional, and its absence means nobody said anything about it -
 * which stays distinct from a present `suppressed` stance meaning somebody
 * decided it must not be said. That difference has been load-bearing since
 * Stage 31 and survives composition intact.
 */
export interface ResolvedPageDocument {
  readonly target: DocumentTarget;
  readonly metadata?: ResolvedStance<ComposedMetadata>;
  readonly structuredData?: ResolvedStance<OrganizationContract>;
  readonly guarantees?: ResolvedStance<AccessibilityContract>;
}

// ---------------------------------------------------------------------------
// The constraint accessibility turned out to need
// ---------------------------------------------------------------------------

/**
 * Refuses a document guarantee scoped to one page.
 *
 * Stage 31 recorded this as a suspicion - "`DocumentStance` permits suppressing
 * document guarantees, which is probably never correct" - and left it. The
 * contract settles it: `ACCESSIBILITY_GUARANTEES` is documented as "a property
 * of the generated document that holds on **every page**", and every entry is
 * phrased so it can be checked against real built HTML. A page that suppressed
 * `document-language` would still build, still pass review, and make the
 * contract false for the whole project - and the bounded claim the contract
 * makes is the thing that gives it any value.
 *
 * So the constraint is structural rather than advisory: a guarantee may only be
 * stated for the document as a whole. Scoping one to a page is refused here,
 * where pages first become meaningful, rather than being silently ignored.
 */
export function assertGuaranteesAreDocumentWide(
  contributions: readonly DocumentContribution[],
): void {
  const scoped = contributions.filter(
    (contribution) =>
      contribution.kind === 'document-guarantees' && contribution.scope.kind === 'page',
  );
  if (scoped.length === 0) return;

  const lines = scoped.map(
    (contribution) =>
      `  ${contribution.owner} scoped a guarantee to ${describeScope(contribution.scope)}\n    reason: ${contribution.reason}`,
  );

  throw new CliError('A document guarantee cannot be scoped to one page.', {
    hint: [
      ...lines,
      '',
      'The accessibility contract promises properties that hold on every page the',
      'generator emits, and each one is checked against real built HTML. A page',
      'that opted out would leave the promise false for the whole project while',
      'still building, so the guarantee is stated for the document or not at all.',
    ].join('\n'),
  });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** The entries that speak to this target, least specific first. */
function applicable(
  resolved: readonly ResolvedDocumentContribution[],
  target: DocumentTarget,
): readonly ResolvedDocumentContribution[] {
  return resolved
    .filter((entry) => appliesTo(entry.scope, target))
    .sort((a, b) => specificityOf(a.scope) - specificityOf(b.scope));
}

/**
 * Overlays metadata field by field, most specific last.
 *
 * Field-level throughout, exactly as Stage 32 established within a scope: a
 * page that states a title overrides the inherited title and inherits
 * everything else. Returning to "the page's whole statement wins because it has
 * a title" would undo the distinction Stage 32 was written for.
 *
 * A field present with an empty value is a statement, not a gap.
 * `canonical: ''` means the page claims no canonical address - which is what
 * the contract means by it and what the only consumer does with it - so it
 * overrides an inherited one rather than falling through to it. Absence is how
 * a contributor says nothing, and that is a different thing entirely.
 */
function overlayMetadata(
  layers: readonly { readonly scope: DocumentScope; readonly resolved: ResolvedMetadata }[],
): ComposedMetadata {
  const value: Record<string, unknown> = {};
  const provenance: Partial<Record<MetadataField, ComposedProvenance>> = {};

  // Vocabulary order, so the composed object's keys never depend on which
  // layer happened to supply them.
  for (const field of METADATA_FIELDS) {
    for (const layer of layers) {
      const claimed = layer.resolved.value[field];
      if (claimed === undefined) continue;
      const fieldProvenance = layer.resolved.provenance[field];
      value[field] = claimed;
      provenance[field] = {
        owners: fieldProvenance?.owners ?? [],
        reasons: fieldProvenance?.reasons ?? [],
        from: layer.scope,
      };
    }
  }

  return { value: value as ResolvedMetadata['value'], provenance };
}

/**
 * What one page's document says, once every applicable scope is applied.
 *
 * Pure and total: contributions and a target in, semantic data out. No
 * filesystem, no architecture, no adapter, no feature, no framework. It never
 * learns who contributed beyond an owner string it carries for diagnostics.
 *
 * Genuine conflicts are still conflicts. Two owners disagreeing about a field
 * *within* one scope raises exactly as it did in Stage 32 - specificity
 * combines different scopes and never arbitrates between owners at the same
 * one, which is what keeps it from becoming a general last-writer-wins.
 */
export function resolveDocumentForPage(
  contributions: readonly DocumentContribution[],
  target: DocumentTarget,
): ResolvedPageDocument {
  assertGuaranteesAreDocumentWide(contributions);

  const entries = applicable(resolveDocumentContributions(contributions), target);

  const metadataLayers: { scope: DocumentScope; resolved: ResolvedMetadata }[] = [];
  let metadata: ResolvedStance<ComposedMetadata> | undefined;
  let structuredData: ResolvedStance<OrganizationContract> | undefined;
  let guarantees: ResolvedStance<AccessibilityContract> | undefined;

  for (const entry of entries) {
    switch (entry.kind) {
      case 'metadata': {
        if (entry.metadata.state === 'suppressed') {
          /*
           * A refusal wins over everything less specific: the page said not to
           * state this, and inheriting anyway would restore exactly what was
           * refused.
           *
           * With two levels that is all it takes, because a page refusal is
           * always the last entry - `metadata` is set and the accumulated
           * layers below are never read. An earlier draft also cleared them,
           * which was defence against a *third* level (document → section →
           * page, where a middle refusal would otherwise be overlaid by a page
           * statement and let the document layer through). `SCOPE_SPECIFICITY`
           * leaves room for such a level, and whoever adds one has to revisit
           * this branch - a guard that cannot be reached cannot be proven, so
           * it is not carried here pretending to be load-bearing.
           */
          metadata = entry.metadata;
        } else {
          // A statement at a more specific scope overrides a less specific
          // refusal, which is the same specificity rule pointing the other way.
          metadata = undefined;
          metadataLayers.push({ scope: entry.scope, resolved: entry.metadata.value });
        }
        break;
      }
      case 'structured-data':
        // Whole-object, so a more specific scope replaces rather than merges.
        // Two organisations are the same or different and there is no third
        // answer that does not involve assembling one nobody described.
        structuredData = entry.jsonLd;
        break;
      case 'document-guarantees':
        guarantees = entry.guarantees;
        break;
    }
  }

  if (metadata === undefined && metadataLayers.length > 0) {
    metadata = { state: 'stated', value: overlayMetadata(metadataLayers) };
  }

  return {
    target,
    ...(metadata === undefined ? {} : { metadata }),
    ...(structuredData === undefined ? {} : { structuredData }),
    ...(guarantees === undefined ? {} : { guarantees }),
  };
}
