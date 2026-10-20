import path from 'node:path';

import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution, FileContribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import { siteUrlHelpers } from './search-files.js';

/**
 * A robots policy, as a feature.
 *
 * ## What it generates
 *
 * One route module at `route.robots` that lets every crawler index every page.
 * A missing site URL does not block indexing - "no domain yet" and "hide this
 * site" are different decisions, and only the second is a robots decision.
 *
 * ## The sitemap line
 *
 * Advertised only when this project generates a sitemap, and then only once
 * the site URL is a real address. The manifest is what says whether one is
 * generated, so that is what is read: a `Sitemap:` line pointing at a route
 * that does not exist would send crawlers to a 404 the project put there
 * itself. Two templates rather than a conditional in one, because a module
 * that imports helpers it never calls does not type-check in the generated
 * project.
 *
 * ## Two ways to be satisfied
 *
 * `metadata-routes` (Next): robots.txt is a route module the project owns, and
 * this feature writes it.
 *
 * `template-crawler-files` (Astro): the template already ships a robots route
 * on every project. The feature is accepted and contributes nothing - no file,
 * no claim of ownership over the template's - the position `structured-data`
 * has always held on Astro. The branch is on the capability, never on which
 * framework it is.
 *
 * No required role: on Next the `metadata-routes` contract already holds the
 * architecture to mapping the surface, and on Astro there is nothing for this
 * feature to guarantee that the template does not already.
 */

const ROBOTS_DECLARATION: AdapterDeclaration = {
  id: 'robots',
  kind: 'feature',
  displayName: 'robots.txt',
  provides: [],
  requires: [
    {
      kind: 'requiresOneOf',
      capabilities: ['metadata-routes', 'template-crawler-files'],
      because:
        'robots.txt has to be served: from a route module this feature writes, or by a template that already ships one',
    },
  ],
};

const OWNER = adapterRef(ROBOTS_DECLARATION);

export function createRobotsAdapter(templatesRoot: string): Adapter {
  return {
    declaration: ROBOTS_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      return {};
    },

    contribute(project: ResolvedProject): Contribution {
      // The template already serves robots.txt; there is nothing to add.
      if (!project.capabilities.has('metadata-routes')) return emptyContribution(OWNER);

      const advertisesSitemap = project.manifest.features.includes('sitemap');

      const policy: FileContribution = {
        target: { kind: 'role', role: 'route.robots' },
        intent: 'create',
        payload: {
          kind: 'template',
          source: path.join(
            templatesRoot,
            'feature',
            'robots',
            advertisesSitemap ? 'robots-with-sitemap.ts' : 'robots.ts',
          ),
        },
        owner: OWNER,
        order: 0,
        reason: advertisesSitemap
          ? 'lets crawlers index the site and advertises the generated sitemap'
          : 'lets crawlers index the site',
      };

      return {
        ...emptyContribution(OWNER),
        files: advertisesSitemap ? [policy, siteUrlHelpers(OWNER, templatesRoot)] : [policy],
      };
    },
  };
}

export { ROBOTS_DECLARATION };
