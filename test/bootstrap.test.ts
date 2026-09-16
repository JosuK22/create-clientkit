import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_DECLARATION } from '../src/adapters/bootstrap.js';
import { assertRequiredRoles, planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { REACT_DECLARATION } from '../src/adapters/react.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import { TAILWIND_DECLARATION } from '../src/adapters/tailwind.js';
import { VITE_DECLARATION } from '../src/adapters/vite.js';
import type { AdapterDeclaration, ProjectManifest, StylingId } from '../src/domain/index.js';
import { evaluateCombination } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * Bootstrap, and the styling dimension.
 *
 * The claim under test is not "Bootstrap works". It is that a second styling
 * system was added without the React adapter or the Vite adapter learning it
 * exists - so that `React + Vite + Tailwind` and `React + Vite + Bootstrap` are
 * two compositions of the same four independent adapters rather than two
 * products.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const manifest = (styling: StylingId, over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-app'),
  projectName: 'acme-app',
  framework: 'react',
  buildTool: 'vite',
  language: 'ts',
  styling,
  uiLibrary: 'none',
  router: 'none',
  architecture: 'react-standard',
  starter: 'coming-soon',
  features: [],
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
});

const planFor = (styling: StylingId, over: Partial<ProjectManifest> = {}) =>
  planManifest(manifest(styling, over), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: over.starter ?? 'coming-soon',
  });

// ---------------------------------------------------------------------------

describe('Bootstrap is a styling adapter, nothing more', () => {
  it('occupies the styling dimension, not the UI library one', () => {
    expect(BOOTSTRAP_DECLARATION.kind).toBe('styling');
    // React Bootstrap and friends are component libraries and are not this.
    expect(adapters.implementedStyling()).toContain('bootstrap');
  });

  it('requires only what is technically true', () => {
    const required = BOOTSTRAP_DECLARATION.requires.map((constraint) =>
      constraint.kind === 'requiresOneOf'
        ? constraint.capabilities.join('|')
        : constraint.capability,
    );
    expect(required).toEqual(['composed-stylesheet']);

    // Not React: Bootstrap is CSS and has no opinion about the runtime.
    expect(required).not.toContain('react-runtime');
    // Not a plugin pipeline: unlike Tailwind v4 it ships plain CSS. Requiring
    // one would exclude bundlers that could serve it perfectly well.
    expect(required).not.toContain('vite-plugins');
  });

  it('names no framework and no build tool anywhere in what it produces', () => {
    const { project } = resolveProject(manifest('bootstrap'), adapters);
    const bootstrap = adapters.styling('bootstrap');
    const emitted = JSON.stringify([
      bootstrap.declaration,
      bootstrap.resolve(manifest('bootstrap')),
      bootstrap.contribute(project),
    ]).toLowerCase();
    expect(emitted).not.toContain('react');
    expect(emitted).not.toContain('vite');
    expect(emitted).not.toContain('astro');
  });

  it('resolves identically whichever framework selected it', () => {
    const bootstrap = adapters.styling('bootstrap');
    expect(bootstrap.resolve(manifest('bootstrap'))).toEqual(
      bootstrap.resolve({ ...manifest('bootstrap'), framework: 'astro', buildTool: 'astro' }),
    );
  });
});

