import { assertFlagCombinations, type ParsedFlags } from '../args.js';
import { registryFor } from '../adapters/bridge.js';
import { createAdapterRegistry } from '../adapters/registry.js';
import type { ProjectManifest } from '../domain/manifest.js';
import { CliError } from '../errors.js';
import { findTemplatesRoot, type TemplateRegistry } from '../templates/registry.js';
import {
  TEMPLATE_MODES,
  type ContextInput,
  type ProjectContext,
  type ResolutionResult,
  type ValueSource,
} from '../types.js';
import { detectPackageManager } from '../util/pm.js';
import {
  DEFAULTS,
  TEMPLATE_ID_PLACEHOLDER,
  defaultSiteDescription,
  titleCase,
} from './defaults.js';
import {
  DIMENSION_FLAGS,
  hasDimensionInput,
  manifestFrom,
  resolveDimensions,
  type DimensionInput,
} from './dimensions.js';
import { loadConfigFile, NO_CONFIG, type FileReader } from './fromFile.js';
import { presetDimensions, PRESETS, type PresetRegistry } from './presets.js';
import { promptDimensions } from './interactive.js';
import type { Prompter } from './prompts.js';
import {
  deriveProjectName,
  isPackageManagerId,
  isTemplateMode,
  validateProjectName,
  validateSiteName,
  validateTargetDir,
  validateUrl,
  type TargetDirFs,
} from './validate.js';

/**
 * A resolution, in both vocabularies.
 *
 * `plan()` is V1-shaped and reads a context for tokens and provenance; the
 * adapter pipeline reads a manifest. Both describe the same resolution and
 * never disagree - a test asserts that the manifest a legacy invocation
 * produces is exactly the one `manifestFromProjectContext` derives from its
 * context.
 *
 * Declared here rather than on `ResolutionResult` because `types.ts` is the V1
 * contract and `domain/manifest.ts` already imports from it; pointing it back
 * would make that a cycle.
 */
export interface ContextResolution extends ResolutionResult {
  readonly manifest: ProjectManifest;
}

export interface ResolveOptions {
  readonly flags: ParsedFlags;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompter: Prompter;
  readonly registry: TemplateRegistry;
  readonly cliVersion: string;
  readonly now: Date;
  /**
   * Where the shipped templates live, for reading framework declarations.
   *
   * Injectable so a test can point at a fixture tree, the same way `registry`
   * already is. Production discovers it.
   */
  readonly templatesRoot?: string | undefined;
  /** Overridable so a test can exercise the registry's own rules. */
  readonly presets?: PresetRegistry | undefined;
  readonly home?: string | undefined;
  readonly fs?: TargetDirFs | undefined;
  readonly readFile?: FileReader | undefined;
}

/** Recursively freezes the context so no downstream stage can mutate it. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** Builds the CLI-flag precedence layer, validating as it goes. */
function flagsLayer(flags: ParsedFlags, cwd: string): ContextInput {
  const layer: ContextInput = {};

  const dir = flags.positionals[0];
  if (dir !== undefined) {
    if (dir.trim() === '') {
      throw new CliError('The target directory cannot be an empty string.');
    }
    const nameError = validateProjectName(deriveProjectName(dir, cwd));
    if (nameError) {
      throw new CliError(`Invalid target directory "${dir}": ${nameError}`);
    }
    layer.dir = dir;
  }

  if (flags.template !== undefined) layer.templateId = flags.template;

  // --name / --url / --mode reuse the same validators as the config file and
  // the prompts; there is exactly one validation path per field.
  if (flags.name !== undefined) {
    const error = validateSiteName(flags.name);
    if (error) throw new CliError(`Invalid --name: ${error}`);
    layer.siteName = flags.name.trim();
  }

  if (flags.url !== undefined) {
    const check = validateUrl(flags.url);
    if (check.error) throw new CliError(`Invalid --url: ${check.error}`);
    // An explicitly empty --url means "no production URL", not "unset".
    layer.siteUrl = check.value;
  }

  if (flags.mode !== undefined) {
    if (!isTemplateMode(flags.mode)) {
      throw new CliError(`Unknown mode "${flags.mode}".`, {
        hint: `Supported values for --mode: ${TEMPLATE_MODES.join(', ')}.`,
      });
    }
    layer.mode = flags.mode;
  }

  if (flags.pm !== undefined) {
    if (!isPackageManagerId(flags.pm)) {
      throw new CliError(`Unknown package manager "${flags.pm}".`, {
        hint: 'Supported values for --pm: npm, pnpm, yarn, bun.',
      });
    }
    layer.packageManager = flags.pm;
  }

  if (flags.noGit) layer.git = false;
  if (flags.noInstall) layer.install = false;

  return layer;
}

