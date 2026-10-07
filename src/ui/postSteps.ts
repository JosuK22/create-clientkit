import type { PostStepProgress, PostStepResult } from '../generate/postSteps.js';
import type { PostStep } from '../templates/manifest.js';
import type { ProjectContext } from '../types.js';
import type { Logger } from './logger.js';

/**
 * What a person sees while the post steps run.
 *
 * One line as a step starts and one as it ends, through the logger - no
 * spinner, no cursor movement. The commands run synchronously, so an animation
 * could not advance while they work anyway, and plain lines read the same in a
 * terminal, a CI log and a redirected file. Every state is words as well as a
 * symbol: "Dependencies installed", "Failed to install dependencies".
 */
const WORDING: Readonly<
  Record<Exclude<PostStep, 'format'>, { running: string; done: string; failed: string }>
> = {
  install: {
    running: 'Installing dependencies',
    done: 'Dependencies installed',
    failed: 'Failed to install dependencies',
  },
  'git-init': {
    running: 'Initializing Git',
    done: 'Git initialized',
    failed: 'Failed to initialize Git',
  },
};

export function postStepProgress(logger: Logger, context: ProjectContext): PostStepProgress {
  return {
    started(step) {
      if (step === 'format') return;
      const via = step === 'install' ? ` with ${context.packageManager}` : '';
      logger.info(`${WORDING[step].running}${via}...`);
    },
    finished(result) {
      reportPostStep(logger, result);
    },
  };
}

/** The end of one step: done, failed with the reason, or skipped (debug only). */
export function reportPostStep(logger: Logger, result: PostStepResult): void {
  const { step } = result;
  if (result.status === 'skipped' || step === 'format') {
    logger.debug(`post-step "${step}" ${result.status}: ${result.detail ?? ''}`);
    return;
  }
  if (result.status === 'ok') {
    logger.success(WORDING[step].done);
    return;
  }
  logger.error(WORDING[step].failed);
  logger.hint(
    result.detail === undefined || result.detail === '' ? 'unknown error' : result.detail,
  );
  logger.hint('The project was generated; finish this step yourself.');
}
