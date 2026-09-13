import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CliError } from '../errors.js';
import type { ContextInput } from '../types.js';
import type { DimensionInput } from './dimensions.js';
import {
  deriveProjectName,
  isPackageManagerId,
  isTemplateMode,
  validateLocale,
  validateProjectName,
  validateSiteName,
  validateUrl,
} from './validate.js';

const TOP_LEVEL_KEYS = [
  'dir',
  'site',
  'stack',
  'template',
  'packageManager',
  'git',
  'install',
] as const;
const SITE_KEYS = ['name', 'url', 'description', 'locale', 'author'] as const;
const TEMPLATE_KEYS = ['id', 'version', 'mode'] as const;

/**
 * The manifest dimensions, grouped the way `site` and `template` already are.
 *
 * Nested rather than spread across the top level because the file already
 * groups by subject, and because `stack` and `template` are two ways of naming
 * the same thing - a reader seeing them side by side can tell they are
 * alternatives, which is exactly what the conflict rule says.
 *
 * The names match the manifest's own, so a field here is the flag without its
 * dashes. There is no second vocabulary to learn and none to keep in step.
 *
 * `preset` sits among them although it is not a dimension: it is a shorthand
 * for several, and a reader seeing it beside `uiLibrary` can tell at a glance
 * that the two combine - the preset supplies a starting point and the sibling
 * fields override it.
 */
const STACK_KEYS = [
  'preset',
  'framework',
  'buildTool',
  'language',
  'styling',
  'uiLibrary',
  'router',
  'architecture',
  'features',
] as const;

export type FileReader = (filePath: string) => string;

const defaultReader: FileReader = (filePath) => readFileSync(filePath, 'utf8');

function fail(message: string, hint?: string): never {
  throw new CliError(message, hint === undefined ? {} : { hint });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  scope: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      fail(
        `Unknown key "${key}" in ${scope} of the config file.`,
        `Allowed keys: ${allowed.join(', ')}.`,
      );
    }
  }
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`Config file field "${label}" must be a string.`);
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`Config file field "${label}" must be true or false.`);
  return value;
}

/**
 * A config file, split by where each half is consumed.
 *
 * `context` joins the V1 precedence chain; `stack` becomes part of the same
 * `DimensionInput` the flags and the prompts fill. Two fields rather than one
 * merged object because they answer to different layers, not because the file
 * has two formats.
 */
export interface LoadedConfig {
  readonly context: ContextInput;
  readonly stack: DimensionInput;
  /**
   * The preset the file named, if any.
   *
   * Kept apart from `stack` because it is resolved one rung lower: the file's
   * own dimensions override whatever the preset supplies, and merging them here
   * would lose the distinction.
   */
  readonly preset: string | undefined;
}

/** What an absent `--from` contributes: nothing, in every half. */
export const NO_CONFIG: LoadedConfig = { context: {}, stack: {}, preset: undefined };

/**
 * Loads `--from <file.json>`. Strictly JSON — no JS, no code execution, no
 * dynamic import. This is another input source, not a validation bypass: every
 * value goes through the same validators as flags and prompts.
 *
 * ## What this layer checks, and what it deliberately does not
 *
 * Shape only: is `framework` a string, is `features` an array, is this a key
 * the file knows. Whether `"vue"` is a framework, whether an adapter implements
 * it, and whether the combination can be built are three different questions
 * with three existing answers - the vocabulary, the registry and the
 * compatibility engine. Answering any of them here would put a second copy of
 * the architecture in a JSON parser, and it would be the copy that goes stale.
 */
