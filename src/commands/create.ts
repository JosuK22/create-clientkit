import { readdirSync } from 'node:fs';
import path from 'node:path';

import type { ParsedFlags } from '../args.js';
import { ClackPrompter, NonInteractivePrompter, type Prompter } from '../context/prompts.js';
import { resolveContext } from '../context/resolve.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { apply, findCollisions } from '../generate/apply.js';
import { planManifest } from '../adapters/bridge.js';
import { runPostSteps } from '../generate/postSteps.js';
import type { TemplateRegistry } from '../templates/registry.js';
import type { Logger } from '../ui/logger.js';
import { renderDryRun, renderNextSteps, renderPlan } from '../ui/plan.js';
import { satisfiesMinimum } from '../util/node.js';

export interface CreateOptions {
  readonly flags: ParsedFlags;
  readonly logger: Logger;
  readonly registry: TemplateRegistry;
  readonly cliVersion: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly isTTY: boolean;
  readonly nodeVersion: string;
  /**
   * Overrides how unanswered values are collected. Production always uses
   * {@link selectPrompter}; tests inject a fake so the interactive
   * confirmation branch can be exercised without a terminal.
   */
  readonly prompter?: Prompter;
}

/**
 * Chooses the input source for unanswered values.
 *
 * `--yes` never prompts. A non-TTY stdin without `--yes` fails immediately
 * rather than hanging on a read that will never return.
 */
function selectPrompter(flags: ParsedFlags, isTTY: boolean): Prompter {
  if (flags.yes) return new NonInteractivePrompter('--yes was passed, so prompts are disabled');
  if (!isTTY) {
    throw new CliError('Cannot prompt because stdin is not an interactive terminal.', {
      exitCode: EXIT_USAGE,
      hint: 'Re-run with --yes, or supply the answers via flags and --from <file.json>.',
    });
  }
  return new ClackPrompter();
}

function hasContent(targetDir: string): boolean {
  try {
    return readdirSync(targetDir).filter((entry) => entry !== '.git').length > 0;
  } catch {
    return false;
  }
}

export async function runCreate(options: CreateOptions): Promise<number> {
  const { flags, logger, registry, cliVersion, cwd, env, isTTY, nodeVersion } = options;

  const prompter = options.prompter ?? selectPrompter(flags, isTTY);
  logger.debug(`prompter=${prompter.interactive ? 'interactive' : 'non-interactive'} tty=${isTTY}`);

  if (prompter instanceof ClackPrompter) prompter.intro(cliVersion);

  const {
    context,
    manifest: projectManifest,
    sources,
    stack,
  } = await resolveContext({
    flags,
    cwd,
    env,
    prompter,
    registry,
    cliVersion,
    now: new Date(),
  });

  /*
   * The manifest, not the context.
   *
   * Since Stage 14 the resolver produces both, and this is the one the pipeline
   * takes. Routing the command through it is what makes the dimension flags do
   * anything at all - `planWithAdapters` derives its manifest from a context,
   * and a context has no framework on it, so every run would resolve to Astro.
   *
   * Byte-for-byte identical to the previous call for a legacy invocation: the
   * resolved manifest is the one `manifestFromProjectContext` would have
   * derived, and a test asserts exactly that.
   */
  const planned = planManifest(projectManifest, {
    registry,
    cliVersion,
    generatedAt: context.generatedAt,
    mode: context.template.mode,
    templateId: context.template.id,
  });
  const generationPlan = planned.plan;
  // Read from the plan rather than the registry: React's template manifest
  // lives on its adapter, so `registry.get('react-vite')` would throw.
  const manifest = planned.templateManifest;
  logger.debug(`planned ${generationPlan.operations.length} operations`);

  if (flags.dryRun) {
    logger.print(
      renderDryRun(generationPlan, projectManifest, stack, context, sources, {
        verbose: flags.debug,
      }),
    );
    return EXIT_OK;
  }

  // The CLI runs on Node 20.19, but a template may target something newer.
  if (!satisfiesMinimum(nodeVersion, manifest.minNode.replace(/^>=/, ''))) {
    logger.warn(
      `Template "${manifest.id}" targets Node ${manifest.minNode}, but you are running ${nodeVersion}.`,
    );
    logger.hint('The project will still be generated, but installing or building it may fail.');
  }

  // ---- non-empty target directory ----------------------------------------
  const collisions = findCollisions(generationPlan);
  let allowNonEmpty = false;

  if (hasContent(generationPlan.targetDir)) {
    if (!prompter.interactive) {
      throw new CliError(
        `Directory "${generationPlan.targetDir}" already exists and is not empty.`,
        {
          hint: 'Choose an empty directory, or re-run interactively to confirm writing into this one.',
        },
      );
    }

    logger.warn(`${path.basename(generationPlan.targetDir)} already contains files.`);
    if (collisions.length > 0) {
      logger.hint(`${collisions.length} existing file(s) would be replaced:`);
      for (const file of collisions.slice(0, 10)) logger.hint(`  ${file}`);
      if (collisions.length > 10) logger.hint(`  ...and ${collisions.length - 10} more`);
    } else {
      logger.hint('No existing file would be replaced; new files are added alongside.');
    }

    allowNonEmpty = await prompter.confirmNonEmpty(collisions.length);
    if (!allowNonEmpty) {
      logger.info('Cancelled. Nothing was written.');
      return EXIT_OK;
    }
  }

  // ---- generate -----------------------------------------------------------
  const result = apply(generationPlan, { allowNonEmpty });
  logger.success(
    `Created ${result.written.length} files in ${path.relative(cwd, result.targetDir) || '.'}`,
  );
  if (result.overwritten.length > 0) {
    logger.warn(`Replaced ${result.overwritten.length} existing file(s).`);
  }

  // ---- post steps ---------------------------------------------------------
  const postResults = runPostSteps({ context, logger, steps: manifest.postSteps });
  for (const postResult of postResults) {
    if (postResult.status === 'ok') {
      logger.success(
        postResult.step === 'install' ? 'Dependencies installed.' : 'Git repository initialised.',
      );
    } else if (postResult.status === 'failed') {
      logger.warn(`Post-step "${postResult.step}" failed: ${postResult.detail ?? 'unknown error'}`);
      logger.hint('The project was generated; finish this step yourself.');
    } else {
      logger.debug(`post-step "${postResult.step}" skipped: ${postResult.detail ?? ''}`);
    }
  }

  logger.print('');
  logger.print(renderPlan(context, projectManifest, sources, stack, { showSources: flags.debug }));
  logger.print('');
  logger.print(renderNextSteps(context, manifest, postResults, cwd));

  return EXIT_OK;
}
