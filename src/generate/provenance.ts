import type { ProjectManifest } from '../domain/manifest.js';
import type { TemplateManifest } from '../templates/manifest.js';
import type { ProjectContext } from '../types.js';

export const PROVENANCE_FILE = '.client-site.json';

/**
 * The stack a project was actually generated as.
 *
 * A projection of `ProjectManifest`, not a second description of it: the same
 * field names, the same union types, narrowed to the seven dimensions the
 * resolver settles. Writing them out again as strings would create a shape that
 * could drift from the one the rest of the system uses, which is the thing to
 * avoid - a `Pick` cannot.
 *
 * The starter and the feature list are deliberately absent. Both are already
 * recorded, as `mode` and `config.features`, and provenance duplicating a value
 * it already holds is how two fields start disagreeing.
 */
export type ResolvedStack = Pick<
  ProjectManifest,
  'framework' | 'buildTool' | 'language' | 'styling' | 'uiLibrary' | 'router' | 'architecture'
>;

export interface Provenance {
  readonly $schema: string;
  readonly cliVersion: string;
  readonly template: {
    readonly id: string;
    readonly version: string;
    readonly framework: string;
    readonly frameworkVersion: string;
  };
  /** What the project is, as opposed to what it was generated from. */
  readonly stack: ResolvedStack;
  readonly mode: string;
  readonly generatedAt: string;
  readonly config: {
    readonly projectName: string;
    readonly siteName: string;
    readonly siteUrl: string | null;
    readonly locale: string;
    readonly packageManager: string;
    readonly features: readonly string[];
  };
}

/**
 * Records how a project was generated, so a future `upgrade` or `add` command
 * does not have to guess.
 *
 * Deliberately an allow-list of resolved configuration: no environment, no
 * absolute paths, no credentials. `author` is excluded because it is personal
 * data the generated project already carries in package.json when set.
 */
export function buildProvenance(
  context: ProjectContext,
  manifest: TemplateManifest,
  stack: ResolvedStack,
): Provenance {
  return {
    $schema: 'https://create-clientkit.dev/schema/client-site.json',
    cliVersion: context.cliVersion,
    template: {
      id: manifest.id,
      version: manifest.version,
      framework: manifest.framework,
      frameworkVersion: manifest.frameworkVersion,
    },
    stack,
    mode: context.template.mode,
    generatedAt: context.generatedAt,
    config: {
      projectName: context.projectName,
      siteName: context.site.name,
      siteUrl: context.site.url,
      locale: context.site.locale,
      packageManager: context.packageManager,
      features: context.features,
    },
  };
}
