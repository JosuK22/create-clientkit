import type { AdapterDeclaration } from './adapters.js';
import { adapterRef } from './adapters.js';
import type { Capability, Constraint } from './capabilities.js';
import { describeConstraint } from './capabilities.js';
import { CliError, EXIT_USAGE } from '../errors.js';
import { compareText } from '../util/order.js';

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
    .sort((a, b) => compareText(a.adapter, b.adapter));

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

// ---------------------------------------------------------------------------
// The canonical result
// ---------------------------------------------------------------------------

/**
 * What a compatibility evaluation concluded, as one word.
 *
 * Listed root-first. A stack with an invalid word is not judged further, so it
 * is `invalid` whatever else might be wrong with it; one whose words are all
 * known but name something ClientKit does not implement is `unsupported`; only
 * a stack whose every piece exists can be `incompatible`.
 *
 *   - `invalid`: a word the domain does not know, or a malformed list.
 *   - `unknown`: there was not enough to go on - a project with no framework
 *     ClientKit could identify.
 *   - `ambiguous`: more than one answer fits and nothing decides between them.
 *   - `unsupported`: a known id that no adapter or template implements.
 *   - `incompatible`: every piece exists, and they cannot be built together.
 */
export const COMPATIBILITY_STATUSES = [
  'invalid',
  'unknown',
  'ambiguous',
  'unsupported',
  'incompatible',
] as const;

export type CompatibilityStatus = 'compatible' | (typeof COMPATIBILITY_STATUSES)[number];

/**
 * Every issue code, and the status it implies. Machine-readable and stable:
 * a code is never renamed or reused, only added. The order here is the order
 * issues of equal status are reported in.
 *
 * The code says what kind of rule failed; `field` says which dimension it is
 * about. `framework-offers` on `buildTool` is "this framework does not offer
 * that build tool" - one rule, applied to four dimensions.
 */
export const COMPATIBILITY_CODES = {
  /** A value that is not a known id for its dimension. */
  'invalid-value': 'invalid',
  /** A feature list with an empty entry, a duplicate, or a starter in it. */
  'invalid-features': 'invalid',
  /** No framework could be identified (detection only). */
  'framework-undetermined': 'unknown',
  /** More than one framework, or value for a dimension, fits (detection only). */
  'ambiguous-value': 'ambiguous',
  /** A known id with no adapter behind it, or a technology ClientKit does not know. */
  'unsupported-value': 'unsupported',
  /** The framework fixes, or does not offer, this build tool / language / router / architecture. */
  'framework-offers': 'incompatible',
  /** An adapter requires a capability nothing selected provides. */
  'capability-missing': 'incompatible',
  /** An adapter cannot sit beside a capability another selected adapter provides. */
  'capability-conflict': 'incompatible',
  /** A template named for a stack whose framework it is not for. */
  'template-framework': 'incompatible',
  /** A template that does not offer the requested mode. */
  'template-mode': 'incompatible',
} as const satisfies Record<string, (typeof COMPATIBILITY_STATUSES)[number]>;

export type CompatibilityCode = keyof typeof COMPATIBILITY_CODES;

/** What an issue is about: a stack dimension, or the template and its mode. */
export const COMPATIBILITY_FIELDS = [
  'framework',
  'buildTool',
  'language',
  'styling',
  'uiLibrary',
  'router',
  'architecture',
  'features',
  'template',
  'mode',
] as const;

export type CompatibilityField = (typeof COMPATIBILITY_FIELDS)[number];

/**
 * One reason a combination cannot be generated.
 *
 * Plain data: no colour, no terminal width, nothing that assumes a CLI. The
 * message and hint are sentences a person can act on, and they are the exact
 * sentences the CLI has always printed for the same problem.
 */
export interface CompatibilityIssue {
  readonly code: CompatibilityCode;
  readonly field: CompatibilityField;
  readonly message: string;
  readonly hint?: string;
  /** The value that was asked for, when there is one. */
  readonly actual?: string;
  /** What would have been accepted, when that is a short list. */
  readonly expected?: readonly string[];
  /** For a capability issue: the adapter (`<kind>:<id>`) whose constraint failed. */
  readonly adapter?: string;
}

