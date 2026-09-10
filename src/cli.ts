import { assertFlagCombinations, parseCliArgs } from './args.js';
import { runCreate } from './commands/create.js';
import { runList } from './commands/list.js';
import { CancelledError, CliError, EXIT_CANCELLED, EXIT_ERROR, EXIT_OK } from './errors.js';
import { emptyRegistry } from './templates/registry.js';
import { helpText } from './ui/help.js';
import { Logger } from './ui/logger.js';
import { MIN_NODE_VERSION, nodeVersionMessage, satisfiesMinimum } from './util/node.js';
import { CLI_VERSION } from './version.js';

export interface MainOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly nodeVersion?: string;
  readonly logger?: Logger;
}

/**
 * Top-level entry. Returns an exit code rather than calling process.exit so the
 * whole CLI can be driven from a test.
 */
export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const logger = options.logger ?? new Logger();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const nodeVersion = options.nodeVersion ?? process.versions.node;

  try {
    const flags = parseCliArgs(argv);
    logger.setDebug(flags.debug);
    logger.debug(`argv=${JSON.stringify(argv)}`);
    logger.debug(`node=${nodeVersion} cwd=${cwd}`);

    // Checked before any prompt or other work.
    if (!satisfiesMinimum(nodeVersion, MIN_NODE_VERSION)) {
      throw new CliError(nodeVersionMessage(nodeVersion, MIN_NODE_VERSION), {
        hint: 'Upgrade Node.js, or use a version manager such as nvm or fnm.',
      });
    }

    if (flags.help) {
      logger.print(helpText());
      return EXIT_OK;
    }
    if (flags.version) {
      logger.print(CLI_VERSION);
      return EXIT_OK;
    }
    assertFlagCombinations(flags);

    if (flags.listTemplates) {
      return runList(emptyRegistry, logger);
    }

    return await runCreate({
      flags,
      logger,
      registry: emptyRegistry,
      cliVersion: CLI_VERSION,
      cwd,
      env,
      isTTY,
    });
  } catch (error) {
    return reportError(error, logger);
  }
}

export function reportError(error: unknown, logger: Logger): number {
  if (error instanceof CancelledError) {
    logger.print('');
    logger.info('Cancelled.');
    return EXIT_CANCELLED;
  }

  if (error instanceof CliError) {
    logger.error(error.message);
    if (error.hint) logger.hint(error.hint);
    if (logger.debugEnabled && error.stack) logger.debug(error.stack);
    if (logger.debugEnabled && error.cause) logger.debug(`cause: ${String(error.cause)}`);
    return error.exitCode;
  }

  // Anything reaching here is a bug in the CLI, not user error.
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Unexpected error: ${message}`);
  if (logger.debugEnabled) {
    logger.debug(error instanceof Error && error.stack ? error.stack : String(error));
  } else {
    logger.hint('Re-run with --debug for a full stack trace.');
  }
  return EXIT_ERROR;
}

/** Wires the entry point to the real process. Called only from bin/cli.js. */
export async function run(): Promise<void> {
  // Ctrl+C outside a prompt: exit 130 quietly, no stack trace.
  process.on('SIGINT', () => {
    process.exitCode = EXIT_CANCELLED;
    process.stderr.write('\n');
    process.exit(EXIT_CANCELLED);
  });

  process.exitCode = await main(process.argv.slice(2));
}
