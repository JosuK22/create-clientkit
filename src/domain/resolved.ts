import type { Capability } from './capabilities.js';
import type { ProjectManifest } from './manifest.js';
import type { ArchitectureDefinition, FileRole } from './roles.js';

/**
 * What the manifest turned out to mean.
 *
 * The second tier of `manifest -> resolved -> plan`. Everything here is a
 * decision derived from intent plus the adapters' own knowledge: which
 * capabilities the stack ends up with, where files go, which file extensions
 * are in play, how new a Node runtime the result needs.
 *
 * It is rebuilt on every run and never persisted. Persisting it would freeze
 * resolved versions into something a user edits, which is the exact confusion
 * the manifest boundary exists to prevent.
 *
 * Adapters are referenced by id rather than held as instances. That keeps this
 * type free of any dependency on the adapter module - adapters receive a
 * `ResolvedProject`, so holding them here would be circular - and it keeps the
 * type printable, comparable and easy to assert against in a test.
 */
export interface ResolvedProject {
  readonly manifest: ProjectManifest;

  /**
   * Every capability the selected stack provides, unioned across adapters.
   *
   * This is the set constraints are evaluated against. A `ReadonlySet` because
   * membership is the only question ever asked of it.
   */
  readonly capabilities: ReadonlySet<Capability>;

  /** Resolved from the framework adapter; maps file roles to real paths. */
  readonly architecture: ArchitectureDefinition;

  /**
   * Chosen by the language adapter and needed by everyone who writes source.
   * A styling adapter should not be deciding `.ts` versus `.js`, nor guessing
   * from the manifest.
   */
  readonly extensions: SourceExtensions;

  /**
   * The highest floor any selected adapter requires.
   *
   * V1 already has this tension - the CLI runs on Node 20.19 while the Astro
   * site it generates needs 22.12 - and with several adapters contributing it
   * has to be computed rather than declared in one place.
   */
  readonly minNode: string;

  /**
   * Roles the framework satisfies from its own template layers.
   *
   * Contributions aimed at these are not composed - the template already puts
   * a file there. Resolved onto the project so the composition layer does not
   * have to reach back into the framework adapter to find out.
   */
  readonly templateOwnedRoles: readonly FileRole[];
  /**
   * Every role the finished plan must contain, from the architecture and from
   * whichever adapters were selected.
   *
   * The architecture's own `requiredRoles` is the structural half - React
   * cannot ship without a global stylesheet. Adapters add to it: selecting a
   * feature is a statement about what the finished project contains, and this
   * is where that statement is recorded so one check can enforce both.
   */
  readonly requiredRoles: readonly FileRole[];

  /** Which adapter was selected for each dimension, by id. */
  readonly selection: AdapterSelection;
}

export interface SourceExtensions {
  /** Plain source: `.ts` or `.js`. */
  readonly source: string;
  /** Component source, where the framework distinguishes it: `.tsx`, `.astro`. */
  readonly component: string;
  /** Config files, where the language affects them: `.ts` or `.mjs`. */
  readonly config: string;
}

/**
 * The adapters in play, by id.
 *
 * Features are a list because several apply at once; every other dimension
 * resolves to exactly one.
 */
export interface AdapterSelection {
  readonly framework: string;
  readonly buildTool: string;
  readonly language: string;
  readonly styling: string;
  readonly uiLibrary: string;
  readonly router: string;
  readonly features: readonly string[];
}
