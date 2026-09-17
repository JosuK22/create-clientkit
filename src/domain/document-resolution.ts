import type { AccessibilityContract } from './accessibility.js';
import type {
  DocumentContribution,
  DocumentContributionGroup,
  DocumentContributionKind,
  DocumentScope,
  MetadataStatement,
} from './document-contribution.js';
import { describeScope, groupDocumentContributions } from './document-contribution.js';
import type { OrganizationContract } from './structured-data.js';
import { CliError } from '../errors.js';

/**
 * Turning many statements about one document into one.
 *
 * ## What Stage 31 left, and why it was not enough
 *
 * Stage 31 arbitrated whole statements: two owners saying anything different
 * about one identity were refused. That is too coarse in one direction and
 * silent in the other. Two owners setting *disjoint* metadata fields were
 * refused for disagreeing when they had not; and when they did disagree, the
 * diagnostic could only say "these two statements differ", not which field.
 *
 * ## Ordering is not precedence
 *
 * The single rule this layer is built around, and the one most easily lost:
 *
 *     deterministic ordering  ≠  semantic winner
 *
 * Contributions are ordered by vocabulary, then scope, then owner, so that the
 * same input always produces the same output and the same message. Nothing
 * reads that order to decide *whose value wins*, because nothing here decides
 * that at all. There is no first-wins, last-wins, feature-order, CLI-order,
 * alphabetical-owner or framework precedence. Two owners making incompatible
 * claims about one field is a conflict, and the fix is for one of them to stop
 * making it.
 *
 * ## Granularity is declared per kind, not universal
 *
 * The three concerns do not resolve the same way, and forcing them through one
 * mechanism is how the distinctions Stage 31 preserved would be lost again:
 *
 *   - **metadata** resolves field by field, because its fields are independent
 *     claims about a page and a contributor may speak to only some of them.
 *   - **structured data** resolves as one object. Two JSON-LD descriptions are
 *     either the same organisation or different ones; merging them field-wise
 *     would let two contributors assemble an organisation neither described.
 *   - **document guarantees** resolve as one contract, for the same reason and
 *     one more: a guarantee is a promise about generated output, and unioning
 *     promises from separate owners would produce a claim nobody verified.
 */

// ---------------------------------------------------------------------------
// Metadata fields
// ---------------------------------------------------------------------------

/**
 * The independently resolvable parts of a metadata statement.
 *
 * `openGraph` and `twitter` are single entries rather than being flattened, and
 * that is a correctness rule rather than a simplification. `resolveSeoContract`
 * derives `openGraph.title` from `title`, `openGraph.description` from
 * `description` and `openGraph.url` from `canonical`. Taking `title` from one
 * owner and `openGraph` from another would emit a document whose `<title>` and
 * `og:title` disagree - valid HTML, passes a build, and wrong in the only place
 * it matters. So each social block is resolved whole, by the owner that
 * computed it.
 */
export const METADATA_FIELDS = [
  'title',
  'description',
  'robots',
  'canonical',
  'openGraph',
  'twitter',
] as const;

export type MetadataField = (typeof METADATA_FIELDS)[number];

