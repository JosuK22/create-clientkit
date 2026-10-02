import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { planUpgrade, type RecordedConfiguration } from '../adapters/upgrade-plan.js';
import type { ProjectManifest } from '../domain/manifest.js';
import { readProvenance, PROVENANCE_DOCUMENT } from '../domain/provenance-reader.js';
import { analyzeChanges, outcomeOf, type ChangeKind, type ChangeSet } from '../generate/changes.js';
import {
  comparePlan,
  narrowPlan,
  realCompareFs,
  type CompareFs,
  type PlanComparison,
  type TargetObservation,
} from '../generate/compare.js';
import type { GenerationPlan } from '../generate/files.js';
import type { PostStep } from '../templates/manifest.js';

/**
 * Running ClientKit again on a project it generated.
 *
 * ## Which directories take part
 *
 * Only one whose `.client-site.json` the provenance reader - the one `upgrade`
 * already trusts - accepts as a usable record. Anything else with content in it
 * is `unrecognised`, including a record that is malformed, from a newer
 * ClientKit, or records no stack: ownership cannot be established, so the
 * existing non-empty-directory rules apply to it exactly as before.
 *
 * ## What a re-run writes
 *
 * The Generation Plan is the expected state; `comparePlan` sorts each planned
 * file into missing, unchanged or different. Then:
 *
 *   - **unchanged** is never written. A re-run of the same configuration writes
 *     nothing at all.
 *   - **missing** is written: ClientKit planned it, it is not there, and
 *     writing it overwrites nothing.
 *   - **different** is a conflict. Without a record of the bytes ClientKit once
 *     wrote, a developer's edit and a file from another configuration or
 *     release look identical, so only a person may overwrite it.
 *   - **`.client-site.json`** is ClientKit's own record, never a conflict. It is
 *     written when it is missing, when what it records changes, or when any
 *     other file is written - and left alone otherwise.
 *
 * Nothing is deleted, and files the plan does not name are never read.
 */

export type TargetState =
  | { readonly kind: 'new' }
  | { readonly kind: 'empty' }
  /**
   * A usable ClientKit record: this directory may be regenerated idempotently.
   * `recorded` is the configuration it records, as `upgrade` reads it.
   */
  | { readonly kind: 'clientkit'; readonly recorded: RecordedConfiguration }
  /** Content, and no record ClientKit can use. `because` says why, when there is a record. */
  | { readonly kind: 'unrecognised'; readonly because?: string };

export function inspectTarget(
  targetDir: string,
  cliVersion: string,
  readFile: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): TargetState {
  if (!existsSync(targetDir)) return { kind: 'new' };
  let entries: string[];
  try {
    entries = readdirSync(targetDir).filter((entry) => entry !== '.git');
  } catch {
    return { kind: 'unrecognised' };
  }
  if (entries.length === 0) return { kind: 'empty' };

  const read = readProvenance(targetDir, readFile, cliVersion);
  if (read.status === 'usable') {
    return {
      kind: 'clientkit',
      recorded: {
        stack: read.stack,
        mode: read.document.mode,
        template: { id: read.document.template.id, framework: read.document.template.framework },
      },
    };
  }
  if (read.status === 'missing') return { kind: 'unrecognised' };
  const because =
    read.status === 'unsupported'
      ? `its ${PROVENANCE_DOCUMENT} was written by a newer ClientKit (${read.recordedVersion})`
      : `its ${PROVENANCE_DOCUMENT} is not a usable ClientKit record: ${read.because}`;
  return { kind: 'unrecognised', because };
}

export interface Regeneration {
  readonly comparison: PlanComparison;
  /**
   * The change analysis (Stage 8): every planned file as a create, restore,
   * modify, conflict or unchanged. The lists below are read from it, never
   * computed beside it.
   */
  readonly changes: ChangeSet;
  /** Planned files, other than the record, that do not exist yet. Safe to write. */
  readonly missing: readonly string[];
  /** Planned files, other than the record, that exist with other content. */
  readonly conflicts: readonly string[];
  /** Whether the record itself needs writing, whatever else is written. */
  readonly recordChanged: boolean;
  /** Nothing to write at all. */
  readonly upToDate: boolean;
}

