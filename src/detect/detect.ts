import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type {
  BuildToolId,
  FrameworkId,
  LanguageId,
  RouterId,
  StylingId,
  UiLibraryId,
} from '../domain/dimensions.js';
import { DetectionError, EXIT_USAGE } from '../errors.js';
import type { PackageManager } from '../types.js';
import { isPackageManager } from '../util/pm.js';
import {
  BUILD_TOOL_SIGNATURES,
  FOREIGN_BUILD_TOOLS,
  FOREIGN_FRAMEWORKS,
  FOREIGN_ROUTERS,
  FOREIGN_STYLING,
  FOREIGN_UI_LIBRARIES,
  FRAMEWORK_SIGNATURES,
  JSCONFIG,
  LOCKFILES,
  ROUTER_SIGNATURES,
  STYLING_SIGNATURES,
  TSCONFIG,
  UI_LIBRARY_SIGNATURES,
  type ForeignSignature,
  type Signature,
} from './signatures.js';

/**
 * Project detection: what is this directory, as far as its own files say?
 *
 * ## What it reads, and nothing more
 *
 * One directory listing of the root, `package.json`, and the *names* of
 * lockfiles and configuration files at the root. It does not descend into any
 * directory - so `node_modules`, `.git`, `dist` and every source file are never
 * opened - it does not open a lockfile, and it runs nothing. The filesystem it
 * is handed can list, stat and read; there is no write on the interface.
 *
 * ## What it answers
 *
 * Raw findings, in ClientKit's vocabulary where the project uses something
 * ClientKit has a name for, and by the thing's own name where it does not.
 * Whether a named value is *implemented* is deliberately not decided here: the
 * resolver asks the adapter registry, exactly as it does for a flag. Detection
 * discovers; resolution normalises.
 *
 * ## Precedence
 *
 *   1. `package.json` dependencies establish a value.
 *   2. Root configuration files corroborate it, and are listed as evidence,
 *      but never establish one alone - a stray `vite.config.ts` in a project
 *      that does not depend on Vite says nothing reliable about its build.
 *      The one exception is language, where `tsconfig.json` *is* the
 *      definition of a TypeScript project.
 *   3. Lockfile names, and the `packageManager` field, decide the package
 *      manager.
 *
 * Ordering is by UTF-16 code unit throughout, never `localeCompare`, and every
 * lookup is by name rather than by position in the listing, so neither the
 * machine's locale nor the order the OS returns entries changes the result.
 */

export type EvidenceSource = 'package.json' | 'lockfile' | 'config';

/** One concrete fact a conclusion rests on. */
export interface Evidence {
  readonly source: EvidenceSource;
  /** Relative to the project root, POSIX separators. */
  readonly path: string;
  /** e.g. `devDependencies.vite`, or `packageManager pnpm@9.1.0`. */
  readonly detail: string;
}

/**
 * One dimension's answer.
 *
 *   - `detected`    one value, in ClientKit's vocabulary.
 *   - `unsupported` one value, recognised, with no name in ClientKit's
 *                   vocabulary - Vue, Gatsby. Never mapped to the nearest
 *                   supported value.
 *   - `ambiguous`   more than one candidate of equal rank. Never picked from.
 *   - `absent`      `package.json` was read and names none of the known
 *                   packages for this dimension.
 *   - `unknown`     there was nothing to read the answer from.
 */
export type Finding<T extends string> =
  | { readonly status: 'detected'; readonly value: T; readonly evidence: readonly Evidence[] }
  | {
      readonly status: 'unsupported';
      readonly name: string;
      readonly evidence: readonly Evidence[];
    }
  | {
      readonly status: 'ambiguous';
      readonly candidates: readonly string[];
      readonly evidence: readonly Evidence[];
    }
  | { readonly status: 'absent'; readonly checked: readonly string[] }
  | { readonly status: 'unknown'; readonly reason: string };

export type ProjectState =
  /** Nothing in the directory, a lone `.git` aside. */
  | 'empty'
  /** Files, but no `package.json`. */
  | 'no-package-json'
  /** A `package.json` that could not be used. See `notes`. */
  | 'unreadable-package-json'
  | 'package-json';

