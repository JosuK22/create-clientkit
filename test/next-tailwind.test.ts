import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { NEXTJS_ARCHITECTURE, NEXTJS_DECLARATION } from '../src/adapters/nextjs.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, selectAdapters } from '../src/adapters/selection.js';
import { BOOTSTRAP_DECLARATION } from '../src/adapters/bootstrap.js';
import { TAILWIND_DECLARATION } from '../src/adapters/tailwind.js';
import type { ProjectManifest } from '../src/domain/index.js';
import { resolveRole } from '../src/domain/index.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * Next.js + Tailwind: composition, not integration.
 *
 * The claim under test is narrow and worth stating exactly. It is **not** that
 * Tailwind works on Next - that would be satisfied by a `next-tailwind`
 * adapter, which is the thing this stage exists to avoid. It is that the
 * *existing* Tailwind adapter, unmodified in any framework-specific way,
 * composes with the Next adapter through the same generic machinery that
 * already serves Astro and React.
 *
 * So the load-bearing tests here are the ones about what did **not** happen:
 *
 *   - the markup is byte-identical with and without Tailwind
 *   - Bootstrap is exactly as refused as it was before
 *   - neither adapter's source names the other
 *   - Tailwind branches on a capability, and there is no framework in sight
 *
 * A test that only checked "the generated project contains Tailwind classes"
 * would pass just as happily against a hand-written Next-specific integration.
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
  styling: 'none',
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

/** With Tailwind. */
const tw = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  manifestFor({ styling: 'tailwind', ...over });

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
const POSTCSS = 'postcss.config.mjs';

// ---------------------------------------------------------------------------
// It composes
// ---------------------------------------------------------------------------

