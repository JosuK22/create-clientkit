import {
  PROVENANCE_NOTE,
  type Evidence,
  type Finding,
  type ProjectDetection,
} from '../detect/detect.js';
import type { DetectedStack } from '../detect/stack.js';
import { PACKAGE_MANAGERS } from '../types.js';

/**
 * Project doctor: does anything about this project need attention, and why?
 *
 * ## Detect once, diagnose from the result
 *
 * Everything here is a pure function of two values the command already has:
 * the detector's `ProjectDetection` and the resolver's `DetectedStack`. Nothing
 * touches the filesystem, nothing re-reads `package.json`, and nothing keeps a
 * list of what ClientKit supports. The checks translate findings into
 * severities; they do not form a second opinion.
 *
 * ## Who decides what
 *
 *   - A dimension check judges the *evidence* for one dimension: found cleanly,
 *     found as something ClientKit has no name for, found twice, not found.
 *     Those verdicts are the detector's statuses, unchanged.
 *   - The compatibility check carries the *resolver's* verdict, and is the only
 *     check that does. A value ClientKit names but has no adapter for, such as
 *     `angular`, is found cleanly - so its dimension passes - and is refused
 *     under compatibility in the resolver's own words, exactly as `detect`
 *     reports it. doctor cannot call supported what detect calls unsupported,
 *     because neither decides.
 *
 * ## Severity
 *
 *   - `error`   the resolver refuses the stack, or a dimension it refuses on
 *               (a foreign or ambiguous value), or `package.json` is unusable.
 *   - `warning` something may be wrong but nothing is known to be: no
 *               framework found, no `package.json`, a build tool ClientKit had
 *               to assume, lockfiles that disagree.
 *   - `info`    worth knowing, not a problem: no styling or UI library, which
 *               resolves to none; no lockfile yet.
 *   - `pass`    nothing to say.
 *
 * Unknown is never unsupported: a dimension with no evidence is at most a
 * warning, and only the resolver can make a stack an error.
 */

export type DoctorSeverity = 'pass' | 'info' | 'warning' | 'error';

export type DoctorStatus = 'healthy' | 'warning' | 'error';

export type DoctorCheckId =
  | 'project'
  | 'framework'
  | 'buildTool'
  | 'language'
  | 'styling'
  | 'uiLibrary'
  | 'router'
  | 'packageManager'
  | 'compatibility'
  | 'provenance';

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  /** What was checked, for the row label. */
  readonly title: string;
  readonly severity: DoctorSeverity;
  /** The answer in a few words, for the row itself. */
  readonly summary: string;
  /** Why, in sentences. Never a restatement of the evidence. */
  readonly details: readonly string[];
  /** The detector's evidence, untouched. Never a default dressed as a finding. */
  readonly evidence: readonly Evidence[];
  /** What the user might do. Only what the evidence supports. */
  readonly hint?: string;
}

export interface DoctorReport {
  /** Absolute; the renderer makes it relative. */
  readonly root: string;
  readonly name: string | undefined;
  readonly status: DoctorStatus;
  readonly errors: number;
  readonly warnings: number;
  /** In a fixed order: project, the seven dimensions, compatibility, provenance. */
  readonly checks: readonly DoctorCheck[];
}

type Dimension = 'framework' | 'buildTool' | 'language' | 'styling' | 'uiLibrary' | 'router';

const TITLES: Readonly<Record<Dimension | 'packageManager', string>> = {
  framework: 'Framework',
  buildTool: 'Build tool',
  language: 'Language',
  styling: 'Styling',
  uiLibrary: 'UI library',
  router: 'Router',
  packageManager: 'Package manager',
};

/** How each dimension reads in a sentence. */
const NOUNS: Readonly<Record<Dimension, string>> = {
  framework: 'framework',
  buildTool: 'build tool',
  language: 'language',
  styling: 'styling',
  uiLibrary: 'UI library',
  router: 'router',
};

const DIMENSIONS: readonly Dimension[] = [
  'framework',
  'buildTool',
  'language',
  'styling',
  'uiLibrary',
  'router',
];

