import type { AdapterRegistry } from '../adapters/registry.js';
import { checkCompatibility } from '../adapters/selection.js';
import type { DimensionOptions } from '../domain/adapters.js';
import { formatReport } from '../domain/compatibility.js';
import {
  assertFrameworkOffers,
  manifestFrom,
  resolveDimensions,
  type DimensionInput,
  type ResolvedDimensions,
} from '../context/dimensions.js';
import { CliError } from '../errors.js';
import type { Finding, ProjectDetection } from './detect.js';

/**
 * From "what the project uses" to "what ClientKit calls that stack".
 *
 * No second resolver. Detected values become the same raw `DimensionInput` a
 * set of flags produces, and go through the same three checks every other
 * input goes through, in the same order as `resolveContext`:
 *
 *   resolveDimensions      is each word known; fill what the framework decides
 *   assertFrameworkOffers  does the framework offer what was found
 *   checkCompatibility     can the pieces be built together
 *
 * So an Angular project is refused by the adapter registry in the same words
 * `--framework angular` gets, and a Next.js project using React Router is
 * refused by the framework's own declaration, not by a rule written here.
 *
 * What this adds is only the translation from a finding to an input, and the
 * one judgement the resolver cannot make for itself: a dimension that is
 * ambiguous or foreign has no input to give, and leaving it out would let the
 * resolver fill in a default the project never chose. Those stop here.
 */

export interface FilledDimension {
  readonly dimension: 'buildTool' | 'language' | 'router' | 'architecture';
  readonly value: string;
  /**
   * `fixed`: the framework offers exactly this value, so nothing needed finding.
   * `default`: the framework offers a choice and the project named none, so
   * ClientKit's default stands in - a value the project does not actually have.
   */
  readonly by: 'fixed' | 'default';
}

export type DetectedStack =
  | {
      readonly status: 'resolved';
      readonly dimensions: ResolvedDimensions;
      /** Dimensions the resolver supplied rather than the project. */
      readonly filled: readonly FilledDimension[];
    }
  | {
      readonly status: 'unresolved';
      /**
       * `undetermined`: there was not enough to go on (no framework found).
       * `unsupported`: there was, and it is not a stack ClientKit generates.
       */
      readonly kind: 'undetermined' | 'unsupported';
      readonly problems: readonly string[];
      readonly hint?: string;
    };

const LABELS = {
  framework: 'framework',
  buildTool: 'build tool',
  language: 'language',
  styling: 'styling',
  uiLibrary: 'UI library',
  router: 'router',
} as const;

type Dimension = keyof typeof LABELS;

/** Why a finding cannot become an input, or `undefined` when it can. */
function problemWith(dimension: Dimension, finding: Finding<string>): string | undefined {
  const label = LABELS[dimension];
  switch (finding.status) {
    case 'unsupported':
      return `Its ${label}, ${finding.name}, is not one ClientKit supports.`;
    case 'ambiguous':
      return `Its ${label} is ambiguous: ${finding.candidates.join(', ')}.`;
    default:
      return undefined;
  }
}

function offered<T extends string>(options: DimensionOptions<T>): readonly T[] {
  return options.kind === 'fixed' ? [options.value] : options.options;
}

export function resolveDetectedStack(
  detection: ProjectDetection,
  adapters: AdapterRegistry,
): DetectedStack {
  const framework = detection.framework;
  switch (framework.status) {
    case 'unknown':
      return {
        status: 'unresolved',
        kind: 'undetermined',
        problems: [`The framework could not be identified: ${framework.reason}.`],
      };
    case 'absent':
      return {
        status: 'unresolved',
        kind: 'undetermined',
        problems: ['package.json lists no framework ClientKit recognises.'],
      };
    case 'unsupported':
      return {
        status: 'unresolved',
        kind: 'unsupported',
        problems: [`${framework.name} is not a framework ClientKit supports.`],
      };
    case 'ambiguous':
      return {
        status: 'unresolved',
        kind: 'unsupported',
        problems: [`The framework is ambiguous: ${framework.candidates.join(', ')}.`],
      };
    case 'detected':
      break;
  }

  const problems = (['buildTool', 'language', 'styling', 'uiLibrary', 'router'] as const)
    .map((dimension) => problemWith(dimension, detection[dimension]))
    .filter((problem): problem is string => problem !== undefined);
  if (problems.length > 0) return { status: 'unresolved', kind: 'unsupported', problems };

  const stated = <T extends string>(finding: Finding<T>): T | undefined =>
    finding.status === 'detected' ? finding.value : undefined;

  try {
    /*
     * Absent means package.json was read and lists none of the known packages,
     * which is a fact about the project: it has no styling system or component
     * library ClientKit knows, and no router - where `none` is a router the
     * framework offers. Where it is not (Next.js and Astro route by file),
     * the dimension is left for the framework to decide.
     */
    const frameworkAdapter = adapters.framework(framework.value);
    const noRouter =
      detection.router.status === 'absent' && offered(frameworkAdapter.routers).includes('none');

    const input: DimensionInput = {
      framework: framework.value,
      buildTool: stated(detection.buildTool),
      language: stated(detection.language),
      styling: detection.styling.status === 'absent' ? 'none' : stated(detection.styling),
      uiLibrary: detection.uiLibrary.status === 'absent' ? 'none' : stated(detection.uiLibrary),
      router: noRouter ? 'none' : stated(detection.router),
      features: [],
    };

    const dimensions = resolveDimensions(input, adapters);
    assertFrameworkOffers(dimensions, adapters);

    // Compatibility reads only the dimensions; the identity is a placeholder
    // because a detected project has no site configuration to offer.
    const report = checkCompatibility(
      manifestFrom(
        {
          targetDir: detection.root,
          projectName: detection.name ?? 'project',
          site: { name: '', url: null, description: '', locale: 'en', author: null },
          packageManager: 'npm',
          git: false,
          install: false,
        },
        dimensions,
        'full',
      ),
      adapters,
    );
    if (!report.compatible) {
      return {
        status: 'unresolved',
        kind: 'unsupported',
        problems: ['That combination will not work.'],
        hint: formatReport(report),
      };
    }

    const options = {
      buildTool: frameworkAdapter.buildTools,
      language: frameworkAdapter.languages,
      router: frameworkAdapter.routers,
      architecture: frameworkAdapter.architectures,
    } as const;
    const filled = (['buildTool', 'language', 'router', 'architecture'] as const)
      .filter((dimension) => dimensions.origins[dimension] !== 'stated')
      .map((dimension) => ({
        dimension,
        value: dimensions[dimension],
        by: options[dimension].kind === 'fixed' ? ('fixed' as const) : ('default' as const),
      }));

    return { status: 'resolved', dimensions, filled };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return {
      status: 'unresolved',
      kind: 'unsupported',
      problems: [error.message],
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    };
  }
}
