import type { AdapterRegistry } from '../adapters/registry.js';
import type { FrameworkAdapter, DimensionOptions } from '../domain/adapters.js';
import {
  ARCHITECTURE_IDS,
  BUILD_TOOL_IDS,
  FEATURE_IDS,
  FRAMEWORK_IDS,
  LANGUAGE_IDS,
  ROUTER_IDS,
  STYLING_IDS,
  UI_LIBRARY_IDS,
} from '../domain/dimensions.js';
import type {
  ArchitectureId,
  BuildToolId,
  FeatureId,
  FrameworkId,
  LanguageId,
  RouterId,
  StylingId,
  UiLibraryId,
} from '../domain/dimensions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import { LEGACY_STARTER_PREFIX, starterFromMode } from '../domain/starter.js';
import { CliError, EXIT_USAGE } from '../errors.js';
import type { TemplateManifest } from '../templates/manifest.js';
import type { PackageManager, SiteContext, TemplateMode } from '../types.js';

/**
 * Where CLI strings become manifest dimensions, and the only place they do.
 *
 * ## What this layer is allowed to decide
 *
 * Two things, and deliberately no more:
 *
 *   - **is this a word the domain knows** - `--framework vue` is a typo, and
 *     saying so here is faster and clearer than letting it travel.
 *   - **what did the user leave unsaid** - a default per dimension, in one
 *     place, so no adapter, engine or template has to carry a fallback.
 *
 * Everything else belongs downstream. Whether the words the user chose can be
 * built *together* is the compatibility engine's question, and whether an
 * adapter exists for one of them is the registry's. Neither judgement is
 * duplicated here, which is what keeps the CLI a configuration layer rather
 * than a second implementation of the architecture.
 *
 * The distinction that matters most is between a **known id** and an
 * **implemented adapter**. `nextjs` is real vocabulary with no adapter behind
 * it; it passes validation here and is refused by the registry, by name. The
 * alternative - a list of "currently supported" ids in this file - would be a
 * second source of truth that goes stale the day an adapter lands.
 *
 * ## Where defaults come from
 *
 * Not from a table of framework special cases. The framework adapter already
 * declares which build tools, languages, routers and architectures it offers
 * and which it fixes, so this asks it. That is what lets the normaliser contain
 * no `if (framework === ...)` at all: a framework that fixes its build tool and
 * one that offers a choice travel the same three lines.
 *
 * Styling and the UI library are not framework-owned - a framework does not get
 * to decide how CSS is authored - so their defaults are stated here, and they
 * are V1's: Tailwind, and no component library.
 */

/** Every public flag that configures a manifest dimension. */
export const DIMENSION_FLAGS = [
  '--framework',
  '--build-tool',
  '--language',
  '--styling',
  '--ui-library',
  '--router',
  '--architecture',
  '--features',
] as const;

/**
 * Dimensions no framework owns, with the values a bare invocation resolves to.
 *
 * V1's stack, stated once. The framework-owned dimensions are absent on
 * purpose: asking the adapter is what keeps this free of per-framework cases.
 */
export const DIMENSION_DEFAULTS = {
  framework: 'astro',
  styling: 'tailwind',
  uiLibrary: 'none',
} as const satisfies {
  framework: FrameworkId;
  styling: StylingId;
  uiLibrary: UiLibraryId;
};

/**
 * Where a dimension came from, for error messages only.
 *
 * The same values arrive from three places now, and being told that
 * `--features` lists something twice is unhelpful when the duplicate is in a
 * JSON file. This changes no rule - only the noun the message uses.
 */
export interface InputOrigin {
  /** How to refer to the feature list: `--features`, or `"stack.features"`. */
  readonly features: string;
}

const FLAG_ORIGIN: InputOrigin = { features: '--features' };

/** The raw strings a user supplied, before any of them mean anything. */
export interface DimensionInput {
  readonly framework?: string | undefined;
  readonly buildTool?: string | undefined;
  readonly language?: string | undefined;
  readonly styling?: string | undefined;
  readonly uiLibrary?: string | undefined;
  readonly router?: string | undefined;
  readonly architecture?: string | undefined;
  /** Each occurrence of `--features`, still comma-joined. */
  readonly features?: readonly string[] | undefined;
}

