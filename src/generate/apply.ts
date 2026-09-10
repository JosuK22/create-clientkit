import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
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
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
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
      renameSync(stagingDir, targetDir);
    } else {
      // Merge path: move planned files only. Nothing else in the target is
      // touched, so unrelated user files always survive.
      for (const operation of plan.operations) {
        const from = path.join(stagingDir, ...operation.path.split('/'));
        const to = path.join(targetDir, ...operation.path.split('/'));
        if (existsSync(to)) {
          overwritten.push(operation.path);
          rmSync(to, { force: true });
        }
        mkdirSync(path.dirname(to), { recursive: true });
        renameSync(from, to);
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