export interface CompatibilityResult {
  readonly status: CompatibilityStatus;
  readonly compatible: boolean;
  /** Every issue found, in canonical order. Empty exactly when compatible. */
  readonly issues: readonly CompatibilityIssue[];
}

const STATUS_RANK = new Map<string, number>(
  COMPATIBILITY_STATUSES.map((status, index) => [status, index]),
);
const CODE_RANK = new Map<string, number>(
  Object.keys(COMPATIBILITY_CODES).map((code, index) => [code, index]),
);
const FIELD_RANK = new Map<string, number>(
  COMPATIBILITY_FIELDS.map((field, index) => [field, index]),
);

export function statusOf(issue: CompatibilityIssue): (typeof COMPATIBILITY_STATUSES)[number] {
  return COMPATIBILITY_CODES[issue.code];
}

/**
 * The canonical order: status, root-first; then code; then field; then the
 * adapter and the message, by the pinned collator. Independent of the order
 * rules ran in or issues were found, so two evaluations of the same stack
 * always list the same issues in the same order.
 */
export function compareIssues(a: CompatibilityIssue, b: CompatibilityIssue): number {
  return (
    (STATUS_RANK.get(statusOf(a)) ?? 0) - (STATUS_RANK.get(statusOf(b)) ?? 0) ||
    (CODE_RANK.get(a.code) ?? 0) - (CODE_RANK.get(b.code) ?? 0) ||
    (FIELD_RANK.get(a.field) ?? 0) - (FIELD_RANK.get(b.field) ?? 0) ||
    compareText(a.adapter ?? '', b.adapter ?? '') ||
    compareText(a.message, b.message)
  );
}

/** Builds a result from issues found in any order. Never mutates its input. */
export function compatibilityResult(issues: readonly CompatibilityIssue[]): CompatibilityResult {
  const ordered = [...issues].sort(compareIssues);
  const first = ordered[0];
  return {
    status: first === undefined ? 'compatible' : statusOf(first),
    compatible: first === undefined,
    issues: ordered,
  };
}

/** The dimension an adapter kind speaks for. */
const FIELD_OF_KIND: Readonly<Record<string, CompatibilityField>> = {
  framework: 'framework',
  'build-tool': 'buildTool',
  language: 'language',
  styling: 'styling',
  'ui-library': 'uiLibrary',
  router: 'router',
  architecture: 'architecture',
  feature: 'features',
};

/**
 * The capability engine's report, as issues. One issue per violation, with
 * the same sentence `formatViolation` has always produced.
 */
export function issuesFromReport(report: CompatibilityReport): CompatibilityIssue[] {
  return report.violations.map((violation): CompatibilityIssue => {
    const [kind = '', id = ''] = violation.adapter.split(':');
    const common = {
      field: FIELD_OF_KIND[kind] ?? 'framework',
      message: formatViolation(violation),
      actual: id,
      adapter: violation.adapter,
    } as const;
    return violation.kind === 'missing-capability'
      ? { code: 'capability-missing', ...common, expected: [...violation.missing] }
      : { code: 'capability-conflict', ...common, expected: [violation.capability] };
  });
}

/**
 * The error the CLI raises for a result, with the message, hint and exit code
 * it has always raised for that problem. `undefined` when compatible.
 *
 * The first issue speaks for the result, except that capability issues are
 * reported together, as they always were: "That combination will not work."
 * with every violation in the hint.
 */
export function compatibilityError(
  result: CompatibilityResult,
  report?: CompatibilityReport,
): CliError | undefined {
  const [first] = result.issues;
  if (first === undefined) return undefined;
  if (report !== undefined && !report.compatible && first.code.startsWith('capability-')) {
    return new CliError('That combination will not work.', { hint: formatReport(report) });
  }
  return issueError(first);
}

/** One issue as the CLI's error. A wrong word or a framework's refusal is a usage error. */
export function issueError(issue: CompatibilityIssue): CliError {
  const usage =
    issue.code === 'invalid-value' ||
    issue.code === 'invalid-features' ||
    issue.code === 'framework-offers';
  return new CliError(issue.message, {
    ...(usage ? { exitCode: EXIT_USAGE } : {}),
    ...(issue.hint === undefined ? {} : { hint: issue.hint }),
  });
}
