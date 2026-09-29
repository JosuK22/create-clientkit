import path from 'node:path';

import type { FrameworkId } from '../domain/dimensions.js';
import { FRAMEWORK_IDS } from '../domain/dimensions.js';
import { CliError, PlanningError } from '../errors.js';
import { comparePlanPaths } from '../generate/files.js';
import { defineTemplate, type TemplateDefinition } from '../templates/definition.js';
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

export function createTemplateCatalog(
  adapters: AdapterRegistry,
  templatesRoot: string,
): TemplateCatalog {
  const byId = new Map<string, TemplateDefinition>();
  const byFramework = new Map<FrameworkId, TemplateDefinition>();

  for (const framework of implemented(adapters)) {
    const adapter = adapters.framework(framework);
    const definition = defineTemplate(adapter.templateManifest, {
      source: { kind: 'built-in', root: path.join(templatesRoot, adapter.templateManifest.id) },
      discoverable: adapter.templateDiscoverable,
      label: `the ${framework} adapter's template`,
    });

    if (definition.framework !== framework) {
      throw new PlanningError(
        `The ${framework} adapter declares template "${definition.id}", which says it is for ` +
          `"${definition.framework}".`,
        { hint: 'A template belongs to exactly one framework. This is a bug in ClientKit.' },
      );
    }
    const clash = byId.get(definition.id);
    if (clash !== undefined) {
      throw new PlanningError(
        `Template id "${definition.id}" is declared for both ${clash.framework} and ${framework}.`,
        { hint: 'Template ids must be unique. This is a bug in ClientKit.' },
      );
    }
    byId.set(definition.id, definition);
    byFramework.set(framework, definition);
  }

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
