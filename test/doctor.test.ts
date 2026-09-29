import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAdapterRegistry } from '../src/adapters/registry.js';
import { parseCliArgs } from '../src/args.js';
import { main } from '../src/cli.js';
import { runDoctor } from '../src/commands/doctor.js';
import { detectProject } from '../src/detect/detect.js';
import { resolveDetectedStack } from '../src/detect/stack.js';
import { diagnoseProject, type DoctorCheck, type DoctorReport } from '../src/doctor/diagnose.js';
import { findTemplatesRoot } from '../src/templates/registry.js';
import { helpText } from '../src/ui/help.js';
import { tempDir, testLogger } from './helpers.js';

/**
 * Project doctor: a diagnosis of the detection, never a second detection.
 *
 * Fixtures are file maps written to a fresh temporary directory, as the
 * detection suite's read-only and CLI tests do. Each test's directory is
 * removed by the helper that created it, and by nothing else.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function writeProject(files: Record<string, string>): string {
  const { dir, cleanup } = tempDir('doctor');
  cleanups.push(cleanup);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

const deps = (dependencies: Record<string, string>, devDependencies: Record<string, string> = {}) =>
  JSON.stringify({ name: 'fixture', dependencies, devDependencies });

function diagnose(files: Record<string, string>): DoctorReport {
  const detection = detectProject({ root: writeProject(files) });
  return diagnoseProject(detection, resolveDetectedStack(detection, adapters));
}

function checkOf(report: DoctorReport, id: DoctorCheck['id']): DoctorCheck {
  const found = report.checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no ${id} check`);
  return found;
}

/** A stack ClientKit supports, with a lockfile: nothing to say. */
const HEALTHY = {
  'package.json': deps(
    { react: '19', 'react-router-dom': '7' },
    { vite: '7', typescript: '5', tailwindcss: '4' },
  ),
  'tsconfig.json': '{}',
  'pnpm-lock.yaml': '',
};

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

describe('a healthy project', () => {
  it('has no errors and no warnings, and every check in order', () => {
    const report = diagnose(HEALTHY);
    expect(report.status).toBe('healthy');
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.checks.map((entry) => entry.id)).toEqual([
      'project',
      'framework',
      'buildTool',
      'language',
      'styling',
      'uiLibrary',
      'router',
      'packageManager',
      'compatibility',
    ]);
    expect(checkOf(report, 'compatibility').summary).toBe('supported');
  });

  it('agrees with detect: every stack detect resolves, doctor passes', () => {
    const detection = detectProject({ root: writeProject(HEALTHY) });
    const stack = resolveDetectedStack(detection, adapters);
    expect(stack.status).toBe('resolved');
    expect(checkOf(diagnoseProject(detection, stack), 'compatibility').severity).toBe('pass');
  });
});

describe('unsupported, unknown and ambiguous stay distinct', () => {
  it('reports an unsupported framework as an error, by name, with evidence', () => {
    const report = diagnose({ 'package.json': deps({ vue: '3' }) });
    const framework = checkOf(report, 'framework');
    expect(framework).toMatchObject({
      severity: 'error',
      summary: 'Vue (not supported)',
      details: ['ClientKit does not currently support Vue.'],
      evidence: [{ source: 'package.json', path: 'package.json', detail: 'dependencies.vue' }],
    });
    expect(checkOf(report, 'compatibility')).toMatchObject({
      severity: 'error',
      details: ['Vue is not a framework ClientKit supports.'],
    });
    expect(report.status).toBe('error');
  });

  it('refuses a named-but-unimplemented framework under compatibility, in the resolver’s words', () => {
    const report = diagnose({ 'package.json': deps({ '@angular/core': '20' }) });
    expect(checkOf(report, 'framework')).toMatchObject({ severity: 'pass', summary: 'angular' });
    expect(checkOf(report, 'compatibility')).toMatchObject({
      severity: 'error',
      details: ['ClientKit does not support framework "angular" yet.'],
    });
  });

  it('reports no framework found as a warning, never as unsupported', () => {
    const report = diagnose({ 'package.json': deps({ lodash: '4' }) });
    expect(checkOf(report, 'framework')).toMatchObject({
      severity: 'warning',
      summary: 'none found',
    });
    expect(checkOf(report, 'compatibility')).toMatchObject({
      severity: 'warning',
      summary: 'could not be determined',
    });
    expect(report.status).toBe('warning');
    expect(report.errors).toBe(0);
  });

  it('reports an ambiguous framework explicitly and picks neither', () => {
    const framework = checkOf(
      diagnose({ 'package.json': deps({ astro: '5', next: '15' }) }),
      'framework',
    );
    expect(framework).toMatchObject({ severity: 'error', summary: 'ambiguous: astro, nextjs' });
    expect(framework.evidence.map((entry) => entry.detail)).toEqual([
      'dependencies.astro',
      'dependencies.next',
    ]);
  });

  it('reports two styling systems as ambiguous', () => {
    const report = diagnose({
      'package.json': deps({ react: '19' }, { vite: '7', tailwindcss: '4', bootstrap: '5' }),
    });
    expect(checkOf(report, 'styling')).toMatchObject({
      severity: 'error',
      summary: 'ambiguous: bootstrap, tailwind',
    });
  });
});

