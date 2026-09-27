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

/**
 * The plan could not be built: an invalid template, an operation that would
 * leave the target directory, two operations for one path. Raised before
 * anything is written, so nothing needs undoing.
 *
 * A `CliError`, so it is reported and exits exactly as one; the subclass only
 * lets a caller tell "could not decide what to write" from "could not write".
 */
export class PlanningError extends CliError {
  constructor(
    message: string,
    options: { exitCode?: number; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'PlanningError';
  }
}

/**
 * Applying a finished plan failed: permission denied, a busy or full disk, a
 * path the executor refused at the mutation boundary.
 */
export class ExecutionError extends CliError {
  constructor(
    message: string,
    options: { exitCode?: number; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'ExecutionError';
  }
}

/**
 * Detection itself could not run: the directory is missing, is not a
 * directory, or cannot be listed. An unrecognised or half-configured project
 * is not this - that is a successful detection whose answer is "unknown".
 */
export class DetectionError extends CliError {
  constructor(
    message: string,
    options: { exitCode?: number; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'DetectionError';
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
