import path from 'node:path';

import pc from 'picocolors';

import type { Evidence, Finding, ProjectDetection } from '../detect/detect.js';
import type { DetectedStack } from '../detect/stack.js';

function label(text: string): string {
  return pc.dim(text.padEnd(18));
}

function evidenceText(evidence: readonly Evidence[]): string {
  return evidence
    .map((entry) => (entry.source === 'package.json' ? entry.detail : entry.path))
    .join(', ');
}

interface Cell {
  readonly text: string;
  readonly colour: (value: string) => string;
  readonly because: string;
}

const plain = (value: string): string => value;

/** A finding as display text, before any padding or colour. */
function cell(finding: Finding<string>, verbose: boolean): Cell {
  switch (finding.status) {
    case 'detected':
      return { text: finding.value, colour: plain, because: evidenceText(finding.evidence) };
    case 'unsupported':
      return {
        text: `${finding.name} (not supported)`,
        colour: pc.yellow,
        because: evidenceText(finding.evidence),
      };
    case 'ambiguous':
      return {
        text: `ambiguous: ${finding.candidates.join(', ')}`,
        colour: pc.yellow,
        because: evidenceText(finding.evidence),
      };
    case 'absent':
      return {
        text: 'none found',
        colour: pc.dim,
        because: verbose ? `checked: ${finding.checked.join(', ')}` : '',
      };
    case 'unknown':
      return { text: 'unknown', colour: pc.dim, because: '' };
  }
}

/**
 * The seven dimension rows, with the evidence column aligned to the widest
 * value. Padded before colouring, so escape codes never count towards a width,
 * and a row with no evidence carries no trailing padding.
 */
function rows(detection: ProjectDetection, verbose: boolean): string[] {
  const entries = [
    ['Framework', detection.framework],
    ['Build tool', detection.buildTool],
    ['Language', detection.language],
    ['Styling', detection.styling],
    ['UI library', detection.uiLibrary],
    ['Router', detection.router],
    ['Package manager', detection.packageManager],
  ] as const;
  const cells = entries.map(([name, finding]) => [name, cell(finding, verbose)] as const);
  const width = Math.max(...cells.map(([, entry]) => entry.text.length)) + 2;

  return cells.map(([name, entry]) =>
    entry.because === ''
      ? `  ${label(name)}${entry.colour(entry.text)}`
      : `  ${label(name)}${entry.colour(entry.text.padEnd(width))}${pc.dim(entry.because)}`,
  );
}

const FLAG_ORDER = [
  ['framework', '--framework'],
  ['buildTool', '--build-tool'],
  ['language', '--language'],
  ['styling', '--styling'],
  ['uiLibrary', '--ui-library'],
  ['router', '--router'],
] as const;

const FILLED_LABEL = {
  buildTool: 'build tool',
  language: 'language',
  router: 'router',
  architecture: 'architecture',
} as const;

function renderStack(stack: DetectedStack): string[] {
  const lines: string[] = [];

  if (stack.status === 'resolved') {
    const { dimensions } = stack;
    lines.push(`  ${label('ClientKit stack')}${pc.green('supported')}`);
    lines.push(`    ${FLAG_ORDER.map(([key, flag]) => `${flag} ${dimensions[key]}`).join(' ')}`);
    for (const filled of stack.filled) {
      const what = `${FILLED_LABEL[filled.dimension]} ${filled.value}`;
      lines.push(
        pc.dim(
          filled.by === 'fixed'
            ? `    ${what}: set by the ${dimensions.framework} framework`
            : `    ${what}: not found in the project; ClientKit's default for ${dimensions.framework}`,
        ),
      );
    }
    return lines;
  }

  lines.push(
    `  ${label('ClientKit stack')}${pc.yellow(
      stack.kind === 'undetermined' ? 'could not be determined' : 'not supported',
    )}`,
  );
  for (const problem of stack.problems) lines.push(`    ${problem}`);
  if (stack.hint !== undefined) {
    for (const line of stack.hint.split('\n')) lines.push(pc.dim(`    ${line}`));
  }
  return lines;
}

/**
 * The detection report. Everything shown is read from the detection and the
 * resolver's answer; nothing is recomputed here.
 */
export function renderDetection(
  detection: ProjectDetection,
  stack: DetectedStack,
  options: { readonly cwd: string; readonly verbose?: boolean },
): string {
  const verbose = options.verbose ?? false;
  const lines: string[] = [];
  const directory = path.relative(options.cwd, detection.root) || '.';

  lines.push(pc.bold('ClientKit project detection'));
  lines.push('');
  lines.push(`  ${label('Directory')}${directory}`);

  if (detection.state === 'empty') {
    lines.push('');
    lines.push('  No project detected: the directory is empty.');
    return lines.join('\n');
  }

  if (detection.name !== undefined) lines.push(`  ${label('Project')}${detection.name}`);
  if (detection.state === 'no-package-json') {
    lines.push('');
    lines.push('  No package.json found.');
  }

  lines.push('');
  lines.push(...rows(detection, verbose));

  lines.push('');
  lines.push(...renderStack(stack));

  if (detection.notes.length > 0) {
    lines.push('');
    for (const note of detection.notes) lines.push(pc.dim(`  ${note}`));
  }

  return lines.join('\n');
}
