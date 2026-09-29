import path from 'node:path';

import pc from 'picocolors';

import type { Evidence } from '../detect/detect.js';
import type { DoctorCheck, DoctorReport, DoctorSeverity } from '../doctor/diagnose.js';

/**
 * The same marks the logger uses, so a doctor row and a CLI message that mean
 * the same thing look the same. ASCII, because a Windows console still mangles
 * the alternatives.
 */
const MARKS: Readonly<Record<DoctorSeverity, string>> = {
  pass: pc.green('*'),
  info: pc.blue('i'),
  warning: pc.yellow('!'),
  error: pc.red('x'),
};

const COLOURS: Readonly<Record<DoctorSeverity, (text: string) => string>> = {
  pass: (text) => text,
  info: pc.dim,
  warning: pc.yellow,
  error: pc.red,
};

function label(text: string): string {
  return pc.dim(text.padEnd(18));
}

function evidenceLine(entry: Evidence): string {
  return entry.source === 'package.json' ? `package.json: ${entry.detail}` : entry.path;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * One check. A pass is one line; so is info, plus what it means. A warning or
 * an error also carries its evidence and hint, because those are the rows the
 * user has to act on. `--debug` expands passes too.
 */
function renderCheck(entry: DoctorCheck, verbose: boolean): string[] {
  const title = entry.title.padEnd(18);
  const lines = [`  ${MARKS[entry.severity]} ${title}${COLOURS[entry.severity](entry.summary)}`];

  const problem = entry.severity === 'warning' || entry.severity === 'error';
  const expand = problem || verbose;

  if (expand || entry.severity === 'info') {
    for (const detail of entry.details) lines.push(`      ${pc.dim(detail)}`);
  }
  if (expand && entry.evidence.length > 0) {
    lines.push(`      ${pc.dim('Evidence:')}`);
    for (const evidence of entry.evidence) lines.push(`        ${evidenceLine(evidence)}`);
  }
  if (problem && entry.hint !== undefined) {
    // A one-line hint sits beside its label; a report (the compatibility
    // engine's) goes beneath it, indented as the evidence is.
    const hint = entry.hint.split('\n').map((line) => line.trimEnd());
    if (hint.length === 1) {
      lines.push(`      ${pc.dim('Hint:')} ${hint[0]}`);
    } else {
      lines.push(`      ${pc.dim('Hint:')}`);
      for (const line of hint) lines.push(line === '' ? '' : `        ${line.trimStart()}`);
    }
  }
  return lines;
}

/** The report, from the report alone. Nothing is recomputed here. */
export function renderDoctorReport(
  report: DoctorReport,
  options: { readonly cwd: string; readonly verbose?: boolean },
): string {
  const verbose = options.verbose ?? false;
  const lines: string[] = [];

  lines.push(pc.bold('ClientKit doctor'));
  lines.push('');
  lines.push(`  ${label('Directory')}${path.relative(options.cwd, report.root) || '.'}`);
  if (report.name !== undefined) lines.push(`  ${label('Project')}${report.name}`);
  lines.push('');

  for (const entry of report.checks) lines.push(...renderCheck(entry, verbose));
  lines.push('');

  if (report.status === 'healthy') {
    lines.push(pc.green('No issues found.'));
  } else {
    const counts = [
      ...(report.errors > 0 ? [plural(report.errors, 'error')] : []),
      ...(report.warnings > 0 ? [plural(report.warnings, 'warning')] : []),
    ];
    const text = `${counts.join(', ')} found.`;
    lines.push(report.status === 'error' ? pc.red(text) : pc.yellow(text));
  }

  return lines.join('\n');
}
