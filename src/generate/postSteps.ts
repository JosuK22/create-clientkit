import { spawnSync } from 'node:child_process';

import type { PostStep } from '../templates/manifest.js';
import type { ProjectContext } from '../types.js';
import type { Logger } from '../ui/logger.js';
import { planPostSteps } from './postStepPlan.js';

/**
 * Post-step execution: the only module in ClientKit that starts a process.
 *
 * What runs is decided in `postStepPlan.ts`, which only describes commands;
 * this module executes exactly those descriptions and nothing else. It is
 * reached only from `create`, after the files were written - never from a
 * dry run, detect, doctor or upgrade.
 */

export interface PostStepResult {
  readonly step: PostStep;
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly detail?: string;
}

export interface PostStepOptions {
  readonly context: ProjectContext;
  readonly logger: Logger;
  readonly steps: readonly PostStep[];
  /** Injected in tests so nothing is actually spawned. */
  readonly run?: CommandRunner;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => { status: number | null; stderr: string };

const defaultRunner: CommandRunner = (command, args, cwd) => {
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    // Windows resolves npm/pnpm/yarn as .cmd shims, which spawn cannot execute
    // directly. Both the command and every argument here are CLI-owned
    // constants, never template or user input.
    shell: process.platform === 'win32',
  });
  return { status: result.status, stderr: result.stderr ?? String(result.error ?? '') };
};

export function runPostSteps(options: PostStepOptions): PostStepResult[] {
  const { context, logger, steps } = options;
  const run = options.run ?? defaultRunner;
  const results: PostStepResult[] = [];

  for (const planned of planPostSteps(context, steps)) {
    const { step } = planned;
    if (!('command' in planned)) {
      if (step === 'format') logger.debug('post-step "format" is a no-op in this release');
      results.push({ step, status: 'skipped', detail: planned.skipped });
      continue;
    }

    if (step === 'install') {
      logger.info(`Installing dependencies with ${context.packageManager}...`);
    }
    const [program, ...args] = planned.command;
    const result = run(program, args, context.targetDir);
    results.push(
      result.status === 0
        ? { step, status: 'ok' }
        : { step, status: 'failed', detail: firstLine(result.stderr) },
    );
  }

  return results;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}
