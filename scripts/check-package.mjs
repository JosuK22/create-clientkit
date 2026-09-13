#!/usr/bin/env node
/**
 * Validates the npm artifact before anyone can publish or install it.
 *
 * Answers three questions:
 *   1. Does the tarball contain exactly what it should, and nothing else?
 *   2. Has anyone added a runtime dependency to the CLI?
 *   3. Has the generated project's dependency set drifted?
 *
 * Uses allow/deny patterns rather than an exact file count, so adding a
 * legitimate template file does not fail the build for the wrong reason.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { ASTRO_GOLDEN, generatedPackage } from './lib/generated-package.mjs';

const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const ok = (message) => notes.push(message);

// --- 1. tarball contents -----------------------------------------------------

/** Every shipped path must match one of these. */
const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^THIRD-PARTY\.md$/,
  /^bin\/cli\.js$/,
  /^dist\/cli\.js$/,
  /^templates\/[^/]+\/template\.json$/,
  /^templates\/[^/]+\/(base|modes\/[^/]+)\/.+$/,
  // The styling tree is not a template: it holds the stylesheets the styling
  // adapters contribute, one directory per system. Deliberately narrower than
  // the two patterns above - one level deep, CSS only - because nothing else
  // has any business living there.
  /^templates\/styling\/[^/]+\/[^/]+\.css$/,
  // The UI-library tree, same shape and same reasoning as the styling tree
  // above: one directory per library, holding the source that library
  // contributes. One level deep, TSX only.
  /^templates\/ui-library\/[^/]+\/[^/]+\.tsx$/,
];

/** Nothing shipped may match one of these, whatever the allow-list says. */
const DENIED = [
  { pattern: /^src\//, why: 'CLI source must not ship; the bundle does' },
  { pattern: /^test\//, why: 'tests must not ship' },
  { pattern: /^scripts\//, why: 'operator scripts must not ship' },
  { pattern: /node_modules\//, why: 'dependencies must never be bundled as files' },
  { pattern: /^\.github\//, why: 'CI configuration must not ship' },
  { pattern: /(^|\/)\.env($|\.)/, why: 'environment files must never ship' },
  { pattern: /\.(pem|key|p12|pfx|crt)$/, why: 'credential material must never ship' },
  { pattern: /(^|\/)\.npmrc$/, why: 'an .npmrc can carry an auth token' },
  { pattern: /(^|\/)npm-shrinkwrap\.json$/, why: 'shrinkwrap would pin consumers unexpectedly' },
  {
    pattern: /^(tsconfig|tsup\.config|vitest\.config|eslint\.config)/,
    why: 'dev config must not ship',
  },
  { pattern: /\.(test|spec)\./, why: 'test files must not ship' },
  { pattern: /\.tsbuildinfo$/, why: 'build cache must not ship' },
  { pattern: /^example\.preset\.json$/, why: 'not referenced by the published package' },
];

/** Files that must be present, or the package is broken on arrival. */
const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD-PARTY.md',
  'bin/cli.js',
  'dist/cli.js',
  'templates/astro-tailwind/template.json',
  'templates/astro-tailwind/base/_package.json',
  'templates/astro-tailwind/base/public/favicon.svg',
  'templates/astro-tailwind/base/src/components/Seo.astro',
  'templates/astro-tailwind/base/src/components/StructuredData.astro',
  'templates/astro-tailwind/base/src/lib/seo.ts',
  'templates/astro-tailwind/base/src/pages/robots.txt.ts',
  'templates/astro-tailwind/base/src/pages/404.astro',
  'templates/astro-tailwind/base/src/config/site.config.ts',
  'templates/astro-tailwind/modes/coming-soon/src/pages/index.astro',
  'templates/astro-tailwind/modes/full/src/pages/index.astro',
  // A styling adapter contributes its global stylesheet by path. If one of
  // these stops shipping, every project built with that styling system gets a
  // dangling import - and the CLI's own tests would not notice, because they
  // read the repository rather than the tarball.
  'templates/styling/tailwind/styles.global.css',
  'templates/styling/bootstrap/styles.global.css',
  // A UI library contributes this by role. If it stops shipping, every project
  // built with that library imports a file that is not there.
  'templates/ui-library/mui/AppProviders.tsx',
];

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }),
);

const entry = Array.isArray(packed) ? packed[0] : packed;
const files = entry.files.map((f) => f.path.split('\\').join('/'));

for (const file of files) {
  if (!ALLOWED.some((pattern) => pattern.test(file))) {
    fail(`unexpected file in tarball: ${file}`);
  }
  for (const { pattern, why } of DENIED) {
    if (pattern.test(file)) fail(`forbidden file in tarball: ${file} (${why})`);
  }
}

for (const required of REQUIRED) {
  if (!files.includes(required)) fail(`missing from tarball: ${required}`);
}

ok(`tarball: ${files.length} files, ${(entry.size / 1024).toFixed(1)} kB packed`);

// --- 2. CLI runtime dependencies ---------------------------------------------

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});

