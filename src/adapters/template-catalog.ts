import path from 'node:path';

import type { FrameworkId } from '../domain/dimensions.js';
import { FRAMEWORK_IDS } from '../domain/dimensions.js';
import { CliError, PlanningError } from '../errors.js';
import { comparePlanPaths } from '../generate/files.js';
import { realPlanFs, type PlanFs } from '../generate/plan.js';
import { defineTemplate, type TemplateDefinition } from '../templates/definition.js';
import {
  assertValidTemplate,
  compareIssues,
  toResult,
  validateTemplate,
  type TemplateIssue,
  type TemplateValidationResult,
} from '../templates/validation.js';
import type { TemplateMode } from '../types.js';
import type { AdapterRegistry } from './registry.js';

/**
 * Every template this build can generate from, validated, and the one way to
 * resolve a stack to its template.
 *
 * ## Where definitions come from
 *
 * From the framework adapters: each declares its template's manifest, and that
 * declaration is where a template's identity has lived since Stage 62. The
 * catalog asks every implemented framework for it, builds a definition through
 * the one validator, and refuses the whole build if two templates share an id
 * or a template claims a framework other than the adapter declaring it. Built
 * eagerly, so a malformed template fails at planning - before a single file is
 * written - and never half-generates a project.
 *
 * ## What resolving checks, and what it leaves alone
 *
 * The template exists, it is the one for the stack's framework, and it offers
 * the requested mode. That is all a template can be compatible or incompatible
 * with. Whether Bootstrap goes with Astro, or MUI with React Router, is a
 * question about the stack, answered by the compatibility engine for flags,
 * prompts and detection alike; the catalog does not ask it a second time.
 */

export interface TemplateRequest {
  readonly framework: FrameworkId;
  /** A specific template id, as `--template` or a recorded project names it. */
  readonly id?: string | undefined;
  readonly mode: TemplateMode;
}

export interface TemplateCatalog {
  /** Every definition, ordered by id. */
  list(): readonly TemplateDefinition[];
  has(id: string): boolean;
  /** Throws a CliError naming the available ids. */
  get(id: string): TemplateDefinition;
  /** The definition a stack generates from, checked against it. */
  resolve(request: TemplateRequest): TemplateDefinition;
}

function implemented(adapters: AdapterRegistry): readonly FrameworkId[] {
  return FRAMEWORK_IDS.filter((id) => {
    try {
      adapters.framework(id);
      return true;
    } catch {
      return false;
    }
  });
}

export interface InspectedCatalog {
  /** The definitions that passed, by framework, in `FRAMEWORK_IDS` order. */
  readonly definitions: ReadonlyMap<FrameworkId, TemplateDefinition>;
  /**
   * Every id a framework declares, valid or not. A broken declaration is still
   * a declaration, so its directory is not an orphan.
   */
  readonly declaredIds: ReadonlySet<string>;
  readonly issues: readonly TemplateIssue[];
}

/**
 * Every framework's declared template, and every problem with the set: a
 * manifest the validator refuses, a template claiming another framework than
 * the adapter declaring it, two templates sharing an id. `createTemplateCatalog`
 * throws the first; `validateTemplateCatalog` reports them all.
 */
