import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

import { SITE } from './src/config/site.config.ts';

// Astro rejects an empty or malformed `site`, so the option is omitted entirely
// until a production URL is set in src/config/site.config.ts. Setting it there
// switches on absolute canonical URLs across the site.
export default defineConfig({
  ...(SITE.url ? { site: SITE.url } : {}),
  vite: {
    plugins: [tailwindcss()],
  },
});
