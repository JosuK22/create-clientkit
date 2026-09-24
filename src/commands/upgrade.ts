import path from 'node:path';
import { readFileSync } from 'node:fs';

import { planManifest } from '../adapters/bridge.js';
import { createAdapterRegistry } from '../adapters/registry.js';
import { planUpgrade, type RecordedConfiguration } from '../adapters/upgrade-plan.js';
import type { UpgradePathPlan } from '../domain/upgrade-paths.js';
import {
  readProvenance,
  PROVENANCE_DOCUMENT,
  type ProvenanceDocument,
} from '../domain/provenance-reader.js';
import type { ParsedFlags } from '../args.js';
import { ClackPrompter, NonInteractivePrompter, type Prompter } from '../context/prompts.js';
import { resolveContext } from '../context/resolve.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { apply, findCollisions } from '../generate/apply.js';
import { findTemplatesRoot, type TemplateRegistry } from '../templates/registry.js';
import type { Logger } from '../ui/logger.js';

/**
 * Upgrading an existing ClientKit project.
 *
 * ## The promise, from Stage 61
 *
 * > ClientKit re-generates the files it would generate today for this
 * > project's recorded stack, using the configuration you supply now. It lists
 * > every file it would replace and asks before replacing any of them. It
 * > never deletes a file, and it never touches a file it did not plan.
 *
 * Not historical migration. ClientKit keeps no template bytes from earlier
 * releases and does not know what one generated, so both sides of the
 * comparison render against the templates this build ships. A file whose
 * content changed between releases is invisible here, and nothing claims
 * otherwise.
 *
 * ## What this command adds, and what it only wires together
 *
 * Almost all of it existed already. Stage 59 reads the document, Stage 62
 * validates its template identity, Stage 63 computes the two path sets, and
 * Stage 55's merge writes planned files while touching nothing else. This
 * command is the order those run in, the sentence shown to the developer, and
 * the question asked before anything is written.
 *
 * ## Where the configuration comes from
 *
 * Recorded provenance is layered *underneath* the developer's input, as a
 * config-file layer, so the existing precedence does the work rather than a
 * new one being invented:
 *
 * ```text
 * explicit flags  >  --from file  >  recorded provenance  >  built-in defaults
 * ```
 *
 * That is what makes `upgrade ./site --styling bootstrap` mean "everything as
 * recorded, but Bootstrap" without the developer restating a stack they
 * already chose once.
 */

export interface UpgradeOptions {
  readonly flags: ParsedFlags;
  readonly logger: Logger;
  readonly registry: TemplateRegistry;
  readonly cliVersion: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly isTTY: boolean;
  readonly prompter?: Prompter;
  /** Injectable so a test can drive the whole command without a real project. */
  readonly readFile?: (filePath: string) => string;
  readonly templatesRoot?: string;
}

/**
 * Everything the recorded document contributes, as a `--from` config would.
 *
 * `changingFramework` drops the dimensions the framework decides. A recorded
 * Astro project carries `buildTool: astro`, `router: file-based` and
 * `architecture: astro-standard`; carrying those into a React upgrade would
 * hand the compatibility engine a stack no framework offers, and the developer
 * would be told their own perfectly reasonable request was incompatible.
 *
 * What survives a framework change is what does not belong to a framework:
 * styling, component library, language, features. The rest is re-derived from
 * the framework now chosen, exactly as a fresh project would derive it.
 */
function configFromProvenance(
  document: ProvenanceDocument,
  changingFramework: boolean,
): Record<string, unknown> {
  const stack = document.stack;
  return {
    site: {
      name: document.config.siteName,
      url: document.config.siteUrl,
      locale: document.config.locale,
    },
    packageManager: document.config.packageManager,
    template: { mode: document.mode },
    /*
     * Stated so nothing has to be asked. An upgrade runs no post-steps - it
     * reconciles files - so these decide nothing here, and leaving them
     * unanswered would make the resolver ask a question the developer already
     * answered when the project was created.
     */
    git: false,
    install: false,
    ...(stack === undefined
      ? {}
      : {
          stack: {
            language: stack.language,
            styling: stack.styling,
            uiLibrary: stack.uiLibrary,
            features: [...document.config.features],
            ...(changingFramework
              ? {}
              : {
                  framework: stack.framework,
                  buildTool: stack.buildTool,
                  router: stack.router,
                  architecture: stack.architecture,
                }),
          },
        }),
  };
}