describe('package manager', () => {
  it('warns about two lockfiles, lists both, and exits cleanly', () => {
    const report = diagnose({ ...HEALTHY, 'package-lock.json': '' });
    const pm = checkOf(report, 'packageManager');
    expect(pm).toMatchObject({ severity: 'warning', summary: 'multiple lockfiles' });
    expect(pm.evidence.map((entry) => entry.path)).toEqual(['package-lock.json', 'pnpm-lock.yaml']);
    expect(pm.hint).toBe('Keep the lockfile for the package manager this project actually uses.');
    expect(report.status).toBe('warning');
    expect(report.errors).toBe(0);
  });

  it('explains a packageManager field that disagrees with the lockfile', () => {
    const report = diagnose({
      ...HEALTHY,
      'package.json': JSON.stringify({
        ...JSON.parse(HEALTHY['package.json']),
        packageManager: 'yarn@4.1.0',
      }),
    });
    const pm = checkOf(report, 'packageManager');
    expect(pm).toMatchObject({
      severity: 'warning',
      summary: 'packageManager field and lockfile disagree',
    });
    expect(pm.evidence.map((entry) => entry.detail)).toEqual([
      'packageManager yarn@4.1.0',
      'lockfile',
    ]);
    expect(pm.hint).toMatch(/"packageManager" field and the lockfile agree/);
  });

  it('calls field plus two lockfiles conflicting evidence', () => {
    const pm = checkOf(
      diagnose({
        ...HEALTHY,
        'package.json': JSON.stringify({
          ...JSON.parse(HEALTHY['package.json']),
          packageManager: 'pnpm@9',
        }),
        'package-lock.json': '',
        'yarn.lock': '',
      }),
      'packageManager',
    );
    expect(pm.summary).toBe('conflicting evidence');
  });

  it('is information, not a problem, when nothing records one yet', () => {
    const { 'pnpm-lock.yaml': _lock, ...noLock } = HEALTHY;
    const report = diagnose(noLock);
    expect(checkOf(report, 'packageManager')).toMatchObject({
      severity: 'info',
      summary: 'none recorded',
    });
    expect(report.status).toBe('healthy');
  });
});

describe('project metadata', () => {
  it('diagnoses an empty directory gracefully', () => {
    const report = diagnose({});
    expect(report.checks.map((entry) => entry.id)).toEqual(['project', 'compatibility']);
    expect(checkOf(report, 'project')).toMatchObject({
      severity: 'warning',
      summary: 'empty directory',
    });
    expect(report.errors).toBe(0);
  });

  it('diagnoses a missing package.json, keeping what was still found', () => {
    const report = diagnose({ 'index.html': '<p>', 'tsconfig.json': '{}', 'yarn.lock': '' });
    expect(checkOf(report, 'project')).toMatchObject({
      severity: 'warning',
      summary: 'no package.json',
    });
    // Only dimensions with an answer are shown; the six "unknown"s are one fact.
    expect(report.checks.map((entry) => entry.id)).toEqual([
      'project',
      'language',
      'packageManager',
      'compatibility',
    ]);
    expect(report.errors).toBe(0);
  });

  it.each([
    ['{ not json', /not valid JSON/],
    ['[1, 2]', /does not contain a JSON object/],
  ])('reports a malformed package.json as an error: %s', (content, reason) => {
    const report = diagnose({ 'package.json': content });
    const project = checkOf(report, 'project');
    expect(project.severity).toBe('error');
    expect(project.details[0]).toMatch(reason);
    expect(report.status).toBe('error');
  });

  it('warns about a package.json block that had to be ignored', () => {
    const report = diagnose({
      'package.json': JSON.stringify({ name: 'x', dependencies: ['react'] }),
    });
    expect(checkOf(report, 'project')).toMatchObject({
      severity: 'warning',
      details: ['package.json "dependencies" is not an object, so it was ignored.'],
    });
  });

  it('notes ClientKit provenance as information, not as a problem', () => {
    const report = diagnose({ ...HEALTHY, '.client-site.json': '{}' });
    expect(checkOf(report, 'project').severity).toBe('pass');
    expect(checkOf(report, 'provenance').severity).toBe('info');
    expect(report.status).toBe('healthy');
  });
});

