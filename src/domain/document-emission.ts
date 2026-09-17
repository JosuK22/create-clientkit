import type { DocumentValue } from './document-value.js';
import {
  bindingsUsedBy,
  derivationParameters,
  derivationType,
  isDocumentBinding,
  isDocumentDerivation,
} from './document-value.js';
import type { AnyDocumentValue, DocumentBinding, DocumentDerivation } from './document-value.js';
import type { DocumentTarget, ResolvedPageDocument } from './document-scope.js';
import { describeTarget } from './document-scope.js';
import type { MetadataField, Provenance } from './document-resolution.js';
import type { OrganizationContract } from './structured-data.js';
import { CliError } from '../errors.js';

/**
 * What a document emitter is handed, and what it is allowed to assume.
 *
 * ## The boundary this draws
 *
 *     ResolvedDocument  →  emission IR  →  architecture realization
 *
 * Everything to the left of the IR is semantics: Stages 31-33 decided what the
 * document says, which scope won, and who disagreed with whom. Everything to
 * the right is spelling: how one framework writes a title, where it puts a
 * canonical link. The IR exists so that neither side has to know the other.
 *
 * An emitter handed this does not repeat resolution. It never sees a
 * contribution, a scope, an owner's disagreement, a feature, a manifest or a
 * conflict - all of that is settled. It sees a list of document facts, in a
 * fixed order, each either stated or refused.
 *
 * ## What it deliberately is not
 *
 * Not markup. There is no `html`, no `markup`, no `source` and no `expression`
 * field anywhere below, and a test fails if one appears. An IR that carried a
 * string of source would have moved the framework back into the domain by the
 * shortest possible route.
 *
 * Not evaluated. A binding stays a binding and a derivation stays a derivation,
 * arguments intact. Turning `absolute-page-url` into an address here would
 * freeze a value the generated project owns, which is the failure Stage 34
 * stopped for and Stages 35-37 were spent making representable.
 */

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * Every document fact the IR can carry, in the order it carries them.
 *
 * A fixed literal, so two identical documents produce identical IR regardless
 * of how either was assembled. The order is semantic - what the document says
 * about itself, then how it says it socially, then what it tells a knowledge
 * graph - and it is **not** precedence. Nothing downstream may read position as
 * authority; arbitration finished before the IR existed.
 */
export const EMISSION_FIELDS = [
  'title',
  'description',
  'robots',
  'canonical',
  'open-graph',
  'twitter',
  'structured-data',
] as const;

export type EmissionField = (typeof EMISSION_FIELDS)[number];

/** The metadata fields, and the emission field each becomes. */
const METADATA_TO_EMISSION: Readonly<Record<MetadataField, EmissionField>> = {
  title: 'title',
  description: 'description',
  robots: 'robots',
  canonical: 'canonical',
  openGraph: 'open-graph',
  twitter: 'twitter',
};

/** The inverse, so the build can walk the vocabulary rather than the record. */
const EMISSION_TO_METADATA: Readonly<Partial<Record<EmissionField, MetadataField>>> =
  Object.fromEntries(
    Object.entries(METADATA_TO_EMISSION).map(([metadataField, emissionField]) => [
      emissionField,
      metadataField,
    ]),
  );

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * One document fact, stated or refused.
 *
 * Three states survive intact, as they have since Stage 31: **stated** is an
 * item carrying a value, **suppressed** is an item carrying reasons and no
 * value, and **absent** is no item at all. A suppression is not an item with an
 * empty value, and an absence is not a suppression - an emitter that could not
 * tell them apart would eventually fill a gap somebody deliberately refused.
 */
export type DocumentEmissionItem =
  | {
      readonly field: 'structured-data';
      readonly state: 'stated';
      /** Whole object, never merged and never flattened into metadata. */
      readonly organization: OrganizationContract;
      readonly provenance: Provenance;
    }
  | {
      readonly field: Exclude<EmissionField, 'structured-data'>;
      readonly state: 'stated';
      /** Unevaluated: a binding is still a binding, a derivation still derived. */
      readonly value: AnyDocumentValue;
      readonly provenance: Provenance;
    }
  | {
      readonly field: EmissionField;
      readonly state: 'suppressed';
      readonly becauses: readonly string[];
      readonly provenance: Provenance;
    };

/**
 * Everything one page's document emits, ready for an architecture to spell.
 *
 * Carries the target so a realization can say which page it failed on, and
 * nothing else about how the document was decided.
 */