if (runtimeDeps.length > 0) {
  fail(
    `the CLI must have zero runtime dependencies, found: ${runtimeDeps.join(', ')}. ` +
      'Bundle it into dist/cli.js instead, or change this guard deliberately.',
  );
} else {
  ok('CLI runtime dependencies: none');
}

for (const field of ['peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
  if (pkg[field] && Object.keys(pkg[field]).length > 0) {
    fail(`unexpected ${field} on the CLI package`);
  }
}

if (pkg.license !== 'MIT') fail(`CLI license must be MIT, found ${pkg.license}`);
if (pkg.name !== 'create-clientkit') fail(`package name must not change, found ${pkg.name}`);

// npm runs `prepare` on install from a git URL; anything heavier is a surprise.
const lifecycle = ['preinstall', 'install', 'postinstall'];
for (const script of lifecycle) {
  if (pkg.scripts?.[script]) {
    fail(`install-time lifecycle script "${script}" would run on every user install`);
  }
}
ok('no install-time lifecycle scripts');

// --- 3. generated-project dependencies ---------------------------------------

// The generated manifest, not the template: since Stage 6 the template carries
// the project identity and the adapters carry the packages, so the template is
// no longer evidence of what a user installs.
const generatedPkg = generatedPackage(ASTRO_GOLDEN);

const EXPECTED_RUNTIME = { '@astrojs/sitemap': '3.7.4', astro: '7.3.2' };
const EXPECTED_DEV = {
  '@astrojs/check': '0.9.10',
  '@tailwindcss/vite': '4.3.3',
  tailwindcss: '4.3.3',
  typescript: '5.9.3',
};

const compare = (label, actual, expected) => {
  for (const [name, version] of Object.entries(expected)) {
    if (actual[name] !== version) {
      fail(`generated ${label}: expected ${name}@${version}, found ${actual[name] ?? 'nothing'}`);
    }
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected)) {
      fail(`generated ${label}: unexpected dependency "${name}" - dependency creep`);
    }
  }
};

compare('dependencies', generatedPkg.dependencies ?? {}, EXPECTED_RUNTIME);
compare('devDependencies', generatedPkg.devDependencies ?? {}, EXPECTED_DEV);

for (const [name, version] of Object.entries({
  ...(generatedPkg.dependencies ?? {}),
  ...(generatedPkg.devDependencies ?? {}),
})) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`generated dependency ${name} must be an exact pin, found "${version}"`);
  }
}

if (generatedPkg.private !== true) fail('generated project must be private');
if (generatedPkg.license !== 'UNLICENSED') {
  fail(`generated project must be UNLICENSED, found ${generatedPkg.license}`);
}
ok('generated project: pinned deps, private, UNLICENSED');

// A client project must never receive the CLI's MIT licence.
if (files.some((f) => /^templates\/.*\/LICENSE$/.test(f))) {
  fail('a LICENSE file inside the template would be copied into client projects');
}

// --- report ------------------------------------------------------------------

for (const note of notes) console.log(`  ok    ${note}`);
for (const failure of failures) console.error(`  FAIL  ${failure}`);

if (failures.length > 0) {
  console.error(`\npackage check failed with ${failures.length} problem(s)`);
  process.exit(1);
}
console.log('\npackage check passed');