/** Merges the developer's own config file over the recorded one, one level deep. */
function mergeConfig(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Refuses with the reason the document actually gave, never a generic failure. */
function refuse(message: string, hint: string): never {
  throw new CliError(message, { exitCode: EXIT_USAGE, hint });
}

export async function runUpgrade(options: UpgradeOptions): Promise<number> {
  const { flags, logger, registry, cliVersion, cwd, env, isTTY } = options;
  const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, 'utf8'));

  const targetInput = flags.positionals[0];
  if (targetInput === undefined) {
    refuse(
      'Upgrade needs the directory of an existing ClientKit project.',
      'For example: create-clientkit upgrade ./my-site',
    );
  }
  const targetDir = path.resolve(cwd, targetInput);
  logger.debug(`upgrade target=${targetDir}`);

  // ---- read what the project recorded --------------------------------------
  const read = readProvenance(targetDir, readFile, cliVersion);
  logger.debug(`provenance=${read.status}`);

  if (read.status === 'missing') {
    refuse(
      `No ${PROVENANCE_DOCUMENT} in ${targetInput}, so there is nothing recording how this ` +
        'project was generated.',
      'Upgrade only works on a project ClientKit created. ClientKit does not inspect a ' +
        'project to work out what it is.',
    );
  }
  if (read.status === 'malformed' || read.status === 'invalid') {
    refuse(
      `The ${PROVENANCE_DOCUMENT} in ${targetInput} is not a ClientKit provenance document.`,
      read.because,
    );
  }
  if (read.status === 'unsupported') {
    refuse(
      `The ${PROVENANCE_DOCUMENT} in ${targetInput} was written by a newer ClientKit ` +
        `(${read.recordedVersion}).`,
      'Upgrade with that version, or newer. This one would have to guess at fields it does ' +
        'not know.',
    );
  }
  if (read.status === 'insufficient') {
    refuse(
      `The ${PROVENANCE_DOCUMENT} in ${targetInput} records no stack, so ClientKit cannot tell ` +
        'what this project was built with.',
      'Projects generated before the stack was recorded cannot be upgraded. ClientKit will ' +
        'not guess a styling system, component library, router or architecture.',
    );
  }

  const recorded: RecordedConfiguration = {
    stack: read.stack,
    mode: read.document.mode,
    template: {
      id: read.document.template.id,
      framework: read.document.template.framework,
    },
  };
  logger.debug(`recorded stack=${JSON.stringify(recorded.stack)} mode=${recorded.mode}`);

  // ---- resolve what the developer wants now --------------------------------
  // A different framework restarts the parts of the stack a framework decides.
  const changingFramework =
    flags.framework !== undefined && flags.framework !== read.stack.framework;
  const provenanceConfig = configFromProvenance(read.document, changingFramework);
  const userConfig =
    flags.from === undefined
      ? {}
      : (JSON.parse(readFile(path.resolve(cwd, flags.from))) as Record<string, unknown>);
  const merged = JSON.stringify(mergeConfig(provenanceConfig, userConfig));

  /*
   * A name for the recorded-configuration layer that cannot collide with a
   * real file. The loader resolves `--from` against the working directory
   * before reading, so the reader below has to match the resolved form.
   */
  const CONFIG_SENTINEL = path.resolve(targetDir, PROVENANCE_DOCUMENT);
  const resolved = await resolveContext({
    // The recorded configuration enters as the file layer, so flags still beat
    // it and nothing needs a new precedence rule.
    flags: { ...flags, from: CONFIG_SENTINEL, positionals: [targetDir] },
    cwd,
    env,
    /*
     * Configuration never asks.
     *
     * An upgrade is not a fresh creation flow: the recorded document answers
     * everything a project already decided, and a flag answers whatever the
     * developer wants changed. If something is genuinely missing, failing with
     * that sentence is far better than reopening the whole interview - and it
     * keeps the only question this command asks the one that matters.
     */
    prompter: new NonInteractivePrompter(
      'an upgrade uses the recorded configuration, overridden by flags',
    ),
    registry,
    cliVersion,
    now: new Date(),
    ...(options.templatesRoot === undefined ? {} : { templatesRoot: options.templatesRoot }),
    readFile: (filePath: string) => (filePath === CONFIG_SENTINEL ? merged : readFile(filePath)),
  });

  const templatesRoot =
    options.templatesRoot ?? findTemplatesRoot(path.resolve(import.meta.dirname, '..'));
  const adapters = createAdapterRegistry(templatesRoot);

  // ---- the two path sets ---------------------------------------------------
  const upgradePlan = planUpgrade(recorded, resolved.manifest, {
    adapters,
    plan: { registry, cliVersion, generatedAt: resolved.context.generatedAt },
  });

  if (upgradePlan.status === 'refused') {
    refuse(
      `The ${PROVENANCE_DOCUMENT} in ${targetInput} does not describe a project ClientKit can ` +
        'plan an upgrade for.',
      upgradePlan.because,
    );
  }

  const planned = planManifest(resolved.manifest, {
    registry,
    cliVersion,
    generatedAt: resolved.context.generatedAt,
    mode: resolved.context.template.mode,
    templateId: resolved.context.template.id,
  });
  const generationPlan = planned.plan;

  // What already exists and is in the current plan: the set a write replaces.
  const collisions = findCollisions(generationPlan);
  const replacing = new Set(collisions);
  const adding = upgradePlan.paths.currentPaths.filter((entry) => !replacing.has(entry));

  logger.print('');
  logger.print(renderUpgrade(upgradePlan.paths, collisions, adding));

  if (flags.dryRun) {
    logger.print('');
    logger.info('Dry run: nothing was written.');
    return EXIT_OK;
  }

  // ---- ask -----------------------------------------------------------------
  /*
   * The same confirmation a re-generation already requires, reached the same
   * way. `--yes` selects the non-interactive prompter, which refuses to answer
   * this - so `--yes` configures, and it does not consent to replacing a
   * developer's files. That boundary is Stage 55's and is deliberately not
   * widened here.
   */
  const prompter = options.prompter ?? consentPrompter(flags, isTTY);
  if (prompter instanceof ClackPrompter) prompter.intro(cliVersion);

  const confirmed = await prompter.confirmNonEmpty(collisions.length);
  if (!confirmed) {
    logger.info('Cancelled. Nothing was written.');
    return EXIT_OK;
  }

  // ---- apply ---------------------------------------------------------------
  // The existing merge: planned files only, nothing else touched, nothing
  // deleted, and atomic - a failure leaves the project exactly as it was.
  const result = apply(generationPlan, { allowNonEmpty: true });

  logger.success(
    `Updated ${result.overwritten.length} file(s) in ${path.relative(cwd, result.targetDir) || '.'}`,
  );
  const created = result.written.filter((entry) => !replacing.has(entry));
  if (created.length > 0) logger.success(`Added ${created.length} new file(s).`);
  if (upgradePlan.paths.orphanCandidates.length > 0) {
    logger.warn(
      `${upgradePlan.paths.orphanCandidates.length} file(s) are no longer generated by this ` +
        'stack. They were left where they are.',
    );
  }

  return EXIT_OK;
}