/**
 * Where a resolved value came from, as far as this layer can tell.
 *
 * Three answers, and the split is the one that matters for explaining a
 * configuration: the caller supplied it, the framework's own declaration did,
 * or the shared defaults did. Which *caller* supplied it - a flag, a file, a
 * preset, an answer - is a question this function cannot answer, because it
 * receives one merged `DimensionInput` with the layers already collapsed. The
 * resolver knows that half and joins the two.
 *
 * Recorded here rather than reconstructed later because here is where the
 * decision is actually made. A second function inferring "this looks derived"
 * would be a second precedence implementation, and the first thing to disagree.
 */
export type DimensionOrigin =
  /** Present in the input this function was handed. */
  | 'stated'
  /** Absent, and filled from the framework adapter's own declaration. */
  | 'adapter'
  /** Absent, and filled from the defaults no framework owns. */
  | 'default';

/** Every dimension, keyed the way the manifest keys them. */
export type DimensionOrigins = Readonly<Record<keyof DimensionInput, DimensionOrigin>>;

/** The dimensions of a manifest, complete, with nothing left to infer. */
export interface ResolvedDimensions {
  readonly framework: FrameworkId;
  readonly buildTool: BuildToolId;
  readonly language: LanguageId;
  readonly styling: StylingId;
  readonly uiLibrary: UiLibraryId;
  readonly router: RouterId;
  readonly architecture: ArchitectureId;
  readonly features: readonly FeatureId[];
  /**
   * The template the framework's files come from, when it brings its own.
   *
   * Astro's is discovered from disk by the V1 registry and is absent here;
   * React's is declared by its adapter because giving its directory a
   * `template.json` would list it in the V1 `--list-templates` output. The
   * asymmetry is Stage 5's, not this stage's.
   */
  readonly templateManifest: TemplateManifest | undefined;
  /** How each of the above was arrived at. See {@link DimensionOrigin}. */
  readonly origins: DimensionOrigins;
}

/** True when the invocation configures any dimension explicitly. */
export function hasDimensionInput(input: DimensionInput): boolean {
  return (
    input.framework !== undefined ||
    input.buildTool !== undefined ||
    input.language !== undefined ||
    input.styling !== undefined ||
    input.uiLibrary !== undefined ||
    input.router !== undefined ||
    input.architecture !== undefined ||
    (input.features !== undefined && input.features.length > 0)
  );
}

/**
 * Spellings accepted alongside the domain ids.
 *
 * Two entries, and the bar for a third is high. `ts` is the id the manifest
 * carries and the one help prints; `typescript` is what a person types. A CLI
 * that rejects the obvious spelling of its own vocabulary is being pedantic at
 * the user's expense, and this is not a second vocabulary - both spellings mean
 * the same single id.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, LanguageId>> = {
  typescript: 'ts',
  javascript: 'js',
};

function known<T extends string>(
  value: string,
  vocabulary: readonly T[],
  dimension: string,
  flag: string,
  supported: readonly string[],
): T {
  if ((vocabulary as readonly string[]).includes(value)) return value as T;
  throw new CliError(`Unknown ${dimension} "${value}".`, {
    exitCode: EXIT_USAGE,
    hint: `Supported values for ${flag}:\n${supported.map((id) => `  ${id}`).join('\n')}`,
  });
}

/**
 * What the framework decided, or what the user did.
 *
 * A user value is taken as given even when the framework fixes something else.
 * That is not the CLI being permissive: `--framework astro --build-tool vite`
 * is a real disagreement, and the compatibility engine is what says so, in the
 * vocabulary of capabilities rather than of flags. Silently correcting it here
 * would hide a conflict the user needs to see.
 */
function fromFramework<T extends string>(explicit: T | undefined, options: DimensionOptions<T>): T {
  if (explicit !== undefined) return explicit;
  return options.kind === 'fixed' ? options.value : options.default;
}

/** Whether a raw input value was actually supplied. */
function stated(value: string | readonly string[] | undefined): boolean {
  return value !== undefined && value.length > 0;
}

/**
 * The origin of one dimension, from the same two facts the value came from.
 *
 * `derived` is what the value falls back to when nothing stated it: the
 * framework's declaration for the dimensions it owns, and the shared defaults
 * for the two it does not.
 */
