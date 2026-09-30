/**
 * The one ordering for anything that reaches generated output, a plan, or a
 * message: a collator pinned to `en`.
 *
 * Never a bare `localeCompare` or a default `Intl.Collator`. Those take the
 * runtime's locale, so the same inputs could order differently on a machine
 * configured for Turkish or Swedish - and an order that decides which
 * contribution merges last decides what a generated file contains. `en` is
 * also the one locale a small-ICU Node build is guaranteed to carry.
 *
 * Plain `.sort()` with no comparator is also deterministic - it compares UTF-16
 * code units - and is fine where no human reads the order. This is for the
 * places where one does, and where it has always matched the `en` order the
 * golden snapshots were recorded in.
 */
const COLLATOR = new Intl.Collator('en');

export function compareText(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}
