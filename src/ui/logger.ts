import pc from 'picocolors';

export interface LoggerStreams {
  readonly out: NodeJS.WritableStream;
  readonly err: NodeJS.WritableStream;
}

export interface LoggerOptions {
  readonly debug?: boolean;
  readonly streams?: LoggerStreams;
}

/**
 * The only module allowed to write to stdout/stderr.
 *
 * Streams are injectable so tests can assert on output without touching the
 * real console. Diagnostics go to stderr, so `--dry-run` output on stdout stays
 * pipeable.
 */
export class Logger {
  #debugEnabled: boolean;
  #out: NodeJS.WritableStream;
  #err: NodeJS.WritableStream;

  constructor(options: LoggerOptions = {}) {
    this.#debugEnabled = options.debug ?? false;
    this.#out = options.streams?.out ?? process.stdout;
    this.#err = options.streams?.err ?? process.stderr;
  }

  get debugEnabled(): boolean {
    return this.#debugEnabled;
  }

  setDebug(enabled: boolean): void {
    this.#debugEnabled = enabled;
  }

  /** Raw line to stdout, no decoration. For --help, --version, plans. */
  print(message = ''): void {
    this.#out.write(`${message}\n`);
  }

  info(message: string): void {
    this.#err.write(`${pc.blue('i')} ${message}\n`);
  }

  success(message: string): void {
    this.#err.write(`${pc.green('*')} ${message}\n`);
  }

  warn(message: string): void {
    this.#err.write(`${pc.yellow('!')} ${pc.yellow(message)}\n`);
  }

  error(message: string): void {
    this.#err.write(`${pc.red('x')} ${pc.red(message)}\n`);
  }

  hint(message: string): void {
    this.#err.write(`  ${pc.dim(message)}\n`);
  }

  debug(message: string): void {
    if (!this.#debugEnabled) return;
    this.#err.write(`${pc.magenta('debug')} ${pc.dim(message)}\n`);
  }
}
