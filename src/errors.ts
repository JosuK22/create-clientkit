/**
 * Errors the user is expected to see: printed as a single sentence, no stack
 * trace unless --debug. Anything that is *not* a CliError is a bug in the CLI
 * and is reported as such.
 */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { exitCode?: number; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}

/** Raised when the user cancels a prompt (Ctrl+C). Exits 130, prints nothing ugly. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CancelledError';
  }
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_CANCELLED = 130;