export interface ProjectDetection {
  /** Absolute, as given. Never searched upwards from. */
  readonly root: string;
  readonly state: ProjectState;
  /** `package.json` `name`, when it is a string. */
  readonly name: string | undefined;
  readonly framework: Finding<FrameworkId>;
  readonly buildTool: Finding<BuildToolId>;
  readonly language: Finding<LanguageId>;
  readonly styling: Finding<StylingId>;
  readonly uiLibrary: Finding<UiLibraryId>;
  readonly router: Finding<RouterId>;
  readonly packageManager: Finding<PackageManager>;
  /** Things worth saying that are not a dimension: a malformed file, a skipped link. */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export interface DetectEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
}

/** Read-only by construction: nothing on this interface can change a byte. */
export interface DetectFs {
  /** The entries directly inside `dir`. Never recursive. */
  list(dir: string): readonly DetectEntry[];
  realpath(target: string): string;
  /** Size in bytes of what `file` finally resolves to. */
  size(file: string): number;
  readText(file: string): string;
}

export const realDetectFs: DetectFs = {
  list: (dir) =>
    readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isSymbolicLink()
        ? 'symlink'
        : entry.isFile()
          ? 'file'
          : entry.isDirectory()
            ? 'directory'
            : 'other',
    })),
  realpath: (target) => realpathSync(target),
  size: (file) => statSync(file).size,
  readText: (file) => readFileSync(file, 'utf8'),
};

/** Larger than any real manifest; a guard against reading something that is not one. */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

const PROVENANCE_FILE = '.client-site.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const SOURCE_RANK: Readonly<Record<EvidenceSource, number>> = {
  'package.json': 0,
  config: 1,
  lockfile: 2,
};

function sortEvidence(evidence: readonly Evidence[]): Evidence[] {
  const unique = new Map(evidence.map((entry) => [`${entry.path}\0${entry.detail}`, entry]));
  return [...unique.values()].sort(
    (a, b) =>
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      byCodeUnit(a.path, b.path) ||
      byCodeUnit(a.detail, b.detail),
  );
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What `package.json` contributed, once read. */
interface PackageFacts {
  readonly json: Record<string, unknown>;
  /** Package name -> the field it was listed in. `dependencies` wins over `devDependencies`. */
  readonly dependencies: ReadonlyMap<string, string>;
}

type PackageRead =
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string }
  | { readonly status: 'ok'; readonly facts: PackageFacts };