function check(
  id: DoctorCheckId,
  title: string,
  severity: DoctorSeverity,
  summary: string,
  details: readonly string[] = [],
  evidence: readonly Evidence[] = [],
  hint?: string,
): DoctorCheck {
  return {
    id,
    title,
    severity,
    summary,
    details,
    evidence,
    ...(hint === undefined ? {} : { hint }),
  };
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

// ---------------------------------------------------------------------------
// Project metadata
// ---------------------------------------------------------------------------

function projectCheck(detection: ProjectDetection, problems: readonly string[]): DoctorCheck {
  const title = 'Project metadata';
  switch (detection.state) {
    case 'empty':
      return check(
        'project',
        title,
        'warning',
        'empty directory',
        ['There is no project here to diagnose.'],
        [],
        "Run doctor in an existing project's root directory.",
      );
    case 'no-package-json':
      return check(
        'project',
        title,
        'warning',
        'no package.json',
        ["ClientKit reads a project's stack from package.json, and this directory has none."],
        [],
        "Run doctor in the directory that holds the project's package.json.",
      );
    case 'unreadable-package-json':
      return check(
        'project',
        title,
        'error',
        'package.json unusable',
        problems,
        [],
        'Nothing about the stack can be read until package.json can.',
      );
    case 'package-json':
      return problems.length > 0
        ? check('project', title, 'warning', 'package.json has problems', problems)
        : check('project', title, 'pass', 'package.json');
  }
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

function ambiguous(
  id: DoctorCheckId,
  title: string,
  finding: Extract<Finding<string>, { status: 'ambiguous' }>,
  severity: DoctorSeverity,
): DoctorCheck {
  return check(
    id,
    title,
    severity,
    `ambiguous: ${finding.candidates.join(', ')}`,
    ['More than one was found, and ClientKit does not choose between them.'],
    finding.evidence,
    'If one of them is no longer used, removing it from package.json leaves one to detect.',
  );
}

/**
 * What a dimension with no package found comes to. Read from the resolver
 * when it resolved, because whether "nothing" is a fact, the framework's
 * decision or ClientKit's assumption is the resolver's answer, not ours.
 */
function absentCheck(dimension: Dimension, stack: DetectedStack): DoctorCheck {
  const title = TITLES[dimension];
  const noun = NOUNS[dimension];
  const none = `package.json lists no ${noun} package ClientKit recognises.`;

  if (dimension === 'framework') {
    return check(
      dimension,
      title,
      'warning',
      'none found',
      [none],
      [],
      'If this is a workspace root, run doctor in the package that holds the site.',
    );
  }

  if (stack.status === 'resolved') {
    const framework = stack.dimensions.framework;
    const filled = stack.filled.find((entry) => entry.dimension === dimension);
    if (filled?.by === 'fixed') {
      return check(dimension, title, 'pass', filled.value, [
        `Set by the ${framework} framework, which offers no other.`,
      ]);
    }
    if (filled?.by === 'default') {
      return check(
        dimension,
        title,
        'warning',
        'none found',
        [
          none,
          `ClientKit would assume ${filled.value}, its default for ${framework}; the project does not show it.`,
        ],
        [],
        `If the project does use ${filled.value}, listing it in package.json lets doctor confirm it.`,
      );
    }
    // Stated by its absence: no styling, no UI library, no router is a fact.
    return check(dimension, title, 'info', 'none found', [
      `${none} The stack's ${noun} is ${stack.dimensions[dimension]}.`,
    ]);
  }

  return check(dimension, title, dimension === 'buildTool' ? 'warning' : 'info', 'none found', [
    none,
  ]);
}

function dimensionCheck(
  dimension: Dimension,
  finding: Finding<string>,
  stack: DetectedStack,
): DoctorCheck {
  const title = TITLES[dimension];
  switch (finding.status) {
    case 'detected':
      return check(dimension, title, 'pass', finding.value, [], finding.evidence);
    case 'unsupported':
      return check(
        dimension,
        title,
        'error',
        `${finding.name} (not supported)`,
        [`ClientKit does not currently support ${finding.name}.`],
        finding.evidence,
      );
    case 'ambiguous':
      return ambiguous(dimension, title, finding, 'error');
    case 'absent':
      return absentCheck(dimension, stack);
    case 'unknown':
      return check(dimension, title, 'warning', 'unknown', [
        `Could not be determined: ${finding.reason}.`,
      ]);
  }
}

function packageManagerCheck(finding: Finding<string>): DoctorCheck {
  const id = 'packageManager';
  const title = TITLES.packageManager;
  switch (finding.status) {
    case 'detected':
      return check(id, title, 'pass', finding.value, [], finding.evidence);
    case 'unsupported':
      return check(
        id,
        title,
        'warning',
        `${finding.name} (not supported)`,
        [
          `ClientKit works with ${PACKAGE_MANAGERS.join(', ')}.`,
          'This does not affect whether the stack is supported.',
        ],
        finding.evidence,
      );
    case 'ambiguous': {
      const lockfiles = finding.evidence.filter((entry) => entry.source === 'lockfile');
      const field = finding.evidence.some((entry) => entry.source === 'package.json');
      return check(
        id,
        title,
        'warning',
        field
          ? lockfiles.length > 1
            ? 'conflicting evidence'
            : 'packageManager field and lockfile disagree'
          : 'multiple lockfiles',
        [
          `The evidence names more than one package manager: ${finding.candidates.join(', ')}.`,
          'ClientKit does not choose between them.',
        ],
        finding.evidence,
        field
          ? 'Make the "packageManager" field and the lockfile agree on the one this project actually uses.'
          : 'Keep the lockfile for the package manager this project actually uses.',
      );
    }
    case 'absent':
    case 'unknown':
      return check(id, title, 'info', 'none recorded', [
        finding.status === 'unknown'
          ? sentence(finding.reason)
          : 'No lockfile, and no "packageManager" field.',
      ]);
  }
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

function compatibilityCheck(stack: DetectedStack): DoctorCheck {
  const title = 'Compatibility';
  if (stack.status === 'resolved') {
    return check('compatibility', title, 'pass', 'supported', [
      'ClientKit resolves this project to a stack it supports.',
    ]);
  }
  return stack.kind === 'undetermined'
    ? check(
        'compatibility',
        title,
        'warning',
        'could not be determined',
        stack.problems,
        [],
        stack.hint,
      )
    : check('compatibility', title, 'error', 'not supported', stack.problems, [], stack.hint);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Diagnoses a detected project. Pure and deterministic: the same detection and
 * stack always produce an equal report, in the same order.
 */
export function diagnoseProject(detection: ProjectDetection, stack: DetectedStack): DoctorReport {
  const problems = detection.notes.filter((note) => note !== PROVENANCE_NOTE);
  const checks: DoctorCheck[] = [projectCheck(detection, problems)];

  /*
   * With no usable package.json, every dimension that needs it is "unknown"
   * for one reason, and the project check has already said it. Repeating it
   * six times says nothing new, so only what was still found is shown - a
   * tsconfig.json, a lockfile.
   */
  const readable = detection.state === 'package-json';
  for (const dimension of DIMENSIONS) {
    const finding = detection[dimension];
    if (!readable && finding.status === 'unknown') continue;
    checks.push(dimensionCheck(dimension, finding, stack));
  }
  if (readable || detection.packageManager.status !== 'unknown') {
    checks.push(packageManagerCheck(detection.packageManager));
  }

  checks.push(compatibilityCheck(stack));

  if (detection.notes.includes(PROVENANCE_NOTE)) {
    checks.push(
      check('provenance', 'ClientKit record', 'info', '.client-site.json', [
        'ClientKit generated this project. doctor does not read the record; `upgrade` does.',
      ]),
    );
  }

  const errors = checks.filter((entry) => entry.severity === 'error').length;
  const warnings = checks.filter((entry) => entry.severity === 'warning').length;
  return {
    root: detection.root,
    name: detection.name,
    status: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'healthy',
    errors,
    warnings,
    checks,
  };
}
