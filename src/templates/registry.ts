import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CliError } from '../errors.js';
import type { TemplateMode } from '../types.js';
import { parseManifest, type TemplateManifest } from './manifest.js';

export interface TemplateSummary {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly modes: readonly TemplateMode[];
}

/** The subset of ProjectContext a template is allowed to supply defaults for. */
export interface TemplateDefaults {
  readonly mode?: TemplateMode;
  readonly locale?: string;
  readonly description?: string;
}

export interface TemplateRegistry {
  list(): readonly TemplateSummary[];
  has(id: string): boolean;
  defaultsFor(id: string): TemplateDefaults;
  /** Throws a CliError when the id is unknown. */
  get(id: string): TemplateManifest;
  /** Absolute path to the template's directory (containing base/ and modes/). */
  rootFor(id: string): string;
  supportsMode(id: string, mode: TemplateMode): boolean;
}

/**
 * Locates the shipped `templates/` directory.
 *
 * Templates travel inside the npm tarball and are never downloaded. The
 * directory sits beside the bundle in a published install
 * (`<pkg>/dist/cli.js` -> `<pkg>/templates`) and at the repo root during
 * development (`src/templates/registry.ts` -> `<repo>/templates`), so the
 * anchor is found by walking up rather than by a fixed relative path.
 */
export function findTemplatesRoot(startDir?: string): string {
  const start = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(current, 'templates');
    if (existsSync(path.join(candidate, 'astro-tailwind', 'template.json'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new CliError('Could not locate the bundled templates directory.', {
    hint: 'This usually means the package was installed incompletely. Try reinstalling create-clientkit.',
  });
}

function readManifest(templateDir: string): TemplateManifest {
  const manifestPath = path.join(templateDir, 'template.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new CliError(`Could not read template manifest at ${manifestPath}.`, {
      cause: error,
      hint: (error as Error).message,
    });
  }
  const manifest = parseManifest(raw, `${path.basename(templateDir)}/template.json`);
  if (manifest.id !== path.basename(templateDir)) {
    throw new CliError(
      `Template manifest id "${manifest.id}" does not match its directory "${path.basename(templateDir)}".`,
    );
  }
  return manifest;
}

/**
 * Discovers templates from disk once, then answers from memory.
 *
 * Discovery is eager and strict: a malformed manifest fails immediately rather
 * than at generation time, so a broken template can never half-generate a
 * project.
 */
export function createRegistry(templatesRoot?: string): TemplateRegistry {
  const root = templatesRoot ?? findTemplatesRoot();

  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const manifests = new Map<string, TemplateManifest>();
  for (const name of entries) {
    const dir = path.join(root, name);
    if (!existsSync(path.join(dir, 'template.json'))) continue;
    const manifest = readManifest(dir);
    manifests.set(manifest.id, manifest);
  }

  const requireTemplate = (id: string): TemplateManifest => {
    const manifest = manifests.get(id);
    if (!manifest) {
      const available = [...manifests.keys()];
      throw new CliError(`Unknown template "${id}".`, {
        hint:
          available.length === 0
            ? 'No templates are available yet.'
            : `Available templates: ${available.join(', ')}.`,
      });
    }
    return manifest;
  };

  return {
    list: () =>
      [...manifests.values()].map((manifest) => ({
        id: manifest.id,
        displayName: manifest.displayName,
        description: manifest.description,
        version: manifest.version,
        modes: manifest.supportedModes,
      })),
    has: (id) => manifests.has(id),
    get: requireTemplate,
    defaultsFor: (id) => manifests.get(id)?.defaults ?? {},
    rootFor: (id) => {
      requireTemplate(id);
      return path.join(root, id);
    },
    supportsMode: (id, mode) => manifests.get(id)?.supportedModes.includes(mode) ?? false,
  };
}

/** Retained for tests that need a registry with nothing in it. */
export const emptyRegistry: TemplateRegistry = {
  list: () => [],
  has: () => false,
  defaultsFor: () => ({}),
  get: (id) => {
    throw new CliError(`Unknown template "${id}".`, { hint: 'No templates are available yet.' });
  },
  rootFor: (id) => {
    throw new CliError(`Unknown template "${id}".`, { hint: 'No templates are available yet.' });
  },
  supportsMode: () => false,
};
