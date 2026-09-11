import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Documentation drifts out of date more quietly than code does.
 *
 * 1.0.0 shipped with a README that still said "pre-release (0.1.0) ... not yet
 * published to npm" and a CI matrix labelled "intended coverage rather than
 * observed results". Both were true when written and false by release. The
 * README is what renders on the npm page, so those were the first sentences a
 * prospective user read.
 *
 * These assertions are deliberately about status claims only. They do not
 * police prose, and they scale with the version rather than hard-coding it.
 */
const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string; name: string };
const isStable = Number(pkg.version.split('.')[0]) >= 1;

describe('documentation status claims', () => {
  it('the README does not claim the package is unpublished', () => {
    const readme = read('README.md');
    expect(isStable, 'this guard assumes a stable version; revisit if 1.0.0 is ever yanked').toBe(
      true,
    );

    const stale = [
      /not yet published/i,
      /unpublished/i,
      /\bpre-release\b/i,
      /has not yet executed/i,
      /intended coverage rather than observed/i,
    ];

    for (const pattern of stale) {
      expect(pattern.test(readme), `README carries a stale status claim matching ${pattern}`).toBe(
        false,
      );
    }
  });

  it('the README advertises the real package name and install command', () => {
    const readme = read('README.md');
    expect(readme).toContain(pkg.name);
    expect(readme).toContain('npm create clientkit@latest');
  });

  it('the CHANGELOG records the version in package.json', () => {
    const changelog = read('CHANGELOG.md');
    expect(
      changelog.includes(`## ${pkg.version}`),
      `CHANGELOG.md has no "## ${pkg.version}" heading`,
    ).toBe(true);
  });

  it('the CHANGELOG does not describe the current version as unreleased', () => {
    // Located by plain string scanning rather than a constructed RegExp: the
    // version contains dots, and escaping them into a pattern is exactly the
    // kind of fiddly step that silently produces a matcher looser than
    // intended.
    const heading = read('CHANGELOG.md')
      .split('\n')
      .find((line) => line.startsWith(`## ${pkg.version}`));

    expect(heading, `CHANGELOG.md has no "## ${pkg.version}" heading`).toBeDefined();
    expect(
      /not yet released|prepared, not|unreleased/i.test(heading!),
      `CHANGELOG heading for ${pkg.version} still says it is unreleased: ${heading!}`,
    ).toBe(false);
  });
});
