import type { MetadataRoute } from 'next';

import { SITE } from '../lib/site.config';
import { absoluteUrl, siteOrigin } from '../lib/seo';

/**
 * Every page this sitemap lists, as site-relative paths.
 *
 * Next does not discover routes for a sitemap, so this list is the whole
 * truth: add a path here when you add a page that should be crawled. The
 * not-found page is deliberately absent - it is a status, not content.
 */
const ROUTES: readonly string[] = ['/'];

/**
 * `/sitemap.xml`, served by Next from this route module.
 *
 * Empty until `SITE.url` is a real address: a sitemap entry has to be an
 * absolute URL, and no domain is ever guessed. No `lastModified` either - a
 * date read from the clock at build time would claim every page changed on
 * every deploy.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin(SITE.url);
  if (origin === '') return [];

  return ROUTES.map((route) => ({ url: absoluteUrl(origin, route) }));
}