describe('Tailwind composes with Next through the generic machinery', () => {
  it('resolves, where it was refused through Stage 22', () => {
    const report = checkCompatibility(tw(), adapters);
    expect(report.compatible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('selects both adapters and nothing else', () => {
    const refs = selectAdapters(tw(), adapters).adapters.map((entry) => entry.ref);
    expect(refs).toEqual(['framework:nextjs', 'styling:tailwind']);
  });

  it('is the same Tailwind adapter Astro and React use', () => {
    // Not a second implementation: one declaration object, one module.
    expect(TAILWIND_DECLARATION.id).toBe('tailwind');
    expect(adapters.styling('tailwind').declaration).toBe(TAILWIND_DECLARATION);
  });

  it('Tailwind owns the stylesheet, addressed by role', () => {
    expect(resolveRole(NEXTJS_ARCHITECTURE, 'styles.global')).toBe(STYLESHEET);
    expect(pathsOf(tw())).toContain(STYLESHEET);
    expect(fileAt(tw(), STYLESHEET)).toContain("@import 'tailwindcss'");
    expect(fileAt(tw(), STYLESHEET)).toContain('@theme');
  });

  it('Next owns the stylesheet when no styling adapter does', () => {
    expect(fileAt(manifestFor(), STYLESHEET)).not.toContain('tailwindcss');
    expect(fileAt(manifestFor(), STYLESHEET)).toContain('.page-title');
  });

  it('exactly one owner claims the stylesheet either way', () => {
    /*
     * The first attempt at this stage failed here, and the failure was the
     * right one: the plain stylesheet was a file in the base template layer,
     * so it was written unconditionally and collided with Tailwind's. Making
     * it a contribution is what lets the two compete on equal terms.
     */
    for (const manifest of [tw(), manifestFor(), tw({ starter: 'full' })]) {
      expect(pathsOf(manifest).filter((file) => file === STYLESHEET)).toHaveLength(1);
    }
  });

  it('contributes the PostCSS config by role, not by path', () => {
    expect(resolveRole(NEXTJS_ARCHITECTURE, 'config.styling')).toBe(POSTCSS);
    expect(pathsOf(tw())).toContain(POSTCSS);
    expect(fileAt(tw(), POSTCSS)).toContain('@tailwindcss/postcss');
  });

  it('writes no PostCSS config when Tailwind is not selected', () => {
    expect(pathsOf(manifestFor())).not.toContain(POSTCSS);
  });
});

// ---------------------------------------------------------------------------
// Dependencies and configuration
// ---------------------------------------------------------------------------

describe('each adapter owns its own half', () => {
  const pkg = (manifest: ProjectManifest) =>
    JSON.parse(fileAt(manifest, 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

  it('installs the PostCSS plugin and never the Vite one', () => {
    const { devDependencies } = pkg(tw());
    expect(Object.keys(devDependencies).sort()).toEqual([
      '@tailwindcss/postcss',
      '@types/node',
      '@types/react',
      'tailwindcss',
      'typescript',
    ]);
    expect(devDependencies['@tailwindcss/vite']).toBeUndefined();
  });

  it('leaves the framework dependencies untouched', () => {
    expect(Object.keys(pkg(tw()).dependencies).sort()).toEqual(['next', 'react', 'react-dom']);
    expect(pkg(tw()).dependencies).toEqual(pkg(manifestFor()).dependencies);
  });

  it('pins Tailwind at one version across the plugin and the package', () => {
    const { devDependencies } = pkg(tw());
    expect(devDependencies['tailwindcss']).toBe('4.3.3');
    expect(devDependencies['@tailwindcss/postcss']).toBe('4.3.3');
  });

  it('keeps the scripts the framework owns', () => {
    expect(pkg(tw()).scripts).toEqual(pkg(manifestFor()).scripts);
  });

  it('classifies everything Tailwind adds as a dev dependency', () => {
    const { dependencies } = pkg(tw());
    for (const name of Object.keys(dependencies)) {
      expect(name.startsWith('@tailwindcss/'), name).toBe(false);
      expect(name).not.toBe('tailwindcss');
    }
  });

  it('no role is claimed by two owners', () => {
    const { contributions } = resolveWithAdapters(tw(), TEMPLATES_ROOT);
    const claims = new Map<string, string>();
    for (const contribution of contributions) {
      for (const file of contribution.files) {
        const key = file.target.kind === 'role' ? `role:${file.target.role}` : file.target.path;
        expect(claims.has(key), `${key} claimed twice`).toBe(false);
        claims.set(key, contribution.owner);
      }
    }
    expect(claims.get('role:styles.global')).toBe('styling:tailwind');
    expect(claims.get('role:config.styling')).toBe('styling:tailwind');
  });

  it('introduces no Vite configuration anywhere', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      const manifest = tw({ starter });
      for (const file of pathsOf(manifest)) {
        expect(file, file).not.toMatch(/vite/i);
        if (/\.(json|mjs|ts|tsx|css)$/.test(file)) {
          // Prose stripped: the generated PostCSS config explains, in a
          // comment, which plugin the *other* pipeline uses. That is
          // documentation. What must not appear is configuration.
          const body = fileAt(manifest, file)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')
            .toLowerCase();
          expect(body, file).not.toContain('@tailwindcss/vite');
          expect(body, file).not.toContain('vite.config');
        }
      }
    }
  });

  it('contributes no Vite build-config entry at all on a PostCSS stack', () => {
    /*
     * Checked on the contribution rather than on the output, because the output
     * cannot see it. `config.build` is unmapped in this architecture, so a
     * contribution aimed at it is composed into nothing - by design, and the
     * same design that lets Tailwind target it on React while Astro ignores it.
     *
     * The consequence is that a Vite entry contributed here would disappear
     * silently. A mutation that always contributes one survived the
     * file-level assertions for exactly that reason; this is where it dies.
     */
    const { contributions } = resolveWithAdapters(tw(), TEMPLATES_ROOT);
    const entries = contributions.flatMap((contribution) => contribution.config);
    expect(entries.filter((entry) => entry.target === 'config.build')).toEqual([]);
    expect(JSON.stringify(entries)).not.toContain('@tailwindcss/vite');

    // And the React stack, where it *is* mapped, still gets it - so the
    // assertion above is about the pipeline, not about Tailwind going quiet.
    const react = resolveWithAdapters(
      {
        ...manifestFor(),
        framework: 'react',
        buildTool: 'vite',
        router: 'none',
        architecture: 'react-standard',
        styling: 'tailwind',
      },
      TEMPLATES_ROOT,
    ).contributions.flatMap((contribution) => contribution.config);
    expect(JSON.stringify(react)).toContain('@tailwindcss/vite');
  });

  it('the Next configuration is untouched by styling', () => {
    expect(fileAt(tw(), 'next.config.ts')).toBe(fileAt(manifestFor(), 'next.config.ts'));
    expect(fileAt(tw(), 'tsconfig.json')).toBe(fileAt(manifestFor(), 'tsconfig.json'));
  });
});

// ---------------------------------------------------------------------------
// The starters
// ---------------------------------------------------------------------------

describe('both starters render through one shared style contract', () => {
  it('the markup is identical whichever styling system was selected', () => {
    /*
     * The strongest statement this stage can make. Composing Tailwind changes
     * the stylesheet, adds a PostCSS config and a dev dependency, and does not
     * move one byte of the component tree. That is what makes styling a
     * dimension rather than a variant - and it is only possible because the
     * markup names semantic classes that every styling system implements.
     */
    for (const starter of ['coming-soon', 'full'] as const) {
      for (const file of ['app/page.tsx', 'app/layout.tsx', 'components/ui/Mark.tsx']) {
        expect(fileAt(tw({ starter }), file), `${starter}/${file}`).toBe(
          fileAt(manifestFor({ starter }), file),
        );
      }
    }
  });

  it('the coming-soon page has a centred hero with the contract classes', () => {
    const page = fileAt(tw(), 'app/page.tsx');
    for (const className of ['app-shell', 'container-page', 'hero', 'hero-inner', 'page-title']) {
      expect(page, className).toContain(className);
    }
  });

  it('the full page has header, hero, sections and footer', () => {
    const page = fileAt(tw({ starter: 'full' }), 'app/page.tsx');
    for (const className of ['site-header', 'intro', 'sections', 'site-footer']) {
      expect(page, className).toContain(className);
    }
    // The section heading class lives in the component that renders it.
    expect(fileAt(tw({ starter: 'full' }), 'components/ui/Section.tsx')).toContain('section-title');
  });

  it('every class the markup asks for is implemented by the stylesheet', () => {
    /*
     * A class the markup uses and no stylesheet implements renders as nothing,
     * silently - the failure mode a shared contract is most exposed to. Checked
     * against both implementations, so neither can drift from the markup.
     */
    const used = new Set<string>();
    for (const starter of ['coming-soon', 'full'] as const) {
      const markup = [
        fileAt(tw({ starter }), 'app/page.tsx'),
        fileAt(tw({ starter }), 'components/ui/Mark.tsx'),
      ].join('\n');
      for (const match of markup.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
        for (const raw of (match[1] ?? match[2] ?? '').split(/\s+/)) {
          const name = raw.replace(/\$\{[^}]*\}/g, '').trim();
          if (name !== '') used.add(name);
        }
      }
    }
    expect(used.size).toBeGreaterThan(10);

    for (const [label, css] of [
      ['tailwind', fileAt(tw(), STYLESHEET)],
      ['plain', fileAt(manifestFor(), STYLESHEET)],
    ] as const) {
      for (const className of used) {
        expect(css, `${label} implements no .${className}`).toContain(`.${className}`);
      }
    }
  });

  it('the responsive rule the sections rely on survives composition', () => {
    // The one media query the full starter depends on for its three-column
    // layout. Present in both implementations, so the two agree about layout.
    for (const css of [fileAt(tw(), STYLESHEET), fileAt(manifestFor(), STYLESHEET)]) {
      expect(css).toContain('min-width: 640px');
    }
  });

  it('is deterministic across repeated planning', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      const first = renderPlan(planFor(tw({ starter })).plan, TEMPLATES_ROOT);
      const second = renderPlan(planFor(tw({ starter })).plan, TEMPLATES_ROOT);
      expect(first).toBe(second);
    }
  });
});

