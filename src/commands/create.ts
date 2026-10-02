import path from 'node:path';

import type { ParsedFlags } from '../args.js';
import { ClackPrompter, NonInteractivePrompter, type Prompter } from '../context/prompts.js';
import { resolveContext } from '../context/resolve.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { apply } from '../generate/apply.js';
import { planManifest } from '../adapters/bridge.js';
import { createAdapterRegistry } from '../adapters/registry.js';
import { findCollisions, observeTarget } from '../generate/compare.js';
import type { GenerationPlan } from '../generate/files.js';
import { planPostSteps } from '../generate/postStepPlan.js';
import { runPostSteps, type PostStepResult } from '../generate/postSteps.js';
import type { PostStep } from '../templates/manifest.js';
import type { TemplateRegistry } from '../templates/registry.js';
import type { ProjectContext } from '../types.js';
import type { Logger } from '../ui/logger.js';
import { renderDryRun, renderNextSteps, renderPlan, summarisePlan } from '../ui/plan.js';
import { satisfiesMinimum } from '../util/node.js';
import {
  decideExecution,
  decideRegeneration,
  inspectTarget,
  leftAlone,
  pathsToWrite,
  postStepsAfter,
  previousPathsFor,
  type Regeneration,
} from './regenerate.js';

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
  for (const line of summarisePlan(generationPlan, planned.composedPackage)) logger.debug(line);

  /*
   * What is already there, decided once, before either the preview or a write.
   *
   * A directory holding a usable `.client-site.json` is a ClientKit project and
   * is re-generated idempotently: files already as planned are left alone,
   * missing ones are added, differing ones need a person (see `regenerate.ts`).
   * Any other directory with content keeps the non-empty rules it always had.
   */
  const target = inspectTarget(generationPlan.targetDir, cliVersion);
  logger.debug(
    `target=${target.kind}${target.kind === 'unrecognised' && target.because ? ` (${target.because})` : ''}`,
  );
  /*
   * The change analysis (Stage 8), for a ClientKit project only: what the
   * recorded configuration generated tells a restore from a create, and a
   * preview asks for each conflict's text diff. A run decides from the same
   * analysis, without the diffs it does not show.
   */
  const regeneration =
    target.kind === 'clientkit'
      ? decideRegeneration(generationPlan, {
          withDiff: flags.dryRun,
          ...withPrevious(
            previousPathsFor(target.recorded, projectManifest, {
              adapters: createAdapterRegistry(path.dirname(registry.rootFor('astro-tailwind'))),
              plan: { registry, cliVersion, generatedAt: context.generatedAt },
            }),
          ),
        })
      : undefined;
  if (regeneration !== undefined) {
    logger.debug(
      `regeneration missing=${regeneration.missing.length} conflicts=${regeneration.conflicts.length} ` +
        `unchanged=${regeneration.comparison.unchanged.length} record=${regeneration.recordChanged ? 'changed' : 'same'}`,
    );
  }

  /*
   * The preview, and the whole of the run. It returns before `apply()` and
   * before the post steps, and what it reports comes from the same checks a
   * real run makes below - the same target inspection and re-generation
   * decision, `findCollisions`, `planPostSteps` - every one of which only
   * reads. No question is asked: a dry run is not a rehearsal for a confirmed
   * write, it is the entire run.
   */
  if (flags.dryRun) {
    // What a real run would write: with conflicts, nothing unless a person can say yes.
    const writes =
      regeneration === undefined
        ? generationPlan.operations.map((operation) => operation.path)
        : regeneration.conflicts.length > 0 && !prompter.interactive
          ? []
          : pathsToWrite(regeneration, true);
    logger.print(
      renderDryRun(
        generationPlan,
        projectManifest,
        stack,
        context,
        sources,
        {
          replaced: findCollisions(generationPlan),
          nonEmpty: target.kind !== 'new' && target.kind !== 'empty',
          interactive: prompter.interactive,
          postSteps: planPostSteps(
            context,
            regeneration === undefined
              ? manifest.postSteps
              : postStepsAfter(manifest.postSteps, writes, generationPlan.targetDir),
          ),
          ...(regeneration === undefined ? {} : { changes: regeneration.changes }),
          ...(target.kind === 'unrecognised' && target.because !== undefined
            ? { unrecognisedBecause: target.because }
            : {}),
        },
        { verbose: flags.debug },
      ),
    );
    logger.print('');
    logger.success('Dry run complete. No changes were made.');
    return EXIT_OK;
  }

  // The CLI runs on Node 20.19, but a template may target something newer.
  if (!satisfiesMinimum(nodeVersion, manifest.minNode.replace(/^>=/, ''))) {
    logger.warn(
      `Template "${manifest.id}" targets Node ${manifest.minNode}, but you are running ${nodeVersion}.`,
    );
    logger.hint('The project will still be generated, but installing or building it may fail.');
  }

  // ---- a project ClientKit generated --------------------------------------
  if (regeneration !== undefined) {
    return regenerate({
      options,
      prompter,
      generationPlan,
      regeneration,
      postSteps: manifest.postSteps,
      finish: (postResults) => {
        logger.print('');
        logger.print(
          renderPlan(context, projectManifest, sources, stack, { showSources: flags.debug }),
        );
        logger.print('');
        logger.print(renderNextSteps(context, manifest, postResults, cwd));
      },
      context,
    });
  }

  // ---- non-empty target directory ----------------------------------------
  // What every planned path holds now, before the question: the executor
  // writes nothing if any of them changes while a person is answering.
  const observed = observeTarget(generationPlan);
  const collisions = findCollisions(generationPlan, observed);
  let allowNonEmpty = false;

  if (target.kind === 'unrecognised') {
    // Why ownership could not be established, when a record was there at all.
    const why =
      target.because === undefined
        ? ''
        : `ClientKit did not treat it as its own project: ${target.because}.\n`;
    if (!prompter.interactive) {
      throw new CliError(
        `Directory "${generationPlan.targetDir}" already exists and is not empty.`,
        {
          hint: `${why}Choose an empty directory, or re-run interactively to confirm writing into this one.`,
        },
      );
    }
    if (why !== '') logger.hint(why.trim());

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
  const result = apply(generationPlan, { allowNonEmpty, expected: observed });
  logger.success(
    `Created ${result.written.length} files in ${path.relative(cwd, result.targetDir) || '.'}`,
  );
  if (result.overwritten.length > 0) {
    logger.warn(`Replaced ${result.overwritten.length} existing file(s).`);
  }

  // ---- post steps ---------------------------------------------------------
  const postResults = runPostSteps({ context, logger, steps: manifest.postSteps });
  reportPostSteps(logger, postResults);

  logger.print('');
  logger.print(renderPlan(context, projectManifest, sources, stack, { showSources: flags.debug }));
  logger.print('');
  logger.print(renderNextSteps(context, manifest, postResults, cwd));

  return EXIT_OK;
}

