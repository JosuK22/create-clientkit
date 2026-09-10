import path from 'node:path';

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
      /** POSIX-style path relative to the target directory. */
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
