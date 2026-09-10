import path from 'node:path';

import pc from 'picocolors';

import type { GenerationPlan } from '../generate/files.js';
import type { PostStepResult } from '../generate/postSteps.js';
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
 * Renders the resolved context. Only known ProjectContext fields are printed;
 * raw environment and raw config-file contents are never echoed.
 */
export function renderPlan(
  context: ProjectContext,
  sources: SourceMap,
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
  lines.push('');
  lines.push(pc.dim(`  CLI ${context.cliVersion}  |  resolved ${context.generatedAt}`));
  return lines.join('\n');
}

/**
 * The `--dry-run` view: the actual file list the plan would produce, so the
 * output is verifiable rather than a promise.
 */
export function renderDryRun(
  generationPlan: GenerationPlan,
  context: ProjectContext,
  sources: SourceMap,
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
  lines.push('');
  lines.push(pc.bold('Files:'));

  for (const operation of generationPlan.operations) {
    const kind = operation.type === 'copy' ? pc.dim(' (binary)') : '';
    const origin = options.verbose ? pc.dim(`  <- ${operation.origin}`) : '';
    lines.push(`  ${operation.path}${kind}${origin}`);
  }

  lines.push('');
  lines.push(`Total: ${generationPlan.operations.length} files`);
  lines.push('');
  lines.push(renderPlan(context, sources, { showSources: true }));
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
