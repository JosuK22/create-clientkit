import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { ExecutionError, PlanningError } from '../src/errors.js';
import { apply } from '../src/generate/apply.js';
import {
  assertValidPlan,
  comparePlanPaths,
  isCanonicalPlanPath,
  normalisePlanPath,
  type GenerationPlan,
} from '../src/generate/files.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { summarisePlan } from '../src/ui/plan.js';
import { enumerateCombinations, type Combination } from './accepted-combinations.js';
import { tempDir } from './helpers.js';

/**
 * The Generation Plan boundary: plan first, execute second.
 *
 * The goldens already pin *what* a plan contains for the covered stacks. These
 * tests pin the properties the boundary itself promises, whatever the stack:
 * planning touches nothing, the same input plans the same way, every path is
 * canonical and inside the target, and the executor refuses a plan that is not
 * - even one that never went through the planner.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const registry = createRegistry(TEMPLATES_ROOT);
const { accepted } = enumerateCombinations(adapters);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function scratch(): string {
  const { dir, cleanup } = tempDir('generation-plan');
  cleanups.push(cleanup);
  return dir;
}

function pick(predicate: (combination: Combination) => boolean): Combination {
  const found = accepted.find(predicate);
  if (found === undefined) throw new Error('no accepted combination matches');
  return found;
}

function planFor(combination: Combination, targetDir: string, over: Record<string, unknown> = {}) {
  const manifest = {
    targetDir,
    projectName: 'acme-site',
    framework: combination.framework,
    buildTool: combination.buildTool,
    language: combination.language,
    styling: combination.styling,
    uiLibrary: combination.uiLibrary,
    router: combination.router,
    architecture: combination.architecture,
    starter: combination.starter,
    features: combination.features,
    site: {
      name: 'Acme Ltd',
      url: 'https://acme.example',
      description: 'Bespoke widgets.',
      locale: 'en',
      author: null,
    },
    packageManager: 'npm',
    git: true,
    install: true,
    ...over,
  };
  return planManifest(manifest as never, {
    registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: combination.starter as 'coming-soon' | 'full',
    templateId:
      adapters.framework(combination.framework as never).templateManifest?.id ?? 'astro-tailwind',
  });
}

const REACT = pick((c) => c.framework === 'react' && c.styling === 'tailwind');
const ASTRO = pick((c) => c.framework === 'astro');

function makePlan(targetDir: string, operations: GenerationPlan['operations']): GenerationPlan {
  return { templateId: 'fake', templateVersion: '1.0.0', mode: 'full', targetDir, operations };
}

function listFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(path.join(root, entry.name), relative));
    else out.push(relative);
  }
  return out.sort();
}

describe('plan creation', () => {
  it('describes a whole project without creating anything', () => {
    const targetDir = path.join(scratch(), 'not-yet');
    const { plan } = planFor(REACT, targetDir);

    expect(existsSync(targetDir)).toBe(false);
    expect(plan.targetDir).toBe(targetDir);
    expect(plan.operations.map((operation) => operation.path)).toEqual(
      expect.arrayContaining(['.client-site.json', 'package.json', 'index.html', 'src/main.tsx']),
    );
  });

  it('carries dependencies and scripts in the package.json write, matching the composed view', () => {
    const { plan, composedPackage } = planFor(REACT, '/ck/acme-site');
    const write = plan.operations.find((operation) => operation.path === 'package.json');
    if (write?.type !== 'write' || composedPackage === undefined) throw new Error('unreachable');

    const json = JSON.parse(write.content) as Record<string, Record<string, string>>;
    const declared = { ...json.dependencies, ...json.devDependencies };
    expect(Object.keys(declared).sort()).toEqual(
      composedPackage.dependencies.map((dependency) => dependency.name).sort(),
    );
    expect(Object.keys(json.scripts ?? {}).sort()).toEqual(
      composedPackage.scripts.map((script) => script.name).sort(),
    );
  });

  it('summarises the plan for --debug as counts', () => {
    const { plan, composedPackage } = planFor(REACT, '/ck/acme-site');
    const lines = summarisePlan(plan, composedPackage);
    expect(lines[0]).toMatch(/^\[planner\] \d+ file operations \(\d+ write, \d+ copy\)$/);
    expect(lines[1]).toMatch(/^\[planner\] \d+ dependency operations \(.+\)$/);
    expect(lines[2]).toMatch(/^\[planner\] \d+ script operations$/);
  });
});

describe('determinism', () => {
  it('plans identically twice, for every accepted configuration', { timeout: 60_000 }, () => {
    for (const combination of accepted) {
      const first = planFor(combination, '/ck/acme-site').plan;
      const second = planFor(combination, '/ck/acme-site').plan;
      expect(second, combination.id).toEqual(first);
    }
  });

  it('is plain data: it survives a JSON round trip unchanged', () => {
    const { plan } = planFor(ASTRO, '/ck/acme-site');
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it('orders operations by the pinned path comparator', { timeout: 60_000 }, () => {
    for (const combination of accepted) {
      const paths = planFor(combination, '/ck/acme-site').plan.operations.map((o) => o.path);
      expect(paths, combination.id).toEqual([...paths].sort(comparePlanPaths));
    }
  });

  it('keeps the order every golden records: dotfiles, then case-insensitive', () => {
    const paths = ['src/main.tsx', 'README.md', 'public/favicon.svg', '.gitignore', 'index.html'];
    expect([...paths].sort(comparePlanPaths)).toEqual([
      '.gitignore',
      'index.html',
      'public/favicon.svg',
      'README.md',
      'src/main.tsx',
    ]);
  });
});

describe('path normalisation', () => {
  it.each([
    ['src/pages/index.astro', 'src/pages/index.astro'],
    ['src\\pages\\index.astro', 'src/pages/index.astro'],
    ['./src/index.css', 'src/index.css'],
    ['src//index.css', 'src/index.css'],
    ['src/./index.css', 'src/index.css'],
    ['..env', '..env'],
  ])('%s -> %s', (input, expected) => {
    expect(normalisePlanPath(input)).toBe(expected);
  });

  it('every path in every accepted plan is already canonical', { timeout: 60_000 }, () => {
    for (const combination of accepted) {
      for (const operation of planFor(combination, '/ck/acme-site').plan.operations) {
        expect(isCanonicalPlanPath(operation.path), `${combination.id}: ${operation.path}`).toBe(
          true,
        );
      }
    }
  });
});

describe('path traversal protection', () => {
  it.each([
    '../outside.txt',
    '../../some-file',
    '../../../etc/file',
    'src/../../escape.txt',
    '..\\..\\windows.txt',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    'c:relative-to-drive.txt',
    '',
    '.',
    './',
    'a\0b',
  ])('refuses %j while planning', (input) => {
    expect(() => normalisePlanPath(input)).toThrow(PlanningError);
    expect(isCanonicalPlanPath(input)).toBe(false);
  });

  it('refuses a plan with a non-canonical path', () => {
    const plan = makePlan('/ck/site', [
      { type: 'write', path: 'src//index.css', content: '', origin: 'test' },
    ]);
    expect(() => assertValidPlan(plan)).toThrow(/not in canonical form/);
  });

  it('refuses a plan that names one path twice', () => {
    const plan = makePlan('/ck/site', [
      { type: 'write', path: 'a.txt', content: '1', origin: 'first' },
      { type: 'write', path: 'a.txt', content: '2', origin: 'second' },
    ]);
    expect(() => assertValidPlan(plan)).toThrow(PlanningError);
  });

  it('reports planning failures as PlanningError, message unchanged', () => {
    // React composes its global stylesheet, so it cannot be planned without a
    // styling system. The compatibility engine already refuses that; the
    // refusal is now classified at the planner boundary, wording untouched.
    let caught: unknown;
    try {
      planFor(REACT, '/ck/acme-site', { styling: 'none', uiLibrary: 'none' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlanningError);
    expect((caught as PlanningError).message).toBe('That combination will not work.');
    expect((caught as PlanningError).hint).toBeTruthy();
  });
});

describe('executor', () => {
  it('writes exactly what the plan describes', () => {
    const targetDir = path.join(scratch(), 'site');
    const { plan } = planFor(ASTRO, targetDir);

    const result = apply(plan);

    expect(listFiles(targetDir)).toEqual(plan.operations.map((o) => o.path).sort());
    for (const operation of plan.operations) {
      const onDisk = path.join(targetDir, ...operation.path.split('/'));
      const expected =
        operation.type === 'write' ? operation.content : readFileSync(operation.source, 'utf8');
      expect(readFileSync(onDisk, 'utf8'), operation.path).toBe(expected);
    }
    expect(result.written).toEqual(plan.operations.map((o) => o.path));
  });

  it.each(['../escape.txt', 'a/../../escape.txt', '/abs.txt', 'src\\..\\..\\escape.txt'])(
    'refuses %j at the mutation boundary, writing nothing',
    (unsafe) => {
      const parent = scratch();
      const targetDir = path.join(parent, 'site');
      const plan = makePlan(targetDir, [
        { type: 'write', path: 'ok.txt', content: 'fine\n', origin: 'test' },
        { type: 'write', path: unsafe, content: 'escaped\n', origin: 'test' },
      ]);

      expect(() => apply(plan)).toThrow(ExecutionError);
      expect(readdirSync(parent)).toEqual([]);
      expect(existsSync(path.join(parent, 'escape.txt'))).toBe(false);
    },
  );

  it('reports a filesystem failure as ExecutionError', () => {
    const targetDir = path.join(scratch(), 'site');
    const plan = makePlan(targetDir, [
      { type: 'copy', path: 'missing.bin', source: path.join(targetDir, 'nope'), origin: 'test' },
    ]);
    expect(() => apply(plan)).toThrow(ExecutionError);
    expect(existsSync(targetDir)).toBe(false);
  });
});
