import path from 'node:path';

import { collectBuildPlugins, emitViteConfig } from '../domain/build-config.js';
import type { ConfigContribution, Contribution } from '../domain/contributions.js';
import { manifestFromProjectContext } from '../domain/manifest.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import { definesRole } from '../domain/roles.js';
import { CliError } from '../errors.js';
import type { FileOperation, GenerationPlan } from '../generate/files.js';
import { plan, type PlanFs, type PlanLayer } from '../generate/plan.js';
import type { TemplateManifest } from '../templates/manifest.js';
import type { TemplateRegistry } from '../templates/registry.js';
import type { ProjectContext, TemplateMode } from '../types.js';
import { createAdapterRegistry } from './registry.js';
import { resolveProject } from './selection.js';

/**
 * The bridge between V1 generation and the V2 adapter model.
 *
 *     ProjectManifest
 *           ↓  selection + compatibility + resolution   (Stage 3)
 *     ResolvedProject
 *           ↓  adapters contribute
 *     Contribution[]
 *           ↓  template layers      ↓  config contributions
 *         plan()                  composed files
 *           └───────────┬───────────┘
 *                       ↓
 *                FileOperation[]
 *
 * The direction still matters: V1 types flow into V2, never the other way.
 * Nothing in `src/context/`, `src/templates/` or `src/generate/` imports this
 * module, so the CLI runs the V1 path exactly as it always has and everything
 * here is reachable only from tests.
 *
 * ## What this bridge still does not do
 *
 * `package.json` is composed from template `_package.json` layers, as in V1 -
 * the dependency and script contributions are declared and asserted against the
 * templates but not yet used to build the file. That is the composition work a
 * later stage covers.
 *
 * The manifest carries no `cliVersion` or `generatedAt`, so planning still
 * needs those alongside it. `plan()` is a V1-shaped function and this shim
 * feeds it a `ProjectContext`; making planning fully manifest-driven is a
 * deliberate later step.
 */

export interface AdapterPlanOptions {
  readonly registry: TemplateRegistry;
  readonly fs?: PlanFs;
  readonly now?: Date;
}

export interface AdapterPlanResult {
  readonly plan: GenerationPlan;
  readonly manifest: ProjectManifest;
  readonly project: ResolvedProject;
  readonly contributions: readonly Contribution[];
}

/** Resolves the adapters for a manifest and collects their contributions. */
export function resolveWithAdapters(
  manifest: ProjectManifest,
  templatesRoot: string,
): { project: ResolvedProject; contributions: readonly Contribution[] } {
  const registry = createAdapterRegistry(templatesRoot);
  const { project, selection } = resolveProject(manifest, registry);

  return {
    project,
    contributions: selection.adapters.map(({ adapter }) => adapter.contribute(project)),
  };
}

/** Every template layer the contributions ask for, in a deterministic order. */
export function layersFrom(contributions: readonly Contribution[]): readonly PlanLayer[] {
  return (
    contributions
      .flatMap((contribution) => contribution.templateLayers)
      .slice()
      // `order` first, then `owner` so the result never depends on which adapter
      // happened to be iterated first.
      .sort((a, b) => a.order - b.order || a.owner.localeCompare(b.owner))
      .map((layer) => ({ name: layer.name, root: layer.root }))
  );
}

/**
 * Files composed from configuration contributions rather than template layers.
 *
 * Driven entirely by file roles. An architecture that maps `config.build` gets
 * a build configuration composed from whatever the selected adapters
 * contributed; one that does not - Astro - gets nothing, with no branch on the
 * framework anywhere. That is what lets the Tailwind adapter register its
 * plugin for React without knowing React exists, and without disturbing Astro.
 */
export function composedFiles(
  project: ResolvedProject,
  contributions: readonly Contribution[],
): readonly FileOperation[] {
  const config: ConfigContribution[] = contributions.flatMap((contribution) => contribution.config);
  if (config.length === 0) return [];

  const targeted = config.filter((entry) => entry.target === 'config.build');
  if (targeted.length === 0) return [];

  if (!definesRole(project.architecture, 'config.build')) {
    // An architecture with no separate build-configuration file registers
    // plugins its own way. Astro is the case in hand: its build config is
    // `astro.config.mjs` under `config.framework`, and the Tailwind plugin is
    // already registered there by the template - the legacy coupling Stage 2
    // recorded. Composing a second file would duplicate it.
    //
    // This is a skip rather than an error on purpose. Tailwind's contribution
    // is framework-blind by design, so it will always be offered to
    // architectures that cannot use it, and treating that as a failure would
    // punish the adapter for being decoupled. The risk it carries - a future
    // architecture forgetting to map the role and silently losing its plugins -
    // is covered by generating and building a real project, which is where a
    // missing plugin surfaces immediately.
    return [];
  }

  const plugins = collectBuildPlugins(targeted);
  return [
    {
      type: 'write',
      path: project.architecture.roles['config.build'] ?? 'vite.config.ts',
      content: emitViteConfig(plugins),
      origin: `composed from ${plugins.map(({ owner }) => owner).join(' + ')}`,
    },
  ];
}