function originOf(
  value: string | readonly string[] | undefined,
  derived: DimensionOrigin,
): DimensionOrigin {
  return stated(value) ? 'stated' : derived;
}

/**
 * Splits, trims and checks the feature list.
 *
 * Duplicates are refused rather than collapsed. The domain already de-duplicates
 * - `selectAdapters` does, and a test holds it - so this is not about
 * protecting the pipeline. It is that `--features seo,seo` is a person making a
 * mistake, and the one thing a CLI is uniquely placed to catch is malformed
 * input. The domain's de-duplication still covers every other path into a
 * manifest.
 */
function parseFeatures(
  occurrences: readonly string[],
  implemented: readonly string[],
  origin: InputOrigin,
): FeatureId[] {
  const seen = new Set<string>();
  const features: FeatureId[] = [];

  for (const occurrence of occurrences) {
    for (const raw of occurrence.split(',')) {
      const value = raw.trim();

      if (value === '') {
        throw new CliError(`${origin.features} contains an empty value.`, {
          exitCode: EXIT_USAGE,
          hint: 'Separate features with a single comma: --features seo,accessibility',
        });
      }

      /*
       * `starter:*` is no longer a feature id at all, so this would otherwise
       * fail as "unknown feature" - technically true and unhelpful. The
       * legacy spelling is recognised purely to say where starters are chosen.
       */
      if (value.startsWith(LEGACY_STARTER_PREFIX)) {
        throw new CliError(`"${value}" cannot be selected with --features.`, {
          exitCode: EXIT_USAGE,
          hint: 'Starters are chosen with --mode: coming-soon | full.',
        });
      }

      const feature = known(value, FEATURE_IDS, 'feature', origin.features, implemented);

      if (seen.has(feature)) {
        throw new CliError(`${origin.features} lists "${feature}" more than once.`, {
          exitCode: EXIT_USAGE,
          hint: 'Name each feature once.',
        });
      }
      seen.add(feature);
      features.push(feature);
    }
  }

  // Sorted so `--features b,a` and `--features a,b` are the same request. The
  // pipeline sorts too; doing it here makes the manifest itself canonical.
  return features.sort();
}

/**
 * Turns CLI strings into a complete, deterministic set of dimensions.
 *
 * The registry is consulted for two different reasons and it is worth keeping
 * them apart: to read the framework's own declarations (what it fixes, what it
 * offers), and to produce the not-implemented diagnostic for an id that is real
 * vocabulary with no adapter. The second is the registry's existing error, not
 * a new one written here.
 */
