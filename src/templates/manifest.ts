import { CliError } from '../errors.js';
import { TEMPLATE_MODES, type TemplateMode } from '../types.js';

/**
 * Post-steps a template may request. These are identifiers, not commands: each
 * maps to a fixed, CLI-owned implementation. A template can never supply a
 * shell string, an executable path or arguments.
 */
export const POST_STEPS = ['install', 'git-init', 'format'] as const;
export type PostStep = (typeof POST_STEPS)[number];

/** Tokens the substitution engine knows about. Anything else is an error. */
export const KNOWN_TOKENS = [
  'siteName',
  'siteUrl',
  'description',
  'year',
  'projectName',
  'author',
  'locale',
  'mode',
] as const;
export type TokenName = (typeof KNOWN_TOKENS)[number];

export interface TemplateManifestDefaults {
  readonly mode?: TemplateMode;
  readonly locale?: string;
  readonly description?: string;
}

export interface TemplateManifest {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly minNode: string;
  readonly supportedModes: readonly TemplateMode[];
  readonly defaults: TemplateManifestDefaults;
  readonly availableFeatures: readonly string[];
  readonly tokens: readonly TokenName[];
  readonly postSteps: readonly PostStep[];
  readonly nextSteps: readonly string[];
}

const REQUIRED_KEYS = [
  'id',
  'displayName',
  'description',
  'version',
  'framework',
  'frameworkVersion',
  'minNode',
  'supportedModes',
  'defaults',
  'availableFeatures',
  'tokens',
  'postSteps',
  'nextSteps',
] as const;

const DEFAULTS_KEYS = ['mode', 'locale', 'description'] as const;

function fail(source: string, message: string, hint?: string): never {
  throw new CliError(`Invalid template manifest (${source}): ${message}`, {
    ...(hint === undefined ? {} : { hint }),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, key: string, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(source, `"${key}" must be a non-empty string.`);
  }
  return value;
}

function expectStringArray(value: unknown, key: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(source, `"${key}" must be an array of strings.`);
  }
  return value as string[];
}

/**
 * Strictly validates a parsed template.json.
 *
 * Unknown keys are rejected rather than ignored: a typo in a manifest must not
 * silently disable a feature. Nothing here executes template-supplied data.
 */
export function parseManifest(raw: unknown, source: string): TemplateManifest {
  if (!isPlainObject(raw)) fail(source, 'the manifest must be a JSON object.');

  for (const key of REQUIRED_KEYS) {
    if (raw[key] === undefined) fail(source, `missing required key "${key}".`);
  }
  for (const key of Object.keys(raw)) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(key)) {
      fail(source, `unknown key "${key}".`, `Allowed keys: ${REQUIRED_KEYS.join(', ')}.`);
    }
  }

  const id = expectString(raw['id'], 'id', source);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    fail(source, `"id" must be lowercase kebab-case, got "${id}".`);
  }

  const supportedModes = expectStringArray(raw['supportedModes'], 'supportedModes', source);
  if (supportedModes.length === 0) fail(source, '"supportedModes" cannot be empty.');
  for (const mode of supportedModes) {
    if (!(TEMPLATE_MODES as readonly string[]).includes(mode)) {
      fail(source, `unsupported mode "${mode}" in "supportedModes".`);
    }
  }

  const tokens = expectStringArray(raw['tokens'], 'tokens', source);
  for (const token of tokens) {
    if (!(KNOWN_TOKENS as readonly string[]).includes(token)) {
      fail(source, `unknown token "${token}".`, `Known tokens: ${KNOWN_TOKENS.join(', ')}.`);
    }
  }

  const postSteps = expectStringArray(raw['postSteps'], 'postSteps', source);
  for (const step of postSteps) {
    if (!(POST_STEPS as readonly string[]).includes(step)) {
      fail(
        source,
        `unknown post-step "${step}".`,
        `Templates may only request CLI-owned steps: ${POST_STEPS.join(', ')}. Arbitrary commands are not supported.`,
      );
    }
  }

  const availableFeatures = expectStringArray(
    raw['availableFeatures'],
    'availableFeatures',
    source,
  );
  if (availableFeatures.length > 0) {
    fail(source, 'feature overlays are not supported in V1; "availableFeatures" must be empty.');
  }

  const nextSteps = expectStringArray(raw['nextSteps'], 'nextSteps', source);

  const rawDefaults = raw['defaults'];
  if (!isPlainObject(rawDefaults)) fail(source, '"defaults" must be an object.');
  for (const key of Object.keys(rawDefaults)) {
    if (!(DEFAULTS_KEYS as readonly string[]).includes(key)) {
      fail(source, `unknown key "${key}" in "defaults".`);
    }
  }

  const defaults: TemplateManifestDefaults = {};
  if (rawDefaults['mode'] !== undefined) {
    const mode = expectString(rawDefaults['mode'], 'defaults.mode', source);
    if (!(TEMPLATE_MODES as readonly string[]).includes(mode)) {
      fail(source, `unknown mode "${mode}" in "defaults.mode".`);
    }
    if (!supportedModes.includes(mode)) {
      fail(source, `"defaults.mode" (${mode}) is not listed in "supportedModes".`);
    }
    (defaults as { mode?: TemplateMode }).mode = mode as TemplateMode;
  }
  if (rawDefaults['locale'] !== undefined) {
    (defaults as { locale?: string }).locale = expectString(
      rawDefaults['locale'],
      'defaults.locale',
      source,
    );
  }
  if (rawDefaults['description'] !== undefined) {
    (defaults as { description?: string }).description = expectString(
      rawDefaults['description'],
      'defaults.description',
      source,
    );
  }

  return {
    id,
    displayName: expectString(raw['displayName'], 'displayName', source),
    description: expectString(raw['description'], 'description', source),
    version: expectString(raw['version'], 'version', source),
    framework: expectString(raw['framework'], 'framework', source),
    frameworkVersion: expectString(raw['frameworkVersion'], 'frameworkVersion', source),
    minNode: expectString(raw['minNode'], 'minNode', source),
    supportedModes: supportedModes as readonly TemplateMode[],
    defaults,
    availableFeatures,
    tokens: tokens as readonly TokenName[],
    postSteps: postSteps as readonly PostStep[],
    nextSteps,
  };
}
