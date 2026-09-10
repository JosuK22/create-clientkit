import type { ParsedFlags } from '../args.js';
import { resolveContext } from '../context/resolve.js';
import { ClackPrompter, NonInteractivePrompter, type Prompter } from '../context/prompts.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import type { TemplateRegistry } from '../templates/registry.js';
import type { Logger } from '../ui/logger.js';
import { renderPlan } from '../ui/plan.js';

export interface CreateOptions {
  readonly flags: ParsedFlags;
  readonly logger: Logger;
  readonly registry: TemplateRegistry;
  readonly cliVersion: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly isTTY: boolean;
}

/**
 * Chooses the input source for unanswered values.
 *
 * `--yes` never prompts. A non-TTY stdin without `--yes` fails immediately
 * rather than hanging on a read that will never return.
 */
function selectPrompter(flags: ParsedFlags, isTTY: boolean): Prompter {
  if (flags.yes) return new NonInteractivePrompter('--yes was passed, so prompts are disabled');
  if (!isTTY) {
    throw new CliError('Cannot prompt because stdin is not an interactive terminal.', {
      exitCode: EXIT_USAGE,
      hint: 'Re-run with --yes, or supply the answers via flags and --from <file.json>.',
    });
  }
  return new ClackPrompter();
}

export async function runCreate(options: CreateOptions): Promise<number> {
  const { flags, logger, registry, cliVersion, cwd, env, isTTY } = options;

  const prompter = selectPrompter(flags, isTTY);
  logger.debug(`prompter=${prompter.interactive ? 'interactive' : 'non-interactive'} tty=${isTTY}`);

  if (prompter instanceof ClackPrompter) prompter.intro(cliVersion);

  const { context, sources } = await resolveContext({
    flags,
    cwd,
    env,
    prompter,
    registry,
    cliVersion,
    now: new Date(),
  });

  logger.debug(`resolved context: ${JSON.stringify(context)}`);

  if (flags.dryRun) {
    logger.print('');
    logger.print('DRY RUN - no files will be written.');
    logger.print('');
  }
  logger.print(renderPlan(context, sources, { showSources: flags.dryRun || flags.debug }));
  logger.print('');

  // M1 stops here by design: the generator and template engine land in M2.
  logger.warn('Generation is not implemented yet - nothing was written to disk.');
  logger.hint('This build resolves and validates configuration only (milestone M1).');

  return EXIT_OK;
}