/**
 * Resolves every input source into one immutable ProjectContext.
 *
 * Precedence (highest first):
 *   CLI flags > --from file > interactive answers > template defaults > built-ins
 *
 * Prompts are only issued for values that no higher-precedence layer supplied,
 * so the ordering is enforced structurally rather than by a final overwrite.
 */
export async function resolveContext(options: ResolveOptions): Promise<ContextResolution> {
  const { flags, cwd, env, prompter, registry: baseRegistry, cliVersion, now } = options;

  assertFlagCombinations(flags);

  const sources: Record<string, ValueSource> = {};
  const mark = (key: string, source: ValueSource): void => {
    sources[key] = source;
  };

  const dirOptions = {
    cwd,
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  };

  const config =
    flags.from === undefined
      ? NO_CONFIG
      : loadConfigFile(flags.from, {
          cwd,
          ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
        });
  const fileLayer = config.context;
  const flagLayer = flagsLayer(flags, cwd);

  /** Everything the user stated explicitly, flags beating the config file. */
  const explicit: ContextInput = { ...fileLayer, ...flagLayer };
  const sourceOf = (key: keyof ContextInput): ValueSource =>
    flagLayer[key] !== undefined ? 'flag' : 'file';

  // ---- dimensions stated up front -----------------------------------------
  /*
   * Validated before anything is prompted for, so a malformed `--framework`
   * fails immediately rather than after three questions. The result is
   * discarded: the dimensions that count are resolved once the interactive
   * answers are in, from this same input plus whatever was asked.
   *
   * Flags beat the config file, per dimension, which is the precedence the
   * V1 layers already use one line above. Merging here rather than anywhere
   * else is what makes `--from` a third way of filling the *same*
   * `DimensionInput` the flags and the prompts fill, instead of a third
   * configuration system.
   */
  const templatesRoot = options.templatesRoot ?? findTemplatesRoot();
  const adapters = createAdapterRegistry(templatesRoot);

  /*
   * The preset, one rung below the config file.
   *
   * An unknown name fails here, by the registry's own words, before anything
   * else is read - a name that resolved to nothing would silently become the
   * default stack, which is the one outcome a named starting point must never
   * produce. Flags beat the file's preset, the same way they beat everything
   * else the file says.
   */
  const preset = presetDimensions(flags.preset ?? config.preset, options.presets ?? PRESETS);

  const dimensionInput: DimensionInput = {
    framework: flags.framework ?? config.stack.framework ?? preset.framework,
    buildTool: flags.buildTool ?? config.stack.buildTool ?? preset.buildTool,
    language: flags.language ?? config.stack.language ?? preset.language,
    styling: flags.styling ?? config.stack.styling ?? preset.styling,
    uiLibrary: flags.uiLibrary ?? config.stack.uiLibrary ?? preset.uiLibrary,
    router: flags.router ?? config.stack.router ?? preset.router,
    architecture: flags.architecture ?? config.stack.architecture ?? preset.architecture,
    /*
     * `features` is an array that is empty rather than absent when the flag was
     * never passed, so "did the user say anything" is a length check.
     *
     * Replacement, not merging, at every level. Merging would make a feature a
     * preset sets impossible to remove, and removing one is the whole reason an
     * override exists.
     */
    features:
      flags.features.length > 0 ? flags.features : (config.stack.features ?? preset.features),
  };
  /*
   * The origin only changes the noun in a feature error. A duplicate in a JSON
   * array should not be reported as a problem with a flag the user never typed.
   */
  const origin = { features: flags.features.length > 0 ? '--features' : '"stack.features"' };
  resolveDimensions(dimensionInput, adapters, origin);

  /** Only what the flags said, so `--dry-run` can attribute each dimension. */
  const flagStack: DimensionInput = {
    framework: flags.framework,
    buildTool: flags.buildTool,
    language: flags.language,
    styling: flags.styling,
    uiLibrary: flags.uiLibrary,
    router: flags.router,
    architecture: flags.architecture,
    features: flags.features,
  };

  /*
   * Only dimensions the user actually stated are recorded.
   *
   * `features` arrives as an array that is empty rather than undefined when the
   * flag was never passed, so a plain `!== undefined` marks it on every run -
   * which added a line to the V1 resolution golden for an invocation that
   * configured nothing. `hasDimensionInput` is the shared answer to "was this
   * supplied", and it is what the conflict check below asks too.
   */
  /*
   * Attributed to the layer that actually supplied it, checked in precedence
   * order. A value the preset provided is labelled `preset` rather than
   * `file`, so `--dry-run --debug` explains a stack the user never typed.
   */
  const presetSourceOf = (key: keyof DimensionInput): ValueSource => {
    if (hasDimensionInput({ [key]: flagStack[key] })) return 'flag';
    if (hasDimensionInput({ [key]: config.stack[key] })) return 'file';
    return 'preset';
  };

  for (const key of Object.keys(dimensionInput) as (keyof DimensionInput)[]) {
    if (!hasDimensionInput({ [key]: dimensionInput[key] })) continue;
    mark(`dimension.${key}`, presetSourceOf(key));
  }

  // ---- template defaults layer -------------------------------------------
  /*
   * A template id and a set of dimensions are two ways of naming a stack, and
   * `assertFlagCombinations` already refuses them together as flags. This
   * catches the same ambiguity arriving through `--from`, where the parser
   * never saw it.
   */
  if (explicit.templateId !== undefined && hasDimensionInput(dimensionInput)) {
    /*
     * Worded for either source. Since Stage 16 both halves of this conflict can
     * arrive from a config file, and telling someone to "remove the dimension
     * flags" when they passed none is an instruction they cannot follow.
     */
    throw new CliError('A template and a set of dimensions both name what to build.', {
      hint:
        'A template selects a whole stack; the dimensions configure one. Remove either.\n' +
        `On the command line the dimensions are ${DIMENSION_FLAGS.join(', ')};\n` +
        'in a config file they are the "stack" block, and the template is "template".',
    });
  }

  // ---- directory ----------------------------------------------------------
  let dirInput: string;
  if (explicit.dir !== undefined) {
    dirInput = explicit.dir;
    mark('targetDir', sourceOf('dir'));
  } else if (prompter.interactive) {
    dirInput = await prompter.projectDir('my-client-site', (value) => {
      const nameError = validateProjectName(deriveProjectName(value, cwd));
      if (nameError) return nameError;
      return validateTargetDir(value, dirOptions).error;
    });
    mark('targetDir', 'prompt');
  } else {
    throw new CliError('No target directory was given.', {
      hint: 'Pass one as an argument: create-clientkit my-client-site',
    });
  }

  const targetCheck = validateTargetDir(dirInput, dirOptions);
  // A non-empty directory is not resolved away here: the command layer decides
  // whether to offer a merge, because only it knows whether it can ask. Every
  // other rejection - a filesystem root, the home directory, an over-long path
  // - is refused outright.
  if (targetCheck.error && targetCheck.reason !== 'non-empty') {
    throw new CliError(targetCheck.error);
  }

  const projectName = deriveProjectName(dirInput, cwd);
  const projectNameError = validateProjectName(projectName);
  if (projectNameError) throw new CliError(projectNameError);
  mark('projectName', 'derived');

  // ---- site name ----------------------------------------------------------
  const siteNameDefault = titleCase(projectName);
  let siteName: string;
  if (explicit.siteName !== undefined) {
    siteName = explicit.siteName;
    mark('site.name', sourceOf('siteName'));
  } else if (prompter.interactive) {
    siteName = (await prompter.siteName(siteNameDefault, validateSiteName)).trim();
    if (siteName === '') siteName = siteNameDefault;
    mark('site.name', 'prompt');
  } else {
    siteName = siteNameDefault;
    mark('site.name', 'derived');
  }
  const siteNameError = validateSiteName(siteName);
  if (siteNameError) throw new CliError(siteNameError);

  // ---- production URL -----------------------------------------------------
  let siteUrl: string | null;
  if (explicit.siteUrl !== undefined) {
    const check = validateUrl(explicit.siteUrl);
    if (check.error) throw new CliError(check.error);
    siteUrl = check.value;
    mark('site.url', sourceOf('siteUrl'));
  } else if (prompter.interactive) {
    const answer = await prompter.productionUrl((value) => validateUrl(value).error);
    siteUrl = validateUrl(answer).value;
    mark('site.url', 'prompt');
  } else {
    // Never invented. Absence is represented explicitly as null.
    siteUrl = null;
    mark('site.url', 'default');
  }

  // ---- the stack ----------------------------------------------------------
  /*
   * Asked here, between the client questions and the starter, because the
   * ordering is a dependency rather than a preference.
   *
   * `mode` picks a starter *the chosen template offers*, and which template
   * that is follows from the framework. Asking for the starter first would mean
   * defaulting it from `astro-tailwind` and then possibly generating React -
   * true by coincidence today, since both templates declare the same default,
   * and the kind of coincidence this codebase does not build on. Everything V1
   * asked is still asked, in the order it always was; the stack block is
   * inserted, and `mode` and `setup` remain the last two questions.
   */
  const interactiveDimensions = await promptDimensions({
    input: dimensionInput,
    adapters,
    prompter,
    // Offered only when nothing is settled, which the interactive layer
    // decides by looking at the input it was handed.
    presets: options.presets ?? PRESETS,
    /*
     * A provisional starter, and provably inconsequential: `selectAdapters`
     * skips every `starter:*` feature, so no candidate manifest's compatibility
     * can turn on it. Passed rather than plumbed backwards because the real
     * answer is not known until the question below.
     */
    mode: explicit.mode ?? DEFAULTS.mode,
  });
  for (const dimension of interactiveDimensions.asked) mark(`dimension.${dimension}`, 'prompt');

  /*
   * One normalisation, for both input mechanisms.
   *
   * Flags and answers have arrived in the same shape, so the same function
   * applies the same defaults, the same validation and the same feature
   * ordering to both. There is no interactive branch below this line.
   */
  const dimensions = resolveDimensions(interactiveDimensions.input, adapters, origin);

  // ---- template defaults layer -------------------------------------------
  /*
   * The framework's own template, unless the user named one.
   *
   * `registryFor` is the bridge's, not a copy: for Astro it changes nothing,
   * and for React it answers for a manifest the disk registry has never seen.
   */
  const registry = registryFor(baseRegistry, templatesRoot, dimensions.templateManifest);
  const templateId = explicit.templateId ?? dimensions.templateManifest?.id ?? DEFAULTS.templateId;
  if (!registry.has(templateId) && templateId !== TEMPLATE_ID_PLACEHOLDER) {
    const available = registry.list();
    throw new CliError(`Unknown template "${templateId}".`, {
      hint:
        available.length === 0
          ? 'No templates are available yet.'
          : `Available templates: ${available.map((t) => t.id).join(', ')}.`,
    });
  }
  const templateDefaults = registry.defaultsFor(templateId);
  mark('template.id', explicit.templateId !== undefined ? sourceOf('templateId') : 'default');

  // ---- mode ---------------------------------------------------------------
  let mode = explicit.mode;
  if (mode !== undefined) {
    mark('template.mode', sourceOf('mode'));
  } else if (prompter.interactive) {
    mode = await prompter.mode(templateDefaults.mode ?? DEFAULTS.mode);
    mark('template.mode', 'prompt');
  } else if (templateDefaults.mode !== undefined) {
    mode = templateDefaults.mode;
    mark('template.mode', 'template');
  } else {
    mode = DEFAULTS.mode;
    mark('template.mode', 'default');
  }

  if (registry.has(templateId) && !registry.supportsMode(templateId, mode)) {
    const supported = registry.get(templateId).supportedModes;
    throw new CliError(`Template "${templateId}" does not support mode "${mode}".`, {
      hint: `Supported modes: ${supported.join(', ')}.`,
    });
  }

  // ---- setup (install / git) ---------------------------------------------
  let install: boolean;
  let git: boolean;
  const bothExplicit = explicit.install !== undefined && explicit.git !== undefined;
  if (!bothExplicit && prompter.interactive) {
    const answer = await prompter.setup({
      install: explicit.install ?? DEFAULTS.install,
      git: explicit.git ?? DEFAULTS.git,
    });
    // Flags and the config file still win over the answer.
    install = explicit.install ?? answer.install;
    git = explicit.git ?? answer.git;
    mark('install', explicit.install !== undefined ? sourceOf('install') : 'prompt');
    mark('git', explicit.git !== undefined ? sourceOf('git') : 'prompt');
  } else {
    install = explicit.install ?? DEFAULTS.install;
    git = explicit.git ?? DEFAULTS.git;
    mark('install', explicit.install !== undefined ? sourceOf('install') : 'default');
    mark('git', explicit.git !== undefined ? sourceOf('git') : 'default');
  }

  // ---- non-prompted fields ------------------------------------------------
  const description =
    explicit.siteDescription ?? templateDefaults.description ?? defaultSiteDescription(siteName);
  mark(
    'site.description',
    explicit.siteDescription !== undefined
      ? sourceOf('siteDescription')
      : templateDefaults.description !== undefined
        ? 'template'
        : 'default',
  );

  const locale = explicit.locale ?? templateDefaults.locale ?? DEFAULTS.locale;
  mark(
    'site.locale',
    explicit.locale !== undefined
      ? sourceOf('locale')
      : templateDefaults.locale !== undefined
        ? 'template'
        : 'default',
  );

  const author = explicit.author ?? DEFAULTS.author;
  mark('site.author', explicit.author !== undefined ? sourceOf('author') : 'default');

  // The registry is the authority on a template's version once one is installed.
  const registryVersion = registry.has(templateId) ? registry.get(templateId).version : null;
  const templateVersion = explicit.templateVersion ?? registryVersion ?? DEFAULTS.templateVersion;
  mark(
    'template.version',
    explicit.templateVersion !== undefined
      ? sourceOf('templateVersion')
      : registryVersion !== null
        ? 'template'
        : 'default',
  );

  const detected = detectPackageManager(env['npm_config_user_agent']);
  const packageManager = explicit.packageManager ?? detected ?? DEFAULTS.packageManager;
  mark(
    'packageManager',
    explicit.packageManager !== undefined
      ? sourceOf('packageManager')
      : detected !== null
        ? 'derived'
        : 'default',
  );

  /*
   * Attributed the same way every other dimension is, rather than assumed.
   *
   * This said `'flag'` outright until Stage 16, which was true while a flag was
   * the only way to ask for a feature. With three input mechanisms it became a
   * summary line telling the user their features came from a flag they never
   * typed - `sources['dimension.features']` already knows better.
   */
  mark(
    'features',
    dimensions.features.length === 0 ? 'default' : (sources['dimension.features'] ?? 'prompt'),
  );

  const context: ProjectContext = deepFreeze({
    targetDir: targetCheck.absolutePath,
    projectName,
    site: { name: siteName, url: siteUrl, description, locale, author },
    template: { id: templateId, version: templateVersion, mode },
    /*
     * The features the user asked for, without the starter.
     *
     * This was always `[]` - V1 had no feature system - and leaving it there
     * would have made the resolved-configuration summary and the provenance
     * file both report "none" for a run that selected three. The starter is
     * deliberately excluded rather than merged in: it is already recorded as
     * `mode` on the line above, and stating it twice under two names would be
     * the provenance file describing one choice as two.
     *
     * A default invocation selects no features, so this is still `[]` there -
     * which is what keeps `"features": []` in the V1 golden untouched.
     */
    features: [...dimensions.features],
    packageManager,
    git,
    install,
    cliVersion,
    generatedAt: now.toISOString(),
  });

  /*
   * The same resolution in the V2 vocabulary, assembled in one place.
   *
   * `plan()` still reads the context for tokens and provenance; the adapter
   * pipeline reads this. Neither invents a value the other does not have, which
   * is what a test asserts by comparing this against the manifest
   * `manifestFromProjectContext` derives for every legacy invocation.
   */
  const manifest = deepFreeze(
    manifestFrom(
      {
        targetDir: targetCheck.absolutePath,
        projectName,
        site: { name: siteName, url: siteUrl, description, locale, author },
        packageManager,
        git,
        install,
      },
      dimensions,
      mode,
    ),
  );

  return { context, manifest, sources: Object.freeze({ ...sources }) };
}