export function loadConfigFile(
  filePath: string,
  options: { cwd: string; readFile?: FileReader } = { cwd: process.cwd() },
): LoadedConfig {
  const absolute = path.resolve(options.cwd, filePath);
  const read = options.readFile ?? defaultReader;

  let raw: string;
  try {
    raw = read(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      fail(`Config file not found: ${absolute}`, 'Check the path passed to --from.');
    }
    if (code === 'EISDIR') {
      fail(`--from expects a JSON file, but ${absolute} is a directory.`);
    }
    fail(`Could not read config file ${absolute}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      `Config file ${absolute} is not valid JSON: ${(error as Error).message}`,
      'Only plain JSON is supported (no comments, no trailing commas).',
    );
  }

  if (!isPlainObject(parsed)) {
    fail(`Config file ${absolute} must contain a JSON object at the top level.`);
  }
  rejectUnknownKeys(parsed, TOP_LEVEL_KEYS, 'the top level');

  const input: ContextInput = {};

  if (parsed['dir'] !== undefined) {
    const dir = expectString(parsed['dir'], 'dir');
    // Reuses the resolver's own derivation rather than repeating the
    // separator handling, so a Windows-style path is trimmed identically here
    // and in the flag layer.
    const nameError = validateProjectName(deriveProjectName(dir, options.cwd));
    if (nameError) fail(`Config file field "dir" is invalid: ${nameError}`);
    input.dir = dir;
  }

  if (parsed['site'] !== undefined) {
    if (!isPlainObject(parsed['site'])) fail('Config file field "site" must be an object.');
    const site = parsed['site'];
    rejectUnknownKeys(site, SITE_KEYS, '"site"');

    if (site['name'] !== undefined) {
      const name = expectString(site['name'], 'site.name');
      const error = validateSiteName(name);
      if (error) fail(`Config file field "site.name" is invalid: ${error}`);
      input.siteName = name.trim();
    }
    if (site['url'] !== undefined) {
      if (site['url'] === null) {
        input.siteUrl = null;
      } else {
        const check = validateUrl(expectString(site['url'], 'site.url'));
        if (check.error) fail(`Config file field "site.url" is invalid: ${check.error}`);
        input.siteUrl = check.value;
      }
    }
    if (site['description'] !== undefined) {
      input.siteDescription = expectString(site['description'], 'site.description');
    }
    if (site['locale'] !== undefined) {
      const locale = expectString(site['locale'], 'site.locale');
      const error = validateLocale(locale);
      if (error) fail(`Config file field "site.locale" is invalid: ${error}`);
      input.locale = locale;
    }
    if (site['author'] !== undefined) {
      input.author = site['author'] === null ? null : expectString(site['author'], 'site.author');
    }
  }

  if (parsed['template'] !== undefined) {
    if (!isPlainObject(parsed['template'])) fail('Config file field "template" must be an object.');
    const template = parsed['template'];
    rejectUnknownKeys(template, TEMPLATE_KEYS, '"template"');

    if (template['id'] !== undefined) {
      input.templateId = expectString(template['id'], 'template.id');
    }
    if (template['version'] !== undefined) {
      input.templateVersion =
        template['version'] === null ? null : expectString(template['version'], 'template.version');
    }
    if (template['mode'] !== undefined) {
      const mode = expectString(template['mode'], 'template.mode');
      if (!isTemplateMode(mode)) {
        fail(`Config file field "template.mode" is invalid: unknown mode "${mode}".`);
      }
      input.mode = mode;
    }
  }

  if (parsed['packageManager'] !== undefined) {
    const pm = expectString(parsed['packageManager'], 'packageManager');
    if (!isPackageManagerId(pm)) {
      fail(`Config file field "packageManager" is invalid: unknown package manager "${pm}".`);
    }
    input.packageManager = pm;
  }

  if (parsed['git'] !== undefined) input.git = expectBoolean(parsed['git'], 'git');
  if (parsed['install'] !== undefined) input.install = expectBoolean(parsed['install'], 'install');

  const { preset, ...stack } = readStack(parsed['stack']);
  return { context: input, stack, preset };
}

/**
 * Reads the `stack` block into the shared `DimensionInput`.
 *
 * Every value stays a raw string, which is the whole point: this produces
 * exactly what `--framework react` produces, so the file gains no defaults, no
 * validation and no vocabulary of its own.
 */
function readStack(value: unknown): DimensionInput & { preset?: string | undefined } {
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail('Config file field "stack" must be an object.');
  rejectUnknownKeys(value, STACK_KEYS, '"stack"');

  const stack: Record<string, string | readonly string[]> = {};
  for (const key of STACK_KEYS) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (key === 'features') continue;
    stack[key] = expectString(entry, `stack.${key}`);
  }
  // Whether the name is one the registry knows is the registry's question,
  // asked where every other id is checked. This layer only says it is a string.

  if (value['features'] !== undefined) {
    const features = value['features'];
    if (!Array.isArray(features)) {
      fail(
        'Config file field "stack.features" must be an array.',
        'For example: "features": ["seo", "accessibility"].',
      );
    }
    stack['features'] = features.map((entry, index) => {
      const feature = expectString(entry, `stack.features[${index}]`);
      /*
       * The comma is the command line's separator, and it has no business
       * here. Allowing it would mean two ways to write the same list, one of
       * which happens to work because the shared parser splits on commas -
       * the quiet second syntax this format is strict specifically to avoid.
       */
      if (feature.includes(',')) {
        fail(
          `Config file field "stack.features[${index}]" contains a comma.`,
          'List features as separate array entries: ["seo", "accessibility"].',
        );
      }
      return feature;
    });
  }

  return stack as DimensionInput & { preset?: string };
}
