#!/usr/bin/env node
/**
 * Release preflight: answers "is this package safe to publish?".
 *
 * Runs every gate in order and reports a single verdict. It publishes nothing
 * and needs no credentials - `npm publish` is a separate, deliberate step a
 * human takes after this passes.
 *
 *   node scripts/preflight.mjs              full run
 *   node scripts/preflight.mjs --fast       skip the audit (axe + Lighthouse)
 *   node scripts/preflight.mjs --allow-dirty  skip the clean-tree gate
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FAST = process.argv.includes('--fast');
const ALLOW_DIRTY = process.argv.includes('--allow-dirty');
const WIN = process.platform === 'win32';

const results = [];
let failed = false;

function step(name, fn) {
  const started = Date.now();
  process.stdout.write(`  ${name.padEnd(34)}`);
  try {
    const detail = fn() ?? '';
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`ok    ${seconds}s ${detail}`);
    results.push({ name, ok: true });
  } catch (error) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`FAIL  ${seconds}s`);
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message;
    console.error(output.split('\n').slice(-25).join('\n').replace(/^/gm, '        '));
    results.push({ name, ok: false });
    failed = true;
  }
}

const npmRun = (script) => () => {
  execFileSync(WIN ? 'npm.cmd' : 'npm', ['run', script], {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: WIN,
  });
};

console.log('\ncreate-clientkit release preflight\n');

// --- repository state --------------------------------------------------------

step('working tree clean', () => {
  if (ALLOW_DIRTY) return '(skipped)';
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (status !== '') {
    throw new Error(`uncommitted changes:\n${status}`);
  }
  return '';
});

step('version is publishable', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version)) {
    throw new Error(`version "${pkg.version}" is not valid semver`);
  }
  if (pkg.name !== 'create-clientkit') throw new Error(`unexpected package name ${pkg.name}`);
  if (pkg.license !== 'MIT') throw new Error(`unexpected licence ${pkg.license}`);
  return `v${pkg.version}`;
});

step('author placeholder resolved', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const license = readFileSync('LICENSE', 'utf8');
  const unresolved = [];
  if (/\{\{[A-Z_]+\}\}/.test(pkg.author ?? '')) unresolved.push('package.json author');
  if (/\{\{[A-Z_]+\}\}/.test(license)) unresolved.push('LICENSE copyright holder');
  if (unresolved.length > 0) {
    // Deliberately fatal: publishing with a literal placeholder would ship a
    // licence with no copyright holder.
    throw new Error(`unresolved placeholder in: ${unresolved.join(', ')}`);
  }
  return '';
});

// --- source quality ----------------------------------------------------------

step('typecheck', npmRun('typecheck'));
step('lint', npmRun('lint'));
step('format', npmRun('format:check'));
step('third-party notices current', npmRun('third-party:check'));
step('unit + integration tests', npmRun('test'));
step('build', npmRun('build'));

// --- artifact ----------------------------------------------------------------

step('package contents', npmRun('check:package'));

step(FAST ? 'clean-room smoke' : 'clean-room smoke + audit', () => {
  execFileSync(WIN ? 'npm.cmd' : 'npm', ['run', FAST ? 'smoke' : 'smoke:audit'], {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: WIN,
  });
});

// --- verdict -----------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} gates passed`);

if (failed) {
  console.error('\nPREFLIGHT FAILED - do not publish.');
  process.exit(1);
}

console.log(`
PREFLIGHT PASSED - the package is safe to publish.

Publishing is a separate, deliberate step and is not automated here:

  npm publish --access public --provenance

Provenance requires publishing from a trusted CI workflow with an OIDC
identity (id-token: write), not a long-lived npm token. See RELEASING.md.
`);
