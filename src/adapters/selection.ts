import type { Adapter, AdapterDeclaration } from '../domain/adapters.js';
import type { CompatibilityReport } from '../domain/compatibility.js';
import { evaluateCombination, formatReport } from '../domain/compatibility.js';
import {
  assertCapabilityContracts,
  assertRolesArePlaceable,
} from '../domain/capability-contract.js';
import type { ProjectManifest } from '../domain/manifest.js';
import { mergeResolutions, type ResolutionInput } from '../domain/resolution.js';
import type { ResolvedProject } from '../domain/resolved.js';
import type { FileRole } from '../domain/roles.js';
import { adapterRef } from '../domain/adapters.js';
import { CliError } from '../errors.js';
import type { AdapterRegistry } from './registry.js';

/**
 * Selection and resolution orchestration.
 *
 *     manifest -> registry -> declarations -> compatibility -> resolution
 *
 * The orchestrator exists because adapters are forbidden from talking to each
 * other. Somebody has to look up who was selected, ask each one what it needs,
 * check the combination and fold the answers together - and that somebody must
 * not be an adapter, or the independence the whole design rests on is gone.
 *
 * Pure apart from the registry lookup, which is itself a pure map read.
 */

/**
 * The order adapters are resolved in.
 *
 * The architecture document does not prescribe one, so this is chosen and
 * recorded rather than assumed. It runs from most to least determining: the
 * framework fixes the build tool, language, router and architecture, so it must
 * resolve first; styling and UI libraries depend on what the framework provides;
 * features depend on everything.
 *
 * Compatibility itself does **not** depend on this order - `evaluateCombination`
 * takes the union of all provides and is order-independent by construction, and
 * a test asserts that. The order matters only for deterministic reporting and
 * for the day a later adapter legitimately needs an earlier one's resolved
 * facts.
 *
 * Only `framework`, `build-tool`, `styling` and `ui-library` have implemented
 * adapters today; the rest are listed because the order is a decision, not a
 * consequence of what exists.
 */
export const RESOLUTION_ORDER = [
  'framework',
  'build-tool',
  'language',
  'styling',
  'ui-library',
  'architecture',
  'feature',
] as const;

export interface SelectedAdapter {
  /** `<kind>:<id>` */
  readonly ref: string;
  readonly adapter: Adapter;
}

export interface Selection {
  readonly adapters: readonly SelectedAdapter[];
  readonly declarations: readonly AdapterDeclaration[];
}

/**
 * Looks up the adapters a manifest asks for.
 *
 * Unsupported ids fail here, by name, before anything else happens - a manifest
 * naming `react` gets an error saying React is not implemented, never a silent
 * fall back to Astro.
 *
 * Returned in `RESOLUTION_ORDER`, so the selection is identical for identical
 * input regardless of how the registry stores things.
 */
export function selectAdapters(manifest: ProjectManifest, registry: AdapterRegistry): Selection {
  const framework = registry.framework(manifest.framework);
  const adapters: SelectedAdapter[] = [
    { ref: adapterRef(framework.declaration), adapter: framework },
  ];

  // A framework that ships its own build tooling (Astro, and later Next and
  // Angular) has no separate build-tool adapter and must not be asked for one.
  // A framework that does not (React) must have one, and a missing adapter is
  // an error rather than a silent skip - skipping would generate a project with
  // no way to build it.
  if (!framework.ownsBuildTool) {
    const buildTool = registry.buildTool(manifest.buildTool);
    adapters.push({ ref: adapterRef(buildTool.declaration), adapter: buildTool });
  }

  // `none` is a real answer meaning "no styling adapter participates", not a
  // missing adapter - asking the registry for it would produce a misleading
  // "not implemented yet".
  if (manifest.styling !== 'none') {
    const styling = registry.styling(manifest.styling);
    adapters.push({ ref: adapterRef(styling.declaration), adapter: styling });
  }

  // `none` is a real answer here too - a project with no component library is
  // the common case, not a missing adapter.
  if (manifest.uiLibrary !== 'none') {
    const uiLibrary = registry.uiLibrary(manifest.uiLibrary);
    adapters.push({ ref: adapterRef(uiLibrary.declaration), adapter: uiLibrary });
  }

  /*
   * The router is explicit, and `none` is a real answer.
   *
   * `file-based` is not an adapter either: it is what a framework that routes
   * by file already does, recorded on the manifest so the choice is visible.
   * Asking the registry for it would report a missing adapter for something
   * that was never one.
   */
  if (manifest.router !== 'none' && manifest.router !== 'file-based') {
    const router = registry.router(manifest.router);
    adapters.push({ ref: adapterRef(router.declaration), adapter: router });
  }

  // Features are a list rather than a single choice. De-duplicated, because
  // asking for the same feature twice is one request, not two, and letting it
  // through would contribute everything twice. The starter used to need
  // skipping here; it is its own field now and never reaches this loop.
  for (const feature of [...new Set(manifest.features)].sort()) {
    const adapter = registry.feature(feature);
    adapters.push({ ref: adapterRef(adapter.declaration), adapter });
  }

  const rank = (ref: string): number => {
    const kind = ref.split(':')[0] ?? '';
    const index = (RESOLUTION_ORDER as readonly string[]).indexOf(kind);
    return index === -1 ? RESOLUTION_ORDER.length : index;
  };
  adapters.sort((a, b) => rank(a.ref) - rank(b.ref) || a.ref.localeCompare(b.ref));

  return { adapters, declarations: adapters.map((entry) => entry.adapter.declaration) };
}

