import path from 'node:path';

import type { FileContribution } from '../domain/contributions.js';

/**
 * The project's URL helpers, as a contribution any search feature can make.
 *
 * `robots`, `sitemap` and `structured-data` each build absolute addresses from
 * the configured site URL, and each may be selected without the others. So
 * each contributes the same file from the same template: identical claims on
 * one path are cooperation (see `contributedFiles`), and the file records
 * every feature that needed it as provenance.
 *
 * Aimed at `lib.urls` by role. Only an architecture whose capabilities admit
 * these features maps the role without shipping it - Astro's template ships
 * its own `src/lib/seo.ts`, and none of these features is accepted there.
 */
export function siteUrlHelpers(owner: string, templatesRoot: string): FileContribution {
  return {
    target: { kind: 'role', role: 'lib.urls' },
    intent: 'create',
    payload: {
      kind: 'template',
      source: path.join(templatesRoot, 'feature', 'shared', 'seo.ts'),
    },
    owner,
    order: 0,
    reason: 'origin, absolute-URL and JSON-LD helpers every search file shares',
  };
}

/**
 * The Organization JSON-LD component, for an architecture that renders a
 * contributed one (`composed-structured-data`).
 *
 * Kept here rather than in the structured-data adapter so that adapter names
 * no framework file at all - it states what the organisation is, and asks for
 * this when the stack's capabilities say a component is how it gets rendered.
 */
export function structuredDataComponent(owner: string, templatesRoot: string): FileContribution {
  return {
    target: { kind: 'role', role: 'app.document.structuredData' },
    intent: 'create',
    payload: {
      kind: 'template',
      source: path.join(templatesRoot, 'feature', 'structured-data', 'StructuredData.tsx'),
    },
    owner,
    order: 0,
    reason: 'renders the Organization JSON-LD from the site configuration',
  };
}
