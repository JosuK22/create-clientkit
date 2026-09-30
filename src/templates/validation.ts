import path from 'node:path';

import { validateLocale } from '../context/validate.js';
import { PlanningError } from '../errors.js';
import {
  comparePlanPaths,
  isTextFile,
  normalisePlanPath,
  renameSpecialPath,
  toPosix,
} from '../generate/files.js';
import { defaultLayers, realPlanFs, walkLayer, type PlanFs } from '../generate/plan.js';
import { PROVENANCE_FILE } from '../generate/provenance.js';
import { findTokens } from '../generate/tokens.js';
import type { TemplateMode } from '../types.js';
import type { TemplateDefinition, TemplateFile } from './definition.js';
import { KNOWN_TOKENS } from './manifest.js';

/**
 * Template validation: one validator, returning every problem at once.
 *
 * ## Three kinds of check, one result
 *
 *   - **structural** - is the manifest well-formed. That is `parseManifest`,
 *     run by `defineTemplate`; a manifest that fails it never becomes a
 *     definition, so nothing here repeats it.
 *   - **semantic** - does the template agree with itself: its files with its
 *     modes, its tokens with its declaration, its destinations with the plan's
 *     rules, its requirements with what the CLI can read. This module.
 *   - **plan and package** - does it produce a valid Generation Plan, and does
 *     the installed package serve the same template. Those need the adapters,
 *     so they live beside the catalog (`verifyTemplatePlans`) and in the
 *     packaged smoke test.
 *
 * ## One walk
 *
 * `inspectTemplateFiles` is the only code that turns a template directory into
 * a file list. Stage 4's `templateFiles` throws its first issue; this module
 * reports them all. The rules are written once.
 *
 * Everything here reads. Nothing is written, installed or run, and nothing is
 * fetched.
 */

export type TemplateIssueCode =
  /** The requested mode is not one the template declares. */
  | 'mode-unsupported'
  /** A declared mode has no files of its own. */
  | 'mode-incomplete'
  /** The template root or its `base/` layer does not exist. */
  | 'source-missing'
  /** A source resolves, through a link, outside the template's directory. */
  | 'source-outside-root'
  /** A source is listed but cannot be read as a file. */
  | 'source-unreadable'
  /** A destination would leave the target directory. */
  | 'destination-unsafe'
  /** A destination no supported operating system can create. */
  | 'destination-name'
  /** A destination the CLI writes itself. */
  | 'destination-reserved'
  /** One layer provides a destination twice. */
  | 'layer-duplicate'
  /** A destination is a file in one layer and a directory in another. */
  | 'layer-file-directory'
  /** A file uses a known token the manifest does not declare. */
  | 'token-undeclared'
  /** A declared token no file of the template uses. */
  | 'token-unused'
  /** The template has no files at all. */
  | 'template-empty'
  /** `minNode` is not a range the CLI can check. */
  | 'requirement-node'
  /** `defaults.locale` is not a valid locale tag. */
  | 'default-locale'
  // ---- catalog: reported by the template catalog --------------------------
  /** A declared manifest fails the manifest validator. */
  | 'manifest-invalid'
  /** A template claims a framework other than the adapter declaring it. */
  | 'framework-owner'
  /** Two templates share an id. */
  | 'id-duplicate'
  /** A template directory on disk that no framework declares. */
  | 'catalog-orphan'
  // ---- plan: reported by building the template's Generation Plan ----------
  /** The framework's default stack cannot be planned from the template. */
  | 'plan-invalid'
  /** Planning the same input twice gave different plans. */
  | 'plan-nondeterministic'
  /** A planned copy reads from outside the shipped templates. */
  | 'plan-source-outside'
  /** The recorded `frameworkVersion` is not the version the adapter installs. */
  | 'framework-version';

export interface TemplateIssue {
  readonly code: TemplateIssueCode;
  readonly severity: 'error' | 'warning';
  readonly templateId: string;
  /** The sentence to show: what is wrong, where. */
  readonly message: string;
  /** What to change. */
  readonly hint?: string;
  readonly mode?: TemplateMode;
  /** The layer, and the path inside it, of the file concerned. */
  readonly source?: string;
  readonly destination?: string;
  readonly variable?: string;
}

export interface TemplateValidationResult {
  readonly templateId: string;
  readonly valid: boolean;
  readonly errors: readonly TemplateIssue[];
  readonly warnings: readonly TemplateIssue[];
}

