import path from 'node:path';

import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import { siteUrlHelpers } from './search-files.js';

/**
 * An XML sitemap, as a feature.
 *
 * ## What it generates
 *
 * One route module at `route.sitemap` listing the pages the starter ships, as
 * absolute URLs built from the configured site origin. With no usable origin
 * the sitemap is empty: an entry must be absolute, and no domain is guessed.
 *
 * ## What it does not claim
 *
 * Route discovery. The list is explicit and starts with `/`, the one page
 * every starter guarantees; a page the developer adds later is listed by
 * whoever adds it. A sitemap that silently missed pages while looking complete
 * would be the worse failure.
 *
 * No `lastModified`: a value read from the clock would change on every build
 * and claim every page changed with it.
 *
 * ## Two ways to be satisfied
 *
 * `metadata-routes` (Next): the sitemap is a route module the project owns,
 * and this feature writes it.
 *
 * `template-crawler-files` (Astro): the template already ships a sitemap
 * integration on every project. The feature is accepted and contributes
 * nothing - writing a second sitemap would be a second owner, and claiming the
 * template's would be provenance nobody tracks.
 */

const SITEMAP_DECLARATION: AdapterDeclaration = {
  id: 'sitemap',
  kind: 'feature',
  displayName: 'Sitemap',
  provides: [],
  requires: [
    {
      kind: 'requiresOneOf',
      capabilities: ['metadata-routes', 'template-crawler-files'],
      because:
        'the sitemap has to be served: from a route module this feature writes, or by a template that already builds one',
    },
  ],
};

const OWNER = adapterRef(SITEMAP_DECLARATION);

export function createSitemapAdapter(templatesRoot: string): Adapter {
  return {
    declaration: SITEMAP_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      return {};
    },

    contribute(project: ResolvedProject): Contribution {
      // The template already builds a sitemap; there is nothing to add.
      if (!project.capabilities.has('metadata-routes')) return emptyContribution(OWNER);

      return {
        ...emptyContribution(OWNER),
        files: [
          {
            target: { kind: 'role', role: 'route.sitemap' },
            intent: 'create',
            payload: {
              kind: 'template',
              source: path.join(templatesRoot, 'feature', 'sitemap', 'sitemap.ts'),
            },
            owner: OWNER,
            order: 0,
            reason: 'the pages the starter ships, as absolute URLs once a site URL is set',
          },
          siteUrlHelpers(OWNER, templatesRoot),
        ],
      };
    },
  };
}

export { SITEMAP_DECLARATION };
