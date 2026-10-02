import type { PostStep } from '../templates/manifest.js';
import type { PackageManager, ProjectContext } from '../types.js';

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
