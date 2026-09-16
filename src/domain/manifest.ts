import type { PackageManager, ProjectContext, SiteContext } from '../types.js';
import type {
  ArchitectureId,
  BuildToolId,
  FeatureId,
  FrameworkId,
  LanguageId,
  RouterId,
  StylingId,
  UiLibraryId,
} from './dimensions.js';
import { starterFromMode, type StarterId } from './starter.js';

/**
 * What the user asked for. Nothing about how it will be built.
 *
 * The boundary has one rule, and holding it is what keeps this type stable:
 *
 *   > If a field would change when a dependency publishes a new version, it
 *   > does not belong here.
 *
 * So no `tailwindPluginVersion`, no `viteConfigFile`, no resolved adapter
 * objects. Those are decisions, and decisions live in `ResolvedProject`. A
 * manifest written today should still describe the same intent in a year, even
 * though what it resolves to will have moved underneath it.
 *
 * That property is also what makes presets viable: a preset is just a partial
 * manifest, so it can be a plain object in the existing precedence chain rather
 * than a new concept.
 */
export interface ProjectManifest {
  /** Absolute, normalised path. Same meaning as V1's `ProjectContext.targetDir`. */
  readonly targetDir: string;
  /** npm-safe name; also the generated `package.json` name. */
  readonly projectName: string;

  readonly framework: FrameworkId;
  readonly buildTool: BuildToolId;
  readonly language: LanguageId;
  readonly styling: StylingId;
  readonly uiLibrary: UiLibraryId;
  readonly router: RouterId;
  readonly architecture: ArchitectureId;
  /**
   * What the project starts out containing.
   *
   * Its own field since Stage 21. It spent Stages 1-20 inside `features` as
   * `starter:full`, which read as a feature, sorted as a feature and had to be
   * filtered out of every list a feature belonged in. One project has exactly
   * one starter, and a single field is how that stops being a rule anyone has
   * to enforce.
   */
  readonly starter: StarterId;
  readonly features: readonly FeatureId[];

  /**
   * Reused from V1 unchanged, including `url: string | null` meaning
   * *explicitly absent*. The refusal to invent a domain is a product
   * invariant that outlives any framework, so it keeps its existing shape
   * rather than being restated.
   */
  readonly site: SiteContext;

  readonly packageManager: PackageManager;
  readonly git: boolean;
  readonly install: boolean;
}

/**
 * The stack V1 generates, as a manifest.
 *
 * A bridge in one direction only, and deliberately not a migration path: it
 * exists so the domain model can be checked against the configuration that
 * actually ships rather than only against fixtures invented to suit it. If
 * today's product cannot be described in this vocabulary, the vocabulary is
 * wrong - and that is worth finding out now, before anything depends on it.
 *
 * Nothing in V1 calls this. It is read by tests.
 */
export function manifestFromProjectContext(context: ProjectContext): ProjectManifest {
  return {
    targetDir: context.targetDir,
    projectName: context.projectName,

    // V1 ships exactly one stack, so these are constants rather than lookups.
    framework: 'astro',
    buildTool: 'astro',
    language: 'ts',
    styling: 'tailwind',
    uiLibrary: 'none',
    router: 'file-based',
    architecture: 'astro-standard',

    // `mode` was never a core concept - it was an Astro template detail that
    // reached src/types.ts. Here it is what it always was: a starter choice,
    // mapped by the one function that owns that mapping.
    starter: starterFromMode(context.template.mode),
    features: [],

    site: context.site,
    packageManager: context.packageManager,
    git: context.git,
    install: context.install,
  };
}
