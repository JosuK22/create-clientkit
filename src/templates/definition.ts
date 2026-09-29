import path from 'node:path';

import { PlanningError } from '../errors.js';
import {
  comparePlanPaths,
  isTextFile,
  normalisePlanPath,
  renameSpecialPath,
  toPosix,
} from '../generate/files.js';
import { defaultLayers, realPlanFs, walkLayer, type PlanFs } from '../generate/plan.js';
import { findTokens } from '../generate/tokens.js';
import type { TemplateMode } from '../types.js';
import {
  KNOWN_TOKENS,
  parseManifest,
  type PostStep,
  type TemplateManifest,
  type TemplateManifestDefaults,
  type TokenName,
} from './manifest.js';

/**
 * A template, as a first-class thing.
 *
 * ## What a template is
 *
 * The material a framework generates from: a `base/` layer and one layer per
 * starting mode (`modes/coming-soon`, `modes/full`) under one directory, plus
 * the manifest that says what it is. Styling systems, component libraries and
 * features are not templates. They are adapters that contribute their own
 * layers and files on top, and the compatibility engine decides which of them
 * a stack may combine.
 *
 * ## What this module adds, and what it reuses
 *
 * The contract already existed as `TemplateManifest`, validated strictly by
 * `parseManifest` - but only for the one template stored as `template.json`.
 * React's and Next's were object literals that nothing checked. A definition is
 * made from any manifest through the same validator, wherever it is stored, and
 * adds the three things the manifest left implicit:
 *
 *   - **source** - where the files come from, as data rather than an
 *     assumption. Only `built-in` exists today.
 *   - **variables** - the declared tokens, typed from one table.
 *   - **files** - what the template contributes, enumerated by the planner's
 *     own layer walk and checked with the plan's own path rules.
 *
 * Nothing here plans or writes. Files reach the filesystem only through the
 * Generation Plan and its executor.
 */

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * Where a template's files are read from.
 *
 * A discriminated union with one member on purpose: the definition names its
 * source instead of every consumer assuming "the directory next to the CLI".
 * A later source is a new member here and a new way to build a definition;
 * the planner, which only ever sees layer roots, does not change.
 */
export type TemplateSource = {
  readonly kind: 'built-in';
  /** Absolute directory holding `base/` and `modes/`. */
  readonly root: string;
};

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/**
 * How a variable's value is shaped. Only the shapes the shipped templates use:
 * free text, an optional URL, a locale, the starting mode, and the year.
 */
export type TemplateVariableType = 'text' | 'url' | 'locale' | 'mode' | 'year';

export interface TemplateVariable {
  readonly name: TokenName;
  readonly type: TemplateVariableType;
  /** A required variable never substitutes to an empty string. */
  readonly required: boolean;
  /** Where the CLI takes the value from. Never from the template itself. */
  readonly from: string;
}

/**
 * Every token the substitution engine knows, described once.
 *
 * Keyed by `TokenName`, so a token added to the engine does not compile until
 * it is described here. `required` is the engine's own rule restated as data -
 * `NULLABLE_TOKENS` in `tokens.ts` - and a test holds the two equal.
 */
export const TEMPLATE_VARIABLES: Readonly<Record<TokenName, Omit<TemplateVariable, 'name'>>> = {
  siteName: { type: 'text', required: true, from: 'site.name' },
  siteUrl: { type: 'url', required: false, from: 'site.url' },
  description: { type: 'text', required: true, from: 'site.description' },
  year: { type: 'year', required: true, from: 'the generation date' },
  projectName: { type: 'text', required: true, from: 'projectName' },
  author: { type: 'text', required: false, from: 'site.author' },
  locale: { type: 'locale', required: true, from: 'site.locale' },
  mode: { type: 'mode', required: true, from: 'the starting mode' },
};

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

export interface TemplateDefinition {
  /** Identity: stable, kebab-case, independent of any path. */
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  /**
   * The one compatibility fact a template states: the framework it is for.
   * Everything a framework fixes - build tool, language, routing - follows from
   * that framework's adapter; everything it leaves open is the compatibility
   * engine's to decide per stack. Neither is restated here.
   */
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly modes: readonly TemplateMode[];
  readonly defaults: TemplateManifestDefaults;
  readonly variables: readonly TemplateVariable[];
  /** What the generated project needs to run. The only requirement a template has today. */
  readonly requirements: { readonly node: string };
  readonly postSteps: readonly PostStep[];
  readonly nextSteps: readonly string[];
  /** Offered to users by name (`--template`, `--list-templates`). */
  readonly discoverable: boolean;
  readonly source: TemplateSource;
  /** The validated manifest, for the consumers that already read one. */
  readonly manifest: TemplateManifest;
}

export interface DefineOptions {
  readonly source: TemplateSource;
  readonly discoverable: boolean;
  /** Names the manifest in an error: a file path, or the adapter that declares it. */
  readonly label: string;
}

