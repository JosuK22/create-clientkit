#!/usr/bin/env node
/**
 * Probes whether the generated template would still work on today's latest
 * ecosystem versions.
 *
 * This is a warning system, not an upgrade mechanism. It never touches the
 * pins in templates/astro-tailwind/base/_package.json - it generates a project
 * into a temporary directory, upgrades that copy, and reports what happens.
 *
 *   node scripts/drift-probe.mjs --report   print pinned vs latest, exit 0
 *   node scripts/drift-probe.mjs            probe; non-zero if latest breaks
 *   node scripts/drift-probe.mjs --force    probe even when nothing is behind
 *   node scripts/drift-probe.mjs --simulate-drift <pkg>@<version>
 *
 * --simulate-drift exists because the interesting branch - "something is
 * actually behind" - only executes when the ecosystem happens to have moved.
 * Left to chance, the upgrade-and-rebuild path can sit untested for months and
 * then fail on the one morning it matters.
 *
 * It overrides what this script *believes* the latest version to be, for the
 * named package only. It does not change a pin, does not write to the
 * template, and does not contact a different registry. Point it at a real
 * published version adjacent to the pin and the whole path runs for real:
 * drift detected -> project generated -> copy upgraded -> astro check ->
 * build -> report.
 *
 *   node scripts/drift-probe.mjs --simulate-drift tailwindcss@4.3.2
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ASTRO_GOLDEN, generatedPins } from './lib/generated-package.mjs';

const REPORT_ONLY = process.argv.includes('--report');
// Runs the probe even when nothing is behind, so the machinery itself can be
// exercised on demand rather than only when the ecosystem happens to move.
const FORCE = process.argv.includes('--force');

/**
 * Parsed `--simulate-drift <pkg>@<version>` pairs, as a name -> version map.
 *
 * Deliberately parsed strictly: a malformed argument is a hard error rather
 * than a silently ignored flag, because silently probing the real versions
 * while believing a simulation ran is the one outcome worth preventing.
 */
const SIMULATED = {};
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] !== '--simulate-drift') continue;
  const spec = process.argv[i + 1];
  const at = spec === undefined ? -1 : spec.lastIndexOf('@');
  if (at === undefined || at <= 0) {
    console.error(`--simulate-drift needs <pkg>@<version>, got: ${spec ?? '(nothing)'}`);
    process.exit(2);
  }
  SIMULATED[spec.slice(0, at)] = spec.slice(at + 1);
}
const SIMULATING = Object.keys(SIMULATED).length > 0;

/**
 * Pins held back on purpose, with the reason. The probe reports these but does
 * not fail on them - a deliberate decision should not produce a weekly alert.
 * Remove an entry when the blocking constraint is gone.
 */
const HELD = {
  typescript:
    '@astrojs/check peers typescript ^5 || ^6; TypeScript 7 is not yet supported by Astro tooling',
};
const WIN = process.platform === 'win32';
const repoRoot = process.cwd();

const npm = (args, cwd) =>
  execFileSync(WIN ? 'npm.cmd' : 'npm', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: WIN,
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
  });

// The pins live in the adapter contributions now, not the template. This reads
// them from the generated project, which is what they actually affect.
const pinned = generatedPins(path.join(repoRoot, ASTRO_GOLDEN));
const names = Object.keys(pinned).sort();

// --- report -------------------------------------------------------------------

const latest = {};
for (const name of names) {
  latest[name] = npm(['view', name, 'version'], repoRoot).trim();
}

for (const [name, version] of Object.entries(SIMULATED)) {
  if (!(name in latest)) {
    console.error(
      `--simulate-drift names "${name}", which the template does not depend on.\n` +
        `  known: ${names.join(', ')}`,
    );
    process.exit(2);
  }
  latest[name] = version;
}

if (SIMULATING) {
  console.log(`
  SIMULATION - not a real drift report.

  The "latest" column below is overridden for: ${Object.entries(SIMULATED)
    .map(([n, v]) => `${n}@${v}`)
    .join(', ')}

  Nothing is pinned, written or published differently because of this. The
  point is to run the upgrade-and-rebuild path on demand instead of waiting
  for the ecosystem to move.`);
}

console.log('\n  package                pinned      latest      status');
console.log('  ' + '-'.repeat(58));
let drifted = 0;
const probeable = [];
for (const name of names) {
  const behind = pinned[name] !== latest[name];
  const held = HELD[name] !== undefined;
  if (behind && !held) {
    drifted += 1;
    probeable.push(name);
  }
  const status = !behind ? 'current' : held ? 'held' : 'behind';
  console.log(
    `  ${name.padEnd(22)} ${pinned[name].padEnd(11)} ${latest[name].padEnd(11)} ${status}`,
  );
}
console.log(`\n  ${drifted} pinned dependencies are behind latest and not held`);
for (const [name, reason] of Object.entries(HELD)) {
  console.log(`  held: ${name} - ${reason}`);
}

if (REPORT_ONLY) {
  console.log('\n  (report only - the pins are unchanged and no probe was run)');
  process.exit(0);
}

if (drifted === 0 && !FORCE) {
  console.log('\n  nothing to probe: every pin is current or deliberately held');
  process.exit(0);
}

// --- probe ---------------------------------------------------------------------

const workspace = mkdtempSync(path.join(tmpdir(), 'ck-drift-'));
const project = path.join(workspace, 'probe');

try {
  console.log('\n  generating a project with the pinned template...');
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'bin', 'cli.js'),
      'probe',
      '--yes',
      '--no-install',
      '--no-git',
      '--name',
      'Drift Probe',
      '--url',
      'https://probe.example',
    ],
    { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
  );

  console.log('  upgrading the generated copy to latest...');
  // Held pins keep their pinned version so the probe tests a combination that
  // is actually intended to work.
  const upgrades = names.map(
    (name) => `${name}@${HELD[name] === undefined ? latest[name] : pinned[name]}`,
  );
  console.log(`  upgrade set: ${upgrades.join(' ')}`);
  npm(['install', ...upgrades, '--no-fund', '--no-audit'], project);

  const failures = [];
  for (const [label, args] of [
    ['astro check', ['run', 'check']],
    ['astro build', ['run', 'build']],
  ]) {
    try {
      npm(args, project);
      console.log(`  ok    ${label} on latest`);
    } catch (error) {
      const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`
        .trim()
        .split('\n')
        .slice(-20)
        .join('\n');
      failures.push(`${label} failed on latest:\n${detail}`);
      console.error(`  FAIL  ${label} on latest\n${detail.replace(/^/gm, '        ')}`);
    }
  }

  if (failures.length > 0) {
    console.error(`
  The template does NOT build against the latest versions.

  The published pins are unchanged and the released package is unaffected.
  Investigate before moving any pin:
${probeable.map((n) => `    ${n}: ${pinned[n]} -> ${latest[n]}`).join('\n')}
`);
    process.exit(1);
  }

  console.log(
    SIMULATING
      ? `
  SIMULATED drift probe completed: the generated project upgraded, type-checked
  and built against the simulated versions.

  This proves the probe path works. It says nothing about the real ecosystem -
  run without --simulate-drift for that. No pin was changed.
`
      : `
  The template builds cleanly against the latest versions.
  The pins are still deliberate - upgrade them in a reviewed commit, not here.
`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