function readPackageJson(
  fs: DetectFs,
  root: string,
  entry: DetectEntry | undefined,
  notes: string[],
): PackageRead {
  if (entry === undefined) return { status: 'missing' };
  if (entry.kind === 'directory' || entry.kind === 'other') {
    return { status: 'unreadable', reason: 'package.json is not a regular file' };
  }

  const file = path.join(root, 'package.json');
  try {
    if (entry.kind === 'symlink' && !isInside(fs.realpath(root), fs.realpath(file))) {
      return {
        status: 'unreadable',
        reason: 'package.json is a link to a file outside the project, so it was not read',
      };
    }
    if (fs.size(file) > MAX_PACKAGE_JSON_BYTES) {
      return {
        status: 'unreadable',
        reason: 'package.json is larger than 1 MiB, so it was not read',
      };
    }
  } catch (error) {
    return { status: 'unreadable', reason: `package.json could not be read: ${message(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom(fs.readText(file)));
  } catch (error) {
    return { status: 'unreadable', reason: `package.json is not valid JSON: ${message(error)}` };
  }
  if (!isPlainObject(parsed)) {
    return { status: 'unreadable', reason: 'package.json does not contain a JSON object' };
  }

  const dependencies = new Map<string, string>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const block = parsed[field];
    if (block === undefined) continue;
    if (!isPlainObject(block)) {
      notes.push(`package.json "${field}" is not an object, so it was ignored.`);
      continue;
    }
    for (const name of Object.keys(block)) {
      if (!dependencies.has(name)) dependencies.set(name, field);
    }
  }

  return { status: 'ok', facts: { json: parsed, dependencies } };
}

/** Editors on Windows still write a byte-order mark; `JSON.parse` rejects one. */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Candidate {
  readonly label: string;
  readonly known: boolean;
  readonly owner: boolean;
  readonly evidence: readonly Evidence[];
}

/**
 * One dimension from its signatures. The whole inference engine, and
 * deliberately small: match packages, keep the highest tier, and report one,
 * several or none.
 */
function detectDimension<T extends string>(
  known: Readonly<Record<T, Signature>>,
  foreign: readonly ForeignSignature[],
  facts: PackageFacts | undefined,
  unknownReason: string,
  present: (name: string) => boolean,
): Finding<T> {
  if (facts === undefined) return { status: 'unknown', reason: unknownReason };

  const signatures: { label: string; known: boolean; signature: Signature }[] = [
    ...(Object.entries(known) as [T, Signature][]).map(([id, signature]) => ({
      label: id as string,
      known: true,
      signature,
    })),
    ...foreign.map((signature) => ({ label: signature.name, known: false, signature })),
  ];

  const candidates: Candidate[] = [];
  for (const { label, known: isKnown, signature } of signatures) {
    const found = signature.packages.filter((name) => facts.dependencies.has(name));
    if (found.length === 0) continue;
    candidates.push({
      label,
      known: isKnown,
      owner: signature.owner === true,
      evidence: [
        ...found.map((name) => ({
          source: 'package.json' as const,
          path: 'package.json',
          detail: `${facts.dependencies.get(name) ?? 'dependencies'}.${name}`,
        })),
        ...(signature.configs ?? []).filter(present).map((config) => ({
          source: 'config' as const,
          path: config,
          detail: 'configuration file',
        })),
      ],
    });
  }

  if (candidates.length === 0) {
    const checked = [...new Set(signatures.flatMap((entry) => entry.signature.packages))];
    return { status: 'absent', checked: checked.sort(byCodeUnit) };
  }

  const top = candidates.some((candidate) => candidate.owner)
    ? candidates.filter((candidate) => candidate.owner)
    : candidates;

  const [only] = top;
  if (top.length === 1 && only !== undefined) {
    const evidence = sortEvidence(only.evidence);
    return only.known
      ? { status: 'detected', value: only.label as T, evidence }
      : { status: 'unsupported', name: only.label, evidence };
  }

  return {
    status: 'ambiguous',
    candidates: top.map((candidate) => candidate.label).sort(byCodeUnit),
    evidence: sortEvidence(top.flatMap((candidate) => candidate.evidence)),
  };
}

function detectLanguage(
  facts: PackageFacts | undefined,
  unknownReason: string,
  present: (name: string) => boolean,
): Finding<LanguageId> {
  const tsEvidence: Evidence[] = [];
  if (present(TSCONFIG)) {
    tsEvidence.push({ source: 'config', path: TSCONFIG, detail: 'configuration file' });
  }
  const typescript = facts?.dependencies.get('typescript');
  if (typescript !== undefined) {
    tsEvidence.push({
      source: 'package.json',
      path: 'package.json',
      detail: `${typescript}.typescript`,
    });
  }
  if (tsEvidence.length > 0) {
    return { status: 'detected', value: 'ts', evidence: sortEvidence(tsEvidence) };
  }

  if (present(JSCONFIG)) {
    return {
      status: 'detected',
      value: 'js',
      evidence: [{ source: 'config', path: JSCONFIG, detail: 'configuration file' }],
    };
  }
  if (facts !== undefined) {
    return {
      status: 'detected',
      value: 'js',
      evidence: [
        {
          source: 'package.json',
          path: 'package.json',
          detail: 'no typescript dependency, and no tsconfig.json',
        },
      ],
    };
  }
  return { status: 'unknown', reason: unknownReason };
}

function detectPackageManager(
  facts: PackageFacts | undefined,
  present: (name: string) => boolean,
): Finding<PackageManager> {
  const found = new Map<string, { known: boolean; evidence: Evidence[] }>();
  const add = (label: string, known: boolean, evidence: Evidence): void => {
    const entry = found.get(label) ?? { known, evidence: [] };
    entry.evidence.push(evidence);
    found.set(label, entry);
  };

  for (const [lockfile, manager] of Object.entries(LOCKFILES)) {
    if (present(lockfile))
      add(manager, true, { source: 'lockfile', path: lockfile, detail: 'lockfile' });
  }

  // Corepack's field: `"packageManager": "pnpm@9.1.0"`. A stated fact, as strong as a lockfile.
  const field = facts?.json.packageManager;
  if (typeof field === 'string' && field.trim() !== '') {
    const name = field.trim().split('@')[0]?.toLowerCase() ?? '';
    if (name !== '') {
      add(name, isPackageManager(name), {
        source: 'package.json',
        path: 'package.json',
        detail: `packageManager ${field.trim()}`,
      });
    }
  }

  if (found.size === 0) {
    return { status: 'unknown', reason: 'no lockfile, and no "packageManager" field' };
  }

  const labels = [...found.keys()].sort(byCodeUnit);
  const [only] = labels;
  if (labels.length === 1 && only !== undefined) {
    const entry = found.get(only);
    const evidence = sortEvidence(entry?.evidence ?? []);
    return entry?.known === true
      ? { status: 'detected', value: only as PackageManager, evidence }
      : { status: 'unsupported', name: only, evidence };
  }
  return {
    status: 'ambiguous',
    candidates: labels,
    evidence: sortEvidence([...found.values()].flatMap((entry) => entry.evidence)),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface DetectOptions {
  /** The project to inspect. Exactly this directory; parents are never searched. */
  readonly root: string;
  readonly fs?: DetectFs;
}

/**
 * Inspects one directory and reports what it is.
 *
 * Succeeds for any directory that can be listed - an empty one, one with no
 * `package.json`, one with a broken `package.json` - and says so in the
 * result. Throws a `DetectionError` only when the directory itself cannot be
 * read, because that is the one case with no answer to give.
 */
export function detectProject(options: DetectOptions): ProjectDetection {
  const fs = options.fs ?? realDetectFs;
  const root = path.resolve(options.root);

  let entries: readonly DetectEntry[];
  try {
    entries = fs.list(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new DetectionError(`Directory "${root}" does not exist.`, {
        exitCode: EXIT_USAGE,
        hint: 'Pass the directory of an existing project: create-clientkit detect ./my-site',
      });
    }
    if (code === 'ENOTDIR') {
      throw new DetectionError(`"${root}" is not a directory.`, {
        exitCode: EXIT_USAGE,
        hint: 'Pass the directory that contains the project, not a file inside it.',
      });
    }
    throw new DetectionError(`Cannot read "${root}": ${message(error)}`, { cause: error });
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const present = (name: string): boolean => {
    const entry = byName.get(name);
    return entry !== undefined && entry.kind !== 'directory';
  };

  const notes: string[] = [];
  const meaningful = entries.filter((entry) => entry.name !== '.git');

  let state: ProjectState;
  let facts: PackageFacts | undefined;
  let unknownReason: string;

  if (meaningful.length === 0) {
    state = 'empty';
    unknownReason = 'the directory is empty';
  } else {
    const read = readPackageJson(fs, root, byName.get('package.json'), notes);
    if (read.status === 'ok') {
      state = 'package-json';
      facts = read.facts;
      unknownReason = '';
    } else if (read.status === 'missing') {
      state = 'no-package-json';
      unknownReason = 'there is no package.json';
    } else {
      state = 'unreadable-package-json';
      unknownReason = 'package.json could not be used';
      notes.unshift(`${read.reason}.`);
    }
  }

  if (present(PROVENANCE_FILE)) {
    notes.push(
      `${PROVENANCE_FILE} is present: ClientKit generated this project. Detection does not ` +
        'read it; `upgrade` does.',
    );
  }

  const name =
    facts !== undefined && typeof facts.json.name === 'string' ? facts.json.name : undefined;

  return {
    root,
    state,
    name,
    framework: detectDimension(
      FRAMEWORK_SIGNATURES,
      FOREIGN_FRAMEWORKS,
      facts,
      unknownReason,
      present,
    ),
    buildTool: detectDimension(
      BUILD_TOOL_SIGNATURES,
      FOREIGN_BUILD_TOOLS,
      facts,
      unknownReason,
      present,
    ),
    language:
      state === 'empty'
        ? { status: 'unknown', reason: unknownReason }
        : detectLanguage(facts, unknownReason, present),
    styling: detectDimension(STYLING_SIGNATURES, FOREIGN_STYLING, facts, unknownReason, present),
    uiLibrary: detectDimension(
      UI_LIBRARY_SIGNATURES,
      FOREIGN_UI_LIBRARIES,
      facts,
      unknownReason,
      present,
    ),
    router: detectDimension(ROUTER_SIGNATURES, FOREIGN_ROUTERS, facts, unknownReason, present),
    packageManager:
      state === 'empty'
        ? { status: 'unknown', reason: unknownReason }
        : detectPackageManager(facts, present),
    notes,
  };
}
