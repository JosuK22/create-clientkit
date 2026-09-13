import type { Capability, Constraint } from './capabilities.js';
import type { Contribution } from './contributions.js';
import type { ArchitectureId, BuildToolId, LanguageId, RouterId } from './dimensions.js';
import type { ProjectManifest } from './manifest.js';
import type { ResolvedProject, SourceExtensions } from './resolved.js';
import type { ArchitectureDefinition, FileRole } from './roles.js';
import type { TemplateManifest } from '../templates/manifest.js';

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
  /**
   * Roles the project must end up with because this adapter was selected.
   *
   * The architecture has said this since Stage 6 - React cannot ship without a
   * global stylesheet - but only an architecture could say it. A feature needs
   * the same sentence: selecting `not-found` means the finished project has a
   * not-found page, and a plan that quietly produces none is the exact failure
   * the guarantee exists to prevent.
   *
   * Deliberately not a promise to *supply* the role. Whoever fills it - a
   * framework template, another adapter's contribution - satisfies it equally,
   * because the check runs against the finished plan by resolved path.
   */
  readonly requiredRoles?: readonly FileRole[];
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
  /**
   * Whether the framework is its own build tool.
   *
   * Astro, Next and Angular each ship their build tooling; React does not and
   * has to be paired with one. Selection needs to know which, or it cannot tell
   * "this framework needs no separate build-tool adapter" from "the build-tool
   * adapter is missing" - and silently skipping the second would generate a
   * project with no way to build it.
   *
   * Stated explicitly rather than inferred from `buildTools.kind === 'fixed'`,
   * which happens to agree for all four frameworks today but conflates two
   * different questions: whether the user has a choice, and who owns the
   * tooling. A framework could one day fix its build tool to something it does
   * not own.
   */
  readonly ownsBuildTool: boolean;
  readonly buildTools: DimensionOptions<BuildToolId>;
  readonly languages: DimensionOptions<LanguageId>;
  readonly routers: DimensionOptions<RouterId>;
  readonly architectures: DimensionOptions<ArchitectureId>;
  /**
   * Roles this framework satisfies from its own template layers.
   *
   * A contribution aimed at one of these is not composed: the template already
   * puts a file there, and writing a second would be a collision between two
   * owners. Astro lists styles.global because its template ships global.css;
   * React lists nothing, so its stylesheet comes from whichever styling adapter
   * was selected.
   *
   * Declared rather than inferred from what the template happens to contain, so
   * a template that accidentally ships a file an adapter also contributes is
   * reported as a collision instead of silently winning.
   */
  readonly templateOwnedRoles?: readonly FileRole[];

  /** The architecture definitions this framework offers, keyed by id. */
  readonly architectureDefinitions: readonly ArchitectureDefinition[];
  /**
   * Template identity, for frameworks whose template directory is not
   * discoverable by the V1 registry.
   *
   * Astro omits it: its template.json is on disk and the V1 registry already
   * serves it, so declaring it here would only create something to drift.
   * React needs it, because giving its directory a template.json would make it
   * appear in the V1 --list-templates output and announce a framework that has
   * no public selection path yet.
   */
  readonly templateManifest?: TemplateManifest;
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
