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
import { loadConfigFile, type FileReader } from './fromFile.js';
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

  const fileLayer =
    flags.from === undefined
      ? {}
      : loadConfigFile(flags.from, {
          cwd,
          ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
        });
  const flagLayer = flagsLayer(flags, cwd);

  /** Everything the user stated explicitly, flags beating the config file. */
  const explicit: ContextInput = { ...fileLayer, ...flagLayer };
  const sourceOf = (key: keyof ContextInput): ValueSource =>
    flagLayer[key] !== undefined ? 'flag' : 'file';

  // ---- dimensions ---------------------------------------------------------
  /*
   * Resolved before anything is prompted for, so a malformed `--framework`
   * fails immediately rather than after three questions.
   */
  const templatesRoot = options.templatesRoot ?? findTemplatesRoot();
  const dimensionInput: DimensionInput = {
    framework: flags.framework,
    buildTool: flags.buildTool,
    language: flags.language,
    styling: flags.styling,
    uiLibrary: flags.uiLibrary,
    router: flags.router,
    architecture: flags.architecture,
    features: flags.features,
  };
  const dimensions = resolveDimensions(dimensionInput, createAdapterRegistry(templatesRoot));

  /*
   * Only dimensions the user actually stated are recorded.
   *
   * `features` arrives as an array that is empty rather than undefined when the
   * flag was never passed, so a plain `!== undefined` marks it on every run -
   * which added a line to the V1 resolution golden for an invocation that
   * configured nothing. `hasDimensionInput` is the shared answer to "was this
   * supplied", and it is what the conflict check below asks too.
   */
  for (const key of Object.keys(dimensionInput) as (keyof DimensionInput)[]) {
    if (hasDimensionInput({ [key]: dimensionInput[key] })) mark(`dimension.${key}`, 'flag');
  }

  // ---- template defaults layer -------------------------------------------
  /*
   * A template id and a set of dimensions are two ways of naming a stack, and
   * `assertFlagCombinations` already refuses them together as flags. This
   * catches the same ambiguity arriving through `--from`, where the parser
   * never saw it.
   */
  if (explicit.templateId !== undefined && hasDimensionInput(dimensionInput)) {
    throw new CliError('A template and a set of dimensions both name what to build.', {
      hint:
        `"template" selects a whole stack; ${DIMENSION_FLAGS.join(', ')} configure one.\n` +
        'Remove the template, or remove the dimension flags.',
    });
  }

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

  mark('features', dimensions.features.length > 0 ? 'flag' : 'default');

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