function reportPostSteps(logger: Logger, postResults: readonly PostStepResult[]): void {
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
}

interface RegenerateArgs {
  readonly options: CreateOptions;
  readonly prompter: Prompter;
  readonly generationPlan: GenerationPlan;
  readonly regeneration: Regeneration;
  readonly postSteps: readonly PostStep[];
  readonly context: ProjectContext;
  /** Prints the summary and next steps, as a first run does. */
  readonly finish: (postResults: readonly PostStepResult[]) => void;
}

/**
 * Generating again into a project ClientKit generated: idempotent.
 *
 * Every decision is made before anything is written - which files are
 * missing, which differ, whether a person agreed - so a refusal or a "no"
 * leaves the project exactly as it was. Then the plan, narrowed to what was
 * decided, goes through the same executor as a first run.
 */
async function regenerate(args: RegenerateArgs): Promise<number> {
  const { options, prompter, generationPlan, regeneration } = args;
  const { logger, cwd } = options;
  const where = path.relative(cwd, generationPlan.targetDir) || '.';
  const unchanged = regeneration.comparison.unchanged.length;

  if (regeneration.upToDate) {
    logger.success(
      `${where} is already up to date: all ${unchanged} generated files match. Nothing was written.`,
    );
    return EXIT_OK;
  }

  let replace = false;
  const conflicts = regeneration.conflicts;
  if (conflicts.length > 0) {
    const listed = conflicts.slice(0, 10).map((file) => `  ${file}`);
    if (conflicts.length > 10) listed.push(`  ...and ${conflicts.length - 10} more`);
    const why =
      'They may be your edits, or files from another configuration or release. ClientKit ' +
      'cannot tell which, so it replaces them only when you confirm.';

    if (!prompter.interactive) {
      throw new CliError(
        `${conflicts.length} generated file(s) in "${generationPlan.targetDir}" differ from what ` +
          'ClientKit would write now, so nothing was changed.',
        {
          hint:
            `${listed.join('\n')}\n${why}\n` +
            'Re-run interactively to review and replace them, or use --dry-run to see the plan.',
        },
      );
    }

    logger.warn(
      `${path.basename(generationPlan.targetDir)} is a ClientKit project. ${conflicts.length} of ` +
        'its generated files differ from what ClientKit would write now:',
    );
    for (const line of listed) logger.hint(line);
    logger.hint(why);
    logger.hint('Files ClientKit does not generate are never touched, and nothing is deleted.');

    replace = await prompter.confirmNonEmpty(conflicts.length);
    if (!replace) {
      logger.info('Cancelled. Nothing was written.');
      return EXIT_OK;
    }
  }

  // ---- the execution boundary: everything below was decided above ----------
  const execution = decideExecution(generationPlan, regeneration, replace, args.postSteps);
  const result = apply(execution.plan, { allowNonEmpty: true, expected: execution.expected });
  const added = result.written.length - result.overwritten.length;
  logger.success(
    `Updated ${where}: ${added} added, ${result.overwritten.length} replaced, ` +
      `${leftAlone(regeneration, result.written).length} already up to date.`,
  );

  const postResults = runPostSteps({ context: args.context, logger, steps: execution.postSteps });
  reportPostSteps(logger, postResults);
  args.finish(postResults);
  return EXIT_OK;
}

/** The option, only when there is a value - `exactOptionalPropertyTypes` will not take `undefined`. */
function withPrevious(previousPaths: ReadonlySet<string> | undefined): {
  previousPaths?: ReadonlySet<string>;
} {
  return previousPaths === undefined ? {} : { previousPaths };
}
