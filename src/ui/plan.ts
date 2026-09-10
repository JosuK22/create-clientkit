import pc from 'picocolors';

import type { ProjectContext, SourceMap } from '../types.js';

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
