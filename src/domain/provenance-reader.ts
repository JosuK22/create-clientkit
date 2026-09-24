import path from 'node:path';

import { parseVersion } from '../util/node.js';
import type {
  ArchitectureId,
  BuildToolId,
  FrameworkId,
  LanguageId,
  RouterId,
  StylingId,
  UiLibraryId,
} from './dimensions.js';
import {
  ARCHITECTURE_IDS,
  BUILD_TOOL_IDS,
  FRAMEWORK_IDS,
  LANGUAGE_IDS,
  ROUTER_IDS,
  STYLING_IDS,
  UI_LIBRARY_IDS,
} from './dimensions.js';

/**
 * Reading `.client-site.json` back, and saying exactly what it proves.
 *
 * ## The one question this answers
 *
 * > What does this document establish about this project?
 *
 * Not "how should it be upgraded". There is no upgrade command, and the
 * decision about what to *do* with a provenance document belongs with the
 * command that does it. This layer reads, validates, and classifies.
 *
 * ## Readable is not the same as sufficient
 *
 * The distinction the whole module exists for. Every project generated up to
 * and including 1.0.2 has a provenance file that is perfectly well-formed and
 * perfectly understandable - and contains no `stack`, because the stack was
 * only recorded from Stage 58. Such a document is **readable** and **not
 * sufficient** for anything that needs to know what the project was built as.
 *
 * Collapsing those two into one boolean is how a tool ends up guessing. Stage
 * 56 measured where that leads: reconstructing a missing stack from resolver
 * defaults turns a project that chose MUI into one that never did, and a
 * developer's own module into a file the tool believes it owns.
 *
 * So there is no default, no inference and no repair anywhere below. A document
 * that does not say something is reported as not saying it.
 *
 * ## What it will not do
 *
 * It does not write, generate, repair, or look at any file other than the one
 * it was asked for. It does not open `package.json` to work out a framework, or
 * read the directory to see which files exist. Everything it reports comes from
 * the document itself.
 */

/**
 * The document's name on disk.
 *
 * Deliberately a second constant rather than an import from
 * `generate/provenance.ts`, which owns the writer: the dependency direction is
 * V1 -> V2, and a domain module reaching into the generator would invert it.
 * `test/provenance-reader.test.ts` asserts the two names are identical, so the
 * duplication cannot become a disagreement.
 */
export const PROVENANCE_DOCUMENT = '.client-site.json';

/** The stack as a document records it, once every dimension has been checked. */
export interface RecordedStack {
  readonly framework: FrameworkId;
  readonly buildTool: BuildToolId;
  readonly language: LanguageId;
  readonly styling: StylingId;
  readonly uiLibrary: UiLibraryId;
  readonly router: RouterId;
  readonly architecture: ArchitectureId;
}

/** A provenance document that has been read and found structurally sound. */
export interface ProvenanceDocument {
  readonly cliVersion: string;
  readonly template: {
    readonly id: string;
    readonly version: string;
    readonly framework: string;
    readonly frameworkVersion: string;
  };
  readonly mode: string;
  readonly generatedAt: string;
  readonly config: {
    readonly projectName: string;
    readonly siteName: string;
    readonly siteUrl: string | null;
    readonly locale: string;
    readonly packageManager: string;
    readonly features: readonly string[];
  };
  /** Absent on everything generated before Stage 58. */
  readonly stack?: RecordedStack;
}

/**
 * What a read established.
 *
 * A discriminated union rather than a thrown error, following
 * `validateTargetDir`: several of these are ordinary answers rather than
 * failures. A project with no provenance is not a malfunction, and a 1.0.2
 * project being insufficient for a stack-dependent operation is the expected
 * state of every project that exists today.
 */
