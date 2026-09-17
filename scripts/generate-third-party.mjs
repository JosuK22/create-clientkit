#!/usr/bin/env node
/**
 * Regenerates THIRD-PARTY.md from the installed dependency graph.
 *
 * The CLI publishes with `dependencies: {}` because its dependencies are
 * bundled into dist/cli.js at build time. Those bundled libraries still carry
 * attribution obligations, and a hand-maintained list goes stale silently -
 * so this derives the list from what is actually imported and installed.
 *
 *   node scripts/generate-third-party.mjs            rewrite the file
 *   node scripts/generate-third-party.mjs --check    fail if it is out of date
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CHECK = process.argv.includes('--check');
const OUTPUT = 'THIRD-PARTY.md';

/** Full licence texts, keyed by SPDX id. Only licences we actually ship. */
const LICENSE_TEXTS = {
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  ISC: `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
};

/**
 * Discovers which packages the CLI source actually imports. Anything else in
 * devDependencies is build or test tooling and is never shipped.
 */
function findBundledRoots() {
  const roots = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.ts$/.test(entry.name)) continue;
      // Anchored to the start of a line, which is what separates a real import
      // from a string that merely looks like one.
      //
      // src/domain/build-config.ts emits import statements for the *generated*
      // project, so its source contains "import { defineConfig } from 'vite';"
      // as data. Unanchored, this scan read that as the CLI bundling Vite, and
      // pulled postcss and source-map-js into the notices - three packages the
      // CLI does not ship. Emitted strings are always indented inside an
      // expression; real imports and re-exports start their line.
      //
      // The second pattern catches the closing line of a multi-line import,
      // which prettier produces for long specifier lists.
      const source = readFileSync(full, 'utf8');
      const matches = [
        ...source.matchAll(/^[ \t]*(?:import|export)\b[^;\n]*?from\s+'([^']+)'/gm),
        ...source.matchAll(/^\}\s*from\s+'([^']+)'/gm),
      ];
      for (const match of matches) {
        const spec = match[1];
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        // Keep the package name, dropping any deep import path.
        roots.add(
          spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0],
        );
      }
    }
  };
  walk('src');
  return [...roots].sort();
}

function readPackage(name) {
  const file = path.join('node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Walks runtime dependencies transitively - those get bundled too. */
function collect(roots) {
  const seen = new Map();
  const queue = [...roots];

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;

    const pkg = readPackage(name);
    if (!pkg) {
      console.error(`  FAIL  ${name} is imported by src/ but is not installed`);
      process.exitCode = 1;
      continue;
    }

    const author =
      typeof pkg.author === 'string'
        ? pkg.author.replace(/\s*<[^>]*>/, '')
        : (pkg.author?.name ?? '');

    seen.set(name, {
      name,
      version: pkg.version,
      license: pkg.license ?? null,
      author,
      homepage:
        pkg.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '') ?? pkg.homepage ?? '',
    });

    queue.push(...Object.keys(pkg.dependencies ?? {}));
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const roots = findBundledRoots();
const packages = collect(roots);

// Never guess a licence: an unknown one is a hard failure.
const unknown = packages.filter((p) => !p.license || !LICENSE_TEXTS[p.license]);
if (unknown.length > 0) {
  for (const pkg of unknown) {
    console.error(
      `  FAIL  ${pkg.name}@${pkg.version} has licence "${pkg.license ?? 'none declared'}" ` +
        'which this script has no verified text for. Add it deliberately.',
    );
  }
  process.exit(1);
}

const used = [...new Set(packages.map((p) => p.license))].sort();

const rows = packages
  .map((p) => `| [${p.name}](${p.homepage}) | ${p.version} | ${p.license} | ${p.author || '-'} |`)
  .join('\n');

const sections = used
  .map(
    (license) =>
      `## ${license} License\n\nApplies to ${packages
        .filter((p) => p.license === license)
        .map((p) => `\`${p.name}\``)
        .join(', ')}.\n\n\`\`\`\n${LICENSE_TEXTS[license]}\n\`\`\``,
  )
  .join('\n\n');

const content = `# Third-party notices

<!--
  Generated by scripts/generate-third-party.mjs from the installed dependency
  graph. Do not edit by hand - run \`npm run third-party\` instead.
-->

\`create-clientkit\` publishes with \`dependencies: {}\`. The libraries below are
bundled into \`dist/cli.js\` at build time so that \`npm create clientkit@latest\`
costs a single tarball download and no dependency resolution.

Their licences and copyright notices are reproduced here as required.

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
${rows}

${sections}
`;

if (CHECK) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (current.trim() !== content.trim()) {
    console.error(
      `  FAIL  ${OUTPUT} is out of date with the dependency graph. Run \`npm run third-party\`.`,
    );
    process.exit(1);
  }
  console.log(`  ok    ${OUTPUT} matches the dependency graph (${packages.length} packages)`);
} else {
  writeFileSync(OUTPUT, content);
  console.log(`wrote ${OUTPUT} for ${packages.length} bundled package(s):`);
  for (const pkg of packages) console.log(`  ${pkg.name}@${pkg.version} (${pkg.license})`);
}
