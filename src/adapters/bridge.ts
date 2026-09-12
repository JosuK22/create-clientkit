import type { Capability } from '../domain/capabilities.js';
import type { Contribution } from '../domain/contributions.js';
import { manifestFromProjectContext } from '../domain/manifest.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import type { GenerationPlan } from '../generate/files.js';
import { plan, type PlanFs, type PlanLayer } from '../generate/plan.js';
import type { TemplateRegistry } from '../templates/registry.js';
import type { ProjectContext } from '../types.js';
import { createAdapterRegistry } from './registry.js';

/**
 * The narrow bridge between V1 generation and the V2 adapter model.
 *
 *     ProjectContext (V1)
 *           ↓  manifestFromProjectContext
 *     ProjectManifest
 *           ↓  adapters resolve
 *     ResolvedProject
 *           ↓  adapters contribute
 *     Contribution[]
 *           ↓  layers
 *     plan()                      unchanged except for accepting the layers
 *           ↓
 *     FileOperation[]             identical to V1, byte for byte
 *
 * The direction matters: V1 types flow into V2, never the other way. Nothing in
 * `src/context/`, `src/templates/` or `src/generate/` imports this module, so
 * the CLI still runs the V1 path exactly as it did and this code is reachable
 * only from tests until a later stage wires it up.
 *
 * ## What this bridge does not do yet
 *
 * Only the template layers are consumed. Dependencies and scripts are
 * contributed and asserted against the template, but `package.json` is still
 * produced by composing `_package.json` through the template layers, as in V1.
 * Building it from contributions instead is the composition work a later stage
 * covers - and doing it here would change the one thing this stage must not
 * change.
 *
 * The manifest also does not carry `cliVersion` or `generatedAt`, so `plan()`
 * still receives the V1 `ProjectContext` for tokens and provenance. Fully
 * manifest-driven planning needs those on the manifest, which is a deliberate
 * later step rather than an oversight.
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

/**
 * Resolves the adapters for a manifest and collects their contributions.
 *
 * Exported separately from planning so the adapter behaviour can be inspected
 * and asserted without generating anything.
 */
export function resolveWithAdapters(
  manifest: ProjectManifest,
  templateRoot: string,
): { project: ResolvedProject; contributions: readonly Contribution[] } {
  const adapters = createAdapterRegistry(templateRoot);
  const framework = adapters.framework(manifest.framework);
  const styling = adapters.styling(manifest.styling);

  const frameworkResolution = framework.resolve(manifest);
  const stylingResolution = styling.resolve(manifest);

  const capabilities = new Set<Capability>([
    ...framework.declaration.provides,
    ...(frameworkResolution.capabilities ?? []),
    ...styling.declaration.provides,
    ...(stylingResolution.capabilities ?? []),
  ]);

  // The highest floor any selected adapter asks for. With two adapters this is
  // barely arithmetic, but the rule has to live somewhere and it is not the
  // kind of thing to discover late.
  const minNode = [
    frameworkResolution.minNode,
    stylingResolution.minNode,
    framework.declaration.minNode,
    styling.declaration.minNode,
  ]
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);

  const architecture = framework.architectureDefinitions.find(
    (definition) => definition.id === manifest.architecture,
  );
  if (architecture === undefined) {
    throw new Error(
      `Framework "${manifest.framework}" does not define architecture "${manifest.architecture}".`,
    );
  }

  const project: ResolvedProject = {
    manifest,
    capabilities,
    architecture,
    extensions: { source: '.ts', component: '.astro', config: '.mjs' },
    minNode: minNode ?? '>=22.12.0',
    selection: {
      framework: framework.declaration.id,
      buildTool: manifest.buildTool,
      language: manifest.language,
      styling: styling.declaration.id,
      uiLibrary: manifest.uiLibrary,
      router: manifest.router,
      features: [...manifest.features],
    },
  };

  return { project, contributions: [framework.contribute(project), styling.contribute(project)] };
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
 * Generates through the V2 adapter path.
 *
 * Produces a plan that must be byte-identical to `plan()`'s own output for the
 * same context - the Stage 0 golden snapshots are asserted against this
 * function's result, which is the gate for this stage.
 */
export function planWithAdapters(
  context: ProjectContext,
  options: AdapterPlanOptions,
): AdapterPlanResult {
  const manifest = manifestFromProjectContext(context);
  const templateRoot = options.registry.rootFor(context.template.id);
  const { project, contributions } = resolveWithAdapters(manifest, templateRoot);

  const generated = plan(context, {
    registry: options.registry,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    layers: layersFrom(contributions),
  });

  return { plan: generated, manifest, project, contributions };
}
