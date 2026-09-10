import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node20.19',
  // Bundle every dependency into the output so the published package can
  // declare `dependencies: {}` and cost users zero extra network round-trips
  // during `npm create`.
  noExternal: [/.*/],
  bundle: true,
  splitting: false,
  clean: true,
  minify: false,
  sourcemap: false,
  dts: false,
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
});