export interface DocumentEmissionPlan {
  readonly target: DocumentTarget;
  readonly items: readonly DocumentEmissionItem[];
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

const EMPTY_PROVENANCE: Provenance = { owners: [], reasons: [] };

/**
 * Turns a resolved document into the facts an emitter must express.
 *
 * A projection, not a decision. Nothing is chosen here, nothing is merged and
 * nothing is computed - each resolved field becomes an item, suppression
 * becomes a suppressed item, and absence becomes nothing. The only judgement is
 * the order, which comes from `EMISSION_FIELDS`.
 *
 * Accessibility contributes no item, and the reason is worth stating. Its one
 * valued fact is the document's language, and the shipped Astro layout writes
 * that as `lang={SITE.locale}` - a *binding*. `AccessibilityContract` holds a
 * generation-time snapshot of the same value, so emitting it would freeze a
 * value the project owns, which is precisely the Stage 34 failure. Representing
 * it truthfully needs a binding-aware accessibility contract, which remains
 * deferred; the remaining guarantees are body structure and assertions about
 * the shell rather than values, and belong to a document-structure boundary
 * this stage does not build.
 */
export function buildDocumentEmission(document: ResolvedPageDocument): DocumentEmissionPlan {
  const items: DocumentEmissionItem[] = [];

  if (document.metadata !== undefined) {
    if (document.metadata.state === 'suppressed') {
      // The page refused to state metadata at all, so every metadata field is
      // refused - not absent, which an emitter would be free to fill in.
      for (const field of EMISSION_FIELDS) {
        if (field === 'structured-data') continue;
        items.push({
          field,
          state: 'suppressed',
          becauses: document.metadata.becauses,
          provenance: EMPTY_PROVENANCE,
        });
      }
    } else {
      const composed = document.metadata.value;
      /*
       * Walked in vocabulary order, not in the order `METADATA_TO_EMISSION`
       * happens to be written. An earlier draft iterated that record and then
       * sorted the result, which produced the right answer for the wrong
       * reason: the record's keys already matched, so the sort was unreachable
       * and the real ordering came from a `Record` literal's insertion order -
       * exactly the dependence this layer is supposed to avoid.
       */
      for (const field of EMISSION_FIELDS) {
        const metadataField = EMISSION_TO_METADATA[field];
        if (metadataField === undefined) continue;

        const value = composed.value[metadataField];
        // Nobody claimed it, so nothing is emitted for it.
        if (value === undefined) continue;
        const provenance = composed.provenance[metadataField];
        items.push({
          field: field as Exclude<EmissionField, 'structured-data'>,
          state: 'stated',
          value: value as AnyDocumentValue,
          provenance: {
            owners: provenance?.owners ?? [],
            reasons: provenance?.reasons ?? [],
          },
        });
      }
    }
  }

  if (document.structuredData !== undefined) {
    items.push(
      document.structuredData.state === 'suppressed'
        ? {
            field: 'structured-data',
            state: 'suppressed',
            becauses: document.structuredData.becauses,
            provenance: EMPTY_PROVENANCE,
          }
        : {
            field: 'structured-data',
            state: 'stated',
            organization: document.structuredData.value,
            provenance: EMPTY_PROVENANCE,
          },
    );
  }

  /*
   * No sort. Metadata items are pushed in vocabulary order above and the
   * organisation is appended last, which is where the vocabulary puts it - so
   * the order is a property of the walk rather than something re-imposed
   * afterwards. A sort here would be unreachable, and an unreachable guard is
   * one nobody can prove.
   */

  return { target: document.target, items };
}

// ---------------------------------------------------------------------------
// What a plan needs from an architecture
// ---------------------------------------------------------------------------

/** Every binding the plan's values refer to, sorted. */
export function bindingsRequiredBy(plan: DocumentEmissionPlan): readonly DocumentBinding[] {
  const used = plan.items.flatMap((item) =>
    item.state === 'stated' && item.field !== 'structured-data' ? bindingsUsedBy(item.value) : [],
  );
  return [...new Set(used)].sort();
}

/** Every derivation the plan's values use, including nested ones, sorted. */
export function derivationsRequiredBy(plan: DocumentEmissionPlan): readonly DocumentDerivation[] {
  const collect = (value: AnyDocumentValue): DocumentDerivation[] =>
    value.kind === 'derived'
      ? [value.derivation, ...value.inputs.flatMap((input) => collect(input))]
      : [];

  const used = plan.items.flatMap((item) =>
    item.state === 'stated' && item.field !== 'structured-data' ? collect(item.value) : [],
  );
  return [...new Set(used)].sort();
}

// ---------------------------------------------------------------------------
// The realization contract
// ---------------------------------------------------------------------------

/**
 * What one architecture can actually spell.
 *
 * An architecture declares the bindings and derivations it can realise, and is
 * held to it. There is no fallback anywhere in this file: substituting a
 * near-enough value emits a document that states something untrue and builds
 * without complaint, which is worse than refusing to build.
 *
 * Deliberately a declaration rather than a set of functions. Stage 38 defines
 * what a realization must understand; *how* it writes any of it is Stage 39's
 * problem, and putting a function here would be that stage arriving early.
 */
export interface RealizationSupport {
  /** Identifies the architecture in a diagnostic. Never branched on. */
  readonly architecture: string;
  readonly bindings: readonly DocumentBinding[];
  readonly derivations: readonly DocumentDerivation[];
}

/**
 * How deep a value may nest before the walk gives up.
 *
 * Stage 37 established that a cycle cannot be *constructed*: values are
 * immutable and assembled bottom-up, and `JSON.parse` cannot produce one
 * either. What remains is a value that reached here through an erased cast,
 * where a malformed structure would make an unbounded walk hang rather than
 * fail. A bound turns that into a named refusal for the cost of a counter, and
 * no honest document comes close to it - the deepest thing the vocabulary can
 * express today is two levels.
 */
const MAX_VALUE_DEPTH = 16;

function checkValue(
  value: AnyDocumentValue,
  support: RealizationSupport,
  field: EmissionField,
  depth: number,
): void {
  if (depth > MAX_VALUE_DEPTH) {
    throw new CliError(`The value for ${field} nests more than ${MAX_VALUE_DEPTH} levels deep.`, {
      hint: 'A document value this deep is malformed; nothing the vocabulary can express needs it.',
    });
  }

  switch (value.kind) {
    case 'literal':
      return;
    case 'binding': {
      if (!isDocumentBinding(value.binding)) {
        throw new CliError(`"${value.binding}" is not a binding this vocabulary knows.`, {
          hint: `Found in the value for ${field}.`,
        });
      }
      if (!support.bindings.includes(value.binding)) {
        throw new CliError(
          `"${support.architecture}" cannot supply ${value.binding}, which ${field} needs.`,
          {
            hint:
              'A document value may only refer to something the architecture can produce. ' +
              'There is no fallback: a near-enough value would emit a document that states ' +
              'something untrue and builds without complaint.',
          },
        );
      }
      return;
    }
    case 'derived': {
      if (!isDocumentDerivation(value.derivation)) {
        throw new CliError(`"${value.derivation}" is not a derivation this vocabulary knows.`, {
          hint: `Found in the value for ${field}.`,
        });
      }
      if (!support.derivations.includes(value.derivation)) {
        throw new CliError(
          `"${support.architecture}" cannot realise ${value.derivation}, which ${field} needs.`,
          {
            hint:
              `It is declared as (${derivationParameters(value.derivation).join(', ')}) -> ` +
              `${derivationType(value.derivation)}. An architecture that cannot perform the ` +
              'operation must say so rather than approximate it.',
          },
        );
      }

      const expected = derivationParameters(value.derivation);
      if (value.inputs.length !== expected.length) {
        throw new CliError(
          `"${value.derivation}" takes ${expected.length} input(s), not ${value.inputs.length}.`,
          { hint: `Found in the value for ${field}.` },
        );
      }
      expected.forEach((type, index) => {
        const input = value.inputs[index];
        if (input === undefined || input.type !== type) {
          throw new CliError(
            `"${value.derivation}" expects ${type} at position ${index}, found ${input?.type ?? 'nothing'}.`,
            { hint: `Found in the value for ${field}.` },
          );
        }
        checkValue(input, support, field, depth + 1);
      });
      return;
    }
  }
}

/**
 * Refuses a plan an architecture cannot spell.
 *
 * Names the field, the value, the architecture and the reason, so the refusal
 * says which capability is missing rather than that something went wrong. Runs
 * over the whole plan, so a document fails once with the first genuine problem
 * rather than partway through being written.
 */
export function assertPlanRealizable(
  plan: DocumentEmissionPlan,
  support: RealizationSupport,
): void {
  for (const item of plan.items) {
    if (item.state !== 'stated') continue;
    if (item.field === 'structured-data') continue;
    try {
      checkValue(item.value, support, item.field, 0);
    } catch (error) {
      const cli = error as CliError;
      throw new CliError(cli.message, {
        hint: `${cli.hint ?? ''}\n  While preparing ${describeTarget(plan.target)}.`.trim(),
      });
    }
  }
}

/** A stable rendering of a plan, for tests and diagnostics. */
export function describeEmissionPlan(plan: DocumentEmissionPlan): string {
  const lines = plan.items.map((item) =>
    item.state === 'suppressed'
      ? `${item.field}: suppressed`
      : item.field === 'structured-data'
        ? `${item.field}: ${item.organization['@type']}`
        : `${item.field}: ${item.value.kind}`,
  );
  return [describeTarget(plan.target), ...lines].join('\n');
}

/** Narrowing helper: the value of a stated, non-structured-data item. */
export function statedValue(
  item: DocumentEmissionItem,
): DocumentValue<never> | AnyDocumentValue | undefined {
  return item.state === 'stated' && item.field !== 'structured-data' ? item.value : undefined;
}