describe('React and Vite never learned Bootstrap exists', () => {
  it('neither adapter mentions it', () => {
    for (const file of ['react.ts', 'vite.ts']) {
      const source = readFileSync(
        path.resolve(import.meta.dirname, '..', 'src', 'adapters', file),
        'utf8',
      ).toLowerCase();
      expect(source, `${file} mentions bootstrap`).not.toContain('bootstrap');
    }
  });

  it('names no styling system in code, only in prose explaining the design', () => {
    // Both files discuss Tailwind in comments - that is how the reasoning for
    // capability boundaries is recorded, and deleting it would make the design
    // harder to follow, not more decoupled. What must never appear is a styling
    // system in the *code*: a `styling === 'tailwind'` branch, a dependency, a
    // path. So comments are stripped and the remainder is checked.
    for (const file of ['react.ts', 'vite.ts']) {
      const source = readFileSync(
        path.resolve(import.meta.dirname, '..', 'src', 'adapters', file),
        'utf8',
      );
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .toLowerCase();
      expect(code, `${file} names tailwind in code`).not.toContain('tailwind');
      expect(code, `${file} names bootstrap in code`).not.toContain('bootstrap');
    }
  });

  it('React and Vite contribute identically under either styling system', () => {
    // The heart of the stage. Swap the styling adapter and the framework and
    // build-tool contributions must not move at all.
    const withTailwind = resolveWithAdapters(manifest('tailwind'), TEMPLATES_ROOT).contributions;
    const withBootstrap = resolveWithAdapters(manifest('bootstrap'), TEMPLATES_ROOT).contributions;

    const byOwner = (list: typeof withTailwind, owner: string) =>
      list.find((contribution) => contribution.owner === owner);

    expect(byOwner(withBootstrap, 'framework:react')).toEqual(
      byOwner(withTailwind, 'framework:react'),
    );
    expect(byOwner(withBootstrap, 'build-tool:vite')).toEqual(
      byOwner(withTailwind, 'build-tool:vite'),
    );
  });

  it('the two stacks differ only in the styling contribution', () => {
    const tailwind = planFor('tailwind')
      .plan.operations.map((o) => o.path)
      .sort();
    const bootstrap = planFor('bootstrap')
      .plan.operations.map((o) => o.path)
      .sort();
    expect(bootstrap).toEqual(tailwind);
  });
});