// ---------------------------------------------------------------------------
// The negative test this stage exists for
// ---------------------------------------------------------------------------

describe('adding Tailwind made nothing else compatible', () => {
  it('Bootstrap resolves on its own terms, not on Tailwind’s', () => {
    /*
     * Through Stage 23 this asserted a refusal, and the refusal was real but
     * stale: Stage 23 had already made Next compose its stylesheet, which is
     * what Bootstrap requires, and only the declaration lagged. Stage 24R
     * corrected it.
     *
     * The claim the test was making survives, and is what is checked now: the
     * two styling systems remain independent. Bootstrap resolves because Next
     * provides `composed-stylesheet`, which is nothing to do with the
     * `postcss` capability Tailwind needed - and Bootstrap asks for no build
     * pipeline at all.
     */
    expect(checkCompatibility(manifestFor({ styling: 'bootstrap' }), adapters).compatible).toBe(
      true,
    );
    const required = BOOTSTRAP_DECLARATION.requires.flatMap((constraint) =>
      constraint.kind === 'requires' ? [constraint.capability] : [],
    );
    expect(required).toEqual(['composed-stylesheet']);
    expect(required).not.toContain('postcss');
    expect(required).not.toContain('vite-plugins');
  });

  it('React Router is still refused; MUI resolves on its own terms', () => {
    // MUI became compatible in Stage 26, through the provider role rather than
    // through anything Tailwind did. React Router stays refused, by a conflict
    // with the framework's own file-based routing.
    expect(checkCompatibility(manifestFor({ router: 'react-router' }), adapters).compatible).toBe(
      false,
    );
    expect(checkCompatibility(manifestFor({ uiLibrary: 'mui' }), adapters).compatible).toBe(true);
  });

  it('the head features are still refused', () => {
    for (const feature of ['seo', 'structured-data', 'accessibility'] as const) {
      expect(
        checkCompatibility(manifestFor({ features: [feature] }), adapters).compatible,
        feature,
      ).toBe(false);
    }
  });

  it('Tailwind plus a refused selection is still refused', () => {
    for (const over of [
      { styling: 'tailwind', router: 'react-router' },
      { styling: 'tailwind', features: ['seo'] },
      { styling: 'tailwind', features: ['client-route-fallback'] },
    ] as Partial<ProjectManifest>[]) {
      expect(checkCompatibility(manifestFor(over), adapters).compatible, JSON.stringify(over)).toBe(
        false,
      );
    }
  });

  it('Next provides both capabilities, for two separate reasons', () => {
    // `postcss` is about processing - there is a pipeline a build plugin can
    // run in. `composed-stylesheet` is about composition - there is a
    // stylesheet surface a contribution can be written into. Tailwind needed
    // the first; Bootstrap needs the second; Next has both, independently.
    expect(NEXTJS_DECLARATION.provides).toContain('postcss');
    expect(NEXTJS_DECLARATION.provides).toContain('composed-stylesheet');
  });
});