export type ProvenanceRead =
  /** Readable, and it records the stack. */
  | {
      readonly status: 'usable';
      readonly document: ProvenanceDocument;
      readonly stack: RecordedStack;
    }
  /** Readable, but it does not record what the caller needs. */
  | {
      readonly status: 'insufficient';
      readonly document: ProvenanceDocument;
      readonly missing: 'stack';
      readonly because: string;
    }
  /** No document at the expected path. */
  | { readonly status: 'missing'; readonly because: string }
  /** A file, but not JSON. */
  | { readonly status: 'malformed'; readonly because: string }
  /** JSON, but not a provenance document. */
  | { readonly status: 'invalid'; readonly because: string }
  /** A provenance document this CLI is too old to interpret safely. */
  | { readonly status: 'unsupported'; readonly because: string; readonly recordedVersion: string };

/** Reads one file as text, or throws. The same shape `--from` already uses. */
export type ProvenanceFileReader = (filePath: string) => string;

const TOP_LEVEL_KEYS = [
  '$schema',
  'cliVersion',
  'template',
  'stack',
  'mode',
  'generatedAt',
  'config',
] as const;
const TEMPLATE_KEYS = ['id', 'version', 'framework', 'frameworkVersion'] as const;
const CONFIG_KEYS = [
  'projectName',
  'siteName',
  'siteUrl',
  'locale',
  'packageManager',
  'features',
] as const;