/**
 * Who may answer the one question this command asks.
 *
 * Separate from configuration on purpose, and reached only when a write is
 * actually about to happen - so `--dry-run` needs no terminal and no consent,
 * because it changes nothing.
 *
 * `--yes` is refused rather than honoured. Stage 55 measured the existing
 * contract: `--yes` selects a prompter that declines to answer a
 * write-into-a-non-empty-directory question at all, so a second run with
 * `--yes` already refuses today. Treating it as consent here would widen that
 * boundary in the one command where it matters most, and the whole point of
 * the confirmation is that a person saw the list.
 */
function consentPrompter(flags: ParsedFlags, isTTY: boolean): Prompter {
  if (flags.yes) {
    throw new CliError('Upgrade cannot run with --yes.', {
      exitCode: EXIT_USAGE,
      hint:
        'Replacing generated files needs an answer that --yes is not allowed to give. ' +
        'Re-run interactively, or use --dry-run to see what would change.',
    });
  }
  if (!isTTY) {
    throw new CliError(
      'Cannot ask for confirmation because stdin is not an interactive terminal.',
      {
        exitCode: EXIT_USAGE,
        hint: 'Run the upgrade from a terminal, or use --dry-run to see what would change.',
      },
    );
  }
  return new ClackPrompter();
}

/**
 * The summary shown before the question.
 *
 * Deterministic, and careful with its nouns. Orphan candidates are listed under
 * what they are - paths this stack no longer generates - and never as files to
 * be deleted, because ClientKit does not delete them and saying so would
 * describe a tool that does.
 */
export function renderUpgrade(
  paths: UpgradePathPlan,
  replacing: readonly string[],
  adding: readonly string[],
): string {
  const lines: string[] = [];

  lines.push('This upgrade would:');
  lines.push('');

  if (replacing.length > 0) {
    lines.push(`  Replace ${replacing.length} generated file(s):`);
    for (const entry of replacing) lines.push(`    ${entry}`);
    lines.push('');
  }

  if (adding.length > 0) {
    lines.push(`  Add ${adding.length} file(s):`);
    for (const entry of adding) lines.push(`    ${entry}`);
    lines.push('');
  }

  if (replacing.length === 0 && adding.length === 0) {
    lines.push('  Write nothing: the current plan matches what is already there.');
    lines.push('');
  }

  if (paths.orphanCandidates.length > 0) {
    lines.push(
      `  Leave ${paths.orphanCandidates.length} file(s) no longer generated by this stack:`,
    );
    for (const entry of paths.orphanCandidates) lines.push(`    ${entry}`);
    lines.push('');
    lines.push('  These are not deleted. Remove them yourself once you have checked them.');
    lines.push('');
  }

  lines.push('Files ClientKit did not plan are never touched.');
  return lines.join('\n');
}
