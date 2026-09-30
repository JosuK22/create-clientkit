import path from 'node:path';

import { PlanningError } from '../errors.js';
import { compareText } from '../util/order.js';

/**
 * One planned filesystem mutation. The plan is a list of these and nothing
 * else, so a plan can be inspected, diffed and printed without side effects.
 *
 * `write` carries fully-resolved text content. `copy` names a source path on
 * disk and is used for binary assets, which are never read into memory during
 * planning and never token-substituted.
 */
export type FileOperation =
  | {
      readonly type: 'write';
      /** Canonical POSIX path relative to the target directory; see `normalisePlanPath`. */
      readonly path: string;
      readonly content: string;
      /** Which template layer produced the final content. Diagnostics only. */
      readonly origin: string;
    }
  | {
      readonly type: 'copy';
      readonly path: string;
      /** Absolute path of the source file inside the template. */
      readonly source: string;
      readonly origin: string;
    };

/**
 * Every mutation one run intends to make, decided before any is made.
 *
 * Built by the planner (`planManifest` in the adapter bridge, over `plan()`),
 * applied by the executor (`apply()`). Plain serializable data: canonical
 * relative paths, sorted by {@link comparePlanPaths}, no timestamps beyond the
 * context's own `generatedAt`.
 *
 * ## Why there is no `create` / `modify` / `delete`
 *
 * Whether a `write` creates a file or replaces one depends on what is already
 * in the target, not on the configuration - so recording it here would make
 * the same inputs plan differently in two directories. It is answered at the
 * boundary instead: `findCollisions()` before asking, `ApplyResult.overwritten`
 * after writing. And ClientKit never deletes a file (the upgrade promise), so a
 * `delete` operation would be a type with no producer and an executor branch
 * that must never run.
 *
 * Dependencies and scripts are not a second list either. They live in the
 * planned `package.json` write, composed from adapter contributions; the
 * structured view of the same data, with who asked for each package and why,
 * is `AdapterPlanResult.composedPackage`. Installing them is a post-step the
 * CLI runs after `apply()`.
 */
export interface GenerationPlan {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly mode: string;
  readonly targetDir: string;
  readonly operations: readonly FileOperation[];
}

/**
 * Files that npm or git would otherwise hijack inside the template directory
 * are stored with a leading underscore and renamed on the way out.
 *
 * Without this, npm tries to resolve a template's `package.json` while
 * installing the CLI itself, and git refuses to track a template `.gitignore`.
 */
const UNDERSCORE_PREFIXED = new Set([
  '_gitignore',
  '_npmrc',
  '_gitattributes',
  '_editorconfig',
  '_env',
  '_env.example',
  '_package.json',
]);

/**
 * `_package.json` -> `package.json`, `_gitignore` -> `.gitignore`.
 *
 * `_package.json` is the one case that loses the underscore rather than gaining
 * a dot: it is hidden from npm inside the template, but the generated project
 * needs an ordinary `package.json`.
 */
export function renameSpecialFile(basename: string): string {
  if (!UNDERSCORE_PREFIXED.has(basename)) return basename;
  if (basename === '_package.json') return 'package.json';
  return `.${basename.slice(1)}`;
}

/** Applies the rename rule to the last segment of a relative path. */
export function renameSpecialPath(relativePath: string): string {
  const segments = relativePath.split('/');
  const last = segments.pop();
  if (last === undefined) return relativePath;
  return [...segments, renameSpecialFile(last)].join('/');
}

/** Extensions that the token engine is allowed to touch. */
const TEXT_EXTENSIONS = new Set([
  '.astro',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.css',
  '.scss',
  '.html',
  '.txt',
  '.svg',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
]);

/** Underscore-prefixed dotfiles have no extension but are always text. */
const TEXT_BASENAMES = new Set([...UNDERSCORE_PREFIXED, '.gitignore', '.npmrc', '.editorconfig']);