/** Each stack field, with the vocabulary its value has to come from. */
const STACK_DIMENSIONS = [
  ['framework', FRAMEWORK_IDS],
  ['buildTool', BUILD_TOOL_IDS],
  ['language', LANGUAGE_IDS],
  ['styling', STYLING_IDS],
  ['uiLibrary', UI_LIBRARY_IDS],
  ['router', ROUTER_IDS],
  ['architecture', ARCHITECTURE_IDS],
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const invalid = (because: string): ProvenanceRead => ({ status: 'invalid', because });

/** Every string field of an object, or the first complaint about one. */
function checkStrings(
  object: Record<string, unknown>,
  keys: readonly string[],
  scope: string,
): string | null {
  for (const key of keys) {
    if (!(key in object)) return `${scope} is missing "${key}".`;
    if (typeof object[key] !== 'string') return `${scope} field "${key}" is not a string.`;
  }
  return null;
}

/**
 * Whether the document came from a ClientKit newer than this one.
 *
 * Stage 57 settled the direction that matters: a newer CLI must understand an
 * older document, and the reverse is explicitly not supported. A document from
 * the future may use fields whose meaning this build does not know, and JSON
 * parsing succeeding says nothing about that.
 */
function fromTheFuture(recorded: string, running: string): boolean {
  const theirs = parseVersion(recorded);
  const ours = parseVersion(running);
  if (theirs === null || ours === null) return false;
  if (theirs.major !== ours.major) return theirs.major > ours.major;
  if (theirs.minor !== ours.minor) return theirs.minor > ours.minor;
  return theirs.patch > ours.patch;
}

function readStack(value: unknown): { stack: RecordedStack } | { because: string } {
  if (!isPlainObject(value)) return { because: '"stack" is not an object.' };

  for (const key of Object.keys(value)) {
    if (!STACK_DIMENSIONS.some(([dimension]) => dimension === key)) {
      return { because: `"stack" has an unknown dimension "${key}".` };
    }
  }

  for (const [dimension, vocabulary] of STACK_DIMENSIONS) {
    const recorded = value[dimension];
    if (recorded === undefined) return { because: `"stack" is missing "${dimension}".` };
    if (typeof recorded !== 'string') {
      return { because: `"stack.${dimension}" is not a string.` };
    }
    if (!(vocabulary as readonly string[]).includes(recorded)) {
      // Never coerced to something valid: a value ClientKit does not recognise
      // is reported as unrecognised.
      return { because: `"stack.${dimension}" is not a value ClientKit knows: "${recorded}".` };
    }
  }

  return { stack: value as unknown as RecordedStack };
}

/**
 * Classifies one provenance document, given its text.
 *
 * Pure: text in, verdict out, no filesystem. `readProvenance` is the thin shell
 * that finds the file; everything decided here can be decided from a string.
 */
export function interpretProvenance(text: string, cliVersion: string): ProvenanceRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      status: 'malformed',
      because: `${PROVENANCE_DOCUMENT} is not valid JSON: ${(error as Error).message}`,
    };
  }

  if (!isPlainObject(parsed)) {
    return invalid(`${PROVENANCE_DOCUMENT} does not contain a JSON object.`);
  }

  // The version gate comes first, because a document from a newer ClientKit may
  // legitimately have a shape this build would otherwise call invalid.
  if (typeof parsed.cliVersion !== 'string') {
    return invalid(`${PROVENANCE_DOCUMENT} is missing a string "cliVersion".`);
  }
  if (fromTheFuture(parsed.cliVersion, cliVersion)) {
    return {
      status: 'unsupported',
      recordedVersion: parsed.cliVersion,
      because:
        `${PROVENANCE_DOCUMENT} was written by ClientKit ${parsed.cliVersion}, which is newer ` +
        `than this one (${cliVersion}). Reading it could mean misreading fields this version ` +
        'does not know about.',
    };
  }

  for (const key of Object.keys(parsed)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      return invalid(`${PROVENANCE_DOCUMENT} has an unknown field "${key}".`);
    }
  }

  for (const [key, label] of [
    ['mode', '"mode"'],
    ['generatedAt', '"generatedAt"'],
  ] as const) {
    if (typeof parsed[key] !== 'string') {
      return invalid(`${PROVENANCE_DOCUMENT} is missing a string ${label}.`);
    }
  }

  if (!isPlainObject(parsed.template)) {
    return invalid(`${PROVENANCE_DOCUMENT} is missing a "template" object.`);
  }
  const templateComplaint = checkStrings(parsed.template, TEMPLATE_KEYS, '"template"');
  if (templateComplaint !== null) return invalid(templateComplaint);

  if (!isPlainObject(parsed.config)) {
    return invalid(`${PROVENANCE_DOCUMENT} is missing a "config" object.`);
  }
  const config = parsed.config;
  for (const key of CONFIG_KEYS) {
    if (!(key in config)) return invalid(`"config" is missing "${key}".`);
  }
  for (const key of ['projectName', 'siteName', 'locale', 'packageManager'] as const) {
    if (typeof config[key] !== 'string') return invalid(`"config.${key}" is not a string.`);
  }
  if (config.siteUrl !== null && typeof config.siteUrl !== 'string') {
    return invalid('"config.siteUrl" is neither a string nor null.');
  }
  if (!Array.isArray(config.features) || config.features.some((f) => typeof f !== 'string')) {
    return invalid('"config.features" is not an array of strings.');
  }

  const document = parsed as unknown as ProvenanceDocument;

  if (!('stack' in parsed)) {
    return {
      status: 'insufficient',
      document,
      missing: 'stack',
      because:
        `${PROVENANCE_DOCUMENT} records no stack. Projects generated before the stack was ` +
        'recorded cannot say which styling system, component library, router or architecture ' +
        'they were built with, and ClientKit will not guess.',
    };
  }

  const stack = readStack(parsed.stack);
  if ('because' in stack) return invalid(`${PROVENANCE_DOCUMENT}: ${stack.because}`);

  return { status: 'usable', document, stack: stack.stack };
}

/**
 * Reads the provenance document of a project directory.
 *
 * The reader is injected, as `--from` already does it, so nothing here imports
 * the filesystem and a caller can supply whatever it has. A read that throws is
 * taken as the file not being there, the same reading `validateTargetDir` makes
 * of a failed `statSync`: this function's job is to report what provenance the
 * project has, and "none that can be read" is one of the answers.
 */
export function readProvenance(
  projectDir: string,
  readFile: ProvenanceFileReader,
  cliVersion: string,
): ProvenanceRead {
  let text: string;
  try {
    text = readFile(path.join(projectDir, PROVENANCE_DOCUMENT));
  } catch {
    return {
      status: 'missing',
      because:
        `No ${PROVENANCE_DOCUMENT} in this directory, so there is nothing to say it was ` +
        'generated by ClientKit. ClientKit does not inspect a project to work that out.',
    };
  }
  return interpretProvenance(text, cliVersion);
}