export function resolveDimensions(
  input: DimensionInput,
  adapters: AdapterRegistry,
  origin: InputOrigin = FLAG_ORIGIN,
): ResolvedDimensions {
  const framework = known(
    input.framework ?? DIMENSION_DEFAULTS.framework,
    FRAMEWORK_IDS,
    'framework',
    '--framework',
    adapters.implementedFrameworks(),
  );

  // Throws for a known id with no adapter - `nextjs` - in the registry's own
  // words. Reached here rather than at selection because the framework is what
  // the remaining defaults are read from, and there is nothing to read.
  const adapter: FrameworkAdapter = adapters.framework(framework);

  const languageInput = input.language === undefined ? undefined : input.language.toLowerCase();
  const language =
    languageInput === undefined
      ? undefined
      : (LANGUAGE_ALIASES[languageInput] ??
        known(languageInput, LANGUAGE_IDS, 'language', '--language', [
          ...LANGUAGE_IDS,
          ...Object.keys(LANGUAGE_ALIASES),
        ]));

  const buildTool =
    input.buildTool === undefined
      ? undefined
      : known(input.buildTool, BUILD_TOOL_IDS, 'build tool', '--build-tool', [
          ...adapters.implementedBuildTools(),
          // Astro's build tool is Astro, and there is no adapter for it
          // because the framework owns it. A user reading this list would
          // otherwise be told `astro` is not a build tool.
          'astro',
        ]);

  const router =
    input.router === undefined
      ? undefined
      : known(input.router, ROUTER_IDS, 'router', '--router', [
          ...adapters.implementedRouters(),
          'none',
          'file-based',
        ]);

  const architecture =
    input.architecture === undefined
      ? undefined
      : known(
          input.architecture,
          ARCHITECTURE_IDS,
          'architecture',
          '--architecture',
          adapter.architectureDefinitions.map((definition) => definition.id),
        );

  /*
   * The framework gets to say what it ships with, and only that.
   *
   * An explicit value still wins and still reaches the compatibility engine -
   * `--framework nextjs --styling tailwind` resolves to Tailwind and is refused
   * there, not here. This settles the unstated case, which would otherwise
   * inherit V1's Tailwind default and refuse a choice nobody made.
   */
  const styling = known(
    input.styling ?? adapter.defaultStyling ?? DIMENSION_DEFAULTS.styling,
    STYLING_IDS,
    'styling system',
    '--styling',
    [...adapters.implementedStyling(), 'none'],
  );

  const uiLibrary = known(
    input.uiLibrary ?? adapter.defaultUiLibrary ?? DIMENSION_DEFAULTS.uiLibrary,
    UI_LIBRARY_IDS,
    'UI library',
    '--ui-library',
    [...adapters.implementedUiLibraries(), 'none'],
  );

  const features = parseFeatures(input.features ?? [], adapters.implementedFeatures(), origin);

  return {
    framework,
    buildTool: fromFramework(buildTool, adapter.buildTools),
    language: fromFramework(language, adapter.languages),
    styling,
    uiLibrary,
    router: fromFramework(router, adapter.routers),
    architecture: fromFramework(architecture, adapter.architectures),
    features,
    templateManifest: adapter.templateManifest,
    origins: {
      framework: originOf(input.framework, 'default'),
      // The four the framework owns. Unstated means its declaration decided.
      buildTool: originOf(input.buildTool, 'adapter'),
      language: originOf(input.language, 'adapter'),
      router: originOf(input.router, 'adapter'),
      architecture: originOf(input.architecture, 'adapter'),
      /*
       * The two no framework owns. A framework may still state what it ships
       * with, and when it does the value is the adapter's rather than the
       * built-in default - which is what the summary then says.
       */
      styling: originOf(
        input.styling,
        adapter.defaultStyling === undefined ? 'default' : 'adapter',
      ),
      uiLibrary: originOf(
        input.uiLibrary,
        adapter.defaultUiLibrary === undefined ? 'default' : 'adapter',
      ),
      /*
       * An empty list is not an answer - the Stage 18 rule, and the reason
       * `stated` is a length check rather than a presence one. A flag that was
       * never passed arrives as `[]`, and calling that an explicit choice
       * would make "no features" indistinguishable from "features: none".
       */
      features: originOf(input.features, 'default'),
    },
  };
}

/** The non-dimension half of a manifest, resolved by the existing V1 layers. */
export interface ManifestIdentity {
  readonly targetDir: string;
  readonly projectName: string;
  readonly site: SiteContext;
  readonly packageManager: PackageManager;
  readonly git: boolean;
  readonly install: boolean;
}

/**
 * The one place a complete `ProjectManifest` is built.
 *
 * Everything upstream produces fragments - flags, a config file, prompts,
 * template defaults - and everything downstream reads a finished manifest.
 * Keeping the assembly in a single function is what stops a default from being
 * re-invented in an adapter, an engine or a template, which is how V1's one
 * `template` string ended up with fallbacks in four files.
 *
 * `mode` arrives here rather than being resolved with the other dimensions
 * because it is not one: it names a starter, and `starterFromMode` is the one
 * function that turns it into one. `manifestFromProjectContext` calls the same
 * function, which is why a legacy invocation produces an identical manifest
 * through either route - previously each made the mapping itself, and two
 * copies of one rule is a disagreement waiting for someone to add a starter.
 */
export function manifestFrom(
  identity: ManifestIdentity,
  dimensions: ResolvedDimensions,
  mode: TemplateMode,
): ProjectManifest {
  return {
    targetDir: identity.targetDir,
    projectName: identity.projectName,

    framework: dimensions.framework,
    buildTool: dimensions.buildTool,
    language: dimensions.language,
    styling: dimensions.styling,
    uiLibrary: dimensions.uiLibrary,
    router: dimensions.router,
    architecture: dimensions.architecture,
    starter: starterFromMode(mode),
    features: dimensions.features,

    site: identity.site,
    packageManager: identity.packageManager,
    git: identity.git,
    install: identity.install,
  };
}
