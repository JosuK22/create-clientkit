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

export function runPostSteps(options: PostStepOptions): PostStepResult[] {
  const { context, logger, steps } = options;
  const run = options.run ?? defaultRunner;
  const results: PostStepResult[] = [];

  for (const step of steps) {
    switch (step) {
      case 'install': {
        if (!context.install) {
          results.push({ step, status: 'skipped', detail: 'disabled by --no-install' });
          break;
        }
        const args = INSTALL_ARGS[context.packageManager];
        logger.info(`Installing dependencies with ${context.packageManager}...`);
        const result = run(context.packageManager, args, context.targetDir);
        results.push(
          result.status === 0
            ? { step, status: 'ok' }
            : { step, status: 'failed', detail: firstLine(result.stderr) },
        );
        break;
      }

      case 'git-init': {
        if (!context.git) {
          results.push({ step, status: 'skipped', detail: 'disabled by --no-git' });
          break;
        }
        const result = run('git', ['init', '--quiet'], context.targetDir);
        results.push(
          result.status === 0
            ? { step, status: 'ok' }
            : { step, status: 'failed', detail: firstLine(result.stderr) },
        );
        break;
      }

      case 'format': {
        // Known identifier, intentionally inert in M2: the generated project
        // has no formatter dependency yet. Wired up in a later milestone.
        logger.debug('post-step "format" is a no-op in this release');
        results.push({ step, status: 'skipped', detail: 'not implemented yet' });
        break;
      }
    }
  }

  return results;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}