// ---------------------------------------------------------------------------
// Structural: neither adapter learned about the other
// ---------------------------------------------------------------------------

describe('neither adapter knows the other exists', () => {
  it('the Tailwind adapter names no framework', () => {
    const tailwind = code('src/adapters/tailwind.ts').toLowerCase();
    for (const name of ['nextjs', 'next.js', 'next/', 'app/', 'astro', 'react']) {
      expect(tailwind, `tailwind.ts mentions ${name}`).not.toContain(name);
    }
  });

  it('the Next adapter names no styling system', () => {
    const next = code('src/adapters/nextjs.ts').toLowerCase();
    for (const name of ['tailwind', 'bootstrap', 'mui']) {
      expect(next, `nextjs.ts mentions ${name}`).not.toContain(name);
    }
    /*
     * `postcss.config.mjs` does appear, as the path the `config.styling` role
     * maps to - which is exactly what an architecture is for, and the same
     * thing it does for `next.config.ts`. What must not appear is a branch on
     * which styling system was selected.
     */
    expect(next).toContain("'config.styling': 'postcss.config.mjs'");
    expect(next).not.toMatch(/stylings*===s*'(tailwind|bootstrap)'/);
  });

  it('Tailwind branches on a capability, never on a framework', () => {
    const tailwind = code('src/adapters/tailwind.ts');
    expect(tailwind).toContain("capabilities.has('vite-plugins')");
    expect(tailwind).not.toMatch(/manifest\.framework/);
    expect(tailwind).not.toMatch(/framework\s*[=!]==/);
  });

  it('the compatibility engine has no framework or styling special case', () => {
    for (const file of ['src/domain/compatibility.ts', 'src/adapters/selection.ts']) {
      const source = code(file).toLowerCase();
      for (const name of ['nextjs', 'tailwind', 'bootstrap']) {
        expect(source, `${file} mentions ${name}`).not.toContain(name);
      }
    }
  });

  it('the starter domain knows neither', () => {
    const starter = code('src/domain/starter.ts').toLowerCase();
    for (const name of ['next', 'tailwind', 'postcss', 'globals.css']) {
      expect(starter, `starter.ts mentions ${name}`).not.toContain(name);
    }
  });

  it('there is no second Tailwind adapter', () => {
    expect(() =>
      readFileSync(path.resolve(import.meta.dirname, '..', 'src/adapters/next-tailwind.ts')),
    ).toThrow();
    expect(() =>
      readFileSync(path.resolve(import.meta.dirname, '..', 'src/adapters/nextjs-tailwind.ts')),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

describe('golden: Next.js + Tailwind', () => {
  const scenarios = [
    { name: 'Coming Soon + URL', file: './golden/next-tailwind-coming-soon-url.txt', over: {} },
    {
      name: 'Full + URL',
      file: './golden/next-tailwind-full-url.txt',
      over: { starter: 'full' } as Partial<ProjectManifest>,
    },
    {
      name: 'URL-less',
      file: './golden/next-tailwind-url-less.txt',
      over: {
        site: {
          name: 'Acme Ltd',
          url: null,
          description: 'Bespoke widgets.',
          locale: 'en',
          author: null,
        },
      } as Partial<ProjectManifest>,
    },
  ];

  for (const scenario of scenarios) {
    it(`golden: Next + Tailwind ${scenario.name}`, async () => {
      await expect(renderPlan(planFor(tw(scenario.over)).plan, TEMPLATES_ROOT)).toMatchFileSnapshot(
        scenario.file,
      );
    });
  }
});
