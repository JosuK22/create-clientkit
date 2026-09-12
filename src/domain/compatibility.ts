import type { AdapterDeclaration } from './adapters.js';
import { adapterRef } from './adapters.js';
import type { Capability, Constraint } from './capabilities.js';
import { describeConstraint } from './capabilities.js';

/**
 * The compatibility engine.
 *
 * Answers one question: given a set of adapter declarations, is the combination
 * satisfiable, and if not, precisely why. It never looks at an adapter id to
 * decide - every judgement comes from `provides` and `requires`, which is what
 * keeps the cost of adding a framework at "write the adapter" rather than
 * "revisit every other adapter".
 *
 * Pure by construction: declarations in, data out. No filesystem, no registry,
 * no adapter instances, no clock, no mutation. That is also what lets the whole
 * engine be tested against hypothetical declarations, which is the only honest
 * way to prove it generalises while exactly one framework is implemented.
 */

// ---------------------------------------------------------------------------
// Capability index
// ---------------------------------------------------------------------------

/**
 * Every capability the combination provides, and who provides it.
 *
 * Provenance is not decoration. It is what lets a conflict say "css-framework
 * is already provided by styling:bootstrap" instead of "conflict", and it is
 * what makes self-exclusion possible (see `evaluateDeclaration`).
 */
export interface CapabilityIndex {
  readonly capabilities: ReadonlySet<Capability>;
  readonly providers: ReadonlyMap<Capability, readonly string[]>;
}