/**
 * The order issues are reported in: errors first, then by mode, file and
 * code, through the plan's pinned collator. Never the order a directory
 * happened to be listed in.
 */
export function compareIssues(a: TemplateIssue, b: TemplateIssue): number {
  const severity = (issue: TemplateIssue): number => (issue.severity === 'error' ? 0 : 1);
  return (
    severity(a) - severity(b) ||
    comparePlanPaths(a.templateId, b.templateId) ||
    comparePlanPaths(a.mode ?? '', b.mode ?? '') ||
    comparePlanPaths(a.destination ?? a.source ?? '', b.destination ?? b.source ?? '') ||
    comparePlanPaths(a.code, b.code) ||
    comparePlanPaths(a.message, b.message)
  );
}

export function toResult(
  templateId: string,
  issues: readonly TemplateIssue[],
): TemplateValidationResult {
  const sorted = [...issues].sort(compareIssues);
  const errors = sorted.filter((issue) => issue.severity === 'error');
  return {
    templateId,
    valid: errors.length === 0,
    errors,
    warnings: sorted.filter((issue) => issue.severity === 'warning'),
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Names Windows cannot create, whatever the extension - `con.txt` included -
 * and characters it refuses. ClientKit is tested on Windows, macOS and Linux,
 * so a destination has to be valid on all three.
 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTER = /[<>:"|?*\u0000-\u001f]/;

function badSegment(destination: string): string | undefined {
  for (const segment of destination.split('/')) {
    if (RESERVED_NAME.test(segment)) return `"${segment}" is a reserved name on Windows`;
    if (FORBIDDEN_CHARACTER.test(segment))
      return `"${segment}" contains a character Windows forbids`;
    if (/[. ]$/.test(segment)) return `"${segment}" ends in a dot or a space, which Windows drops`;
  }
  return undefined;
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

export interface InspectedFiles {
  readonly files: readonly TemplateFile[];
  readonly issues: readonly TemplateIssue[];
  /** Declared tokens a file used, for the unused-token rule. */
  readonly used: ReadonlySet<string>;
}

/**
 * The files a template contributes for one mode, and every problem with them.
 *
 * The planner's own walk over the planner's own default layers, destinations
 * renamed and checked by the plan's own `normalisePlanPath`. A file with an
 * unusable destination is reported and left out of the list; the rest is
 * still inspected, so one run names every problem.
 */
export function inspectTemplateFiles(
  definition: TemplateDefinition,
  mode: TemplateMode,
  fs: PlanFs = realPlanFs,
): InspectedFiles {
  const issues: TemplateIssue[] = [];
  const used = new Set<string>();
  const issue = (fields: Omit<TemplateIssue, 'templateId' | 'mode'>): void => {
    issues.push({ templateId: definition.id, mode, ...fields });
  };

  if (!definition.modes.includes(mode)) {
    issue({
      code: 'mode-unsupported',
      severity: 'error',
      message: `Template "${definition.id}" does not support mode "${mode}".`,
      hint: `Supported modes: ${definition.modes.join(', ')}.`,
    });
    return { files: [], issues, used };
  }

  const root = definition.source.root;
  const layers = defaultLayers(root, mode);
  const [baseLayer] = layers;
  if (!fs.exists(root) || (baseLayer !== undefined && !fs.exists(baseLayer.root))) {
    issue({
      code: 'source-missing',
      severity: 'error',
      message: `Template "${definition.id}" has no ${fs.exists(root) ? 'base/ layer' : 'directory'} at ${root}.`,
      hint: 'The template directory is missing from the package, or the manifest names the wrong id.',
    });
    return { files: [], issues, used };
  }
  const realRoot = fs.realpath?.(root) ?? root;

  const declared = new Set<string>(definition.variables.map((variable) => variable.name));
  const byDestination = new Map<string, { source: string; layers: string[] }>();
  const modeLayer = `modes/${mode}`;
  // Entries the walk met, usable or not: "empty" and "incomplete" mean there
  // was nothing there at all, not that what was found was refused for another
  // reason - that reason is its own issue.
  let walked = 0;
  let modeFiles = 0;

  for (const layer of layers) {
    const inLayer = new Map<string, string>();
    for (const file of walkLayer(fs, layer.root, layer.name)) {
      walked += 1;
      if (layer.name === modeLayer) modeFiles += 1;
      const where = `${layer.name}/${file.rawRelativePath}`;

      let destination: string;
      try {
        destination = normalisePlanPath(renameSpecialPath(toPosix(file.rawRelativePath)));
      } catch (error) {
        issue({
          code: 'destination-unsafe',
          severity: 'error',
          message: (error as Error).message,
          hint: 'Generated files must stay inside the target directory.',
          source: where,
        });
        continue;
      }

      const badName = badSegment(destination);
      if (badName !== undefined) {
        issue({
          code: 'destination-name',
          severity: 'error',
          message: `Template "${definition.id}" writes "${destination}", but ${badName}.`,
          hint: 'Rename the file so it can be created on Windows, macOS and Linux.',
          source: where,
          destination,
        });
      }
      if (destination === PROVENANCE_FILE) {
        issue({
          code: 'destination-reserved',
          severity: 'error',
          message: `Template "${definition.id}" provides "${destination}", which ClientKit writes itself.`,
          hint: 'Remove the file from the template; the CLI records the project there.',
          source: where,
          destination,
        });
      }

      const clash = inLayer.get(destination);
      if (clash !== undefined) {
        issue({
          code: 'layer-duplicate',
          severity: 'error',
          message:
            `Template "${definition.id}" has two files for "${destination}" in ${layer.name}: ` +
            `${clash} and ${file.rawRelativePath}.`,
          hint: 'Each layer may provide a destination once. This is a bug in the template.',
          source: where,
          destination,
        });
        continue;
      }
      inLayer.set(destination, file.rawRelativePath);

      let realSource: string;
      try {
        realSource = fs.realpath?.(file.absolutePath) ?? file.absolutePath;
      } catch (error) {
        issue({
          code: 'source-unreadable',
          severity: 'error',
          message: `Template "${definition.id}" lists ${where}, which does not resolve: ${(error as Error).message}`,
          hint: 'A broken link or a file removed mid-walk. Every entry in a layer must be a real file.',
          source: where,
          destination,
        });
        continue;
      }
      if (!isInside(realRoot, realSource)) {
        issue({
          code: 'source-outside-root',
          severity: 'error',
          message: `Template "${definition.id}" reads ${where} from outside its directory (${realSource}).`,
          hint: 'Template files must live inside the template directory; replace the link with the file.',
          source: where,
          destination,
        });
        continue;
      }

      if (isTextFile(destination)) {
        let content: string;
        try {
          content = fs.readText(file.absolutePath);
        } catch (error) {
          issue({
            code: 'source-unreadable',
            severity: 'error',
            message: `Template "${definition.id}" cannot read ${where}: ${(error as Error).message}`,
            hint: 'Every entry in a template layer must be a readable file.',
            source: where,
            destination,
          });
          continue;
        }
        const tokens = findTokens(content).filter((token) =>
          (KNOWN_TOKENS as readonly string[]).includes(token),
        );
        const undeclared = tokens.filter((token) => !declared.has(token));
        for (const token of tokens) if (declared.has(token)) used.add(token);
        if (undeclared.length > 0) {
          issue({
            code: 'token-undeclared',
            severity: 'error',
            message:
              `Template "${definition.id}" uses ${undeclared.map((t) => `{{${t}}}`).join(', ')} in ` +
              `${where}, which its manifest does not declare.`,
            hint: 'Declare every token a template uses in its manifest "tokens" list.',
            source: where,
            destination,
            ...(undeclared.length === 1 && undeclared[0] !== undefined
              ? { variable: undeclared[0] }
              : {}),
          });
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

  // A path that is a file in one layer and a directory in another cannot be
  // written: whichever the executor meets second fails.
  const destinations = [...byDestination.keys()].sort(comparePlanPaths);
  for (const destination of destinations) {
    const nested = destinations.find((other) => other.startsWith(`${destination}/`));
    if (nested !== undefined) {
      issue({
        code: 'layer-file-directory',
        severity: 'error',
        message:
          `Template "${definition.id}" has "${destination}" as a file and as the directory ` +
          `holding "${nested}".`,
        hint: 'Rename one of them; a path cannot be both.',
        destination,
      });
    }
  }

  if (walked === 0) {
    issue({
      code: 'template-empty',
      severity: 'error',
      message: `Template "${definition.id}" produced no files.`,
      hint: 'The template directory appears to be empty or missing from the package.',
    });
  } else if (modeFiles === 0) {
    issue({
      code: 'mode-incomplete',
      severity: 'error',
      message: `Template "${definition.id}" declares mode "${mode}" but has no files under ${modeLayer}/.`,
      hint: `Add the ${mode} starter's files, or remove "${mode}" from "supportedModes".`,
    });
  }

  const files = [...byDestination]
    .map(([destination, entry]) => ({
      destination,
      source: entry.source,
      kind: isTextFile(destination) ? ('text' as const) : ('binary' as const),
      layers: entry.layers,
    }))
    .sort((a, b) => comparePlanPaths(a.destination, b.destination));

  return { files, issues, used };
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  readonly fs?: PlanFs;
  /**
   * The modes to check. All declared modes by default. Generation checks only
   * the one it is about to plan, which is also why the unused-token rule -
   * which needs every mode to judge - runs only when all are checked.
   */
  readonly modes?: readonly TemplateMode[];
}

/** A Node range the CLI can check: `create` strips `>=` and compares versions. */
const NODE_RANGE = /^>=\d+\.\d+\.\d+$/;

/** Every problem with a definition, as one deterministic result. */
export function validateTemplate(
  definition: TemplateDefinition,
  options: ValidateOptions = {},
): TemplateValidationResult {
  const fs = options.fs ?? realPlanFs;
  const modes = options.modes ?? definition.modes;
  const issues: TemplateIssue[] = [];
  const used = new Set<string>();

  if (!NODE_RANGE.test(definition.requirements.node)) {
    issues.push({
      code: 'requirement-node',
      severity: 'error',
      templateId: definition.id,
      message:
        `Template "${definition.id}" requires Node "${definition.requirements.node}", ` +
        'which is not a range ClientKit can check.',
      hint: 'Write "minNode" as ">=MAJOR.MINOR.PATCH", for example ">=22.12.0".',
    });
  }

  const locale = definition.defaults.locale;
  const localeProblem = locale === undefined ? null : validateLocale(locale);
  if (localeProblem !== null) {
    issues.push({
      code: 'default-locale',
      severity: 'error',
      templateId: definition.id,
      message: `Template "${definition.id}" defaults to locale "${locale}": ${localeProblem}`,
      hint: 'Use a BCP-47 tag such as "en" or "en-GB".',
    });
  }

  let filesClean = true;
  for (const mode of modes) {
    const inspected = inspectTemplateFiles(definition, mode, fs);
    issues.push(...inspected.issues);
    if (inspected.issues.some((issue) => issue.severity === 'error')) filesClean = false;
    for (const token of inspected.used) used.add(token);
  }

  // Usage can only be judged from every mode's files, all of them read: a
  // missing or unreadable file would make every token it uses look unused.
  const everyMode = definition.modes.every((mode) => modes.includes(mode));
  if (everyMode && filesClean) {
    for (const variable of definition.variables) {
      if (used.has(variable.name)) continue;
      issues.push({
        code: 'token-unused',
        severity: 'warning',
        templateId: definition.id,
        message: `Template "${definition.id}" declares {{${variable.name}}}, but no file of it uses it.`,
        hint: `Remove "${variable.name}" from the manifest "tokens" list, or use it.`,
        variable: variable.name,
      });
    }
  }

  return toResult(definition.id, issues);
}

/**
 * Throws when a result has errors: the first as the message, the rest in the
 * hint, as the `PlanningError` the CLI already reports. Warnings never throw.
 */
export function assertValidTemplate(result: TemplateValidationResult): void {
  const [first, ...rest] = result.errors;
  if (first === undefined) return;
  const more =
    rest.length === 0
      ? ''
      : `\n${rest.length} more problem${rest.length === 1 ? '' : 's'}:\n` +
        rest.map((issue) => `  - ${issue.message}`).join('\n');
  throw new PlanningError(first.message, {
    hint: `${first.hint ?? 'This is a bug in the template.'}${more}`,
  });
}

/** One line per issue, for a maintainer reading a validation run. */
export function formatValidation(result: TemplateValidationResult): string {
  const lines = [`${result.templateId}: ${result.valid ? 'VALID' : 'INVALID'}`];
  for (const issue of [...result.errors, ...result.warnings]) {
    lines.push(`  ${issue.severity} ${issue.code}: ${issue.message}`);
    if (issue.hint !== undefined) lines.push(`    ${issue.hint}`);
  }
  return lines.join('\n');
}
