import path from 'node:path';

import { createAdapterRegistry } from '../adapters/registry.js';
import type { ParsedFlags } from '../args.js';
import { detectProject, type DetectFs } from '../detect/detect.js';
import { resolveDetectedStack } from '../detect/stack.js';
import { diagnoseProject } from '../doctor/diagnose.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { findTemplatesRoot } from '../templates/registry.js';
import { renderDoctorReport } from '../ui/doctor.js';
import type { Logger } from '../ui/logger.js';
import { generationFlags } from './detect.js';

/**
 * `create-clientkit doctor [directory]`: say whether anything about a project
 * needs attention before ClientKit works with it, and change nothing.
 *
 * Detect once, diagnose from the result. The one detection pass is `detect`'s,
 * the one resolution is `detect`'s, and the diagnosis is a pure function of the
 * two - see `doctor/diagnose.ts`. It never prompts, writes, installs, or runs a
 * package manager or a project script.
 *
 * Exit codes:
 *
 *   0  no errors - a healthy project, or one with warnings only. A warning is
 *      something to look at, not a reason to fail a script.
 *   2  at least one error: the stack is one ClientKit cannot use, or
 *      package.json is unusable. The same code a missing directory or a refused
 *      option exits with, because each is the user's input rather than the
 *      CLI failing.
 */

export interface DoctorOptions {
  readonly flags: ParsedFlags;
  readonly logger: Logger;
  readonly cwd: string;
  /** Injectable so a test can drive the command against an in-memory project. */
  readonly fs?: DetectFs;
  readonly templatesRoot?: string;
}

export function runDoctor(options: DoctorOptions): number {
  const { flags, logger, cwd } = options;

  const refused = generationFlags(flags);
  if (refused.length > 0) {
    throw new CliError(`doctor does not take ${refused.join(', ')}.`, {
      exitCode: EXIT_USAGE,
      hint: 'doctor only reads a project. Pass a directory, and --debug for more detail.',
    });
  }

  const root = path.resolve(cwd, flags.positionals[0] ?? '.');
  logger.debug(`doctor root=${root}`);

  const detection = detectProject({
    root,
    command: 'doctor',
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  logger.debug(`doctor detection complete: state=${detection.state}`);

  const templatesRoot =
    options.templatesRoot ?? findTemplatesRoot(path.resolve(import.meta.dirname, '..'));
  const stack = resolveDetectedStack(detection, createAdapterRegistry(templatesRoot));
  logger.debug(
    `doctor stack=${stack.status}${stack.status === 'unresolved' ? `:${stack.kind}` : ''}`,
  );

  const report = diagnoseProject(detection, stack);
  logger.debug(
    `doctor checks=${report.checks.length} errors=${report.errors} warnings=${report.warnings}`,
  );

  logger.print(renderDoctorReport(report, { cwd, verbose: flags.debug }));
  logger.print('');
  logger.success('Diagnosis complete. Nothing was changed.');
  return report.errors > 0 ? EXIT_USAGE : EXIT_OK;
}
