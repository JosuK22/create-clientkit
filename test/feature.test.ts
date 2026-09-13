import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASTRO_DECLARATION } from '../src/adapters/astro.js';
import { assertRequiredRoles, planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { MUI_DECLARATION } from '../src/adapters/mui.js';
import { NOT_FOUND_DECLARATION } from '../src/adapters/not-found.js';
import { REACT_DECLARATION } from '../src/adapters/react.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import { TAILWIND_DECLARATION } from '../src/adapters/tailwind.js';
import { VITE_DECLARATION } from '../src/adapters/vite.js';
import type {
  AdapterDeclaration,
  FeatureId,
  FrameworkId,
  ProjectManifest,
} from '../src/domain/index.js';
import { evaluateCombination } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import type { FileOperation } from '../src/generate/files.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * The feature dimension, through `not-found`.
 *
 * The claim under test is that a website capability can be selected
 * independently of the framework that implements it - that `not-found` knows no
 * framework, no framework knows `not-found`, and the capability engine and the
 * semantic-role system are what connect them.
 *
 * The sharpest tests are the negative ones. React with Vite is refused, on
 * purpose, because it cannot route an unmatched path; a hypothetical framework
 * nobody has written is accepted, because it can.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const astro = (features: readonly FeatureId[]): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-site'),
  projectName: 'acme-site',
  framework: 'astro',
  buildTool: 'vite',
  language: 'ts',
  styling: 'tailwind',
  uiLibrary: 'none',
  router: 'file-based',
  architecture: 'astro-standard',
  features,
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
});

const react = (features: readonly FeatureId[]): ProjectManifest => ({
  ...astro(features),
  framework: 'react' as FrameworkId,
  buildTool: 'vite',
  router: 'none',
  architecture: 'react-standard',
});

const planAstro = (features: readonly FeatureId[]) =>
  planManifest(astro(features), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'coming-soon',
    templateId: 'astro-tailwind',
  });

// ---------------------------------------------------------------------------
// The dimension
// ---------------------------------------------------------------------------

