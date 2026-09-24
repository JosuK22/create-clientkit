/**
 * The set arithmetic an upgrade rests on, and nothing else.
 *
 * ## What this answers
 *
 * Given the paths the recorded configuration generates and the paths the
 * current one generates, which are in both, which are new, and which the
 * current configuration no longer produces.
 *
 * That is the whole of it. The module is deliberately small, because the hard
 * part of an upgrade was never the arithmetic - it was deciding what the
 * arithmetic is allowed to mean, which Stages 55 to 62 settled.
 *
 * ## Path membership is not file ownership
 *
 * The distinction Stage 61 drew, and the reason `orphanCandidates` is named
 * the way it is. This layer can say:
 *
 * > this path was produced by the recorded configuration and is not produced
 * > by the current one
 *
 * It cannot say the file is ClientKit's, that it is safe to delete, or that
 * the developer has not rewritten it. Those need evidence this layer does not
 * have and deliberately never acquires: it sees two lists of strings, not a
 * project. `AppProviders.tsx` is exactly the kind of file someone edits, which
 * is why an orphan is a *candidate* and why ClientKit does not delete.
 *
 * ## Both sides come from today's templates
 *
 * Stage 61 chose current-template reconciliation: ClientKit keeps no
 * historical template bytes, so the recorded *stack and mode* are rendered
 * against the templates this build ships. Path differences are therefore
 * attributable to the configuration changing, never to ClientKit's templates
 * having changed between releases - which this cannot detect and does not
 * claim to.
 *
 * The inputs are plain strings so that nothing here can reach a filesystem,
 * a plan, or a template. It is pure in the strong sense: two lists in, one
 * verdict out.
 */

/**
 * What an upgrade would do to the file list, before anyone decides anything.
 *
 * Every array is deduplicated and sorted, so the same pair of inputs always
 * serialises identically - a property tests assert rather than assume, since a
 * plan that reorders between runs would make review meaningless.
 *
 * There is deliberately no field implying permission. No `deletable`, no
 * `owned`, no `safeToRemove`: naming one would invite a later stage to act on
 * it, and the evidence for it does not exist.
 */
export interface UpgradePathPlan {
  /** Everything the recorded configuration generates. */
  readonly oldPaths: readonly string[];
  /** Everything the current configuration generates. */
  readonly currentPaths: readonly string[];
  /** In both. `old ∩ current`. */
  readonly unchanged: readonly string[];
  /** Only in the current plan. `current - old`. */
  readonly added: readonly string[];
  /**
   * Only in the old plan. `old - current`.
   *
   * Paths the recorded configuration produced that the current one does not.
   * A candidate for a developer's attention, never for ClientKit's deletion.
   */
  readonly orphanCandidates: readonly string[];
}

/**
 * Sorted, deduplicated, and independent of where the strings came from.
 *
 * `Array.prototype.sort` without a comparator orders by UTF-16 code unit,
 * which is the same on every platform and in every locale. `localeCompare`
 * would not be: it can reorder under a different ICU build, and a file list
 * that reorders by machine is not a plan anyone can review.
 */
function canonical(paths: Iterable<string>): readonly string[] {
  return [...new Set(paths)].sort();
}

/**
 * Classifies two plan-derived path sets.
 *
 * Takes strings rather than plans on purpose. A `GenerationPlan` carries
 * content, origins and a target directory, none of which this decision may
 * depend on, and accepting one would make it possible for it to start
 * depending on them.
 *
 * Duplicate operations targeting one path collapse to one entry: a path set is
 * a set, and layering the same path twice is composition working rather than
 * two files. Whether a repeated path is legitimate layering or a collision is
 * the existing planner's question, settled before this is ever called.
 */
export function planUpgradePaths(
  oldPaths: Iterable<string>,
  currentPaths: Iterable<string>,
): UpgradePathPlan {
  const oldSet = canonical(oldPaths);
  const currentSet = canonical(currentPaths);
  const inOld = new Set(oldSet);
  const inCurrent = new Set(currentSet);

  return {
    oldPaths: oldSet,
    currentPaths: currentSet,
    unchanged: oldSet.filter((path) => inCurrent.has(path)),
    added: currentSet.filter((path) => !inOld.has(path)),
    orphanCandidates: oldSet.filter((path) => !inCurrent.has(path)),
  };
}
