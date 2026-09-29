import path from 'node:path';

import { createAdapterRegistry } from '../adapters/registry.js';
import { dimensionFlagsUsed, type ParsedFlags } from '../args.js';
import { detectProject, type DetectFs } from '../detect/detect.js';
import { resolveDetectedStack } from '../detect/stack.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { findTemplatesRoot } from '../templates/registry.js';
import { renderDetection } from '../ui/detect.js';
import type { Logger } from '../ui/logger.js';

/**
 * `create-clientkit detect [directory]`: report what a project is, and change
 * nothing.
 *
 * Informational only. It never prompts, never writes, and never runs a package
 * manager or a project script - see `detect/detect.ts` for exactly what it
 * reads. It exits 0 whenever detection completes, however much of the answer is
 * "unknown"; only a directory that cannot be read at all is an error.
 */

export interface DetectOptions {
  readonly flags: ParsedFlags;
  readonly logger: Logger;
  readonly cwd: string;
  /** Injectable so a test can drive the command against an in-memory project. */
  readonly fs?: DetectFs;
  readonly templatesRoot?: string;
}

/**
 * Options that configure or perform generation, which `detect` does neither of.
 *
 * Refused rather than ignored: `detect --framework react` reads as a request to
 * check the project *against* React, and silently dropping the flag would
 * answer a different question than the one asked.
 */
export function generationFlags(flags: ParsedFlags): readonly string[] {
  const used: string[] = [...dimensionFlagsUsed(flags)];
  if (flags.yes) used.push('--yes');
  if (flags.dryRun) used.push('--dry-run');
  if (flags.noGit) used.push('--no-git');
  if (flags.noInstall) used.push('--no-install');
  if (flags.template !== undefined) used.push('--template');
  if (flags.name !== undefined) used.push('--name');
  if (flags.url !== undefined) used.push('--url');
  if (flags.mode !== undefined) used.push('--mode');
  if (flags.from !== undefined) used.push('--from');
  if (flags.pm !== undefined) used.push('--pm');
  return used;
}

export function runDetect(options: DetectOptions): number {
  const { flags, logger, cwd } = options;

  const refused = generationFlags(flags);
  if (refused.length > 0) {
    throw new CliError(`detect does not take ${refused.join(', ')}.`, {
      exitCode: EXIT_USAGE,
      hint: 'detect only reads a project. Pass a directory, and --debug for more detail.',
    });
  }

  const root = path.resolve(cwd, flags.positionals[0] ?? '.');
  logger.debug(`detect root=${root}`);

  const detection = detectProject({
    root,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  logger.debug(`detect state=${detection.state}`);

  const templatesRoot =
    options.templatesRoot ?? findTemplatesRoot(path.resolve(import.meta.dirname, '..'));
  const stack = resolveDetectedStack(detection, createAdapterRegistry(templatesRoot));

  logger.print(renderDetection(detection, stack, { cwd, verbose: flags.debug }));
  logger.print('');
  logger.success('Detection complete. Nothing was changed.');
  return EXIT_OK;
}
