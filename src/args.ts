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
  readonly from: string | undefined;
  readonly pm: string | undefined;
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
  yes: { type: 'boolean', short: 'y' },
  from: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'no-git': { type: 'boolean' },
  'no-install': { type: 'boolean' },
  pm: { type: 'string' },
  debug: { type: 'boolean' },
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

  const values = parsed.values as Record<string, string | boolean | undefined>;
  const asBool = (key: string): boolean => values[key] === true;
  const asStr = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;

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
    from: asStr('from'),
    pm: asStr('pm'),
  };
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
}
