import path from 'node:path';

import { realCompareFs, type CompareFs, type PlanComparison } from './compare.js';
import { diffText, type TextDiff } from './diff.js';
import { comparePlanPaths, type GenerationPlan } from './files.js';
import { PROVENANCE_FILE } from './provenance.js';

/**
 * The change analysis: how a Generation Plan relates to a project already on
 * disk, file by file, as data.
 *
 * ## Three things, kept apart
 *
 *   - the **Generation Plan** says what ClientKit intends to write;
 *   - the **change analysis** (this module) says what each intended file would
 *     do to the project as it is - built on `comparePlan`, which is the one
 *     place a planned file is compared with the disk;
 *   - the **diff** is a rendering of the analysis for a person.
 *
 * The preview and the run both read the analysis, so what `--dry-run` shows is
 * what a run then writes.
 *
 * ## The kinds, and the rule behind each
 *
 *   create     the file does not exist, and the project never had it - new to
 *              this configuration, or the project is new.
 *   restore    the file does not exist, but the configuration the project
 *              records generated it: it was removed, and is put back.
 *   modify     the file exists, differs, and is ClientKit's own to rewrite
 *              without asking. Only `.client-site.json` is ever this.
 *   conflict   the file exists and differs. It may be the developer's edit -
 *              ClientKit cannot tell - so only a person may replace it.
 *   unchanged  the file is already exactly as planned. Never written.
 *
 * What a run then does with them - write, or skip - is `outcomeOf`.
 */

export type ChangeKind = 'create' | 'restore' | 'modify' | 'conflict' | 'unchanged';

/** The one order changes are listed in, everywhere. */
export const CHANGE_ORDER: readonly ChangeKind[] = [
  'create',
  'restore',
  'modify',
  'conflict',
  'unchanged',
];

export interface FileChange {
  readonly kind: ChangeKind;
  readonly path: string;
  /** A copied file, compared as bytes and never diffed as text. */
  readonly binary: boolean;
  /** Why it has this kind, in a sentence. */
  readonly reason: string;
  /** For a text file that exists and differs, when asked for. */
  readonly diff?: TextDiff;
}

export interface ChangeSet {
  /** Every planned file, in `CHANGE_ORDER`, then by path. */
  readonly changes: readonly FileChange[];
  readonly counts: Readonly<Record<ChangeKind, number>>;
  /** Nothing would be written. */
  readonly upToDate: boolean;
}

export interface AnalyzeOptions {
  /**
   * Everything the configuration the project records generates. With it, a
   * missing file is a restore when the project had it; without it, every
   * missing file is a create.
   */
  readonly previousPaths?: ReadonlySet<string>;
  /** Attach a text diff to every existing file that differs. */
  readonly withDiff?: boolean;
  readonly fs?: CompareFs;
}

/** The record's own decision: it changes when what it records does, or when anything else is written. */
function recordKind(comparison: PlanComparison, otherWrites: boolean): ChangeKind {
  if (comparison.missing.includes(PROVENANCE_FILE)) return 'create';
  if (comparison.differs.includes(PROVENANCE_FILE) || otherWrites) return 'modify';
  return 'unchanged';
}

export function analyzeChanges(
  plan: GenerationPlan,
  comparison: PlanComparison,
  options: AnalyzeOptions = {},
): ChangeSet {
  const fs = options.fs ?? realCompareFs;
  const missing = new Set(comparison.missing);
  const differs = new Set(comparison.differs);
  const isRecord = (entry: string) => entry === PROVENANCE_FILE;
  const otherWrites =
    comparison.missing.some((entry) => !isRecord(entry)) ||
    comparison.differs.some((entry) => !isRecord(entry));

  const changes: FileChange[] = plan.operations.map((operation) => {
    const binary = operation.type === 'copy';
    const at = { path: operation.path, binary };

    if (isRecord(operation.path)) {
      const kind = recordKind(comparison, otherWrites);
      const reason =
        kind === 'create'
          ? 'ClientKit’s record of this project is missing'
          : kind === 'modify'
            ? 'ClientKit’s record is rewritten whenever the project is'
            : 'ClientKit’s record already describes this project';
      return { ...at, kind, reason };
    }

    if (missing.has(operation.path)) {
      return options.previousPaths?.has(operation.path) === true
        ? { ...at, kind: 'restore', reason: 'generated for this project before, and now missing' }
        : { ...at, kind: 'create', reason: 'not in the project yet' };
    }

    if (!differs.has(operation.path)) {
      return { ...at, kind: 'unchanged', reason: 'already exactly as planned' };
    }

    const conflict: FileChange = {
      ...at,
      kind: 'conflict',
      reason: binary
        ? 'a binary file that differs from the one ClientKit would copy'
        : 'differs from what ClientKit would write now - possibly your edit',
    };
    if (binary || options.withDiff !== true || operation.type !== 'write') return conflict;
    const target = path.join(plan.targetDir, ...operation.path.split('/'));
    const current = fs.read(target).toString('utf8');
    return { ...conflict, diff: diffText(current, operation.content) };
  });

  const rank = (kind: ChangeKind) => CHANGE_ORDER.indexOf(kind);
  changes.sort((a, b) => rank(a.kind) - rank(b.kind) || comparePlanPaths(a.path, b.path));

  const counts = Object.fromEntries(
    CHANGE_ORDER.map((kind) => [kind, changes.filter((change) => change.kind === kind).length]),
  ) as Record<ChangeKind, number>;

  return { changes, counts, upToDate: changes.every((change) => change.kind === 'unchanged') };
}

/**
 * Every planned file as a new project sees it: nothing exists, so everything
 * is created. The same model as a re-run, so one renderer serves both.
 */
export function analyzeNewProject(plan: GenerationPlan): ChangeSet {
  return analyzeChanges(plan, {
    missing: plan.operations.map((operation) => operation.path),
    unchanged: [],
    differs: [],
  });
}

export interface ChangeOutcome {
  /** Paths the run writes, in `CHANGE_ORDER`. */
  readonly write: readonly string[];
  /** Planned changes the run does not make: conflicts nobody agreed to, and all else alongside. */
  readonly skip: readonly string[];
  /** The run stops and writes nothing because a conflict has no answer. */
  readonly blocked: boolean;
}

/**
 * What a run does with an analysis.
 *
 * Unchanged files are never written. Everything else is written - unless a
 * conflict is not agreed to, and then nothing is: a run never applies half of
 * what it showed. That is what `--yes` and a missing terminal mean, and what a
 * person's "no" means.
 */
export function outcomeOf(set: ChangeSet, conflictsAgreed: boolean): ChangeOutcome {
  const pending = set.changes.filter((change) => change.kind !== 'unchanged').map((c) => c.path);
  const blocked = set.counts.conflict > 0 && !conflictsAgreed;
  return blocked ? { write: [], skip: pending, blocked } : { write: pending, skip: [], blocked };
}
