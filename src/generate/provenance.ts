import type { TemplateManifest } from '../templates/manifest.js';
import type { ProjectContext } from '../types.js';

export const PROVENANCE_FILE = '.client-site.json';

export interface Provenance {
  readonly $schema: string;
  readonly cliVersion: string;
  readonly template: {
    readonly id: string;
    readonly version: string;
    readonly framework: string;
    readonly frameworkVersion: string;
  };
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
export function buildProvenance(context: ProjectContext, manifest: TemplateManifest): Provenance {
  return {
    $schema: 'https://create-clientkit.dev/schema/client-site.json',
    cliVersion: context.cliVersion,
    template: {
      id: manifest.id,
      version: manifest.version,
      framework: manifest.framework,
      frameworkVersion: manifest.frameworkVersion,
    },
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
