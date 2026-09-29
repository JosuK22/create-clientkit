import path from 'node:path';

import pc from 'picocolors';

import { explainStack } from '../context/explain.js';
import type { StackSources } from '../context/resolve.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ComposedPackage } from '../domain/package-composition.js';
import type { GenerationPlan } from '../generate/files.js';
import type { PlannedPostStep, PostStepResult } from '../generate/postSteps.js';
import type { TemplateManifest } from '../templates/manifest.js';
import type { PackageManager, ProjectContext, SourceMap } from '../types.js';

function label(text: string): string {
  return pc.dim(text.padEnd(18));
}

function show(value: string | null | boolean): string {
  if (value === null) return pc.dim('(not set)');
  if (typeof value === 'boolean') return value ? pc.green('yes') : pc.dim('no');
  if (value === '') return pc.dim('(empty)');
  return value;
}

/**
 * What a plan contains, as counts, for `--debug`.
 *
 * Counts rather than contents: the full plan is what `--dry-run --debug`
 * prints, and a debug log that repeated it would bury everything else.
 * Dependencies and scripts are counted from the composed package, which is the
 * same data the planned `package.json` write carries.
 */
export function summarisePlan(plan: GenerationPlan, composed?: ComposedPackage): string[] {
  const writes = plan.operations.filter((operation) => operation.type === 'write').length;
  const copies = plan.operations.length - writes;
  const lines = [
    `[planner] ${plan.operations.length} file operations (${writes} write, ${copies} copy)`,
  ];
  if (composed !== undefined) {
    const kinds = (['prod', 'dev', 'peer', 'optional'] as const)
      .map((kind) => [kind, composed.dependencies.filter((d) => d.kind === kind).length] as const)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ');
    lines.push(
      `[planner] ${composed.dependencies.length} dependency operations${kinds === '' ? '' : ` (${kinds})`}`,
    );
    lines.push(`[planner] ${composed.scripts.length} script operations`);
  }
  return lines;
}

/**
 * Renders the resolved context. Only known ProjectContext fields are printed;
 * raw environment and raw config-file contents are never echoed.
 */
export function renderPlan(
  context: ProjectContext,
  manifest: ProjectManifest,
  sources: SourceMap,
  stack: StackSources,
  options: { showSources: boolean },
): string {
  const lines: string[] = [];
  const row = (name: string, value: string | null | boolean, sourceKey: string): void => {
    const origin =
      options.showSources && sources[sourceKey] ? pc.dim(`  [${sources[sourceKey]}]`) : '';
    lines.push(`  ${label(name)}${show(value)}${origin}`);
  };

  lines.push(pc.bold('Resolved configuration'));
  row('Target directory', context.targetDir, 'targetDir');
  row('Project name', context.projectName, 'projectName');
  row('Site name', context.site.name, 'site.name');
  row('Production URL', context.site.url, 'site.url');
  row('Description', context.site.description, 'site.description');
  row('Locale', context.site.locale, 'site.locale');
  row('Author', context.site.author, 'site.author');
  row('Template', context.template.id, 'template.id');
  row('Template version', context.template.version, 'template.version');
  row('Mode', context.template.mode, 'template.mode');
  row(
    'Features',
    context.features.length === 0 ? pc.dim('none') : context.features.join(', '),
    'features',
  );
  row('Package manager', context.packageManager, 'packageManager');
  row('Install deps', context.install, 'install');
  row('Initialise git', context.git, 'git');

  /*
   * The stack, which until Stage 17 was not printed at all.
   *
   * Tolerable while every dimension had to be typed - the user could read them
   * back off their own command line. A preset makes it untenable: `--preset
   * react-mui` states four dimensions the user never wrote, and a summary that
   * omits them cannot be checked against what was intended. With `--debug`
   * each row says which layer supplied it, so `[preset]` is distinguishable
   * from `[flag]`.
   */
  lines.push('');
  lines.push(pc.bold('Stack'));
  /*
   * Rendered from the explanation rather than read field by field.
   *
   * The order, the labels and which dimensions exist are one list in
   * `explain.ts`, so a future `--explain` prints the same thing this does and
   * a dimension cannot appear in one and not the other.
   */
  for (const entry of explainStack(manifest, stack)) {
    const origin = options.showSources && entry.source ? pc.dim(`  [${entry.source}]`) : '';
    lines.push(`  ${label(entry.label)}${entry.value}${origin}`);
  }

  lines.push('');
  lines.push(pc.dim(`  CLI ${context.cliVersion}  |  resolved ${context.generatedAt}`));
  return lines.join('\n');
}

