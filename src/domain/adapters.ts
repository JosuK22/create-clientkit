import type { Capability, Constraint } from './capabilities.js';
import type { Contribution } from './contributions.js';
import type { ArchitectureId, BuildToolId, LanguageId, RouterId } from './dimensions.js';
import type { ProjectManifest } from './manifest.js';
import type { ResolvedProject, SourceExtensions } from './resolved.js';
import type { ArchitectureDefinition } from './roles.js';

/**
 * The adapter contract: declare, then resolve, then contribute.
 *
 * Three phases because they answer different questions at different times.
 * Declaration is static and must be readable before anything is selected -
 * that is what the compatibility engine filters on, and it cannot run an
 * adapter to find out whether the adapter is usable. Resolution happens once a
 * selection exists. Contribution happens last, when an adapter can see the
 * fully resolved project, because what a styling adapter writes depends on the
 * file extension the language chose and the path the architecture assigned.
 *
 * ## What an adapter cannot do
 *
 * Enforced structurally rather than by convention: an adapter is handed plain
 * data and returns plain data. The contract passes it no filesystem, no
 * logger, no registry and no other adapter, so there is nothing to reach for.
 * It cannot write a file, run a command, call `apply()`, or read another
 * adapter's state - it can only describe what it wants and let the planner
 * decide. Two adapters that disagree therefore produce a reportable conflict
 * instead of a race.
 *
 * This also keeps every adapter a pure function of its inputs, which is what
 * makes them testable with no CLI, no disk and no fixtures beyond a
 * `ResolvedProject` literal.
 */

export const ADAPTER_KINDS = [
  'framework',
  'build-tool',
  'language',
  'styling',
  'ui-library',
  'architecture',
  'feature',
] as const;

export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/**
 * Everything the compatibility engine needs, available without running
 * anything.
 *
 * `provides` and `requires` are the whole of the compatibility story. Note
 * what is absent: no list of compatible frameworks, no exclusions by adapter
 * id. An adapter that named another adapter would have to be edited whenever
 * that other one changed, which is the coupling this design exists to remove.
 */
export interface AdapterDeclaration {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly displayName: string;
  readonly provides: readonly Capability[];
  readonly requires: readonly Constraint[];
  /** Node floor this adapter imposes, if any. Folded into `ResolvedProject.minNode`. */
  readonly minNode?: string;
}

/**
 * A dimension that may or may not be a real choice.
 *
 * Astro, Next and Angular each fix their build tool; React does not. Expressing
 * that here means the prompt driver needs one rule - ask only when `choice` has
 * more than one surviving option - rather than a branch per framework. The same
 * shape covers language, router, and anything later that is sometimes forced.
 */
export type DimensionOptions<T> =
  | { readonly kind: 'fixed'; readonly value: T }
  | { readonly kind: 'choice'; readonly options: readonly T[]; readonly default: T };

/** Extra facts an adapter knows only once a selection exists. */
export interface AdapterResolution {
  /**
   * Capabilities that depend on the selection rather than being unconditional.
   * Most adapters return nothing here and let `provides` stand.
   */
  readonly capabilities?: readonly Capability[];
  readonly minNode?: string;
  /**
   * Source extensions this adapter decides.
   *
   * Partial because the decision is genuinely shared: a language adapter owns
   * `.ts` versus `.js`, while the framework owns whether a component is
   * `.astro` or `.tsx`. Two adapters supplying different values for the same
   * key is a conflict the orchestrator reports rather than resolving by
   * whichever ran last.
   */
  readonly extensions?: Partial<SourceExtensions>;
}

/**
 * The shape every adapter category shares.
 *
 * `resolve` sees only the manifest, because resolution is what produces the
 * resolved project - it cannot also consume it. `contribute` sees the finished
 * `ResolvedProject`, which is how an adapter learns the things it must not
 * decide for itself.
 */
export interface Adapter {
  readonly declaration: AdapterDeclaration;
  resolve(manifest: ProjectManifest): AdapterResolution;
  contribute(project: ResolvedProject): Contribution;
}

/**
 * The framework adapter carries more because it owns the shape of the project:
 * which build tools and languages are even available, and what the folder
 * structure is. Everything else is a plain `Adapter`.
 */
export interface FrameworkAdapter extends Adapter {
  readonly buildTools: DimensionOptions<BuildToolId>;
  readonly languages: DimensionOptions<LanguageId>;
  readonly routers: DimensionOptions<RouterId>;
  readonly architectures: DimensionOptions<ArchitectureId>;
  /** The architecture definitions this framework offers, keyed by id. */
  readonly architectureDefinitions: readonly ArchitectureDefinition[];
}

export type BuildToolAdapter = Adapter;
export type LanguageAdapter = Adapter;
export type StylingAdapter = Adapter;
export type UiLibraryAdapter = Adapter;
export type FeatureAdapter = Adapter;

/** Formats the `owner` stamped onto every contribution. */
export function adapterRef(declaration: AdapterDeclaration): string {
  return `${declaration.kind}:${declaration.id}`;
}
