/**
 * Reads the package manifest of a generated project.
 *
 * Until Stage 6 the operator scripts read `templates/astro-tailwind/base/
 * _package.json` and treated it as "what the user gets". That stopped being
 * true when dependencies moved into adapter contributions: the template now
 * carries the project's identity and nothing else, and a script reading it for
 * pins finds an empty object.
 *
 * The honest replacement is the generated output itself, and the golden
 * snapshot *is* the generated output - byte for byte, asserted by the test
 * suite on every run and in CI. So these scripts read pins from the same
 * artifact the compatibility contract is written against, with no build step,
 * no temp directory and no npm install.
 *
 * Every failure here is loud. The bug this replaces was silent: `drift-probe`
 * found zero pins and cheerfully reported that every pin was current.
 */
import { readFileSync } from 'node:fs';

/** The golden that records a full Astro + Tailwind generation. */
export const ASTRO_GOLDEN = 'test/golden/coming-soon-url.txt';

/**
 * Extracts one generated file's contents from a golden snapshot.
 *
 * The format is a `---- <path> ----` header, two metadata lines, a `----`
 * separator, then the contents until the next header.
 */
export function fileFromGolden(goldenPath, filePath) {
  const golden = readFileSync(goldenPath, 'utf8');
  const header = `---- ${filePath} ----`;
  const start = golden.indexOf(header);
  if (start === -1) {
    throw new Error(`${goldenPath} contains no generated "${filePath}".`);
  }

  const afterSeparator = golden.indexOf('\n----\n', start);
  if (afterSeparator === -1) {
    throw new Error(`The "${filePath}" block in ${goldenPath} has no content separator.`);
  }

  const bodyStart = afterSeparator + '\n----\n'.length;
  const next = golden.indexOf('\n---- ', bodyStart);
  return golden.slice(bodyStart, next === -1 ? undefined : next);
}

/**
 * The generated project's `package.json`, parsed.
 *
 * Refuses to return a manifest with no dependencies: that is the exact shape of
 * the failure this module exists to prevent, and a caller asking for pins must
 * never be handed an empty set that looks like a clean result.
 */
export function generatedPackage(goldenPath = ASTRO_GOLDEN) {
  const parsed = JSON.parse(fileFromGolden(goldenPath, 'package.json'));

  const pinned = { ...parsed.dependencies, ...parsed.devDependencies };
  if (Object.keys(pinned).length === 0) {
    throw new Error(
      `The generated package.json in ${goldenPath} declares no dependencies.\n` +
        '  Either package composition is broken, or the golden is stale. Run the test suite.',
    );
  }

  return parsed;
}

/** Every pinned dependency of the generated project, runtime and development alike. */
export function generatedPins(goldenPath = ASTRO_GOLDEN) {
  const parsed = generatedPackage(goldenPath);
  return { ...parsed.dependencies, ...parsed.devDependencies };
}