describe('not-found is a feature, not a framework concern', () => {
  it('occupies the feature dimension', () => {
    expect(NOT_FOUND_DECLARATION.kind).toBe('feature');
  });

  it('is not any of the other dimensions', () => {
    // Guards against the dimension collapsing: the moment a feature is modelled
    // as styling or a framework, "a site with a real 404" stops being something
    // you can ask for independently of how the site is built.
    for (const other of [
      ASTRO_DECLARATION,
      REACT_DECLARATION,
      VITE_DECLARATION,
      TAILWIND_DECLARATION,
      MUI_DECLARATION,
    ]) {
      expect(other.kind).not.toBe('feature');
    }
  });

  it('is addressable only as a feature', () => {
    expect(adapters.feature('not-found').declaration.id).toBe('not-found');
    expect(() => adapters.styling('not-found' as never)).toThrow(CliError);
    expect(() => adapters.uiLibrary('not-found' as never)).toThrow(CliError);
  });

  it('is one of the implemented features', () => {
    // 'seo' moved to the other side of this line in Stage 9.
    expect(adapters.implementedFeatures()).toEqual(['not-found', 'seo']);
    expect(adapters.hasFeature('not-found')).toBe(true);
    expect(adapters.hasFeature('sitemap')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Capability, not adapter identity
// ---------------------------------------------------------------------------

const requiredCapabilities = (declaration: AdapterDeclaration): readonly string[] =>
  declaration.requires.flatMap((entry) =>
    entry.kind === 'requires'
      ? [entry.capability]
      : entry.kind === 'requiresOneOf'
        ? [...entry.capabilities]
        : [],
  );

describe('the feature requires a capability and names nothing', () => {
  it('requires exactly file-based routing', () => {
    expect(requiredCapabilities(NOT_FOUND_DECLARATION)).toEqual(['file-based-routing']);
  });

  it('requires no styling system, UI library, build tool or language', () => {
    // Each of these would turn a composition choice into a technical
    // constraint. A 404 page is markup; it needs a route, not a design system.
    for (const capability of [
      'css-framework',
      'composed-stylesheet',
      'css-in-js',
      'vite-plugins',
      'typescript',
      'react-runtime',
    ]) {
      expect(requiredCapabilities(NOT_FOUND_DECLARATION)).not.toContain(capability);
    }
  });

  it('provides nothing, because nothing can meaningfully require it', () => {
    expect(NOT_FOUND_DECLARATION.provides).toEqual([]);
  });

  it('names no adapter anywhere in what it declares', () => {
    const declared = JSON.stringify(NOT_FOUND_DECLARATION).toLowerCase();
    for (const name of ['astro', 'react', 'vite', 'tailwind', 'bootstrap', 'mui', 'next']) {
      expect(declared, `the declaration mentions ${name}`).not.toContain(name);
    }
  });

  it('names no adapter in its code, only in prose explaining the design', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'not-found.ts'),
      'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .toLowerCase();
    for (const name of ['astro', 'react', 'vite', 'tailwind', 'bootstrap', 'mui']) {
      expect(code, `not-found.ts names ${name} in code`).not.toContain(name);
    }
  });

  it('contains no concrete output path', () => {
    // The feature must not know that Astro puts the page at
    // src/pages/404.astro. That belongs to the architecture's role mapping.
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'not-found.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('404.');
    expect(code).not.toContain('src/pages');
    expect(code).not.toContain('.astro');
  });
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('compatibility is decided by capability', () => {
  it('Astro + Tailwind + not-found is compatible', () => {
    expect(
      checkCompatibility(astro(['starter:coming-soon', 'not-found']), adapters).compatible,
    ).toBe(true);
  });

  it('React + Vite + Tailwind + not-found is refused', () => {
    // Deliberate. React with Vite ships no router, so an unmatched path never
    // reaches the application - a generated 404 component would be a file that
    // looks like a feature and is dead code. The boundary holds until a router
    // adapter exists; adding one is not this stage's job.
    const report = checkCompatibility(react(['starter:coming-soon', 'not-found']), adapters);
    expect(report.compatible).toBe(false);
  });

  it('the refusal names the missing capability, not just the framework', () => {
    let error: CliError | undefined;
    try {
      resolveProject(react(['starter:coming-soon', 'not-found']), adapters);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    expect(text).toContain('file-based-routing');
    expect(text).toContain('Not-found page');
  });

  it('React provides spa-routing, which deliberately does not satisfy it', () => {
    // The two are different claims. One says "the app can change URL without a
    // reload"; the other says "an unmatched URL reaches my page".
    expect(REACT_DECLARATION.provides).toContain('spa-routing');
    expect(REACT_DECLARATION.provides).not.toContain('file-based-routing');
  });

  it('a hypothetical framework that routes by file satisfies it', () => {
    // The strongest available statement: the feature works with a framework
    // that does not exist, has never been written, and that it cannot name.
    const hypothetical: AdapterDeclaration = {
      id: 'nextjs',
      kind: 'framework',
      displayName: 'A framework that is not Astro',
      provides: ['file-based-routing', 'typescript', 'ssr'],
      requires: [],
    };
    expect(evaluateCombination([hypothetical, NOT_FOUND_DECLARATION]).compatible).toBe(true);
  });

  it('a hypothetical framework that does not is refused, naming the capability', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'angular',
      kind: 'framework',
      displayName: 'A framework with no file-based routing',
      provides: ['typescript', 'spa-routing'],
      requires: [],
    };
    const report = evaluateCombination([hypothetical, NOT_FOUND_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report)).toContain('file-based-routing');
  });

  it('is indifferent to the styling system', () => {
    for (const styling of [TAILWIND_DECLARATION, undefined]) {
      const combination = [ASTRO_DECLARATION, NOT_FOUND_DECLARATION, ...(styling ? [styling] : [])];
      expect(evaluateCombination(combination).compatible).toBe(true);
    }
  });

  it('is indifferent to the UI library', () => {
    expect(
      evaluateCombination([
        REACT_DECLARATION,
        VITE_DECLARATION,
        MUI_DECLARATION,
        {
          id: 'nextjs',
          kind: 'framework',
          displayName: 'routes by file',
          provides: ['file-based-routing'],
          requires: [],
        },
        NOT_FOUND_DECLARATION,
      ]).compatible,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('selection', () => {
  it('selects the feature alongside the other dimensions', () => {
    expect(
      selectAdapters(astro(['starter:coming-soon', 'not-found']), adapters).adapters.map(
        (entry) => entry.ref,
      ),
    ).toEqual(['framework:astro', 'styling:tailwind', 'feature:not-found']);
  });

  it('selects no feature adapter when none is asked for', () => {
    expect(
      selectAdapters(astro(['starter:coming-soon']), adapters).adapters.map((entry) => entry.ref),
    ).toEqual(['framework:astro', 'styling:tailwind']);
  });

  it('treats a starter as a template layer, not an adapter', () => {
    // `starter:*` is where V1's `mode` landed. Asking the registry for it would
    // report a missing adapter for something that was never one.
    const refs = selectAdapters(astro(['starter:full']), adapters).adapters.map(
      (entry) => entry.ref,
    );
    expect(refs.some((ref) => ref.startsWith('feature:starter'))).toBe(false);
    expect(() => selectAdapters(astro(['starter:full']), adapters)).not.toThrow();
  });

  it('de-duplicates a feature asked for twice', () => {
    const refs = selectAdapters(
      astro(['starter:coming-soon', 'not-found', 'not-found']),
      adapters,
    ).adapters.map((entry) => entry.ref);
    expect(refs.filter((ref) => ref === 'feature:not-found')).toHaveLength(1);
  });

  it('produces the same plan whether the feature is listed once or twice', () => {
    expect(renderPlan(planAstro(['starter:coming-soon', 'not-found']).plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planAstro(['starter:coming-soon', 'not-found', 'not-found']).plan, TEMPLATES_ROOT),
    );
  });

  it('selection order does not depend on how features were listed', () => {
    const forwards = selectAdapters(astro(['not-found', 'starter:full']), adapters).adapters.map(
      (entry) => entry.ref,
    );
    const backwards = selectAdapters(astro(['starter:full', 'not-found']), adapters).adapters.map(
      (entry) => entry.ref,
    );
    expect(forwards).toEqual(backwards);
  });

  it('refuses a known but unimplemented feature, with no fallback', () => {
    // 'seo' is implemented as of Stage 9; these three are not.
    for (const id of ['sitemap', 'structured-data', 'social-metadata'] as const) {
      expect(() => adapters.feature(id)).toThrow(CliError);
      expect(() => selectAdapters(astro(['starter:coming-soon', id]), adapters)).toThrow(CliError);
    }
  });

  it('an unimplemented feature never becomes not-found', () => {
    let refs: readonly string[];
    try {
      refs = selectAdapters(astro(['starter:coming-soon', 'sitemap']), adapters).adapters.map(
        (entry) => entry.ref,
      );
    } catch {
      refs = [];
    }
    expect(refs).not.toContain('feature:not-found');
  });
});

// ---------------------------------------------------------------------------
// What it contributes
// ---------------------------------------------------------------------------

describe('contributions', () => {
  const contribution = () =>
    resolveWithAdapters(
      astro(['starter:coming-soon', 'not-found']),
      TEMPLATES_ROOT,
    ).contributions.find((entry) => entry.owner === 'feature:not-found');

  it('adds no dependency', () => {
    // A feature that quietly installed a package to render a 404 would be the
    // worst version of this abstraction.
    expect(contribution()?.dependencies).toEqual([]);
  });

  it('adds no script', () => {
    expect(contribution()?.scripts).toEqual([]);
  });

  it('adds no configuration', () => {
    expect(contribution()?.config).toEqual([]);
  });

  it('adds no template layer', () => {
    expect(contribution()?.templateLayers).toEqual([]);
  });

  it('changes nothing in the generated package manifest', () => {
    const withFeature = planAstro(['starter:coming-soon', 'not-found']).plan.operations.find(
      (entry) => entry.path === 'package.json',
    );
    const without = planAstro(['starter:coming-soon']).plan.operations.find(
      (entry) => entry.path === 'package.json',
    );
    expect(withFeature?.type === 'write' ? withFeature.content : '').toBe(
      without?.type === 'write' ? without.content : 'x',
    );
  });

  it('requests the not-found page as a semantic role', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'not-found']), adapters);
    expect(project.requiredRoles).toContain('page.notFound');
  });

  it('requires nothing extra when the feature is not selected', () => {
    const { project } = resolveProject(astro(['starter:coming-soon']), adapters);
    expect(project.requiredRoles).not.toContain('page.notFound');
  });

  it('lets the architecture decide where the page lives', () => {
    // The feature asked for a role. Astro's architecture is what turns that
    // into a path, and the feature never sees it.
    const { project } = resolveProject(astro(['starter:coming-soon', 'not-found']), adapters);
    expect(project.architecture.roles['page.notFound']).toBe('src/pages/404.astro');
  });
});

// ---------------------------------------------------------------------------
// The guarantee
// ---------------------------------------------------------------------------

describe('the guarantee is load-bearing', () => {
  const operationsFor = (paths: readonly string[]): readonly FileOperation[] =>
    paths.map((entry) => ({ type: 'write', path: entry, content: '', origin: 'test' }));

  it('passes when something produces the page', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'not-found']), adapters);
    expect(() =>
      assertRequiredRoles(project, operationsFor(['src/pages/404.astro'])),
    ).not.toThrow();
  });

  it('fails before writing when nothing does', () => {
    // The whole point of selecting the feature. Without this a project could
    // claim a real 404 and ship the host's default one.
    const { project } = resolveProject(astro(['starter:coming-soon', 'not-found']), adapters);
    expect(() => assertRequiredRoles(project, operationsFor([]))).toThrow(CliError);
    expect(() => assertRequiredRoles(project, operationsFor([]))).toThrow(/page\.notFound/);
  });

  it('is satisfied by a template-owned file exactly as by a contributed one', () => {
    // Astro's template ships the page. The check runs against the finished plan
    // by resolved path, so it never asks who produced it - which is what lets
    // the same feature work for a framework that contributes one instead.
    const { plan } = planAstro(['starter:coming-soon', 'not-found']);
    const page = plan.operations.find((entry) => entry.path === 'src/pages/404.astro');
    expect(page).toBeDefined();
    expect(page?.origin).toBe('base');
  });

  it('does not require the page when the feature is absent', () => {
    const { project } = resolveProject(astro(['starter:coming-soon']), adapters);
    expect(() => assertRequiredRoles(project, operationsFor([]))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Ownership and collision
// ---------------------------------------------------------------------------

describe('ownership is not silently transferred', () => {
  it('the framework template keeps ownership of its own markup', () => {
    // Deliberate, and the reason is worth stating: `.astro` markup cannot live
    // in a framework-agnostic feature without shipping one implementation per
    // framework, which is the matrix the architecture exists to prevent.
    const { plan } = planAstro(['starter:coming-soon', 'not-found']);
    const page = plan.operations.find((entry) => entry.path === 'src/pages/404.astro');
    expect(page?.origin).toBe('base');
  });

  it('the feature cannot overwrite a page another owner produced', () => {
    // If the feature ever grows a file contribution for this role, it must
    // collide rather than win. Astro lists page.notFound as template-owned, so
    // a contribution is skipped rather than applied - and this asserts the
    // arrangement is deliberate rather than accidental.
    const { project } = resolveProject(astro(['starter:coming-soon', 'not-found']), adapters);
    expect(project.templateOwnedRoles).toContain('page.notFound');
  });

  it('selecting the feature adds no file of its own', () => {
    const withFeature = planAstro(['starter:coming-soon', 'not-found']).plan.operations.map(
      (entry) => entry.path,
    );
    const without = planAstro(['starter:coming-soon']).plan.operations.map((entry) => entry.path);
    expect(withFeature).toEqual(without);
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the feature adapter stays inside the contract', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'not-found.ts'),
    'utf8',
  );

  it('touches no filesystem, process, shell or network API', () => {
    for (const forbidden of [
      'node:fs',
      'node:child_process',
      'node:process',
      'node:os',
      'readFileSync',
      'writeFileSync',
      'execSync',
      'spawn',
      'fetch(',
    ]) {
      expect(source, `not-found.ts uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('imports no other adapter', () => {
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      expect(specifier, `not-found.ts imports ${specifier}`).not.toMatch(
        /\.\/(astro|react|vite|tailwind|bootstrap|mui)\.js$/,
      );
    }
  });

  it('is a pure function of its inputs', () => {
    const adapter = adapters.feature('not-found');
    const manifest = astro(['starter:coming-soon', 'not-found']);
    expect(JSON.stringify(adapter.resolve(manifest))).toBe(
      JSON.stringify(adapter.resolve(manifest)),
    );
  });

  it('resolves identically whatever the rest of the manifest says', () => {
    const adapter = adapters.feature('not-found');
    expect(adapter.resolve(astro(['not-found']))).toEqual(
      adapter.resolve({ ...astro(['not-found']), styling: 'bootstrap', uiLibrary: 'mui' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Regression and determinism
// ---------------------------------------------------------------------------

describe('the rest of the project is untouched', () => {
  it('Astro without the feature generates exactly what it did before', () => {
    const { plan } = planAstro(['starter:coming-soon']);
    expect(plan.operations).toHaveLength(22);
    expect(plan.operations.some((entry) => entry.path === 'src/pages/404.astro')).toBe(true);
  });

  it('the same manifest produces the same plan twice', () => {
    expect(renderPlan(planAstro(['starter:coming-soon', 'not-found']).plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planAstro(['starter:coming-soon', 'not-found']).plan, TEMPLATES_ROOT),
    );
  });

  it('no generated content carries a machine-specific value or an unresolved token', () => {
    for (const operation of planAstro(['starter:coming-soon', 'not-found']).plan.operations) {
      if (operation.type !== 'write') continue;
      expect(operation.content).not.toContain(TEST_CWD);
      expect(operation.content).not.toContain('\r\n');
      expect(operation.content).not.toMatch(/\{\{\s*[a-zA-Z]/);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

/**
 * Renders what selecting a feature actually changes.
 *
 * `renderPlan` records the files, and for this stage the files are identical
 * with and without the feature - Astro's template already ships the page. A
 * pair of byte-identical snapshots would protect nothing, so this records the
 * composition instead: who was selected, what they contribute, what the project
 * is now required to contain, and who owns each generated path.
 *
 * That is the difference the feature makes, so that is what the golden holds.
 */
const renderComposition = (features: readonly FeatureId[]): string => {
  const { project, selection } = resolveProject(astro(features), adapters);
  const { plan, contributions } = planAstro(features);

  const lines: string[] = [];
  lines.push('== MANIFEST ==');
  lines.push(`framework   ${project.selection.framework}`);
  lines.push(`styling     ${project.selection.styling}`);
  lines.push(`uiLibrary   ${project.selection.uiLibrary}`);
  lines.push(`features    ${[...project.selection.features].sort().join(', ') || '(none)'}`);
  lines.push('');

  lines.push('== SELECTED ADAPTERS ==');
  for (const entry of selection.adapters) {
    lines.push(`${entry.ref.padEnd(24)} ${entry.adapter.declaration.kind}`);
  }
  lines.push('');

  lines.push('== REQUIRED ROLES ==');
  for (const role of project.requiredRoles) {
    lines.push(`${role.padEnd(24)} -> ${project.architecture.roles[role] ?? '(unmapped)'}`);
  }
  if (project.requiredRoles.length === 0) lines.push('(none)');
  lines.push('');

  lines.push('== TEMPLATE-OWNED ROLES ==');
  for (const role of [...project.templateOwnedRoles].sort()) lines.push(role);
  lines.push('');

  lines.push('== CONTRIBUTIONS ==');
  for (const contribution of [...contributions].sort((a, b) => (a.owner < b.owner ? -1 : 1))) {
    lines.push(
      `${contribution.owner.padEnd(24)} deps=${contribution.dependencies.length} scripts=${contribution.scripts.length} config=${contribution.config.length} files=${contribution.files.length} layers=${contribution.templateLayers.length}`,
    );
  }
  lines.push('');

  lines.push('== OWNERSHIP ==');
  for (const operation of plan.operations) {
    lines.push(`${operation.path.padEnd(40)} ${operation.origin}`);
  }

  return `${lines.join('\n')}\n`;
};

describe('golden: Astro + Tailwind, with and without the feature', () => {
  it('golden: composition without the feature', async () => {
    await expect(renderComposition(['starter:coming-soon'])).toMatchFileSnapshot(
      './golden/astro-baseline.txt',
    );
  });

  it('golden: composition with not-found', async () => {
    await expect(renderComposition(['starter:coming-soon', 'not-found'])).toMatchFileSnapshot(
      './golden/astro-not-found.txt',
    );
  });

  it('golden: the generated files themselves', async () => {
    await expect(
      renderPlan(planAstro(['starter:coming-soon', 'not-found']).plan, TEMPLATES_ROOT),
    ).toMatchFileSnapshot('./golden/astro-not-found-files.txt');
  });

  it('the two compositions are not the same snapshot', () => {
    // Guards the goldens themselves. If these ever became identical the pair
    // would silently stop protecting anything about the feature.
    expect(renderComposition(['starter:coming-soon'])).not.toBe(
      renderComposition(['starter:coming-soon', 'not-found']),
    );
  });

  it('the two differ in plan semantics even though the files match', () => {
    // Recorded rather than glossed over. Selecting the feature changes what the
    // project is allowed to be - the adapter set and the required-role set -
    // without changing a byte, because Astro's template already ships the page.
    const withFeature = resolveProject(astro(['starter:coming-soon', 'not-found']), adapters);
    const without = resolveProject(astro(['starter:coming-soon']), adapters);

    expect(withFeature.selection.adapters.map((entry) => entry.ref)).toContain('feature:not-found');
    expect(without.selection.adapters.map((entry) => entry.ref)).not.toContain('feature:not-found');
    expect(withFeature.project.requiredRoles).toContain('page.notFound');
    expect(without.project.requiredRoles).not.toContain('page.notFound');
  });
});
