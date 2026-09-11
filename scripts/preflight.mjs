#!/usr/bin/env node
/**
 * Release preflight: answers "is this package safe to publish?".
 *
 * Runs every gate in order and reports a single verdict. It publishes nothing
 * and needs no credentials - releasing is a separate, deliberate step a human
 * takes after this passes.
 *
 *   node scripts/preflight.mjs              full run
 *   node scripts/preflight.mjs --fast       skip the audit (axe + Lighthouse)
 *   node scripts/preflight.mjs --allow-dirty  skip the clean-tree gate
 *   node scripts/preflight.mjs --skip-if-verified   see below
 *
 * --skip-if-verified exists because the release workflow would otherwise run
 * every gate twice: once as its own step, and again when `npm stage publish`
 * fires `prepublishOnly`.
 *
 * It is not a bypass. A full passing run stamps the shasum of the tarball npm
 * would produce, and the skip applies only when the tarball npm would produce
 * *now* has that same shasum - meaning the exact bytes headed for the registry
 * have already been through every gate. Any difference at all (a source edit,
 * a hand-modified dist/, a version bump, a different machine, a missing stamp)
 * fails the comparison and runs the gates in full.
 *
 * A --fast or --allow-dirty run never stamps: those skip real gates, so their
 * verdict must not stand in for a complete one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FAST = process.argv.includes('--fast');
const ALLOW_DIRTY = process.argv.includes('--allow-dirty');
const SKIP_IF_VERIFIED = process.argv.includes('--skip-if-verified');
const WIN = process.platform === 'win32';

/** Gitignored: node_modules is already ignored, and `npm ci` clears it. */
const STAMP_FILE = path.join('node_modules', '.cache', 'clientkit', 'preflight-stamp.json');

/**
 * The shasum of the tarball `npm publish` would upload, without writing one.
 *
 * Verified reproducible: repeated calls agree, and a stray .tgz in the repo
 * root does not perturb it because `files` is an explicit allow-list.
 */
function packFingerprint() {
  const out = execFileSync(WIN ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: WIN,
  });
  const entry = JSON.parse(out)[0];
  return { shasum: entry.shasum, files: entry.entryCount, size: entry.size };
}

function readStamp() {
  if (!existsSync(STAMP_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STAMP_FILE, 'utf8'));
  } catch {
    return null; // a corrupt stamp is simply no stamp
  }
}

function writeStamp(fingerprint, version) {
  mkdirSync(path.dirname(STAMP_FILE), { recursive: true });
  writeFileSync(
    STAMP_FILE,
    `${JSON.stringify({ ...fingerprint, version, at: new Date().toISOString() }, null, 2)}\n`,
  );
}

if (SKIP_IF_VERIFIED) {
  const stamp = readStamp();
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  let current = null;
  try {
    current = packFingerprint();
  } catch {
    // Leave it null: if the artifact cannot be fingerprinted it cannot be
    // shown to match, so the gates run in full. That is the safe direction.
  }

  if (stamp && current && stamp.shasum === current.shasum && stamp.version === version) {
    console.log(`
preflight: skipped - these exact bytes already passed.

  tarball shasum : ${current.shasum}
  files / size   : ${current.files} / ${current.size} B
  verified at    : ${stamp.at}

The full gate ran earlier against an identical artifact. Change anything at all
and this runs again automatically.
`);
    process.exit(0);
  }

  if (stamp && current && stamp.shasum !== current.shasum) {
    console.log('preflight: the artifact changed since it was last verified - running in full.\n');
  }
}

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

// Only a complete run earns a stamp. --fast skips the audit and --allow-dirty
// skips the clean-tree gate, so neither verdict may stand in for a full one.
if (!FAST && !ALLOW_DIRTY) {
  try {
    const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
    writeStamp(packFingerprint(), pkgVersion);
  } catch (error) {
    // Never fail a passing preflight over a cache write - the only cost is
    // that the next publish re-runs the gates, which is the safe direction.
    console.error(`  (could not record the preflight stamp: ${error.message})`);
  }
}

console.log(`
PREFLIGHT PASSED - the package is safe to publish.

Publishing is a separate, deliberate step and is not automated here. Tagging
is what starts it:

  git tag v<version> && git push --follow-tags

CI then stages the release with provenance, using trusted publishing (OIDC)
rather than a long-lived npm token. Staging is not public. A maintainer makes
it live:

  npm stage list create-clientkit
  npm stage approve <stage-id>          # prompts for 2FA

Approval cannot be automated - it requires proof of presence and rejects OIDC
tokens, which is the point. See RELEASING.md.
`);
