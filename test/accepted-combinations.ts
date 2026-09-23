import path from 'node:path';

import { createAdapterRegistry, type AdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility } from '../src/adapters/selection.js';
import { assertFrameworkOffers, resolveDimensions } from '../src/context/dimensions.js';
import type { ProjectManifest } from '../src/domain/manifest.js';
import type { StarterId } from '../src/domain/starter.js';
import { STARTER_IDS } from '../src/domain/starter.js';

/**
 * Which stacks ClientKit currently accepts, asked rather than remembered.
 *
 * ## Why this is not a list
 *
 * Stage 52 enumerated the accepted set from a scratch script and reported 104.
 * Stage 53 has to install and build every one of them, which is only meaningful
 * if the set being built is the same set the product accepts - and a number
 * copied into a harness stops being that the first time an adapter changes.
 *
 * So nothing here decides what is valid. This walks the cross-product of the
 * values the registry says it *implements*, hands each one to the real
 * dimension resolver and the real compatibility engine, and reports what came
 * back. Both refusal paths are kept apart, because they are different facts:
 *
 *   - `resolution` - the framework does not offer that build tool, language,
 *     router or architecture. Refused before capabilities are consulted.
 *   - `compatibility` - the selections are individually fine and disagree.
 *
 * No capability rule, no framework name and no styling rule appears below.
 */

/** The dimensions that identify one configuration, and nothing else. */
export interface Combination {
  /** Stable, filesystem-safe, derived from the resolved dimensions. */
  readonly id: string;
  readonly framework: string;
  readonly buildTool: string;
  readonly language: string;
  readonly styling: string;
  readonly uiLibrary: string;
  readonly router: string;
  readonly architecture: string;
  readonly starter: string;
  readonly features: readonly string[];
}

export interface Rejection extends Combination {
  /** Which layer said no. */
  readonly refusedBy: 'resolution' | 'compatibility';
  readonly reason: string;
}

export interface Enumeration {
  readonly accepted: readonly Combination[];
  readonly rejected: readonly Rejection[];
  /** Everything considered, so a caller can show coverage rather than a count. */
  readonly total: number;
}

/** Every subset of a list, in a stable order. */
function subsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask += 1) {
    out.push(items.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return out;
}

/**
 * The ordering the matrix is reported in.
 *
 * Declared, not incidental: the dimensions in the order a reader thinks about
 * them, then the feature list. Nothing here reads insertion order from a
 * registry, a directory listing or the order results happened to finish in.
 */
export const COMBINATION_ORDER = [
  'framework',
  'buildTool',
  'language',
  'styling',
  'uiLibrary',
  'router',
  'architecture',
  'starter',
] as const;

export function compareCombinations(a: Combination, b: Combination): number {
  for (const key of COMBINATION_ORDER) {
    const difference = a[key].localeCompare(b[key]);
    if (difference !== 0) return difference;
  }
  return a.features.join(',').localeCompare(b.features.join(','));
}

/** A short, stable, path-safe name for one configuration. */
function identify(combination: Omit<Combination, 'id'>): string {
  const features = combination.features.length === 0 ? 'none' : combination.features.join('+');
  return [
    combination.framework,
    combination.styling,
    combination.uiLibrary,
    combination.router,
    combination.starter,
    features,
  ].join('_');
}

/**
 * A manifest for one candidate, with the identity fields a real run would have.
 *
 * `targetDir` is a placeholder: compatibility never reads it, and putting a
 * real temporary path here would make the enumeration machine-specific.
 */
function candidateManifest(
  resolved: ReturnType<typeof resolveDimensions>,
  starter: StarterId,
): ProjectManifest {
  return {
    targetDir: path.join(path.parse(process.cwd()).root, 'ck-matrix', 'acme-site'),
    projectName: 'acme-site',
    framework: resolved.framework,
    buildTool: resolved.buildTool,
    language: resolved.language,
    styling: resolved.styling,
    uiLibrary: resolved.uiLibrary,
    router: resolved.router,
    architecture: resolved.architecture,
    starter,
    features: resolved.features,
    site: {
      name: 'Acme Ltd',
      url: 'https://acme.example',
      description: 'Bespoke widgets.',
      locale: 'en',
      author: null,
    },
    packageManager: 'npm',
    git: false,
    install: false,
  };
}

/**
 * Walks every implemented value and reports what the product accepts.
 *
 * The registry is asked which ids have adapters; `none` is added for the three
 * dimensions where absence is a real answer, and `file-based` for the router,
 * which is a framework's own arrangement rather than an adapter.
 */
export function enumerateCombinations(adapters: AdapterRegistry): Enumeration {
  const frameworks = adapters.implementedFrameworks();
  const stylings = ['none', ...adapters.implementedStyling()];
  const uiLibraries = ['none', ...adapters.implementedUiLibraries()];
  const routers = ['none', 'file-based', ...adapters.implementedRouters()];
  const features = adapters.implementedFeatures();
  const languages = ['ts', 'js'];

  const accepted: Combination[] = [];
  const rejected: Rejection[] = [];
  let total = 0;

  for (const framework of frameworks) {
    for (const styling of stylings) {
      for (const uiLibrary of uiLibraries) {
        for (const router of routers) {
          for (const language of languages) {
            for (const selected of subsets(features)) {
              for (const starter of STARTER_IDS) {
                total += 1;

                let resolved;
                try {
                  resolved = resolveDimensions(
                    { framework, styling, uiLibrary, router, language, features: selected },
                    adapters,
                  );
                  // The same check the CLI runs once a stack is settled.
                  assertFrameworkOffers(resolved, adapters);
                } catch (error) {
                  rejected.push({
                    id: identify({
                      framework,
                      buildTool: '?',
                      language,
                      styling,
                      uiLibrary,
                      router,
                      architecture: '?',
                      starter,
                      features: selected,
                    }),
                    framework,
                    buildTool: '?',
                    language,
                    styling,
                    uiLibrary,
                    router,
                    architecture: '?',
                    starter,
                    features: selected,
                    refusedBy: 'resolution',
                    reason: (error as Error).message,
                  });
                  continue;
                }

                const shape = {
                  framework: resolved.framework,
                  buildTool: resolved.buildTool,
                  language: resolved.language,
                  styling: resolved.styling,
                  uiLibrary: resolved.uiLibrary,
                  router: resolved.router,
                  architecture: resolved.architecture,
                  starter,
                  features: resolved.features,
                };
                const report = checkCompatibility(candidateManifest(resolved, starter), adapters);

                if (report.compatible) {
                  accepted.push({ id: identify(shape), ...shape });
                } else {
                  rejected.push({
                    id: identify(shape),
                    ...shape,
                    refusedBy: 'compatibility',
                    reason: report.violations
                      .map((violation) =>
                        violation.constraint.kind === 'requiresOneOf'
                          ? violation.constraint.capabilities.join('|')
                          : violation.constraint.capability,
                      )
                      .join(', '),
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    accepted: [...accepted].sort(compareCombinations),
    rejected,
    total,
  };
}

/** The accepted set, against a registry built from the repository's templates. */
export function acceptedCombinations(templatesRoot: string): readonly Combination[] {
  return enumerateCombinations(createAdapterRegistry(templatesRoot)).accepted;
}
