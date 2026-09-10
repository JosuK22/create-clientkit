import type { APIRoute } from 'astro';

import { SEO, SITE } from '../config/site.config.ts';
import { absoluteUrl, siteOrigin } from '../lib/seo.ts';

/**
 * robots.txt is generated at build time rather than dropped in public/, so it
 * always reflects the current site.config.ts instead of whatever was true when
 * the project was scaffolded.
 *
 * The sitemap is only advertised when a production URL exists AND the site is
 * indexable - the same condition that decides whether a sitemap is built at
 * all (see astro.config.mjs). A URL-less site gets a valid, permissive
 * robots.txt with no sitemap line, never a fabricated domain.
 */
export const GET: APIRoute = () => {
  const origin = siteOrigin(SITE.url);
  const lines = ['User-agent: *'];

  if (SEO.noindex) {
    lines.push('Disallow: /');
  } else {
    lines.push('Allow: /');
    if (origin !== '') {
      lines.push('', `Sitemap: ${absoluteUrl(origin, '/sitemap-index.xml')}`);
    }
  }

  return new Response(`${lines.join('\n')}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