export function inspectTemplateCatalog(
  adapters: AdapterRegistry,
  templatesRoot: string,
): InspectedCatalog {
  const definitions = new Map<FrameworkId, TemplateDefinition>();
  const byId = new Map<string, FrameworkId>();
  const declaredIds = new Set<string>();
  const issues: TemplateIssue[] = [];

  for (const framework of implemented(adapters)) {
    const adapter = adapters.framework(framework);
    const declaredId = adapter.templateManifest.id;
    if (typeof declaredId === 'string') declaredIds.add(declaredId);
    let definition: TemplateDefinition;
    try {
      definition = defineTemplate(adapter.templateManifest, {
        source: { kind: 'built-in', root: path.join(templatesRoot, declaredId) },
        discoverable: adapter.templateDiscoverable,
        label: `the ${framework} adapter's template`,
      });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      issues.push({
        code: 'manifest-invalid',
        severity: 'error',
        templateId: String(declaredId),
        message: error.message,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
      continue;
    }

    if (definition.framework !== framework) {
      issues.push({
        code: 'framework-owner',
        severity: 'error',
        templateId: definition.id,
        message:
          `The ${framework} adapter declares template "${definition.id}", which says it is for ` +
          `"${definition.framework}".`,
        hint: 'A template belongs to exactly one framework. This is a bug in ClientKit.',
      });
      continue;
    }
    const clash = byId.get(definition.id);
    if (clash !== undefined) {
      issues.push({
        code: 'id-duplicate',
        severity: 'error',
        templateId: definition.id,
        message: `Template id "${definition.id}" is declared for both ${clash} and ${framework}.`,
        hint: 'Template ids must be unique. This is a bug in ClientKit.',
      });
      continue;
    }
    byId.set(definition.id, framework);
    definitions.set(framework, definition);
  }

  return { definitions, declaredIds, issues };
}

export function createTemplateCatalog(
  adapters: AdapterRegistry,
  templatesRoot: string,
): TemplateCatalog {
  const inspected = inspectTemplateCatalog(adapters, templatesRoot);
  const [first] = [...inspected.issues].sort(compareIssues);
  if (first !== undefined) assertValidTemplate(toResult(first.templateId, [first]));

  const byFramework = inspected.definitions;
  const byId = new Map([...byFramework.values()].map((definition) => [definition.id, definition]));

  const ordered = [...byId.values()].sort((a, b) => comparePlanPaths(a.id, b.id));

  const get = (id: string): TemplateDefinition => {
    const definition = byId.get(id);
    if (definition !== undefined) return definition;
    throw new CliError(`Unknown template "${id}".`, {
      hint: `Available templates: ${ordered.map((entry) => entry.id).join(', ')}.`,
    });
  };

  return {
    list: () => ordered,
    has: (id) => byId.has(id),
    get,
    resolve({ framework, id, mode }) {
      const forStack = byFramework.get(framework);
      if (forStack === undefined) {
        throw new CliError(`ClientKit has no template for framework "${framework}".`);
      }
      const definition = id === undefined ? forStack : get(id);
      if (definition.framework !== framework) {
        throw new PlanningError(
          `Template "${definition.id}" is for ${definition.framework}, not ${framework}.`,
          { hint: `The ${framework} template is "${forStack.id}".` },
        );
      }
      if (!definition.modes.includes(mode)) {
        throw new PlanningError(`Template "${definition.id}" does not support mode "${mode}".`, {
          hint: `Supported modes: ${definition.modes.join(', ')}.`,
        });
      }
      return definition;
    },
  };
}

// ---------------------------------------------------------------------------
// Validating the whole catalog
// ---------------------------------------------------------------------------

export interface CatalogValidation {
  readonly valid: boolean;
  /** Problems with the set rather than with one template. */
  readonly catalog: readonly TemplateIssue[];
  /** Every declared template's own validation, ordered by id. */
  readonly templates: readonly TemplateValidationResult[];
}

/**
 * The catalog and every template in it, validated, every problem reported.
 *
 * Adds the one invariant only the whole set can check: every template
 * directory on disk - a directory with a `base/` layer - is one some framework
 * declares. The shared material beside the templates (`styling/`,
 * `ui-library/`, `feature/`) has no `base/` and is not a template. A template
 * nothing declares would ship in the package and never be generated from.
 */
export function validateTemplateCatalog(
  adapters: AdapterRegistry,
  templatesRoot: string,
  fs: PlanFs = realPlanFs,
): CatalogValidation {
  const inspected = inspectTemplateCatalog(adapters, templatesRoot);
  const catalog: TemplateIssue[] = [...inspected.issues];

  const declared = new Set([...inspected.declaredIds].map((id) => path.join(templatesRoot, id)));
  const onDisk = fs
    .readDir(templatesRoot)
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort(comparePlanPaths);
  for (const name of onDisk) {
    const dir = path.join(templatesRoot, name);
    if (declared.has(dir) || !fs.exists(path.join(dir, 'base'))) continue;
    catalog.push({
      code: 'catalog-orphan',
      severity: 'error',
      templateId: name,
      message: `templates/${name} looks like a template (it has a base/ layer), but no framework declares it.`,
      hint: 'Declare it on its framework adapter, or remove it from the package.',
    });
  }

  const templates = [...inspected.definitions.values()]
    .sort((a, b) => comparePlanPaths(a.id, b.id))
    .map((definition) => validateTemplate(definition, { fs }));
  const sortedCatalog = toResult('catalog', catalog);

  return {
    valid: sortedCatalog.valid && templates.every((result) => result.valid),
    catalog: [...sortedCatalog.errors, ...sortedCatalog.warnings],
    templates,
  };
}