/**
 * Decided by an explicit allow-list, never by sniffing content. Anything not on
 * the list is treated as binary and copied through untouched.
 */
export function isTextFile(relativePath: string): boolean {
  // Accepts posix or native separators: the planner normalises, but callers
  // elsewhere may hand over a raw platform path.
  const basename = path.basename(relativePath.split('/').join(path.sep));
  if (TEXT_BASENAMES.has(basename)) return true;
  return TEXT_EXTENSIONS.has(path.extname(basename).toLowerCase());
}

/** JSON files that are deep-merged rather than replaced when layers collide. */
const MERGEABLE_JSON = new Set(['package.json', 'tsconfig.json']);

export function isMergeableJson(relativePath: string): boolean {
  return MERGEABLE_JSON.has(relativePath.split('/').pop() ?? '');
}

/** Generated text is always written with LF, on every platform. */
export function normaliseEol(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/**
 * The order operations appear in a plan.
 *
 * Collation rather than code-unit order, because that is the order every plan
 * has been emitted in since 1.0.0 and the golden snapshots record it: `README.md`
 * sorts after `public/`, not before `.gitignore`. Changing it would reorder
 * every plan without changing a single generated byte, which is churn in the
 * one artifact reviewers diff.
 *
 * The locale is pinned, through the one shared comparator in `util/order.ts`:
 * a bare `localeCompare` takes the runtime's default, so the same inputs could
 * come out in a different order on a machine configured for another language.
 */
export function comparePlanPaths(a: string, b: string): number {
  return compareText(a, b);
}

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/**
 * The canonical form of a path inside the target directory, or a
 * `PlanningError` saying why there is none.
 *
 * Canonical means POSIX separators, relative, and no `.`, `..` or empty
 * segments. Anything that could resolve outside the target - `../x`, `/etc/x`,
 * `C:\x`, `a/../../x` - is refused rather than repaired: an operation aimed
 * there is a bug in a template or an adapter, and quietly clamping it would
 * write the file somewhere its author did not intend.
 */
export function normalisePlanPath(input: string): string {
  const refuse = (reason: string): never => {
    throw new PlanningError(`Refusing to plan "${input}": ${reason}.`, {
      hint: 'Generated files must stay inside the target directory. This is a bug in a template or an adapter, not in your configuration.',
    });
  };

  if (input.includes('\0')) refuse('the path contains a NUL character');
  const posix = input.replace(/\\/g, '/');
  if (posix.startsWith('/') || WINDOWS_DRIVE.test(posix)) refuse('the path is absolute');

  const segments = posix.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) refuse('the path contains a ".." segment');
  if (segments.length === 0) refuse('the path names the target directory itself');

  return segments.join('/');
}

/** True when a path is already canonical and inside the target. Never throws. */
export function isCanonicalPlanPath(relativePath: string): boolean {
  try {
    return normalisePlanPath(relativePath) === relativePath;
  } catch {
    return false;
  }
}

/**
 * Refuses a plan the executor should never be handed.
 *
 * Every path canonical and inside the target, and no path planned twice. The
 * planner already produces exactly that, so on a correct plan this is a no-op
 * pass; it exists so a future adapter that gets it wrong fails here, before
 * anything is written, rather than at the mutation boundary.
 */
export function assertValidPlan(plan: GenerationPlan): void {
  const seen = new Set<string>();
  for (const operation of plan.operations) {
    const canonical = normalisePlanPath(operation.path);
    if (canonical !== operation.path) {
      throw new PlanningError(
        `Planned path "${operation.path}" is not in canonical form (expected "${canonical}").`,
        { hint: `Produced by ${operation.origin}. This is a bug in a template or an adapter.` },
      );
    }
    if (seen.has(operation.path)) {
      throw new PlanningError(`"${operation.path}" is planned more than once.`, {
        hint: `The second operation came from ${operation.origin}. Exactly one owner should produce each file.`,
      });
    }
    seen.add(operation.path);
  }
}
