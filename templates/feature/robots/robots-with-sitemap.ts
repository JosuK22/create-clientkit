import type { MetadataRoute } from 'next';

import { SITE } from '../lib/site.config';
import { absoluteUrl, siteOrigin } from '../lib/seo';

/**
 * `/robots.txt`, served by Next from this route module.
 *
 * Every crawler may index every page. The sitemap is advertised only once
 * `SITE.url` is a real address, because a `Sitemap:` line has to be absolute
 * and no domain is ever guessed. A missing URL does not block indexing either:
 * a site without a domain yet is not a site that asked to be hidden.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin(SITE.url);

  return {
    rules: { userAgent: '*', allow: '/' },
    ...(origin === '' ? {} : { sitemap: absoluteUrl(origin, '/sitemap.xml') }),
  };
}
