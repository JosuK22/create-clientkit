import type { MetadataRoute } from 'next';

/**
 * `/robots.txt`, served by Next from this route module.
 *
 * Every crawler may index every page. No sitemap is advertised, because this
 * project does not generate one - add `app/sitemap.ts` and a `sitemap` entry
 * here together, or regenerate with `--features robots,sitemap`.
 *
 * A missing production URL does not block indexing: a site without a domain
 * yet is not a site that asked to be hidden.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
  };
}