/** Checks a manifest's adapters against each other, without resolving anything. */
export function checkCompatibility(
  manifest: ProjectManifest,
  registry: AdapterRegistry,
): CompatibilityReport {
  return evaluateCombination(selectAdapters(manifest, registry).declarations);
}

/**
 * Turns a manifest into a `ResolvedProject`, or explains why it cannot.
 *
 * Compatibility is checked **before** any adapter resolves, so an impossible
 * combination never reaches resolution and never produces a half-built project.
 */
export function resolveProject(
  manifest: ProjectManifest,
  registry: AdapterRegistry,
): { project: ResolvedProject; selection: Selection; report: CompatibilityReport } {
  const selection = selectAdapters(manifest, registry);
  const report = evaluateCombination(selection.declarations);

  if (!report.compatible) {
    throw new CliError('That combination will not work.', {
      hint: formatReport(report),
    });
  }

  const inputs: ResolutionInput[] = selection.adapters.map(({ ref, adapter }) => ({
    owner: ref,
    resolution: adapter.resolve(manifest),
  }));
  const merged = mergeResolutions(inputs);

  const framework = registry.framework(manifest.framework);
  const architecture = framework.architectureDefinitions.find(
    (definition) => definition.id === manifest.architecture,
  );
  if (architecture === undefined) {
    throw new CliError(
      `The ${framework.declaration.displayName} adapter does not define the "${manifest.architecture}" architecture.`,
      {
        hint: `It offers: ${framework.architectureDefinitions.map((d) => d.id).join(', ')}.`,
      },
    );
  }

  // Declared capabilities plus anything resolution added. Declarations are the
  // ones compatibility was judged on; resolution may only widen the set.
  const capabilities = new Set([
    ...selection.declarations.flatMap((declaration) => declaration.provides),
    ...merged.capabilities,
  ]);

  /*
   * The architecture contract, checked at the first moment both halves exist.
   *
   * Compatibility above judged declarations against each other and never saw an
   * architecture - it cannot, because the architecture is resolved from the
   * framework the declarations were being judged with. That leaves the gap
   * Stage 28 closes: a capability can be declared truthfully as far as the
   * engine can tell and still be unmaterializable by the architecture that was
   * chosen alongside it.
   *
   * Two directions, deliberately separate functions:
   *
   *   - a declared capability whose surface the architecture cannot place
   *   - a required role the architecture cannot place
   *
   * Both fail here rather than during planning, so no `FileOperation` exists
   * when they do. The planner's own guards stay exactly where they were: this
   * says the architecture *could* place a surface, and `assertRequiredRoles`
   * still asks whether anything actually did.
   */
  assertCapabilityContracts(
    capabilities,
    architecture,
    framework.templateOwnedRoles ?? [],
    report.index.providers,
  );
  // The architecture's own requirements have no adapter behind them, so they
  // are attributed to the architecture that stated them - merged into the
  // adapters' map rather than spread over it, so a role both of them ask for
  // names both askers instead of whichever spread came last.
  const roleAskers = new Map<FileRole, string[]>(
    [...merged.requiredRoleOwners].map(([role, owners]) => [role, [...owners]]),
  );
  for (const role of architecture.requiredRoles ?? []) {
    const asker = `architecture:${architecture.id}`;
    const existing = roleAskers.get(role);
    if (existing === undefined) roleAskers.set(role, [asker]);
    else if (!existing.includes(asker)) existing.unshift(asker);
  }
  assertRolesArePlaceable(architecture, roleAskers);

  // Destructured rather than checked in a loop so the narrowing is real and no
  // non-null assertion is needed to build the result.
  const { source, component, config } = merged.extensions;
  if (source === undefined || component === undefined || config === undefined) {
    const missing = [
      source === undefined ? 'source' : null,
      component === undefined ? 'component' : null,
      config === undefined ? 'config' : null,
    ].filter((name): name is string => name !== null);
    throw new CliError(`No adapter resolved the ${missing.join(', ')} file extension.`, {
      hint: `Selected adapters: ${selection.adapters.map((entry) => entry.ref).join(', ')}.`,
    });
  }

  const declaredFloors = selection.declarations
    .map((declaration) => declaration.minNode)
    .filter((floor): floor is string => floor !== undefined);

  const project: ResolvedProject = {
    manifest,
    capabilities,
    architecture,
    extensions: { source, component, config },
    templateOwnedRoles: framework.templateOwnedRoles ?? [],
    // Architecture first, then anything a selected adapter asked for. Sorted so
    // the set is identical however the adapters happened to be ordered.
    requiredRoles: [
      ...new Set([...(architecture.requiredRoles ?? []), ...merged.requiredRoles]),
    ].sort(),
    minNode: merged.minNode ?? declaredFloors[0] ?? '>=20.19',
    selection: {
      framework: manifest.framework,
      buildTool: manifest.buildTool,
      language: manifest.language,
      styling: manifest.styling,
      uiLibrary: manifest.uiLibrary,
      router: manifest.router,
      features: [...manifest.features],
    },
  };

  return { project, selection, report };
}