export function indexCapabilities(declarations: readonly AdapterDeclaration[]): CapabilityIndex {
  const providers = new Map<Capability, string[]>();
  for (const declaration of declarations) {
    const ref = adapterRef(declaration);
    for (const capability of declaration.provides) {
      const existing = providers.get(capability);
      if (existing) existing.push(ref);
      else providers.set(capability, [ref]);
    }
  }
  // Sorted so a report never depends on the order declarations arrived in.
  for (const list of providers.values()) list.sort();
  return { capabilities: new Set(providers.keys()), providers };
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

export type Violation =
  | {
      readonly kind: 'missing-capability';
      readonly adapter: string;
      readonly displayName: string;
      readonly constraint: Constraint;
      /** Capabilities the constraint asked for that nothing provides. */
      readonly missing: readonly Capability[];
    }
  | {
      readonly kind: 'conflicting-capability';
      readonly adapter: string;
      readonly displayName: string;
      readonly constraint: Constraint;
      readonly capability: Capability;
      /** Who provides the capability this adapter cannot tolerate. */
      readonly providedBy: readonly string[];
    };

export interface CompatibilityReport {
  readonly compatible: boolean;
  readonly index: CapabilityIndex;
  readonly violations: readonly Violation[];
}

/**
 * Evaluates one declaration's constraints against the combination it sits in.
 *
 * A `conflicts` constraint deliberately ignores the declaration's own
 * contribution. Bootstrap provides `css-framework` *and* refuses to sit
 * alongside another one; without excluding itself it would reject every
 * combination including the one where it is the only CSS framework present.
 * `requires` has no such subtlety - an adapter satisfying its own requirement
 * is fine and occasionally useful.
 */
export function evaluateDeclaration(
  declaration: AdapterDeclaration,
  index: CapabilityIndex,
): readonly Violation[] {
  const ref = adapterRef(declaration);
  const violations: Violation[] = [];

  const othersProviding = (capability: Capability): readonly string[] =>
    (index.providers.get(capability) ?? []).filter((owner) => owner !== ref);

  for (const constraint of declaration.requires) {
    switch (constraint.kind) {
      case 'requires': {
        if (!index.capabilities.has(constraint.capability)) {
          violations.push({
            kind: 'missing-capability',
            adapter: ref,
            displayName: declaration.displayName,
            constraint,
            missing: [constraint.capability],
          });
        }
        break;
      }
      case 'requiresOneOf': {
        const satisfied = constraint.capabilities.some((capability) =>
          index.capabilities.has(capability),
        );
        if (!satisfied) {
          violations.push({
            kind: 'missing-capability',
            adapter: ref,
            displayName: declaration.displayName,
            constraint,
            missing: [...constraint.capabilities],
          });
        }
        break;
      }
      case 'conflicts': {
        const providedBy = othersProviding(constraint.capability);
        if (providedBy.length > 0) {
          violations.push({
            kind: 'conflicting-capability',
            adapter: ref,
            displayName: declaration.displayName,
            constraint,
            capability: constraint.capability,
            providedBy,
          });
        }
        break;
      }
    }
  }

  return violations;
}

/**
 * Evaluates a whole combination.
 *
 * Every declaration is checked against the union of what all of them provide,
 * so a chain resolves without needing an order: if A provides X, B requires X
 * and provides Y, and C requires Y, the union contains X and Y and all three
 * pass. Nothing here knows that chain exists.
 */
export function evaluateCombination(
  declarations: readonly AdapterDeclaration[],
): CompatibilityReport {
  const index = indexCapabilities(declarations);
  const violations = declarations
    .flatMap((declaration) => evaluateDeclaration(declaration, index))
    // Stable regardless of the order declarations were passed in.
    .sort((a, b) => a.adapter.localeCompare(b.adapter));

  return { compatible: violations.length === 0, index, violations };
}

// ---------------------------------------------------------------------------
// Filtering a dimension's choices
// ---------------------------------------------------------------------------

export interface Candidate<T> {
  readonly value: T;
  readonly declaration: AdapterDeclaration;
}

export interface FilterResult<T> {
  readonly eligible: readonly T[];
  readonly rejected: readonly { readonly value: T; readonly violations: readonly Violation[] }[];
}

/**
 * Which options for one dimension still work, given what is already selected.
 *
 * This is what a prompt would render, and it is the operation that makes the
 * design's central claim concrete: choosing Chakra narrows the framework list
 * to the ones providing a React runtime, without any rule mentioning Chakra and
 * a framework together. Each candidate is tried in the combination it would
 * create, and the whole combination is judged - not just the candidate - so an
 * option that would break something already chosen is rejected too.
 */
export function filterCandidates<T>(
  candidates: readonly Candidate<T>[],
  selected: readonly AdapterDeclaration[],
): FilterResult<T> {
  const eligible: T[] = [];
  const rejected: { value: T; violations: readonly Violation[] }[] = [];

  for (const candidate of candidates) {
    const report = evaluateCombination([...selected, candidate.declaration]);
    if (report.compatible) eligible.push(candidate.value);
    else rejected.push({ value: candidate.value, violations: report.violations });
  }

  return { eligible, rejected };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * One violation as a sentence for a user.
 *
 * Built from the constraint's own `because`, which is why that field is
 * mandatory: a constraint cannot exist without someone having written the
 * reason it will be explained by.
 */
export function formatViolation(violation: Violation): string {
  if (violation.kind === 'conflicting-capability') {
    return (
      `${violation.displayName} ${describeConstraint(violation.constraint)}, ` +
      `which ${violation.providedBy.join(' and ')} provides.`
    );
  }
  return `${violation.displayName} ${describeConstraint(violation.constraint)}.`;
}

/**
 * The whole report as user-facing text.
 *
 * Deliberately restrained: the violation sentences, then what the combination
 * does provide. No object dumps, no internal structures, no paths. The
 * structured `CompatibilityReport` stays available for anything that needs to
 * reason about the failure rather than read it.
 */
export function formatReport(report: CompatibilityReport): string {
  if (report.compatible) return 'Compatible.';

  const lines = report.violations.map((violation) => `  - ${formatViolation(violation)}`);
  const available = [...report.index.capabilities].sort();
  return [
    ...lines,
    '',
    `  The selected stack provides: ${available.length === 0 ? '(nothing)' : available.join(', ')}.`,
  ].join('\n');
}
