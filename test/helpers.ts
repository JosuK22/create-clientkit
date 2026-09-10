import path from 'node:path';

import type { Prompter, SetupAnswer } from '../src/context/prompts.js';
import type { TargetDirFs } from '../src/context/validate.js';
import type { TemplateMode } from '../src/types.js';
import { Logger } from '../src/ui/logger.js';

/** Short, non-existent cwd so path-length checks and the real fs stay out of play. */
export const TEST_CWD = path.join(path.parse(process.cwd()).root, 'ck-test');
export const TEST_HOME = path.join(path.parse(process.cwd()).root, 'ck-home');

/** Pretends every path is missing, so nothing touches the real filesystem. */
export const emptyFs: TargetDirFs = {
  statSync: () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  },
  readdirSync: () => [],
};

export function occupiedFs(entries: string[]): TargetDirFs {
  return {
    statSync: () => ({ isDirectory: () => true }),
    readdirSync: () => entries,
  };
}

export interface FakeAnswers {
  dir?: string;
  siteName?: string;
  url?: string | null;
  mode?: TemplateMode;
  setup?: SetupAnswer;
}

/** Records which questions were asked, so precedence can be asserted directly. */
export class FakePrompter implements Prompter {
  readonly interactive = true;
  readonly asked: string[] = [];
  readonly #answers: FakeAnswers;

  constructor(answers: FakeAnswers = {}) {
    this.#answers = answers;
  }

  async projectDir(defaultValue: string): Promise<string> {
    this.asked.push('dir');
    return this.#answers.dir ?? defaultValue;
  }

  async siteName(defaultValue: string): Promise<string> {
    this.asked.push('siteName');
    return this.#answers.siteName ?? defaultValue;
  }

  async productionUrl(): Promise<string | null> {
    this.asked.push('url');
    return this.#answers.url ?? null;
  }

  async mode(defaultValue: TemplateMode): Promise<TemplateMode> {
    this.asked.push('mode');
    return this.#answers.mode ?? defaultValue;
  }

  async setup(defaults: SetupAnswer): Promise<SetupAnswer> {
    this.asked.push('setup');
    return this.#answers.setup ?? defaults;
  }
}

export class Collector {
  chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  get text(): string {
    return this.chunks.join('');
  }
}

export function testLogger(): { logger: Logger; out: Collector; err: Collector } {
  const out = new Collector();
  const err = new Collector();
  const logger = new Logger({
    streams: {
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    },
  });
  return { logger, out, err };
}
