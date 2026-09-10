import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

import { SEO, SITE } from './src/config/site.config.ts';
import { siteOrigin } from './src/lib/seo.ts';

// '' when no production URL is configured. Astro rejects an empty or malformed
// `site`, and an absolute sitemap cannot exist without a real domain, so both
// are switched on by the same condition rather than guessing a URL.
const origin = siteOrigin(SITE.url);

// A site asking not to be indexed should not also publish a sitemap listing
// every page it wants ignored.
const wantsSitemap = origin !== '' && !SEO.noindex;

export default defineConfig({
  ...(origin ? { site: origin } : {}),
  integrations: [
    ...(wantsSitemap
      ? [
          sitemap({
            // 404 is a status page, not content to be crawled.
            filter: (page) => !page.includes('/404'),
          }),
        ]
      : []),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