/** Who claimed a value, and why. Kept for diagnostics, never for equality. */
export interface Provenance {
  readonly owners: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * A resolved metadata statement, with each field traceable to its claimants.
 *
 * `value` is partial on purpose. A field nobody claimed is absent, and stays
 * absent: filling in a title from the site name would be inventing a claim
 * nobody made, and the contract that does derive a title from the site name
 * already exists one layer up where somebody chose it.
 */
export interface ResolvedMetadata {
  readonly value: MetadataStatement;
  readonly provenance: Readonly<Partial<Record<MetadataField, Provenance>>>;
}

// ---------------------------------------------------------------------------
// Resolved output
// ---------------------------------------------------------------------------

/**
 * The resolved form of a stance.
 *
 * `suppressed` carries every reason rather than one. Two owners refusing to
 * state something agree about the document even if they explain it differently,
 * so the reasons are provenance rather than semantic content - the same
 * treatment `reason` gets everywhere else.
 */
export type ResolvedStance<T> =
  | { readonly state: 'stated'; readonly value: T }
  | { readonly state: 'suppressed'; readonly becauses: readonly string[] };

interface ResolvedBase {
  readonly scope: DocumentScope;
  /** Every owner that contributed to this statement, sorted. */
  readonly owners: readonly string[];
  readonly reasons: readonly string[];
}

export interface ResolvedMetadataContribution extends ResolvedBase {
  readonly kind: 'metadata';
  readonly metadata: ResolvedStance<ResolvedMetadata>;
}

export interface ResolvedStructuredDataContribution extends ResolvedBase {
  readonly kind: 'structured-data';
  readonly jsonLd: ResolvedStance<OrganizationContract>;
}

export interface ResolvedGuaranteesContribution extends ResolvedBase {
  readonly kind: 'document-guarantees';
  readonly guarantees: ResolvedStance<AccessibilityContract>;
}

export type ResolvedDocumentContribution =
  | ResolvedMetadataContribution
  | ResolvedStructuredDataContribution
  | ResolvedGuaranteesContribution;

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

const show = (value: unknown): string => (value === undefined ? '(absent)' : JSON.stringify(value));

/**
 * A serialisation that depends on a value's structure, not on how it was built.
 *
 * `JSON.stringify` preserves key insertion order, so two statements that mean
 * the same thing compare unequal if one was assembled in another order - and
 * Stage 32 has always described this equality as *structural*. That went
 * unnoticed while every value came from the same constructors and therefore
 * always had the same key order. Stage 37's derivations, which can be read back
 * from JSON or assembled by hand, made the gap reachable.
 *
 * Arrays keep their order, because an ordered list is part of the meaning: a
 * derivation's arguments are positional, and sorting them would make
 * `f(a, b)` equal `f(b, a)`.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Names the kind, the field, the scope and every owner with its value.
 *
 * `field` is omitted for a kind that resolves as a whole, because naming a
 * field there would imply a granularity the resolution does not have.
 */
function conflict(
  kind: DocumentContributionKind,
  field: string | undefined,
  scope: DocumentScope,
  claims: readonly { readonly owner: string; readonly value: unknown; readonly reason: string }[],
): never {
  const what = field === undefined ? kind : `${kind}.${field}`;
  const lines = claims.map(
    (claim) => `  ${claim.owner}\n    ${show(claim.value)}\n    reason: ${claim.reason}`,
  );

  throw new CliError(`Two adapters disagree about ${what} for ${describeScope(scope)}.`, {
    hint: [
      ...lines,
      '',
      'One document can only say one of these, and nothing here picks a winner:',
      'the order contributions are resolved in is fixed so the result is',
      'reproducible, not so that one of them takes precedence. Exactly one of',
      'these claims has to be withdrawn.',
    ].join('\n'),
  });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Claims on one thing, in canonical order, with the claimant kept. */
interface Claim {
  readonly owner: string;
  readonly reason: string;
  readonly value: unknown;
}

/**
 * Agreement or a conflict. Never a choice.
 *
 * Equality is structural and excludes the owner, so two adapters computing the
 * same value cooperate. Anything else raises, naming everyone involved - which
 * is the whole of the precedence policy.
 */
function agree(
  kind: DocumentContributionKind,
  field: string | undefined,
  scope: DocumentScope,
  claims: readonly Claim[],
): { readonly value: unknown; readonly provenance: Provenance } {
  const [first] = claims;
  if (first === undefined) throw new Error('unreachable: no claims');

  const differing = claims.find((claim) => canonical(claim.value) !== canonical(first.value));
  if (differing !== undefined) {
    conflict(kind, field, scope, [
      { owner: first.owner, value: first.value, reason: first.reason },
      { owner: differing.owner, value: differing.value, reason: differing.reason },
    ]);
  }

  return {
    value: first.value,
    provenance: {
      owners: [...new Set(claims.map((claim) => claim.owner))],
      reasons: [...new Set(claims.map((claim) => claim.reason))],
    },
  };
}

/**
 * Splits a group into the ones that state something and the ones that refuse.
 *
 * A group containing both is a conflict, and deliberately so: "say this" and
 * "do not say this" is a genuine disagreement about the document, and Stage 31
 * kept `suppressed` distinct from absent precisely so it could not be resolved
 * by treating a refusal as a gap.
 */
function partitionStances(group: DocumentContributionGroup): {
  readonly stated: readonly {
    readonly contribution: DocumentContribution;
    readonly value: unknown;
  }[];
  readonly suppressed: readonly DocumentContribution[];
} {
  const stated: { contribution: DocumentContribution; value: unknown }[] = [];
  const suppressedList: DocumentContribution[] = [];

  for (const contribution of group.contributions) {
    const stance =
      contribution.kind === 'metadata'
        ? contribution.metadata
        : contribution.kind === 'structured-data'
          ? contribution.jsonLd
          : contribution.guarantees;

    if (stance.state === 'stated') stated.push({ contribution, value: stance.value });
    else suppressedList.push(contribution);
  }

  if (stated.length > 0 && suppressedList.length > 0) {
    const sayer = stated[0];
    const refuser = suppressedList[0];
    if (sayer === undefined || refuser === undefined) throw new Error('unreachable');
    conflict(group.kind, undefined, group.scope, [
      { owner: sayer.contribution.owner, value: sayer.value, reason: sayer.contribution.reason },
      { owner: refuser.owner, value: '(suppressed)', reason: refuser.reason },
    ]);
  }

  return { stated, suppressed: suppressedList };
}

const provenanceOf = (contributions: readonly DocumentContribution[]): ResolvedBase => ({
  scope: contributions[0]?.scope ?? { kind: 'every-page' },
  owners: [...new Set(contributions.map((entry) => entry.owner))],
  reasons: [...new Set(contributions.map((entry) => entry.reason))],
});

/** Metadata: field by field, with the two social blocks resolved whole. */
function resolveMetadata(
  group: DocumentContributionGroup,
  stated: readonly { readonly contribution: DocumentContribution; readonly value: unknown }[],
): ResolvedMetadata {
  const value: Record<string, unknown> = {};
  const provenance: Partial<Record<MetadataField, Provenance>> = {};

  // Walked in vocabulary order, so the resolved object's keys do not depend on
  // which contribution happened to be first.
  for (const field of METADATA_FIELDS) {
    const claims: Claim[] = stated
      .filter((entry) => (entry.value as MetadataStatement)[field] !== undefined)
      .map((entry) => ({
        owner: entry.contribution.owner,
        reason: entry.contribution.reason,
        value: (entry.value as MetadataStatement)[field],
      }));

    // Nobody claimed it, so it stays absent. This is the no-fabrication rule.
    if (claims.length === 0) continue;

    const resolved = agree('metadata', field, group.scope, claims);
    value[field] = resolved.value;
    provenance[field] = resolved.provenance;
  }

  return { value: value as MetadataStatement, provenance };
}

/**
 * Resolves a set of document contributions, or refuses.
 *
 * Pure: statements in, statements out. No filesystem, no architecture, no
 * adapter, no feature and no framework - the resolver never learns who
 * contributed beyond an owner string it only uses for diagnostics.
 *
 * Scopes stay separate. `every-page` and `page.notFound` are different
 * identities and each resolves on its own, so a site-wide statement cannot
 * overwrite a page-specific one. There is deliberately no inheritance: how a
 * page's statement relates to the document's is a composition question, and
 * inventing a rule for it here would be precedence by another name.
 */
export function resolveDocumentContributions(
  contributions: readonly DocumentContribution[],
): readonly ResolvedDocumentContribution[] {
  return groupDocumentContributions(contributions).map((group) => {
    const { stated, suppressed } = partitionStances(group);
    const base = provenanceOf(group.contributions);

    if (stated.length === 0) {
      const becauses = [
        ...new Set(
          suppressed.map((contribution) => {
            const stance =
              contribution.kind === 'metadata'
                ? contribution.metadata
                : contribution.kind === 'structured-data'
                  ? contribution.jsonLd
                  : contribution.guarantees;
            return stance.state === 'suppressed' ? stance.because : '';
          }),
        ),
      ];
      // A refusal resolves to a refusal whatever the kind is, so the three
      // variants share one shape here.
      switch (group.kind) {
        case 'metadata':
          return { ...base, kind: 'metadata', metadata: { state: 'suppressed', becauses } };
        case 'structured-data':
          return { ...base, kind: 'structured-data', jsonLd: { state: 'suppressed', becauses } };
        case 'document-guarantees':
          return {
            ...base,
            kind: 'document-guarantees',
            guarantees: { state: 'suppressed', becauses },
          };
      }
    }

    switch (group.kind) {
      case 'metadata':
        return {
          ...base,
          kind: 'metadata',
          metadata: { state: 'stated', value: resolveMetadata(group, stated) },
        };
      case 'structured-data': {
        // One object, not a deep merge: two descriptions are the same
        // organisation or different ones, and there is no third answer that
        // does not involve assembling one nobody wrote.
        const claims: Claim[] = stated.map((entry) => ({
          owner: entry.contribution.owner,
          reason: entry.contribution.reason,
          value: entry.value,
        }));
        const resolved = agree('structured-data', undefined, group.scope, claims);
        return {
          ...base,
          kind: 'structured-data',
          jsonLd: { state: 'stated', value: resolved.value as OrganizationContract },
        };
      }
      case 'document-guarantees': {
        // One contract, for the same reason plus one: a guarantee is a promise
        // about generated output, and unioning promises from separate owners
        // would assert something nobody verified.
        const claims: Claim[] = stated.map((entry) => ({
          owner: entry.contribution.owner,
          reason: entry.contribution.reason,
          value: entry.value,
        }));
        const resolved = agree('document-guarantees', undefined, group.scope, claims);
        return {
          ...base,
          kind: 'document-guarantees',
          guarantees: { state: 'stated', value: resolved.value as AccessibilityContract },
        };
      }
    }
  });
}
