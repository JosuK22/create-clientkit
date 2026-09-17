import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { BOOTSTRAP_DECLARATION } from '../src/adapters/bootstrap.js';
import { NEXTJS_ARCHITECTURE, NEXTJS_DECLARATION } from '../src/adapters/nextjs.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import type { AdapterDeclaration, Capability, ProjectManifest } from '../src/domain/index.js';
import { evaluateCombination, resolveRole } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * The `composed-stylesheet` capability boundary, and the correction that made
 * it honest.
 *
 * ## What went wrong
 *
 * Stage 22 gave Next a template that shipped `styles/globals.css`, and withheld
 * `composed-stylesheet` for exactly that reason. Stage 23 moved the stylesheet
 * out of the template layer so Tailwind could own the role - and did not update
 * the declaration. For one stage, Next refused Bootstrap on grounds that were
 * no longer true of Next.
 *
 * Nothing caught it, because every test asserted the *refusal* and none
 * asserted the *reason*. Three stages of goldens, mutation runs and CI passed
 * over a capability declaration that had stopped describing the code.
 *
 * ## What this file holds
 *
 * The correction, and the guards that would have caught it:
 *
 *   - Next declares the capability, and a test says so directly, so the stale
 *     claim cannot return quietly.
 *   - Bootstrap's contract is proved capability-driven against a framework that
 *     does not exist, in both directions: with the capability it composes,
 *     without it it does not.
 *   - Neither adapter names the other, and the engine has no case for the pair.
 *
 * The synthetic framework is the load-bearing part. Bootstrap working on Next
 * proves Bootstrap works on Next; Bootstrap working on a framework nobody has
 * written, purely because that framework declares one capability, proves the
 * contract is what the architecture claims it is.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const manifestFor = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-site'),
  projectName: 'acme-site',
  framework: 'nextjs',
  buildTool: 'next',
  language: 'ts',
  styling: 'bootstrap',
  uiLibrary: 'none',
  router: 'file-based',
  architecture: 'next-app',
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

const planFor = (manifest: ProjectManifest) =>
  planManifest(manifest, {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: manifest.starter,
  });

const pathsOf = (manifest: ProjectManifest): readonly string[] =>
  planFor(manifest).plan.operations.map((operation) => operation.path);

const fileAt = (manifest: ProjectManifest, file: string): string => {
  const operation = planFor(manifest).plan.operations.find((entry) => entry.path === file);
  if (operation === undefined) throw new Error(`no operation for ${file}`);
  return operation.type === 'write' ? operation.content : '';
};