describe('compatibility', () => {
  it('React + Vite + Bootstrap is compatible', () => {
    const report = checkCompatibility(manifest('bootstrap'), adapters);
    expect(report.compatible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('React + Vite + Tailwind is still compatible', () => {
    expect(checkCompatibility(manifest('tailwind'), adapters).compatible).toBe(true);
  });

  it('Astro + Tailwind is still compatible', () => {
    const astro = checkCompatibility(
      {
        ...manifest('tailwind'),
        framework: 'astro',
        buildTool: 'astro',
        architecture: 'astro-standard',
        starter: 'coming-soon',
      },
      adapters,
    );
    expect(astro.compatible).toBe(true);
  });

  it('Astro + Bootstrap is rejected, by capability rather than by rule', () => {
    // Astro ships its own global.css, so a contributed stylesheet would be
    // silently ignored there. Rather than generate a project with Bootstrap in
    // package.json and none of it applied, the engine refuses - and no rule
    // anywhere names Astro and Bootstrap together.
    const report = checkCompatibility(
      {
        ...manifest('bootstrap'),
        framework: 'astro',
        buildTool: 'astro',
        architecture: 'astro-standard',
        starter: 'coming-soon',
      },
      adapters,
    );
    expect(report.compatible).toBe(false);
    expect(report.violations[0]?.adapter).toBe('styling:bootstrap');
    expect(JSON.stringify(BOOTSTRAP_DECLARATION)).not.toContain('astro');
  });

  it('a hypothetical framework that composes its stylesheet works unmodified', () => {
    // The regression this prevents is `if (framework === 'react') allow bootstrap`.
    // Bootstrap asked for a capability, so anything providing it is compatible -
    // including a framework that does not exist.
    const hypothetical: AdapterDeclaration = {
      id: 'someframework',
      kind: 'framework',
      displayName: 'Some Framework',
      provides: ['composed-stylesheet'],
      requires: [],
    };
    const report = evaluateCombination([hypothetical, BOOTSTRAP_DECLARATION]);
    expect(report.compatible).toBe(true);

    // and one that does not provide it is refused, with no React in sight
    const without: AdapterDeclaration = { ...hypothetical, id: 'other', provides: [] };
    expect(evaluateCombination([without, BOOTSTRAP_DECLARATION]).compatible).toBe(false);
  });

  it('Bootstrap needs no build tool at all', () => {
    // Tailwind would fail this; Bootstrap must not, because plain CSS needs no
    // plugin pipeline.
    expect(evaluateCombination([REACT_DECLARATION, BOOTSTRAP_DECLARATION]).compatible).toBe(true);
    expect(evaluateCombination([REACT_DECLARATION, TAILWIND_DECLARATION]).compatible).toBe(false);
    expect(
      evaluateCombination([REACT_DECLARATION, VITE_DECLARATION, TAILWIND_DECLARATION]).compatible,
    ).toBe(true);
  });

  it('an unimplemented framework still fails without falling back', () => {
    expect(() =>
      resolveProject({ ...manifest('bootstrap'), framework: 'nextjs' }, adapters),
    ).toThrow(CliError);
  });
});

describe('selection', () => {
  it('React + Vite + Bootstrap selects exactly three adapters', () => {
    expect(selectAdapters(manifest('bootstrap'), adapters).adapters.map((a) => a.ref)).toEqual([
      'framework:react',
      'build-tool:vite',
      'styling:bootstrap',
    ]);
  });

  it('React + Vite + Tailwind is unchanged', () => {
    expect(selectAdapters(manifest('tailwind'), adapters).adapters.map((a) => a.ref)).toEqual([
      'framework:react',
      'build-tool:vite',
      'styling:tailwind',
    ]);
  });

  it('only one styling system can be selected', () => {
    // The manifest holds a single StylingId, so "tailwind and bootstrap" is not
    // representable. This asserts the shape rather than a runtime guard.
    const selected = manifest('bootstrap').styling;
    expect(Array.isArray(selected)).toBe(false);
    expect(typeof selected).toBe('string');
    const styling = selectAdapters(manifest('bootstrap'), adapters).adapters.filter((a) =>
      a.ref.startsWith('styling:'),
    );
    expect(styling).toHaveLength(1);
  });
});

describe('contributions', () => {
  const contributionsOf = (styling: StylingId) =>
    resolveWithAdapters(manifest(styling), TEMPLATES_ROOT).contributions;

  it('contributes Bootstrap exactly once, owned by Bootstrap', () => {
    const deps = contributionsOf('bootstrap').flatMap((c) => c.dependencies);
    const bootstrap = deps.filter((d) => d.name === 'bootstrap');
    expect(bootstrap).toHaveLength(1);
    expect(bootstrap[0]?.owner).toBe('styling:bootstrap');
    expect(bootstrap[0]?.version).toBe('5.3.8');
    expect(bootstrap[0]?.kind).toBe('prod');
    expect(bootstrap[0]?.reason.length).toBeGreaterThan(0);
  });

  it('brings no Tailwind packages with it', () => {
    const names = contributionsOf('bootstrap')
      .flatMap((c) => c.dependencies)
      .map((d) => d.name);
    expect(names).not.toContain('tailwindcss');
    expect(names).not.toContain('@tailwindcss/vite');
  });

  it('acquires no React or Vite dependency of its own', () => {
    const bootstrapOwned = contributionsOf('bootstrap')
      .flatMap((c) => c.dependencies)
      .filter((d) => d.owner === 'styling:bootstrap')
      .map((d) => d.name);
    expect(bootstrapOwned).toEqual(['bootstrap']);
  });

  it('contributes the global stylesheet by role, not by path', () => {
    const files = contributionsOf('bootstrap')
      .flatMap((c) => c.files)
      .filter((f) => f.owner === 'styling:bootstrap');
    // One, since Stage 6. It used to also merge its package into package.json;
    // that is now a DependencyContribution, which the package composer owns.
    // A styling adapter contributes a stylesheet and a dependency - it never
    // edits a file the framework owns.
    expect(files.map((f) => f.target)).toEqual([{ kind: 'role', role: 'styles.global' }]);
    const stylesheet = files.find(
      (f) => f.target.kind === 'role' && f.target.role === 'styles.global',
    );
    expect(stylesheet?.intent).toBe('create');
    expect(files.every((f) => f.target.kind === 'role')).toBe(true);
  });

  it('contributes no build-config entry, because Bootstrap needs no plugin', () => {
    const config = contributionsOf('bootstrap').flatMap((c) => c.config);
    expect(config.filter((entry) => entry.owner === 'styling:bootstrap')).toEqual([]);
    // Tailwind does contribute one, which is the difference between them.
    expect(
      contributionsOf('tailwind')
        .flatMap((c) => c.config)
        .filter((entry) => entry.owner === 'styling:tailwind'),
    ).toHaveLength(1);
  });

  it('is deterministic', () => {
    expect(contributionsOf('bootstrap')).toEqual(contributionsOf('bootstrap'));
  });
});

describe('the composed stylesheet', () => {
  it('React gets Bootstrap CSS at the architecture-chosen path', () => {
    const css = planFor('bootstrap').plan.operations.find((o) => o.path === 'src/styles/index.css');
    expect(css?.origin).toBe('styling:bootstrap');
    const content = css?.type === 'write' ? css.content : '';
    expect(content).toContain("@import 'bootstrap/dist/css/bootstrap.min.css';");
    expect(content).not.toContain('tailwindcss');
  });

  it('React + Tailwind still gets Tailwind CSS at the same path', () => {
    const css = planFor('tailwind').plan.operations.find((o) => o.path === 'src/styles/index.css');
    expect(css?.origin).toBe('styling:tailwind');
    const content = css?.type === 'write' ? css.content : '';
    expect(content).toContain("@import 'tailwindcss';");
    expect(content).not.toContain('bootstrap');
  });

  it('both implement the same semantic class contract the markup asks for', () => {
    const classesIn = (styling: StylingId) => {
      const css = planFor(styling).plan.operations.find((o) => o.path === 'src/styles/index.css');
      const content = css?.type === 'write' ? css.content : '';
      return new Set([...content.matchAll(/^\s*\.([a-z-]+)/gm)].map((m) => m[1]));
    };
    const tailwind = classesIn('tailwind');
    const bootstrap = classesIn('bootstrap');
    expect(bootstrap).toEqual(tailwind);
    // and the markup's classes are covered by both
    for (const required of ['app-shell', 'site-header', 'page-title', 'button-primary']) {
      expect(tailwind.has(required), `tailwind missing .${required}`).toBe(true);
      expect(bootstrap.has(required), `bootstrap missing .${required}`).toBe(true);
    }
  });

  it('the React template no longer hardcodes any styling system', () => {
    // The coupling this stage removed: while index.css lived in the framework's
    // base layer, every React project shipped Tailwind whatever was selected.
    const base = path.join(TEMPLATES_ROOT, 'react-vite', 'base');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(base);
    for (const file of files) {
      const source = readFileSync(file, 'utf8').toLowerCase();
      expect(source.includes('tailwind'), `${path.basename(file)} mentions tailwind`).toBe(false);
      expect(source.includes('bootstrap'), `${path.basename(file)} mentions bootstrap`).toBe(false);
    }
  });

  it('Astro composes no stylesheet, because its template owns that role', () => {
    const { project } = resolveProject(
      {
        ...manifest('tailwind'),
        framework: 'astro',
        buildTool: 'astro',
        architecture: 'astro-standard',
        starter: 'coming-soon',
      },
      adapters,
    );
    expect(project.templateOwnedRoles).toContain('styles.global');
  });
});

describe('golden: React + Vite + TypeScript + Bootstrap', () => {
  const scenarios = [
    { name: 'Coming Soon + URL', file: './golden/react-bootstrap-coming-soon-url.txt', over: {} },
    {
      name: 'Full + URL',
      file: './golden/react-bootstrap-full-url.txt',
      over: { starter: 'full' } as Partial<ProjectManifest>,
    },
    {
      name: 'URL-less',
      file: './golden/react-bootstrap-url-less.txt',
      over: {
        site: {
          name: 'Acme Ltd',
          url: null,
          description: 'Bespoke widgets.',
          locale: 'en',
          author: null,
        },
      },
    },
  ];

  for (const scenario of scenarios) {
    it(`golden: Bootstrap ${scenario.name}`, async () => {
      await expect(
        renderPlan(planFor('bootstrap', scenario.over).plan, TEMPLATES_ROOT),
      ).toMatchFileSnapshot(scenario.file);
    });
  }

  it('is deterministic across repeated planning', () => {
    expect(renderPlan(planFor('bootstrap').plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planFor('bootstrap').plan, TEMPLATES_ROOT),
    );
  });

  it('emits no unresolved tokens and no CRLF', () => {
    for (const operation of planFor('bootstrap').plan.operations) {
      expect(operation.path).not.toContain('\\');
      if (operation.type !== 'write') continue;
      expect(/\{\{\s*\w+\s*\}\}/.test(operation.content), operation.path).toBe(false);
      expect(operation.content.includes('\r\n'), operation.path).toBe(false);
    }
  });
});

describe('structural isolation', () => {
  it('the Bootstrap adapter touches no filesystem or process API', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src/adapters/bootstrap.ts'),
      'utf8',
    );
    for (const module of ['node:fs', 'node:child_process', 'node:process', 'node:os']) {
      expect(source.includes(`'${module}'`), `imports ${module}`).toBe(false);
    }
  });

  it('contribution is a pure function of the resolved project', () => {
    const { project } = resolveProject(manifest('bootstrap'), adapters);
    const bootstrap = adapters.styling('bootstrap');
    expect(bootstrap.contribute(project)).toEqual(bootstrap.contribute(project));
  });
});

// ---------------------------------------------------------------------------

/**
 * `styling: 'none'` is a real answer, and it has to fail honestly.
 *
 * This stage moved the global stylesheet out of React's template and into the
 * styling adapters. That is what lets Bootstrap and Tailwind be interchangeable
 * - and it opens a hole: with no styling adapter selected, nothing contributes
 * `src/styles/index.css`, but `src/main.tsx` still imports it. The generated
 * project would install cleanly, typecheck cleanly, and fail on first build.
 *
 * `requiredRoles` closes it. These tests exist because the plan looked
 * perfectly healthy - 20 files, no error - while being unbuildable.
 */
describe('an architecture that cannot do without a role says so', () => {
  it('refuses React with no styling system rather than planning a broken project', () => {
    expect(() => planFor('none')).toThrow(CliError);
    expect(() => planFor('none')).toThrow(/src\/styles\/index\.css/);
  });

  it('explains what to do instead of naming an internal role', () => {
    let hint = '';
    try {
      planFor('none');
    } catch (error) {
      hint = (error as CliError).hint ?? '';
    }
    expect(hint).toMatch(/styling system/i);
    expect(hint).toMatch(/none/);
  });

  it('is satisfied by either styling system, which is the point', () => {
    for (const styling of ['tailwind', 'bootstrap'] as const) {
      const paths = planFor(styling).plan.operations.map((operation) => operation.path);
      expect(paths).toContain('src/styles/index.css');
    }
  });

  it('checks by path, so a template-owned file would count too', () => {
    // Astro's template ships its own global stylesheet. The check resolves the
    // role to a path and looks in the finished plan, so template-owned and
    // contributed files are indistinguishable to it - which is why Astro could
    // declare the same requirement without changing how it generates.
    const astro = adapters.framework('astro');
    const architecture = astro.architectureDefinitions[0];
    expect(architecture?.roles['styles.global']).toBe('src/styles/global.css');
    expect(architecture?.requiredRoles).toBeUndefined();
  });

  it('adds nothing of its own when the architecture declares nothing', () => {
    // Astro's architecture declares no required role, so the only one left is
    // the starter's `page.home` - which every project has and which says
    // nothing about styling. Asserting the exact list rather than "nothing is
    // required" keeps the claim about *this* architecture: were it to start
    // demanding a stylesheet the way the Bootstrap-composing one does, this
    // would fail rather than quietly widen.
    const astro = adapters.framework('astro');
    const project = resolveProject(
      {
        ...manifest('tailwind'),
        framework: 'astro',
        buildTool: 'vite',
        architecture: astro.architectureDefinitions[0]!.id,
        starter: 'coming-soon',
      },
      adapters,
    ).project;
    expect(project.requiredRoles).toEqual(['page.home']);
    expect(() =>
      assertRequiredRoles(project, [
        { type: 'write', path: 'src/pages/index.astro', content: '', origin: 'test' },
      ]),
    ).not.toThrow();
  });
});