/**
 * What the directory and the post steps would make of the plan, read before
 * anything is written. Gathered by the command from the same checks a real run
 * makes; the renderer only displays it.
 */
export interface DryRunFacts {
  /** Plan paths that already exist, and would be replaced. Sorted. */
  readonly replaced: readonly string[];
  /** The target already holds files, `.git` aside. */
  readonly nonEmpty: boolean;
  /** Whether a real run could ask before writing into a non-empty target. */
  readonly interactive: boolean;
  readonly postSteps: readonly PlannedPostStep[];
}

/**
 * The `--dry-run` view: the actual file list the plan would produce, so the
 * output is verifiable rather than a promise.
 *
 * Every line is read from the plan or from `facts`. The plan has two operation
 * types, write and copy, and both create a file or replace the one already
 * there - so "create" and "replace" are the only two verbs, and which applies
 * is the filesystem's answer, not a guess.
 */
export function renderDryRun(
  generationPlan: GenerationPlan,
  manifest: ProjectManifest,
  stack: StackSources,
  context: ProjectContext,
  sources: SourceMap,
  facts: DryRunFacts,
  options: { verbose: boolean },
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(pc.bold(pc.yellow('DRY RUN - no files will be written.')));
  lines.push('');
  lines.push(`  ${label('Target')}${generationPlan.targetDir}`);
  lines.push(
    `  ${label('Template')}${generationPlan.templateId} ${pc.dim(`v${generationPlan.templateVersion}`)}`,
  );
  lines.push(`  ${label('Mode')}${generationPlan.mode}`);

  const replaced = new Set(facts.replaced);
  const entry = (operation: GenerationPlan['operations'][number], mark: string): string => {
    const kind = operation.type === 'copy' ? pc.dim(' (binary)') : '';
    const origin = options.verbose ? pc.dim(`  <- ${operation.origin}`) : '';
    return `  ${mark} ${operation.path}${kind}${origin}`;
  };
  const creates = generationPlan.operations.filter((operation) => !replaced.has(operation.path));
  const replaces = generationPlan.operations.filter((operation) => replaced.has(operation.path));

  lines.push('');
  lines.push(pc.bold(`Files to create (${creates.length})`));
  for (const operation of creates) lines.push(entry(operation, pc.green('+')));
  if (replaces.length > 0) {
    lines.push('');
    lines.push(pc.bold(`Files to replace (${replaces.length})`));
    for (const operation of replaces) lines.push(entry(operation, pc.yellow('~')));
  }
  lines.push('');
  lines.push(`Total: ${generationPlan.operations.length} files`);

  if (facts.nonEmpty) {
    lines.push('');
    lines.push(pc.yellow('The target directory already contains files.'));
    if (facts.interactive) {
      lines.push('  Without --dry-run, you would be asked before anything is written into it.');
      lines.push(pc.dim('  Files it does not replace are never touched, and nothing is deleted.'));
    } else {
      lines.push(
        '  Without --dry-run, this run would stop here: it does not write into a non-empty\n' +
          '  directory without asking, and --yes or a script cannot be asked.',
      );
    }
  }

  lines.push('');
  lines.push(pc.bold('Post steps (not run)'));
  if (facts.postSteps.length === 0) lines.push(pc.dim('  none'));
  for (const planned of facts.postSteps) {
    lines.push(
      'command' in planned
        ? `  ${pc.cyan(planned.command.join(' '))}`
        : pc.dim(`  ${planned.step}: skipped, ${planned.skipped}`),
    );
  }

  lines.push('');
  lines.push(renderPlan(context, manifest, sources, stack, { showSources: true }));
  return lines.join('\n');
}

const RUN_PREFIX: Readonly<Record<PackageManager, string>> = {
  npm: 'npm run',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun run',
};

export function renderNextSteps(
  context: ProjectContext,
  manifest: TemplateManifest,
  postResults: readonly PostStepResult[],
  cwd: string,
): string {
  const relative = path.relative(cwd, context.targetDir) || '.';
  const installed = postResults.some(
    (result) => result.step === 'install' && result.status === 'ok',
  );

  const commands: string[] = [`cd ${relative}`];
  if (!installed) commands.push(`${context.packageManager} install`);
  commands.push(`${RUN_PREFIX[context.packageManager]} dev`);

  const lines: string[] = [pc.bold('Next steps')];
  for (const command of commands) lines.push(`  ${pc.cyan(command)}`);
  if (manifest.nextSteps.length > 0) {
    lines.push('');
    for (const step of manifest.nextSteps) lines.push(`  ${pc.dim('-')} ${step}`);
  }
  return lines.join('\n');
}