describe('what the resolver supplied', () => {
  it('warns about a partial project whose build tool ClientKit had to assume', () => {
    const report = diagnose({
      'package.json': deps({ react: '19', bootstrap: '5' }),
      'tsconfig.json': '{}',
    });
    const buildTool = checkOf(report, 'buildTool');
    expect(buildTool).toMatchObject({ severity: 'warning', summary: 'none found' });
    expect(buildTool.details.join(' ')).toContain('ClientKit would assume vite');
    // A default is never presented as detected evidence.
    expect(buildTool.evidence).toEqual([]);
    expect(checkOf(report, 'compatibility').severity).toBe('pass');
  });

  it('does not warn about what the framework decides for itself', () => {
    const report = diagnose({
      'package.json': deps({ next: '15', react: '19' }, { typescript: '5' }),
    });
    expect(checkOf(report, 'router')).toMatchObject({
      severity: 'pass',
      summary: 'file-based',
      evidence: [],
    });
    expect(report.warnings).toBe(0);
  });

  it('reads no styling library as none, with no evidence', () => {
    const report = diagnose({
      'package.json': deps({ next: '15', react: '19' }, { typescript: '5' }),
    });
    expect(checkOf(report, 'styling')).toMatchObject({
      severity: 'info',
      summary: 'none found',
      evidence: [],
    });
  });
});

describe('determinism', () => {
  const RICH = {
    ...HEALTHY,
    'package.json': deps(
      { react: '19', 'react-router-dom': '7', '@mui/material': '7', antd: '5' },
      { vite: '7', typescript: '5', tailwindcss: '4', bootstrap: '5' },
    ),
    'package-lock.json': '',
    'yarn.lock': '',
  };

  it('produces an equal report on repeated runs', () => {
    const detection = detectProject({ root: writeProject(RICH) });
    const stack = resolveDetectedStack(detection, adapters);
    const first = diagnoseProject(detection, stack);
    for (let run = 0; run < 5; run += 1) {
      expect(diagnoseProject(detection, resolveDetectedStack(detection, adapters))).toEqual(first);
    }
  });

  it('never consults locale-sensitive comparison', () => {
    const detection = detectProject({ root: writeProject(RICH) });
    const expected = diagnoseProject(detection, resolveDetectedStack(detection, adapters));
    const compare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('localeCompare used');
    });
    const collator = vi.spyOn(Intl, 'Collator').mockImplementation(() => {
      throw new Error('Intl.Collator used');
    });
    try {
      expect(diagnoseProject(detection, resolveDetectedStack(detection, adapters))).toEqual(
        expected,
      );
    } finally {
      compare.mockRestore();
      collator.mockRestore();
    }
  });
});

describe('architecture', () => {
  it('diagnoses from the detection alone: no filesystem, no registry, no second detector', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'doctor', 'diagnose.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from 'node:/);
    expect(source).not.toMatch(/adapters\//);
    expect(source).not.toMatch(/signatures/);
    expect(source).not.toMatch(/detectProject\(/);
  });
});

// ---------------------------------------------------------------------------
// Read-only, and the command
// ---------------------------------------------------------------------------

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stats = statSync(full);
        out[path.relative(root, full)] =
          `${stats.size}:${stats.mtimeMs}:${readFileSync(full, 'base64')}`;
      }
    }
  };
  walk(root);
  return out;
}

describe('read-only', () => {
  it.each([
    ['healthy', HEALTHY],
    ['warning', { ...HEALTHY, 'package-lock.json': '{"lockfileVersion":3}' }],
    ['error', { 'package.json': '{ "name": "broken", ', 'yarn.lock': '# yarn' }],
  ])('changes no file, content or timestamp, and creates nothing: %s', async (_label, files) => {
    const dir = writeProject({ ...files, 'node_modules/react/package.json': '{}' });
    const before = snapshot(dir);
    const parentBefore = readdirSync(path.dirname(dir)).sort();

    const { logger } = testLogger();
    await main(['doctor', dir], { logger });

    expect(snapshot(dir)).toEqual(before);
    expect(readdirSync(path.dirname(dir)).sort()).toEqual(parentBefore);
  });
});

