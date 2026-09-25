import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { CliError } from '../errors.js';
import type { GenerationPlan } from './files.js';

export interface ApplyResult {
  readonly targetDir: string;
  readonly written: readonly string[];
  /** Pre-existing files in the target that this run replaced. */
  readonly overwritten: readonly string[];
}

export interface ApplyOptions {
  /** Required when the target already contains unrelated files. */
  readonly allowNonEmpty?: boolean;
  readonly onProgress?: (relativePath: string) => void;
  /**
   * The raw rename underneath the retry. Production uses `renameSync`.
   *
   * Injectable only so a test can make a rename fail the way Windows makes it
   * fail, which is the one thing a real filesystem will not do on demand. It
   * is what lets the suite prove that publishing *goes through* the retry
   * rather than merely that the retry works when called.
   */
  readonly rename?: (from: string, to: string) => void;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Renames, retrying the Windows failures that are contention rather than
 * refusal.
 *
 * A rename of a freshly written tree can fail with `EPERM`, `EBUSY` or
 * `EACCES` on Windows while something else still holds a handle to it -
 * OneDrive's sync filter, Defender's scanner, or the search indexer, each of
 * which opens new files moments after they appear. The operation is perfectly
 * legal; the file is merely busy for a few milliseconds.
 *
 * Reported as `EPERM: operation not permitted, rename …` and intermittent -
 * measured at 2 failures in 8 runs generating into a OneDrive folder. Retrying
 * with a short backoff takes it to 0 in 40. `rmSync` in this file already gets
 * the same treatment through its own `maxRetries`, which is where the pattern
 * comes from; the publish rename simply never got it.
 *
 * Only those three codes are retried. Anything else is a real error and is
 * thrown at once, because a rename that is genuinely wrong should fail fast
 * rather than after a second of hopeful waiting.
 */
export const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface RenameRetryOptions {
  /** Injectable so a test can fail on demand; production uses `renameSync`. */
  readonly rename?: (from: string, to: string) => void;
  readonly attempts?: number;
  readonly delayMs?: number;
}

export function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): void {
  const rename = options.rename ?? renameSync;
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 60;

  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      // Busy-wait: the whole point is to hold the path for a few milliseconds
      // without yielding to code that might touch the tree in between.
      const until = Date.now() + delayMs;
      while (Date.now() < until) {
        /* deliberately spinning */
      }
    }
  }
}

/**
 * Materialises a plan.
 *
 * Everything is written into a temporary directory that is a *sibling* of the
 * target, so the final move stays on one volume (a cross-device rename fails on
 * Windows). Only once every operation has succeeded does anything appear at the
 * destination; on any failure the temporary tree is removed and the target is
 * left exactly as it was.
 *
 * No symlinks are created, and text content arrives here already normalised to
 * LF by the planner.
 */
export function apply(plan: GenerationPlan, options: ApplyOptions = {}): ApplyResult {
  const targetDir = path.resolve(plan.targetDir);
  const parent = path.dirname(targetDir);
  const stagingDir = path.join(parent, `.${path.basename(targetDir)}.tmp-${randomSuffix()}`);

  const targetExists = existsSync(targetDir);
  if (targetExists && !options.allowNonEmpty && !isEffectivelyEmpty(targetDir)) {
    throw new CliError(`Directory "${targetDir}" already exists and is not empty.`);
  }

  const retry = options.rename === undefined ? {} : { rename: options.rename };

  const written: string[] = [];
  const overwritten: string[] = [];

  try {
    mkdirSync(stagingDir, { recursive: true });

    for (const operation of plan.operations) {
      const destination = path.join(stagingDir, ...operation.path.split('/'));
      mkdirSync(path.dirname(destination), { recursive: true });

      if (operation.type === 'write') {
        writeFileSync(destination, operation.content, 'utf8');
      } else {
        copyFileSync(operation.source, destination);
      }
      written.push(operation.path);
      options.onProgress?.(operation.path);
    }

    if (!targetExists) {
      // Fast path: one rename publishes the whole tree at once.
      mkdirSync(parent, { recursive: true });
      renameWithRetry(stagingDir, targetDir, retry);
    } else {
      /*
       * Merge path: move planned files only. Nothing else in the target is
       * touched, so unrelated user files always survive.
       *
       * Publishing cannot be one rename here - the target already exists and
       * keeps files this plan does not name - so it is a file at a time, and
       * that makes a partial failure possible. Each replaced file is therefore
       * moved aside first and restored if any later move fails, so the target
       * ends up either fully updated or exactly as it was.
       *
       * Without this, a plan that failed on its twentieth file left nineteen
       * replaced and their originals already deleted. Stage 64 found it by
       * failing an upgrade on purpose and watching the provenance file - which
       * sorts early - come back describing a stack the project no longer had.
       */
      const backupDir = path.join(stagingDir, '.replaced');
      const undo: { readonly to: string; readonly backup: string | null }[] = [];

      try {
        for (const operation of plan.operations) {
          const from = path.join(stagingDir, ...operation.path.split('/'));
          const to = path.join(targetDir, ...operation.path.split('/'));

          let backup: string | null = null;
          if (existsSync(to)) {
            /*
             * A directory where a planned file goes is a conflict, not
             * something to move out of the way. Replacing it would mean
             * discarding whatever it holds, and ClientKit does not delete a
             * developer's files - so this refuses before anything is touched.
             */
            if (statSync(to).isDirectory()) {
              throw new CliError(
                `Cannot write "${operation.path}": a directory exists at that path.`,
                {
                  hint: 'Move or remove that directory, then run the command again. Nothing was written.',
                },
              );
            }
            overwritten.push(operation.path);
            backup = path.join(backupDir, ...operation.path.split('/'));
            mkdirSync(path.dirname(backup), { recursive: true });
            renameWithRetry(to, backup, retry);
          }

          // Recorded before the move, not after: the operation that fails may
          // already have moved the original aside, and that one needs putting
          // back too.
          undo.push({ to, backup });
          mkdirSync(path.dirname(to), { recursive: true });
          renameWithRetry(from, to, retry);
        }
      } catch (error) {
        // Put everything back, newest move first, before the outer handler
        // reports the failure.
        for (const step of undo.reverse()) {
          rmSync(step.to, { recursive: true, force: true });
          if (step.backup !== null) renameWithRetry(step.backup, step.to, retry);
        }
        throw error;
      }

      rmSync(stagingDir, { recursive: true, force: true });
    }

    return { targetDir, written, overwritten };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (error instanceof CliError) throw error;
    throw new CliError(`Generation failed: ${(error as Error).message}`, {
      cause: error,
      hint: 'Nothing was written to the target directory.',
    });
  }
}

/** A lone `.git` does not count as content. Mirrors the M1 validator. */
function isEffectivelyEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).filter((entry) => entry !== '.git').length === 0;
  } catch {
    return false;
  }
}

/** Files a plan would replace in an existing target. Drives the confirmation. */
export function findCollisions(plan: GenerationPlan): string[] {
  const targetDir = path.resolve(plan.targetDir);
  if (!existsSync(targetDir)) return [];
  return plan.operations
    .map((operation) => operation.path)
    .filter((relative) => existsSync(path.join(targetDir, ...relative.split('/'))))
    .sort();
}
