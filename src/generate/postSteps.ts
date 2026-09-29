import { spawnSync } from 'node:child_process';

import type { PostStep } from '../templates/manifest.js';
import type { PackageManager, ProjectContext } from '../types.js';
import type { Logger } from '../ui/logger.js';

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

/**
 * Post-step execution is entirely CLI-owned.
 *
 * A template can only name an identifier from a fixed allow-list; the command,
 * its arguments and its working directory are chosen here. No template-supplied
 * string ever reaches a process or a shell, so `template.json` cannot smuggle
 * in `rm -rf`, `curl` or a PowerShell invocation.
 */
const INSTALL_ARGS: Readonly<Record<PackageManager, readonly string[]>> = {
  npm: ['install'],
  pnpm: ['install'],
  yarn: ['install'],
  bun: ['install'],
};

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

/**
 * What a post step would do: the exact command, or why it will not run.
 *
 * The one place a step becomes a command. `runPostSteps` executes from it and
 * `--dry-run` displays it, so the preview cannot describe a command the real
 * run would not use.
 */
export type PlannedPostStep =
  | {
      readonly step: PostStep;
      /** Program first, then its arguments. Run in the target directory. */
      readonly command: readonly [string, ...string[]];
    }
  | { readonly step: PostStep; readonly skipped: string };

export function planPostSteps(
  context: ProjectContext,
  steps: readonly PostStep[],
): PlannedPostStep[] {
  return steps.map((step): PlannedPostStep => {
    switch (step) {
      case 'install':
        return context.install
          ? { step, command: [context.packageManager, ...INSTALL_ARGS[context.packageManager]] }
          : { step, skipped: 'disabled by --no-install' };
      case 'git-init':
        return context.git
          ? { step, command: ['git', 'init', '--quiet'] }
          : { step, skipped: 'disabled by --no-git' };
      case 'format':
        // Known identifier, intentionally inert in M2: the generated project
        // has no formatter dependency yet. Wired up in a later milestone.
        return { step, skipped: 'not implemented yet' };
    }
  });
}

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
