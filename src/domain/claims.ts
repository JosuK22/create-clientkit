import type { ConfigContribution } from './contributions.js';
import type { FileRole } from './roles.js';
import { CliError } from '../errors.js';

/**
 * Reading a slot that several adapters may describe.
 *
 * ## Why this is shared
 *
 * Stage 9 gave the SEO feature a way to describe the document head and refused
 * two adapters describing it differently. Stage 10 needed exactly the same rule
 * for structured data, at the same role and a different slot, so the rule moved
 * here rather than being written twice. Two near-identical collectors would
 * drift, and the one that drifted would be the one nobody was looking at.
 *
 * ## The rule
 *
 * Identical claims are cooperation: they de-duplicate to one description and
 * every claimant is kept, because "why is this in my project?" has as many
 * answers as there were adapters. Differing claims are a conflict, because
 * there is one document head and picking a winner silently is how a site ends
 * up describing itself in a way nobody chose.
 *
 * Addressed by role and slot rather than by adapter, so a feature nobody has
 * written yet works with no change here.
 */

/** One adapter's claim on a slot, with who made it and why. */
export interface Claim<T> {
  readonly owner: string;
  readonly reason: string;
  readonly value: T;
}

/** The first field on which two claims differ, for a diagnostic that names it. */
function firstDifference(
  left: unknown,
  right: unknown,
): { readonly field: string; readonly left: unknown; readonly right: unknown } | undefined {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  if (!isObject(left) || !isObject(right)) {
    return JSON.stringify(left) === JSON.stringify(right)
      ? undefined
      : { field: '(value)', left, right };
  }

  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
      return { field: key, left: left[key], right: right[key] };
    }
  }
  return undefined;
}

const show = (value: unknown): string => (value === undefined ? '(absent)' : JSON.stringify(value));

/**
 * Collects every claim on one role and slot, or refuses.
 *
 * Sorted by owner, so the result never depends on the order adapters were
 * selected in. The conflict names the field that differs and both values, since
 * "two adapters disagree" without saying about what is a diagnostic nobody can
 * act on.
 */
export function collectClaims<T>(
  contributions: readonly ConfigContribution[],
  role: FileRole,
  slot: string,
): Claim<T>[] {
  const claims = contributions
    .filter((entry) => entry.target === role && entry.at === slot)
    .map((entry) => ({
      owner: entry.owner,
      reason: entry.reason,
      value: entry.value as T,
    }))
    .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));

  for (let index = 1; index < claims.length; index += 1) {
    const first = claims[0];
    const other = claims[index];
    if (first === undefined || other === undefined) continue;

    const difference = firstDifference(first.value, other.value);
    if (difference === undefined) continue;

    throw new CliError(`Two adapters describe "${slot}" differently.`, {
      hint:
        `They disagree about "${difference.field}":\n` +
        `  ${first.owner}\n    ${difference.field}: ${show(difference.left)}\n    reason: ${first.reason}\n` +
        `  ${other.owner}\n    ${difference.field}: ${show(difference.right)}\n    reason: ${other.reason}\n` +
        'Exactly one description of this slot can be correct.',
    });
  }

  return claims;
}