describe('the doctor command', () => {
  it('reports a healthy project and exits 0', async () => {
    const dir = writeProject(HEALTHY);
    const { logger, out, err } = testLogger();
    expect(await main(['doctor', dir], { logger, cwd: path.dirname(dir) })).toBe(0);
    const text = plain(out.text);
    expect(text).toContain('ClientKit doctor');
    expect(text).toMatch(/\* Framework\s+react/);
    expect(text).toMatch(/\* Compatibility\s+supported/);
    expect(text).toContain('No issues found.');
    // Passes stay one line: detect's evidence is not repeated.
    expect(text).not.toContain('Evidence:');
    expect(plain(err.text)).toContain('Diagnosis complete. Nothing was changed.');
  });

  it('exits 0 with warnings, showing evidence and a hint', async () => {
    const dir = writeProject({ ...HEALTHY, 'package-lock.json': '' });
    const { logger, out } = testLogger();
    expect(await main(['doctor', dir], { logger })).toBe(0);
    const text = plain(out.text);
    expect(text).toMatch(/! Package manager\s+multiple lockfiles/);
    expect(text).toMatch(/Evidence:\n\s+package-lock\.json\n\s+pnpm-lock\.yaml/);
    expect(text).toContain('Hint: Keep the lockfile');
    expect(text).toContain('1 warning found.');
  });

  it('exits 2 for an unsupported project, and says why', async () => {
    const dir = writeProject({ 'package.json': deps({ vue: '3' }) });
    const { logger, out } = testLogger();
    expect(await main(['doctor', dir], { logger })).toBe(2);
    const text = plain(out.text);
    expect(text).toMatch(/x Framework\s+Vue \(not supported\)/);
    expect(text).toContain('package.json: dependencies.vue');
    expect(text).toMatch(/2 errors, 1 warning found\./);
  });

  it('lays a multi-line compatibility report out under its hint', async () => {
    const dir = writeProject({
      'package.json': deps({ react: '19' }, { vite: '7', typescript: '5' }),
    });
    const { logger, out } = testLogger();
    expect(await main(['doctor', dir], { logger })).toBe(2);
    const text = plain(out.text);
    expect(text).toMatch(/Hint:\n {8}- React requires/);
    expect(text.split('\n').some((line) => line !== '' && line.trim() === '')).toBe(false);
  });

  it('defaults to the working directory, and accepts "."', async () => {
    const dir = writeProject(HEALTHY);
    for (const argv of [['doctor'], ['doctor', '.']]) {
      const { logger, out } = testLogger();
      expect(await main(argv, { logger, cwd: dir })).toBe(0);
      expect(plain(out.text)).toMatch(/Directory\s+\./);
    }
  });

  it('accepts a relative directory', async () => {
    const dir = writeProject(HEALTHY);
    const { logger, out } = testLogger();
    expect(
      await main(['doctor', `./${path.basename(dir)}`], { logger, cwd: path.dirname(dir) }),
    ).toBe(0);
    expect(plain(out.text)).toContain(`Directory         ${path.basename(dir)}`);
  });

  it('exits 2 for a missing directory or a file, naming doctor in the hint', async () => {
    const dir = writeProject({ 'file.txt': 'x' });
    for (const target of [path.join(dir, 'missing'), path.join(dir, 'file.txt')]) {
      const { logger, err } = testLogger();
      expect(await main(['doctor', target], { logger })).toBe(2);
      expect(plain(err.text)).toMatch(/does not exist|is not a directory/);
    }
    const { logger, err } = testLogger();
    await main(['doctor', path.join(dir, 'missing')], { logger });
    expect(plain(err.text)).toContain('create-clientkit doctor ./my-site');
  });

  it('keeps detect’s own hint for a missing directory', async () => {
    const dir = writeProject({});
    const { logger, err } = testLogger();
    expect(await main(['detect', path.join(dir, 'missing')], { logger })).toBe(2);
    expect(plain(err.text)).toContain('create-clientkit detect ./my-site');
  });

  it('refuses generation options rather than ignoring them', () => {
    const { logger } = testLogger();
    const flags = parseCliArgs(['doctor', '.', '--framework', 'react', '--yes']);
    expect(() => runDoctor({ flags, logger, cwd: process.cwd() })).toThrow(
      'doctor does not take --framework, --yes.',
    );
  });

  it('has no --fix: an unknown flag is refused', async () => {
    const { logger } = testLogger();
    expect(await main(['doctor', '--fix'], { logger })).toBe(2);
  });

  it('prints debug diagnostics only with --debug, and no environment', async () => {
    const dir = writeProject(HEALTHY);
    const quiet = testLogger();
    await main(['doctor', dir], { logger: quiet.logger });
    expect(plain(quiet.err.text)).not.toContain('doctor checks=');

    const loud = testLogger();
    await main(['doctor', dir, '--debug'], { logger: loud.logger });
    const text = plain(loud.err.text);
    expect(text).toContain('doctor checks=9 errors=0 warnings=0');
    expect(text).not.toMatch(/PATH=|HOME=/);
  });

  it('is a typed command; ./doctor still names a directory to create', () => {
    expect(parseCliArgs(['doctor', './site'])).toMatchObject({
      command: 'doctor',
      positionals: ['./site'],
    });
    expect(parseCliArgs(['./doctor'])).toMatchObject({
      command: 'create',
      positionals: ['./doctor'],
    });
  });

  it('is documented in --help, beside detect', async () => {
    expect(helpText()).toContain('doctor [directory]');
    const { logger, out } = testLogger();
    expect(await main(['doctor', '--help'], { logger })).toBe(0);
    expect(out.text).toContain('doctor [directory]');
  });
});