/**
 * Merges composed files into a planned set, refusing to overwrite silently.
 *
 * A template layer and a config contribution both claiming the same path is a
 * genuine ownership collision between different authors, and V1's last-layer-
 * wins rule is the wrong answer for it. Reported rather than resolved.
 */
export function mergeComposed(
  operations: readonly FileOperation[],
  composed: readonly FileOperation[],
): readonly FileOperation[] {
  const existing = new Map(operations.map((operation) => [operation.path, operation]));

  for (const file of composed) {
    const clash = existing.get(file.path);
    if (clash !== undefined) {
      throw new CliError(`Two owners both claim "${file.path}".`, {
        hint:
          `It is produced by ${clash.origin} and by ${file.origin}. ` +
          'Exactly one of them should own the file.',
      });
    }
    existing.set(file.path, file);
  }

  // Same ordering rule as plan(): sorted by path, so composed files land where
  // they would have had they come from a template.
  return [...existing.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A registry view that also answers for a framework whose template is not on
 * disk in a form the V1 registry discovers.
 *
 * `plan()` asks for a `TemplateManifest` and a template root. Astro's come from
 * the V1 disk registry unchanged; React's come from its adapter, because giving
 * its directory a `template.json` would list it in the V1 CLI.
 */
function registryFor(
  base: TemplateRegistry,
  templatesRoot: string,
  manifest: TemplateManifest | undefined,
): TemplateRegistry {
  if (manifest === undefined) return base;
  return {
    ...base,
    has: (id) => id === manifest.id || base.has(id),
    get: (id) => (id === manifest.id ? manifest : base.get(id)),
    rootFor: (id) =>
      id === manifest.id ? path.join(templatesRoot, manifest.id) : base.rootFor(id),
    supportsMode: (id, mode) =>
      id === manifest.id ? manifest.supportedModes.includes(mode) : base.supportsMode(id, mode),
    defaultsFor: (id) => (id === manifest.id ? manifest.defaults : base.defaultsFor(id)),
  };
}

/**
 * Generates through the V2 adapter path, for the V1 Astro configuration.
 *
 * The Stage 0 golden snapshots are asserted against this, so its output must
 * stay byte-identical to `plan()`'s own.
 */
export function planWithAdapters(
  context: ProjectContext,
  options: AdapterPlanOptions,
): AdapterPlanResult {
  return planManifest(manifestFromProjectContext(context), {
    ...options,
    cliVersion: context.cliVersion,
    generatedAt: context.generatedAt,
    mode: context.template.mode,
    templateId: context.template.id,
  });
}

export interface ManifestPlanOptions extends AdapterPlanOptions {
  readonly cliVersion: string;
  readonly generatedAt: string;
  /** V1 mode, still required by `plan()` for tokens and provenance. */
  readonly mode: TemplateMode;
  /** Overrides the template id; defaults to the framework adapter's own. */
  readonly templateId?: string;
}

/**
 * Generates from a V2 manifest, for any implemented framework.
 *
 * The entry point React uses. Astro reaches it through `planWithAdapters`, so
 * both frameworks travel the same path and the golden snapshots cover it.
 */
export function planManifest(
  manifest: ProjectManifest,
  options: ManifestPlanOptions,
): AdapterPlanResult {
  const templatesRoot = path.dirname(options.registry.rootFor('astro-tailwind'));
  const adapters = createAdapterRegistry(templatesRoot);
  const framework = adapters.framework(manifest.framework);
  const templateManifest = framework.templateManifest;

  const templateId = options.templateId ?? templateManifest?.id ?? manifest.framework;
  const registry = registryFor(options.registry, templatesRoot, templateManifest);

  const { project, contributions } = resolveWithAdapters(manifest, templatesRoot);

  // plan() is V1-shaped and reads tokens and provenance from a ProjectContext.
  const context: ProjectContext = {
    targetDir: manifest.targetDir,
    projectName: manifest.projectName,
    site: manifest.site,
    template: {
      id: templateId,
      version: registry.get(templateId).version,
      mode: options.mode,
    },
    features: [],
    packageManager: manifest.packageManager,
    git: manifest.git,
    install: manifest.install,
    cliVersion: options.cliVersion,
    generatedAt: options.generatedAt,
  };

  const generated = plan(context, {
    registry,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    layers: layersFrom(contributions),
  });

  const operations = mergeComposed(generated.operations, composedFiles(project, contributions));

  return {
    plan: { ...generated, operations },
    manifest,
    project,
    contributions,
  };
}
