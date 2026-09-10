import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
  },
  // test/seo.test.ts imports the template's own SEO helpers so they are unit
  // tested for real rather than asserted about as strings. Those files sit
  // beside a tsconfig.json that extends `astro/tsconfigs/strict`, which is not
  // installed in this repo, so esbuild is given an explicit config instead of
  // discovering one by walking up from each file. Type checking is unaffected:
  // `tsc` still uses the root tsconfig.json.
  esbuild: {
    tsconfigRaw: '{}',
  },
});
