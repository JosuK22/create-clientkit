import { parseArgs } from 'node:util';

import { CliError, EXIT_USAGE } from './errors.js';

export interface ParsedFlags {
  readonly positionals: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
  readonly listTemplates: boolean;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly debug: boolean;
  readonly noGit: boolean;
  readonly noInstall: boolean;
  readonly template: string | undefined;
  readonly name: string | undefined;
  readonly url: string | undefined;
  readonly mode: string | undefined;
  readonly from: string | undefined;
  readonly pm: string | undefined;

  /**
   * The V2 dimension flags, carried as raw strings.
   *
   * Unparsed on purpose. What these words mean is the domain's question, and
   * answering it here would put a second copy of the vocabulary in the parser.
   * `src/context/dimensions.ts` is the one place they become ids.
   */
  readonly framework: string | undefined;
  readonly buildTool: string | undefined;
  readonly language: string | undefined;
  readonly styling: string | undefined;
  readonly uiLibrary: string | undefined;
  readonly router: string | undefined;
  readonly architecture: string | undefined;
  /** Every `--features` occurrence, each still comma-joined. */
  readonly features: readonly string[];
}

/**
 * Node's parseArgs has no native `--no-x` negation, so the negated forms are
 * registered as their own boolean options.
 */
const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  template: { type: 'string', short: 't' },
  'list-templates': { type: 'boolean' },
  name: { type: 'string' },
  url: { type: 'string' },
  mode: { type: 'string', short: 'm' },
  yes: { type: 'boolean', short: 'y' },
  from: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'no-git': { type: 'boolean' },
  'no-install': { type: 'boolean' },
  pm: { type: 'string' },
  debug: { type: 'boolean' },

  // The V2 dimensions. No short forms: these are typed rarely and read often,
  // and `-f` would have to arbitrate between framework and features.
  framework: { type: 'string' },
  'build-tool': { type: 'string' },
  language: { type: 'string' },
  styling: { type: 'string' },
  'ui-library': { type: 'string' },
  router: { type: 'string' },
  architecture: { type: 'string' },
  /**
   * Repeatable, and every occurrence is kept.
   *
   * The single-valued default would make `--features seo --features accessibility`
   * silently drop the first, which is the quiet data loss this codebase treats
   * as worse than an error.
   */
  features: { type: 'string', multiple: true },
} as const;

export function parseCliArgs(argv: readonly string[]): ParsedFlags {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(message, {
      exitCode: EXIT_USAGE,
      hint: 'Run `create-clientkit --help` to see the supported flags.',
      cause: error,
    });
  }

  const values = parsed.values as Record<string, string | string[] | boolean | undefined>;
  const asBool = (key: string): boolean => values[key] === true;
  const asStr = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;
  const asList = (key: string): readonly string[] =>
    Array.isArray(values[key]) ? (values[key] as string[]) : [];

  if (parsed.positionals.length > 1) {
    throw new CliError(
      `Expected at most one target directory, but received ${parsed.positionals.length}.`,
      {
        exitCode: EXIT_USAGE,
        hint: 'Quote the path if it contains spaces: create-clientkit "my site".',
      },
    );
  }

  return {
    positionals: parsed.positionals,
    help: asBool('help'),
    version: asBool('version'),
    listTemplates: asBool('list-templates'),
    yes: asBool('yes'),
    dryRun: asBool('dry-run'),
    debug: asBool('debug'),
    noGit: asBool('no-git'),
    noInstall: asBool('no-install'),
    template: asStr('template'),
    name: asStr('name'),
    url: asStr('url'),
    mode: asStr('mode'),
    from: asStr('from'),
    pm: asStr('pm'),

    framework: asStr('framework'),
    buildTool: asStr('build-tool'),
    language: asStr('language'),
    styling: asStr('styling'),
    uiLibrary: asStr('ui-library'),
    router: asStr('router'),
    architecture: asStr('architecture'),
    features: asList('features'),
  };
}

/** The dimension flags an invocation actually supplied, for diagnostics. */
export function dimensionFlagsUsed(flags: ParsedFlags): readonly string[] {
  const used: string[] = [];
  if (flags.framework !== undefined) used.push('--framework');
  if (flags.buildTool !== undefined) used.push('--build-tool');
  if (flags.language !== undefined) used.push('--language');
  if (flags.styling !== undefined) used.push('--styling');
  if (flags.uiLibrary !== undefined) used.push('--ui-library');
  if (flags.router !== undefined) used.push('--router');
  if (flags.architecture !== undefined) used.push('--architecture');
  if (flags.features.length > 0) used.push('--features');
  return used;
}

/**
 * Cross-flag combination checks.
 *
 * Called from the CLI entry before command dispatch (so it also covers
 * --list-templates) and again from the resolver, which must stay valid when
 * driven directly from a test.
 */
export function assertFlagCombinations(flags: ParsedFlags): void {
  if (flags.listTemplates && (flags.positionals.length > 0 || flags.from !== undefined)) {
    throw new CliError('--list-templates cannot be combined with a target directory or --from.', {
      exitCode: EXIT_USAGE,
      hint: 'Run `create-clientkit --list-templates` on its own.',
    });
  }

  /*
   * `--template` and the dimension flags are two ways of saying what to build,
   * and they are refused together rather than reconciled.
   *
   * A template names a whole stack; a dimension flag configures one axis of
   * one. Deciding per axis which wins would mean a rule nobody could predict -
   * and the case where they happen to agree is not a rule, it is a
   * coincidence. So `--template astro-tailwind --framework react` is an error,
   * and so is `--template astro-tailwind --styling tailwind`, which agrees.
   * One sentence the user can act on beats a precedence table.
   */
  const dimensions = dimensionFlagsUsed(flags);
  if (flags.template !== undefined && dimensions.length > 0) {
    throw new CliError(`--template cannot be combined with ${dimensions.join(', ')}.`, {
      exitCode: EXIT_USAGE,
      hint:
        '--template selects a whole stack; the dimension flags configure one.\n' +
        'Drop --template and state the stack, or drop the dimension flags and keep the template.',
    });
  }
}