export interface DecideOptions {
  readonly fs?: CompareFs;
  /** Everything the recorded configuration generates; makes a missing file a restore. */
  readonly previousPaths?: ReadonlySet<string>;
  /** Attach a text diff to every conflict, for a preview. */
  readonly withDiff?: boolean;
}

export function decideRegeneration(
  plan: GenerationPlan,
  options: DecideOptions = {},
): Regeneration {
  const comparison = comparePlan(plan, options.fs ?? realCompareFs);
  const changes = analyzeChanges(plan, comparison, {
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.previousPaths === undefined ? {} : { previousPaths: options.previousPaths }),
    ...(options.withDiff === undefined ? {} : { withDiff: options.withDiff }),
  });
  const of = (...kinds: ChangeKind[]) =>
    changes.changes
      .filter((change) => kinds.includes(change.kind) && change.path !== PROVENANCE_DOCUMENT)
      .map((change) => change.path);
  return {
    comparison,
    changes,
    missing: of('create', 'restore'),
    conflicts: of('conflict'),
    recordChanged:
      comparison.missing.includes(PROVENANCE_DOCUMENT) ||
      comparison.differs.includes(PROVENANCE_DOCUMENT),
    upToDate: changes.upToDate,
  };
}

/**
 * The paths a run writes, from the change analysis: everything that is not
 * unchanged - or nothing, when a conflict has not been agreed to. The record
 * is among them whenever anything else is, so it always describes the last
 * generation that touched the project.
 */
export function pathsToWrite(decision: Regeneration, conflictsAgreed: boolean): string[] {
  return [...outcomeOf(decision.changes, conflictsAgreed).write];
}

/**
 * The files the recorded configuration generates, from the plan `upgrade`
 * already builds for it. `undefined` when that configuration cannot be planned
 * any more - every missing file is then a create, never a guessed restore.
 */
export function previousPathsFor(
  recorded: RecordedConfiguration,
  manifest: ProjectManifest,
  options: Parameters<typeof planUpgrade>[2],
): ReadonlySet<string> | undefined {
  try {
    const planned = planUpgrade(recorded, manifest, options);
    return planned.status === 'planned' ? new Set(planned.paths.oldPaths) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The post steps a re-run still needs. A run that writes nothing runs none.
 * Otherwise installing follows a change to `package.json`, and initialising
 * git follows its absence.
 */
export function postStepsAfter(
  steps: readonly PostStep[],
  written: readonly string[],
  targetDir: string,
): PostStep[] {
  if (written.length === 0) return [];
  return steps.filter((step) => {
    if (step === 'install') return written.includes('package.json');
    if (step === 'git-init') return !existsSync(path.join(targetDir, '.git'));
    return true;
  });
}

/**
 * Exactly what the executor may do, and nothing it has to work out.
 *
 * Built once every question has been answered, from the decision alone. The
 * executor writes `plan` - the Generation Plan narrowed to the decided paths,
 * not a new plan - refuses if any of them no longer matches `expected`, and
 * then runs `postSteps`. It never re-plans, re-compares or re-asks.
 */
export interface ExecutionDecision {
  /** The Generation Plan narrowed to the paths this run writes. Empty when it writes nothing. */
  readonly plan: GenerationPlan;
  /** What every planned path held when the decision was made. */
  readonly expected: TargetObservation;
  /** The post steps that follow these writes. None when nothing is written. */
  readonly postSteps: readonly PostStep[];
}

export function decideExecution(
  plan: GenerationPlan,
  decision: Regeneration,
  conflictsAgreed: boolean,
  steps: readonly PostStep[],
): ExecutionDecision {
  const writes = pathsToWrite(decision, conflictsAgreed);
  return {
    plan: narrowPlan(plan, writes),
    expected: decision.comparison.observed,
    postSteps: postStepsAfter(steps, writes, plan.targetDir),
  };
}

/** The planned files a run leaves exactly as they are: unchanged, and not being written. */
export function leftAlone(decision: Regeneration, writes: readonly string[]): string[] {
  const written = new Set(writes);
  return decision.changes.changes
    .filter((change) => change.kind === 'unchanged' && !written.has(change.path))
    .map((change) => change.path);
}