const code = (relative: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const STYLESHEET = 'styles/globals.css';

// ---------------------------------------------------------------------------
// The synthetic framework: the proof that matters
// ---------------------------------------------------------------------------

/**
 * A framework that does not exist, declaring the one capability Bootstrap asks
 * for and nothing else.
 *
 * Deliberately minimal. Giving it `react-runtime` or `typescript` would make
 * the positive result ambiguous - it would no longer be clear which capability
 * carried it. One capability in, one compatible result out.
 *
 * It is a literal in this file. It is not registered, not importable from
 * `src/`, not a `FrameworkId`, and a test below proves it cannot be selected.
 */
const SYNTHETIC_WITH: AdapterDeclaration = {
  id: 'synthetic-composed-stylesheet',
  kind: 'framework',
  displayName: 'A framework that composes its stylesheet',
  provides: ['composed-stylesheet'],
  requires: [],
};

/** The same framework with the capability removed, and nothing else changed. */
const SYNTHETIC_WITHOUT: AdapterDeclaration = {
  ...SYNTHETIC_WITH,
  id: 'synthetic-no-composed-stylesheet',
  displayName: 'A framework that ships its own stylesheet',
  provides: [],
};

describe('Bootstrap is compatible with a capability, not with a framework', () => {
  it('composes with a framework nobody has written', () => {
    const report = evaluateCombination([SYNTHETIC_WITH, BOOTSTRAP_DECLARATION]);
    expect(report.compatible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('refuses the same framework with the capability removed', () => {
    // The pair differs in exactly one entry, so the result cannot be explained
    // by anything else.
    const report = evaluateCombination([SYNTHETIC_WITHOUT, BOOTSTRAP_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('composed-stylesheet');
  });

  it('the capability is the only difference between the two', () => {
    const { provides: withIt, ...restWith } = SYNTHETIC_WITH;
    const { provides: withoutIt, ...restWithout } = SYNTHETIC_WITHOUT;
    expect({ ...restWith, id: '', displayName: '' }).toEqual({
      ...restWithout,
      id: '',
      displayName: '',
    });
    expect(withIt).toEqual(['composed-stylesheet']);
    expect(withoutIt).toEqual([]);
  });

  it('needs no other capability at all', () => {
    // Bootstrap asks for one thing. A framework that provides it and nothing
    // else is enough, which is the whole claim: no runtime, no language, no
    // build pipeline.
    expect(SYNTHETIC_WITH.provides).toHaveLength(1);
    expect(BOOTSTRAP_DECLARATION.requires).toHaveLength(1);
  });

  it('Bootstrap never learns any framework id', () => {
    const declared = JSON.stringify(BOOTSTRAP_DECLARATION).toLowerCase();
    for (const id of ['synthetic', 'nextjs', 'next.js', 'react', 'astro', 'angular']) {
      expect(declared, `the declaration mentions ${id}`).not.toContain(id);
    }
  });

  it('cannot be selected, because it is not a framework this build has', () => {
    // The synthetic framework must never become publicly reachable. It is a
    // literal in a test file, so the registry has never heard of it.
    expect(() => adapters.framework('synthetic-composed-stylesheet' as never)).toThrow(CliError);
    expect(adapters.hasFramework('synthetic-composed-stylesheet' as never)).toBe(false);
    expect(adapters.implementedFrameworks()).toEqual(['astro', 'nextjs', 'react']);
  });

  it('does not exist anywhere under src/', () => {
    // A grep rather than an import check: the point is that no production
    // module can reach it, however it were wired.
    for (const file of [
      'src/adapters/registry.ts',
      'src/adapters/bootstrap.ts',
      'src/adapters/nextjs.ts',
      'src/domain/dimensions.ts',
    ]) {
      expect(code(file), `${file} mentions the synthetic framework`).not.toContain('synthetic');
    }
  });
});

// ---------------------------------------------------------------------------
// The correction
// ---------------------------------------------------------------------------

describe('Next declares the capability it actually has', () => {
  it('provides composed-stylesheet', () => {
    // The guard for the whole stage. Withheld through Stage 23 on grounds
    // Stage 23 had itself made false.
    expect(NEXTJS_DECLARATION.provides).toContain('composed-stylesheet');
  });

  it('and the arrangement that makes that true', () => {
    /*
     * The capability means "the global stylesheet is composed from
     * contributions rather than shipped by the framework's template". Both
     * halves checked: the role is mapped, and no template layer owns it.
     */
    expect(resolveRole(NEXTJS_ARCHITECTURE, 'styles.global')).toBe(STYLESHEET);
    expect(adapters.framework('nextjs').templateOwnedRoles).not.toContain('styles.global');
  });

  it('provides postcss for a separate reason, and the two are not the same', () => {
    /*
     * `postcss` is about processing - a pipeline a build plugin can run in,
     * which is what Tailwind needed. `composed-stylesheet` is about
     * composition - a stylesheet surface a contribution can be written into,
     * which is what Bootstrap needs. Next has both, independently; a framework
     * can have either without the other.
     */
    expect(NEXTJS_DECLARATION.provides).toContain('postcss');
    expect(NEXTJS_DECLARATION.provides).toContain('composed-stylesheet');

    // Bootstrap asks for the composition one and no build pipeline at all.
    const required = BOOTSTRAP_DECLARATION.requires.flatMap((constraint) =>
      constraint.kind === 'requires' ? [constraint.capability] : [],
    );
    expect(required).toEqual(['composed-stylesheet']);
    for (const pipeline of ['postcss', 'vite-plugins'] as Capability[]) {
      expect(required, `Bootstrap asks for ${pipeline}`).not.toContain(pipeline);
    }
  });

  it('gained nothing else', () => {
    // Two more since Stage 26 - `client-app-root` and `server-inserted-head` -
    // each earned by architecture rather than asserted. See next-mui.test.ts.
    expect([...NEXTJS_DECLARATION.provides].sort()).toEqual([
      'client-app-root',
      'composed-stylesheet',
      'document-metadata',
      'file-based-routing',
      'jsx',
      'postcss',
      'react-runtime',
      'server-inserted-head',
      'typescript',
    ]);
  });

  it('carries no stale claim about shipping its own stylesheet', () => {
    // The comment that justified the stale declaration said Next "ships
    // styles/globals.css from its own template". It does not, and the source
    // must not say it does.
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src/adapters/nextjs.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/Not `composed-stylesheet`/);
  });
});

// ---------------------------------------------------------------------------
// Next + Bootstrap, through the generic pipeline
// ---------------------------------------------------------------------------

describe('Next + Bootstrap composes with no special case', () => {
  it('resolves, for the stated capability reason', () => {
    const report = checkCompatibility(manifestFor(), adapters);
    expect(report.compatible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('resolves for both starters', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      expect(checkCompatibility(manifestFor({ starter }), adapters).compatible, starter).toBe(true);
    }
  });

  it('selects the framework and the styling adapter, and nothing else', () => {
    const refs = selectAdapters(manifestFor(), adapters).adapters.map((entry) => entry.ref);
    expect(refs).toEqual(['framework:nextjs', 'styling:bootstrap']);
  });

  it('Bootstrap owns the stylesheet, addressed by role', () => {
    expect(pathsOf(manifestFor())).toContain(STYLESHEET);
    expect(fileAt(manifestFor(), STYLESHEET)).toContain(
      "@import 'bootstrap/dist/css/bootstrap.min.css'",
    );
  });

  it('exactly one owner claims the stylesheet', () => {
    // No collision: Next contributes its plain stylesheet only when no styling
    // adapter was selected, so the two never both fire.
    for (const starter of ['coming-soon', 'full'] as const) {
      expect(pathsOf(manifestFor({ starter })).filter((file) => file === STYLESHEET)).toHaveLength(
        1,
      );
    }
  });

  it('no role is claimed twice', () => {
    const { contributions } = resolveWithAdapters(manifestFor(), TEMPLATES_ROOT);
    const claims = new Map<string, string>();
    for (const contribution of contributions) {
      for (const file of contribution.files) {
        const key = file.target.kind === 'role' ? `role:${file.target.role}` : file.target.path;
        expect(claims.has(key), `${key} claimed twice`).toBe(false);
        claims.set(key, contribution.owner);
      }
    }
    expect(claims.get('role:styles.global')).toBe('styling:bootstrap');
  });

  it('Bootstrap owns the dependency, as production', () => {
    const pkg = JSON.parse(fileAt(manifestFor(), 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // Its CSS is imported by application source and ships in the bundle.
    expect(pkg.dependencies['bootstrap']).toBe('5.3.8');
    expect(pkg.devDependencies['bootstrap']).toBeUndefined();
    // And the framework's own three are untouched.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      'bootstrap',
      'next',
      'react',
      'react-dom',
    ]);
  });

  it('needs no build-pipeline configuration, unlike Tailwind', () => {
    // Bootstrap ships plain CSS. A PostCSS config here would be a file nothing
    // reads - and the role is only filled when a styling system asks for it.
    expect(pathsOf(manifestFor())).not.toContain('postcss.config.mjs');
  });

  it('the markup is identical to every other styling choice', () => {
    /*
     * The shared style contract doing its work for a third implementation. If
     * this ever differs, a styling system has started dictating markup.
     */
    for (const starter of ['coming-soon', 'full'] as const) {
      for (const file of ['app/page.tsx', 'app/layout.tsx', 'components/ui/Mark.tsx']) {
        const bootstrap = fileAt(manifestFor({ starter }), file);
        expect(bootstrap, `${starter}/${file} vs tailwind`).toBe(
          fileAt(manifestFor({ starter, styling: 'tailwind' }), file),
        );
        expect(bootstrap, `${starter}/${file} vs plain`).toBe(
          fileAt(manifestFor({ starter, styling: 'none' }), file),
        );
      }
    }
  });

  it('the Bootstrap stylesheet implements every class the markup asks for', () => {
    const used = new Set<string>();
    for (const starter of ['coming-soon', 'full'] as const) {
      const markup = [
        fileAt(manifestFor({ starter }), 'app/page.tsx'),
        fileAt(manifestFor({ starter }), 'components/ui/Mark.tsx'),
      ].join('\n');
      for (const match of markup.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
        for (const raw of (match[1] ?? match[2] ?? '').split(/\s+/)) {
          const name = raw.replace(/\$\{[^}]*\}/g, '').trim();
          if (name !== '') used.add(name);
        }
      }
    }
    expect(used.size).toBeGreaterThan(10);
    const css = fileAt(manifestFor(), STYLESHEET);
    for (const className of used) {
      expect(css, `Bootstrap implements no .${className}`).toContain(`.${className}`);
    }
  });

  it('is deterministic', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      expect(renderPlan(planFor(manifestFor({ starter })).plan, TEMPLATES_ROOT)).toBe(
        renderPlan(planFor(manifestFor({ starter })).plan, TEMPLATES_ROOT),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The rest of the matrix is untouched
// ---------------------------------------------------------------------------

describe('correcting one capability changed only what it should', () => {
  it('every styling choice now resolves on Next', () => {
    for (const styling of ['none', 'tailwind', 'bootstrap'] as const) {
      expect(checkCompatibility(manifestFor({ styling }), adapters).compatible, styling).toBe(true);
    }
  });

  it('everything else on Next is refused exactly as before', () => {
    const refused: ReadonlyArray<readonly [string, Partial<ProjectManifest>, string]> = [
      // MUI left this list in Stage 26; React Router's reason changed from a
      // missing capability to a conflict with the framework's own routing.
      ['react-router', { router: 'react-router' }, 'file-based-routing'],
      ['client-route-fallback', { features: ['client-route-fallback'] }, 'client-side-routing'],
      ['seo', { features: ['seo'] }, 'composed-metadata'],
      ['structured-data', { features: ['structured-data'] }, 'composed-metadata'],
      ['accessibility', { features: ['accessibility'] }, 'composed-metadata'],
    ];
    for (const [label, over, capability] of refused) {
      const report = checkCompatibility(manifestFor(over), adapters);
      expect(report.compatible, label).toBe(false);
      expect(JSON.stringify(report.violations), label).toContain(capability);
    }
  });

  it('not-found is still refused by the architecture, not by a capability', () => {
    let message = '';
    try {
      planFor(manifestFor({ features: ['not-found'] }));
    } catch (error) {
      message = (error as CliError).message;
    }
    expect(message).toContain('page.notFound');
  });

  it('Bootstrap is still refused where the capability is genuinely absent', () => {
    /*
     * Astro ships its own stylesheet from its template and declares
     * `styles.global` template-owned, so it does not provide the capability -
     * and Bootstrap is refused there for the reason that was always true.
     * This is the control: the correction was to Next's declaration, not to
     * the capability.
     */
    const astro = adapters.framework('astro');
    expect(astro.declaration.provides).not.toContain('composed-stylesheet');
    expect(astro.templateOwnedRoles).toContain('styles.global');
    const report = checkCompatibility(
      manifestFor({
        framework: 'astro',
        buildTool: 'astro',
        architecture: 'astro-standard',
        styling: 'bootstrap',
      }),
      adapters,
    );
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('composed-stylesheet');
  });

  it('React + Bootstrap is unaffected', () => {
    const react = checkCompatibility(
      manifestFor({
        framework: 'react',
        buildTool: 'vite',
        router: 'none',
        architecture: 'react-standard',
        styling: 'bootstrap',
      }),
      adapters,
    );
    expect(react.compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('neither adapter knows the other exists', () => {
  it('the Bootstrap adapter names no framework', () => {
    const bootstrap = code('src/adapters/bootstrap.ts').toLowerCase();
    for (const name of ['nextjs', 'next.js', 'next/', 'astro', 'react', 'synthetic']) {
      expect(bootstrap, `bootstrap.ts mentions ${name}`).not.toContain(name);
    }
  });

  it('the Next adapter has no styling logic', () => {
    const next = code('src/adapters/nextjs.ts').toLowerCase();
    for (const name of ['bootstrap', 'tailwind', 'mui']) {
      expect(next, `nextjs.ts mentions ${name}`).not.toContain(name);
    }
    expect(next).not.toMatch(/styling\s*===\s*'(bootstrap|tailwind)'/);
  });

  it('the compatibility engine has no case for the pair', () => {
    for (const file of ['src/domain/compatibility.ts', 'src/adapters/selection.ts']) {
      const source = code(file).toLowerCase();
      for (const name of ['nextjs', 'bootstrap', 'tailwind']) {
        expect(source, `${file} mentions ${name}`).not.toContain(name);
      }
    }
  });

  it('there is no Next-specific Bootstrap module', () => {
    for (const file of ['src/adapters/next-bootstrap.ts', 'src/adapters/nextjs-bootstrap.ts']) {
      expect(() => readFileSync(path.resolve(import.meta.dirname, '..', file))).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe('an impossible stack is refused before anything is planned', () => {
  it('refuses at resolution, not at generation', () => {
    /*
     * The distinction matters: a combination rejected while planning has
     * already decided a file list, and the failure surfaces as a missing file
     * rather than as an explanation. `resolveProject` runs before any operation
     * exists, which is where these must fail.
     */
    for (const over of [
      { router: 'react-router' },
      { features: ['seo'] },
    ] as Partial<ProjectManifest>[]) {
      expect(() => resolveProject(manifestFor(over), adapters)).toThrow(CliError);
    }
  });

  it('a supported stack reaches a complete plan', () => {
    const operations = planFor(manifestFor()).plan.operations;
    expect(operations.length).toBeGreaterThan(10);
    for (const file of ['package.json', STYLESHEET, 'app/page.tsx', '.client-site.json']) {
      expect(operations.map((entry) => entry.path)).toContain(file);
    }
  });
});

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

describe('golden: Next.js + Bootstrap', () => {
  const scenarios = [
    { name: 'Coming Soon + URL', file: './golden/next-bootstrap-coming-soon-url.txt', over: {} },
    {
      name: 'Full + URL',
      file: './golden/next-bootstrap-full-url.txt',
      over: { starter: 'full' } as Partial<ProjectManifest>,
    },
  ];

  for (const scenario of scenarios) {
    it(`golden: Next + Bootstrap ${scenario.name}`, async () => {
      await expect(
        renderPlan(planFor(manifestFor(scenario.over)).plan, TEMPLATES_ROOT),
      ).toMatchFileSnapshot(scenario.file);
    });
  }
});