/**
 * A definition from a manifest, however it was stored.
 *
 * Runs `parseManifest` - the validator `template.json` has always gone through -
 * so a manifest declared in code gets exactly the same checks as one read from
 * disk. Then the one rule the manifest format did not enforce: a token declared
 * twice.
 */
export function defineTemplate(manifest: unknown, options: DefineOptions): TemplateDefinition {
  const parsed = parseManifest(manifest, options.label);

  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (seen.has(token)) {
      throw new PlanningError(
        `Invalid template manifest (${options.label}): token "${token}" is declared twice.`,
      );
    }
    seen.add(token);
  }
  if (!path.isAbsolute(options.source.root)) {
    throw new PlanningError(
      `Template "${parsed.id}" has a relative source root "${options.source.root}".`,
      { hint: 'A template source root must be absolute. This is a bug in ClientKit.' },
    );
  }

  return {
    id: parsed.id,
    version: parsed.version,
    displayName: parsed.displayName,
    description: parsed.description,
    framework: parsed.framework,
    frameworkVersion: parsed.frameworkVersion,
    modes: parsed.supportedModes,
    defaults: parsed.defaults,
    variables: parsed.tokens.map((name) => ({ name, ...TEMPLATE_VARIABLES[name] })),
    requirements: { node: parsed.minNode },
    postSteps: parsed.postSteps,
    nextSteps: parsed.nextSteps,
    discoverable: options.discoverable,
    source: options.source,
    manifest: parsed,
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface TemplateFile {
  /** Where it lands, canonical and inside the target. */
  readonly destination: string;
  /** Absolute file it is read from - the last layer that provides it. */
  readonly source: string;
  readonly kind: 'text' | 'binary';
  /** Every layer providing it, in order; later ones override or merge. */
  readonly layers: readonly string[];
}

/**
 * The files a template contributes for one mode, in plan order.
 *
 * Enumerated with the planner's own walk over the planner's own default layers
 * (`base`, then `modes/<mode>`), destinations renamed and ordered exactly as a
 * plan would. Every destination must pass the plan's path rules, so a template
 * can never name a file outside the target. Two files in one layer that land on
 * the same destination (`_gitignore` beside `.gitignore`) are a template bug;
 * the same destination in two layers is an override, which is the point of
 * layers. A text file may only use the variables the template declares.
 *
 * Reads the template; writes nothing. This is a description of the template,
 * not a second planner: the plan still decides contents, merging and what the
 * adapters layer on top.
 */
export function templateFiles(
  definition: TemplateDefinition,
  mode: TemplateMode,
  fs: PlanFs = realPlanFs,
): readonly TemplateFile[] {
  if (!definition.modes.includes(mode)) {
    throw new PlanningError(`Template "${definition.id}" does not support mode "${mode}".`, {
      hint: `Supported modes: ${definition.modes.join(', ')}.`,
    });
  }

  const declared = new Set<string>(definition.variables.map((variable) => variable.name));
  const byDestination = new Map<string, { source: string; layers: string[] }>();

  for (const layer of defaultLayers(definition.source.root, mode)) {
    const inLayer = new Map<string, string>();
    for (const file of walkLayer(fs, layer.root, layer.name)) {
      const destination = normalisePlanPath(renameSpecialPath(toPosix(file.rawRelativePath)));
      const clash = inLayer.get(destination);
      if (clash !== undefined) {
        throw new PlanningError(
          `Template "${definition.id}" has two files for "${destination}" in ${layer.name}: ` +
            `${clash} and ${file.rawRelativePath}.`,
          { hint: 'Each layer may provide a destination once. This is a bug in the template.' },
        );
      }
      inLayer.set(destination, file.rawRelativePath);

      if (isTextFile(destination)) {
        const undeclared = findTokens(fs.readText(file.absolutePath)).filter(
          (token) => (KNOWN_TOKENS as readonly string[]).includes(token) && !declared.has(token),
        );
        if (undeclared.length > 0) {
          throw new PlanningError(
            `Template "${definition.id}" uses ${undeclared.map((t) => `{{${t}}}`).join(', ')} in ` +
              `${layer.name}/${file.rawRelativePath}, which its manifest does not declare.`,
            { hint: 'Declare every token a template uses in its manifest "tokens" list.' },
          );
        }
      }

      const entry = byDestination.get(destination);
      if (entry === undefined) {
        byDestination.set(destination, { source: file.absolutePath, layers: [layer.name] });
      } else {
        entry.source = file.absolutePath;
        entry.layers.push(layer.name);
      }
    }
  }

  if (byDestination.size === 0) {
    throw new PlanningError(`Template "${definition.id}" produced no files.`, {
      hint: 'The template directory appears to be empty or missing from the package.',
    });
  }

  return [...byDestination]
    .map(([destination, entry]) => ({
      destination,
      source: entry.source,
      kind: isTextFile(destination) ? ('text' as const) : ('binary' as const),
      layers: entry.layers,
    }))
    .sort((a, b) => comparePlanPaths(a.destination, b.destination));
}
