import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASTRO_DECLARATION } from '../src/adapters/astro.js';
import { contributedFiles, planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { MUI_DECLARATION } from '../src/adapters/mui.js';
import {
  NEXTJS_ARCHITECTURE,
  NEXTJS_DECLARATION,
  NEXTJS_TEMPLATE_MANIFEST,
} from '../src/adapters/nextjs.js';
import { REACT_DECLARATION } from '../src/adapters/react.js';
import { REACT_ROUTER_DECLARATION } from '../src/adapters/react-router.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { BOOTSTRAP_DECLARATION } from '../src/adapters/bootstrap.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import { parseCliArgs } from '../src/args.js';
import { resolveContext } from '../src/context/resolve.js';
import { NonInteractivePrompter } from '../src/context/prompts.js';
import type { AdapterDeclaration, ProjectManifest } from '../src/domain/index.js';
import { emptyContribution } from '../src/domain/contributions.js';
import { definesRole, evaluateCombination, resolveRole } from '../src/domain/index.js';
import { type CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { emptyFs, FakePrompter, renderPlan, TEST_CWD } from './helpers.js';
import type { FakeAnswers } from './helpers.js';

/**
 * Next.js, and the question a third framework exists to answer.
 *
 * Astro proved the V2 contract could describe an existing product. React proved
 * it generalised to a second framework with a separate build tool. Both of those
 * were, in hindsight, the easy direction: Astro and React overlap in almost
 * nothing, so "no shared assumptions" was cheap to hold.
 *
 * Next is the hard direction. It provides `react-runtime`, so every React-only
 * library in the registry is a *candidate* rather than obviously excluded, and
 * every refusal below has to be earned by a capability that is actually
 * different rather than by a rule that names a framework.
 *
 * The sharpest tests here are therefore the refusals and the structural ones:
 * that the compatibility engine never learned Next exists, that the starter
 * contract never learned where Next puts a page, and that MUI and React Router
 * are refused for a reason a reader can check rather than because somebody
 * wrote them down as incompatible.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const NEXT_TEMPLATE = path.join(TEMPLATES_ROOT, 'nextjs');
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const nextManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
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

const planNext = (over: Partial<ProjectManifest> = {}) =>
  planManifest(nextManifest(over), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: over.starter ?? 'coming-soon',
  });

const pathsOf = (over: Partial<ProjectManifest> = {}): readonly string[] =>
  planNext(over).plan.operations.map((operation) => operation.path);

const fileAt = (file: string, over: Partial<ProjectManifest> = {}): string => {
  const operation = planNext(over).plan.operations.find((entry) => entry.path === file);
  if (operation === undefined) throw new Error(`no operation for ${file}`);
  return operation.type === 'write' ? operation.content : '';
};

/** Message and hint together - the engine puts the detail in the hint. */
const refusalText = (over: Partial<ProjectManifest>): string => {
  try {
    resolveProject(nextManifest(over), adapters);
  } catch (error) {
    const cli = error as CliError;
    return `${cli.message}\n${cli.hint ?? ''}`;
  }
  return expect.unreachable('the combination was accepted');
};

/** A generated file with its prose removed, for assertions about code. */
const bodyAt = (file: string, over: Partial<ProjectManifest> = {}): string =>
  fileAt(file, over)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const code = (relative: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('Next.js is a framework adapter like the other two', () => {
  it('declares the identity the stage specifies', () => {
    expect(NEXTJS_DECLARATION.id).toBe('nextjs');
    expect(NEXTJS_DECLARATION.kind).toBe('framework');
    expect(NEXTJS_DECLARATION.displayName).toBe('Next.js');
  });

  it('is implemented, and joins the other two rather than replacing them', () => {
    expect(adapters.implementedFrameworks()).toEqual(['astro', 'nextjs', 'react']);
    expect(adapters.hasFramework('nextjs')).toBe(true);
  });

  it('fixes every dimension it owns, so none of them is a question', () => {
    const next = adapters.framework('nextjs');
    expect(next.ownsBuildTool).toBe(true);
    expect(next.buildTools).toEqual({ kind: 'fixed', value: 'next' });
    expect(next.languages).toEqual({ kind: 'fixed', value: 'ts' });
    expect(next.routers).toEqual({ kind: 'fixed', value: 'file-based' });
    expect(next.architectures).toEqual({ kind: 'fixed', value: 'next-app' });
  });

  it('records its own template identity rather than inheriting V1s', () => {
    // Without this the bridge falls back to the V1 registry's default and the
    // generated `.client-site.json` says the project was made from
    // `astro-tailwind` by `astro`. It said exactly that until this was added.
    expect(NEXTJS_TEMPLATE_MANIFEST.id).toBe('nextjs');
    expect(NEXTJS_TEMPLATE_MANIFEST.framework).toBe('nextjs');
    expect(NEXTJS_TEMPLATE_MANIFEST.supportedModes).toEqual(['coming-soon', 'full']);

    const provenance = JSON.parse(fileAt('.client-site.json')) as {
      template: { id: string; framework: string };
    };
    expect(provenance.template.id).toBe('nextjs');
    expect(provenance.template.framework).toBe('nextjs');
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe('it provides what is true and nothing that is convenient', () => {
  it('provides the three the stage names', () => {
    for (const capability of [
      'react-runtime',
      'document-metadata',
      'file-based-routing',
    ] as const) {
      expect(NEXTJS_DECLARATION.provides).toContain(capability);
    }
  });

  it('does not provide client-side routing, SPA routing or Vite plugins', () => {
    // Each of these would be a lie that the compatibility engine could not
    // catch, because the engine believes what an adapter declares.
    for (const capability of ['client-side-routing', 'spa-routing', 'vite-plugins'] as const) {
      expect(NEXTJS_DECLARATION.provides, capability).not.toContain(capability);
    }
  });

  it('provides a client app root, which is what lets context be mounted', () => {
    // Withheld through Stage 25, correctly: the architecture mapped no
    // `app.providers`. Stage 26 mapped it and made the layout wrap whatever
    // fills it, which is what earns the capability rather than asserting it.
    expect(NEXTJS_DECLARATION.provides).toContain('client-app-root');
    expect(REACT_DECLARATION.provides).toContain('client-app-root');
  });

  it('provides a composed stylesheet, and must not stop', () => {
    /*
     * The regression guard for Stage 24R. This was withheld through Stage 23
     * on grounds that Stage 23 itself had made false - the template stopped
     * shipping `styles/globals.css` and the declaration was never updated.
     * Asserting it here means the stale claim cannot come back quietly.
     */
    expect(NEXTJS_DECLARATION.provides).toContain('composed-stylesheet');
    // And the arrangement that makes it true: nothing ships the stylesheet
    // from a template layer, so composition decides the one owner.
    expect(adapters.framework('nextjs').templateOwnedRoles).not.toContain('styles.global');
  });

  it('keeps the not-found page the template ships, against a contribution', () => {
    /*
     * What `templateOwnedRoles` is actually for, asserted as behaviour.
     *
     * Stage 54 mutated the declaration - dropping `page.notFound` from Next's
     * list - and the whole suite still passed, because nothing contributes
     * there today and the entry was only a true statement nobody checked. It is
     * not inert, though: the list is what makes `contributedFiles` step aside
     * for a role the template owns, so removing it would let a later
     * contribution claim `app/not-found.tsx` and quietly replace the page the
     * framework router actually reaches. A synthetic contribution is enough to
     * show which of the two wins.
     */
    const { project } = resolveProject(nextManifest(), adapters);
    expect(project.templateOwnedRoles).toContain('page.notFound');

    const intruder = {
      ...emptyContribution('feature:synthetic'),
      files: [
        {
          owner: 'feature:synthetic',
          target: { kind: 'role', role: 'page.notFound' },
          intent: 'create',
          payload: { kind: 'text', content: 'export default function Replaced() {}\n' },
          order: 10,
        },
      ],
    } as never;

    const written = contributedFiles(project, [intruder], () => '');
    expect(
      written.map((operation) => operation.path),
      'a contribution claimed the role the template owns',
    ).not.toContain(resolveRole(NEXTJS_ARCHITECTURE, 'page.notFound'));

    // And the planned project still ships the template's own page.
    expect(fileAt('app/not-found.tsx')).toContain('This page doesn&apos;t exist.');
  });

  it('still does not provide a composed head', () => {
    // The sibling capability, and still absent for its own unchanged reason:
    // the layout declares its own `metadata` export and reads no
    // contributions, so a feature writing into the head would vanish.
    expect(NEXTJS_DECLARATION.provides).not.toContain('composed-metadata');
  });

  it('asks nothing of the rest of the stack', () => {
    expect(NEXTJS_DECLARATION.requires).toEqual([]);
  });

  it('names no other adapter anywhere in what it declares', () => {
    const declared = JSON.stringify(NEXTJS_DECLARATION).toLowerCase();
    for (const name of ['astro', 'vite', 'tailwind', 'bootstrap', 'mui', 'react-router']) {
      expect(declared, `the declaration mentions ${name}`).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Compatibility - every refusal earned by a capability
// ---------------------------------------------------------------------------

describe('the supported combinations resolve', () => {
  it('accepts Next on its own', () => {
    const report = checkCompatibility(nextManifest(), adapters);
    expect(report.compatible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('accepts both starters', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      expect(checkCompatibility(nextManifest({ starter }), adapters).compatible, starter).toBe(
        true,
      );
    }
  });
});

describe('every refusal comes from the engine, not from a branch', () => {
  it('accepts Tailwind, through the PostCSS pipeline rather than Vite', () => {
    // Refused until Stage 23, and for a reason that turned out to be
    // over-specified rather than wrong: Tailwind asked for `vite-plugins` when
    // what it needs is one of its two build plugins to have somewhere to run.
    expect(checkCompatibility(nextManifest({ styling: 'tailwind' }), adapters).compatible).toBe(
      true,
    );
  });

  it('accepts Bootstrap, because it composes its stylesheet', () => {
    // Refused through Stage 23, and the refusal turned out to be an artifact:
    // Stage 23 moved the stylesheet out of the template layer, which is
    // exactly what `composed-stylesheet` means, and the declaration lagged.
    expect(checkCompatibility(nextManifest({ styling: 'bootstrap' }), adapters).compatible).toBe(
      true,
    );
  });

  it('accepts MUI, now that there is a client root to mount a theme above', () => {
    // Refused through Stage 25 for a reason that was real at the time: the
    // architecture had nowhere to put a provider. See next-mui.test.ts.
    expect(checkCompatibility(nextManifest({ uiLibrary: 'mui' }), adapters).compatible).toBe(true);
  });

  it('refuses React Router, for the same missing capability', () => {
    expect(refusalText({ router: 'react-router' })).toContain('client-app-root');
  });

  it('refuses the client route fallback, because nothing routes in the browser', () => {
    expect(refusalText({ features: ['client-route-fallback'] })).toContain('client-side-routing');
  });

  it('refuses the head features, because Next composes no head', () => {
    // Each of these produced a byte-identical project before Stage 22 added
    // `composed-metadata`: the contribution was accepted and then dropped.
    // SEO left this list in Stage 51: it asks for the canonical surface Next
    // has, not the whole metadata surface it does not.
    for (const feature of ['structured-data', 'accessibility'] as const) {
      expect(refusalText({ features: [feature] }), feature).toContain('composed-metadata');
    }
  });

  it('places not-found now that a page is written for it', () => {
    /*
     * Until Stage 50 this refused, and the refusal was the honest one: Next
     * genuinely has file-based routing, so the capability engine accepted the
     * feature, and planning then failed because no path existed for the role.
     * Accepted-then-unbuildable is what mapping a role to nothing produces.
     * The template now ships the page, so both halves agree.
     */
    expect(() => planNext({ features: ['not-found'] })).not.toThrow();
    expect(pathsOf({ features: ['not-found'] })).toContain('app/not-found.tsx');
  });

  it('explains every refusal with a capability, never with a verdict', () => {
    /*
     * The whole point: a reader is told which capability is involved, never
     * "Next.js does not support X".
     *
     * A conflict names the adapter that *provides* the conflicting capability -
     * "which framework:nextjs provides" - and that is the engine's generic
     * rendering rather than a framework-specific message. It would say
     * "styling:bootstrap" just as readily. So the assertion is about the shape
     * of the explanation, not about whether the word appears.
     */
    for (const over of [{ router: 'react-router' } as const]) {
      const text = refusalText(over).toLowerCase();
      expect(text).toMatch(/requires [a-z-]+ \(|cannot be combined with [a-z-]+ \(/);
      expect(text).not.toContain('does not support');
      expect(text).not.toContain('next.js');
      expect(text).not.toContain('incompatible with next');
    }
  });

  it('a library is accepted or refused by capability, never by framework', () => {
    // MUI composes on both, because both provide what it asks for. React
    // Router composes only where nothing else already routes - a conflict
    // rather than a missing capability, and why the two diverge on Next
    // despite having had identical requirements.
    // React's own stylesheet requirement is satisfied so that what is being
    // measured is the library, not React's architecture.
    expect(
      evaluateCombination([REACT_DECLARATION, BOOTSTRAP_DECLARATION, MUI_DECLARATION]).compatible,
    ).toBe(true);
    expect(evaluateCombination([NEXTJS_DECLARATION, MUI_DECLARATION]).compatible).toBe(true);
    expect(
      evaluateCombination([REACT_DECLARATION, BOOTSTRAP_DECLARATION, REACT_ROUTER_DECLARATION])
        .compatible,
    ).toBe(true);
    expect(evaluateCombination([NEXTJS_DECLARATION, REACT_ROUTER_DECLARATION]).compatible).toBe(
      false,
    );
  });

  it('a hypothetical framework with a client root satisfies both, without being React', () => {
    // The strongest available statement: nothing in either library names a
    // framework, so a framework nobody has written works the day it declares
    // the right facts.
    const hypothetical: AdapterDeclaration = {
      id: 'somethingelse' as never,
      kind: 'framework',
      displayName: 'A framework that is not React and not Next',
      provides: ['react-runtime', 'client-app-root', 'jsx'],
      requires: [],
    };
    expect(evaluateCombination([hypothetical, MUI_DECLARATION]).compatible).toBe(true);
    expect(evaluateCombination([hypothetical, REACT_ROUTER_DECLARATION]).compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The architecture
// ---------------------------------------------------------------------------

describe('the App Router architecture', () => {
  it('is one opinionated arrangement, with no alternative offered', () => {
    expect(NEXTJS_ARCHITECTURE.id).toBe('next-app');
    expect(adapters.framework('nextjs').architectureDefinitions).toHaveLength(1);
  });

  it('maps the two roles the starter contract needs', () => {
    expect(NEXTJS_ARCHITECTURE.roles['app.layout']).toBe('app/layout.tsx');
    expect(NEXTJS_ARCHITECTURE.roles['page.home']).toBe('app/page.tsx');
  });

  it('maps no role it cannot fill', () => {
    // `app.providers` and `app.router` are unmapped for the same reason MUI and
    // React Router are refused. `app.providers` left this list in Stage 26: the
    // layout wraps the application in it. `page.notFound` left it in Stage 50,
    // when the template started shipping the file the role points at.
    for (const role of ['app.router', 'app.entry', 'app.root'] as const) {
      expect(definesRole(NEXTJS_ARCHITECTURE, role), role).toBe(false);
    }
    expect(definesRole(NEXTJS_ARCHITECTURE, 'app.providers')).toBe(true);
    expect(definesRole(NEXTJS_ARCHITECTURE, 'page.notFound')).toBe(true);
  });

  it('uses the App Router and neither pages/ nor src/', () => {
    for (const file of pathsOf({ starter: 'full' })) {
      expect(file.startsWith('pages/'), file).toBe(false);
      expect(file.startsWith('src/'), file).toBe(false);
    }
    expect(pathsOf()).toContain('app/page.tsx');
    expect(pathsOf()).toContain('app/layout.tsx');
  });

  it('claims only directories the generated project really has', () => {
    const produced = new Set<string>();
    for (const file of pathsOf({ starter: 'full' })) {
      const dir = file.split('/').slice(0, -1).join('/');
      if (dir !== '') produced.add(dir);
    }
    produced.add('public');
    for (const directory of NEXTJS_ARCHITECTURE.directories) {
      expect(
        produced.has(directory),
        `architecture claims "${directory}" but nothing is in it`,
      ).toBe(true);
    }
  });

  it('resolves Next extensions, not Astro or React ones', () => {
    const { project } = resolveWithAdapters(nextManifest(), TEMPLATES_ROOT);
    expect(project.extensions.source).toBe('.ts');
    expect(project.extensions.component).toBe('.tsx');
    // .ts, where Astro resolved .mjs: next.config.ts is TypeScript natively.
    expect(project.extensions.config).toBe('.ts');
  });
});

// ---------------------------------------------------------------------------
// The generated project
// ---------------------------------------------------------------------------

describe('what a Next project contains', () => {
  it('generates the structure the stage specifies', () => {
    const files = pathsOf({ starter: 'full' });
    for (const file of [
      'app/layout.tsx',
      'app/page.tsx',
      'components/ui/Mark.tsx',
      'lib/site.config.ts',
      'next.config.ts',
      'package.json',
      'styles/globals.css',
      'tsconfig.json',
    ]) {
      expect(files, file).toContain(file);
    }
  });

  it('the layout owns html, body, metadata and the stylesheet', () => {
    const layout = fileAt('app/layout.tsx');
    expect(layout).toMatch(/<html lang=/);
    expect(layout).toContain('<body>');
    expect(layout).toContain('export const metadata');
    expect(layout).toContain("'../styles/globals.css'");
  });

  it('claims no SEO beyond a baseline title and description', () => {
    const layout = bodyAt('app/layout.tsx');
    expect(layout).toContain('title');
    expect(layout).toContain('description');
    // The SEO feature is refused here, so the layout must not pretend to it.
    for (const invented of ['openGraph', 'twitter', 'canonical', 'robots']) {
      expect(layout, `layout claims ${invented}`).not.toContain(invented);
    }
  });

  it('is server-rendered throughout - no client component in either starter', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      for (const file of pathsOf({ starter })) {
        if (!file.endsWith('.tsx')) continue;
        expect(bodyAt(file, { starter }), `${starter}/${file}`).not.toContain('use client');
      }
    }
  });

  it('the coming-soon page has no countdown and no script', () => {
    const page = bodyAt('app/page.tsx');
    expect(page.toLowerCase()).not.toContain('countdown');
    expect(page).not.toContain('useState');
    expect(page).not.toContain('useEffect');
    expect(page).toContain('Coming soon');
  });

  it('the full page has hero, sections, CTA and footer, and nothing interactive', () => {
    const page = bodyAt('app/page.tsx', { starter: 'full' });
    // The same three sections React's full starter uses. Stage 23 aligned the
    // two so both render through one shared style contract.
    for (const section of ['About', 'Work', 'Contact', 'Get in touch']) {
      expect(page, section).toContain(section);
    }
    expect(page).toContain('<header');
    expect(page).toContain('<footer');
    expect(page).not.toContain('useState');
  });

  it('styles are plain CSS with no framework anywhere', () => {
    const css = bodyAt('styles/globals.css');
    for (const marker of ['@tailwind', '@apply', 'bootstrap', '@use ', '$']) {
      expect(css, `globals.css contains ${marker}`).not.toContain(marker);
    }
    expect(css).toContain(':root');
  });

  it('depends on the Next baseline and nothing else', () => {
    const pkg = JSON.parse(fileAt('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['next', 'react', 'react-dom']);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([
      '@types/node',
      '@types/react',
      'typescript',
    ]);
    // No Vite, no Tailwind, no plugin: the things a React project needs and
    // this one does not.
    const all = JSON.stringify(pkg);
    for (const absent of ['vite', 'tailwind', '@mui', 'react-router']) {
      expect(all, `package.json mentions ${absent}`).not.toContain(absent);
    }
  });

  it('uses native Next commands for dev, build and start', () => {
    const pkg = JSON.parse(fileAt('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['dev']).toBe('next dev');
    expect(pkg.scripts['build']).toBe('next build');
    expect(pkg.scripts['start']).toBe('next start');
    // No `lint`: Next 16 removed `next lint`, and binding the script to
    // anything else would need ESLint, which is outside this baseline. The
    // README says so rather than leaving a reader to discover it.
    expect(pkg.scripts['lint']).toBeUndefined();
    expect(fileAt('README.md')).toContain('next lint');
  });

  it('pins exactly the versions the template declares', () => {
    const templatePkg = JSON.parse(
      readFileSync(path.join(NEXT_TEMPLATE, 'base', '_package.json'), 'utf8'),
    ) as { engines: { node: string } };
    const generated = JSON.parse(fileAt('package.json')) as { engines: { node: string } };
    expect(generated.engines.node).toBe(templatePkg.engines.node);
  });

  it('ignores what Next actually produces', () => {
    const ignore = fileAt('.gitignore');
    for (const entry of ['.next', 'next-env.d.ts', 'node_modules']) {
      expect(ignore, entry).toContain(entry);
    }
    // Vite's outputs, which this project never creates.
    expect(ignore).not.toContain('dist-ssr');
  });

  it('is deterministic', () => {
    expect(renderPlan(planNext().plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planNext().plan, TEMPLATES_ROOT),
    );
  });
});

// ---------------------------------------------------------------------------
// The starter contract, unchanged
// ---------------------------------------------------------------------------

describe('Next uses the same starter abstraction as the other two', () => {
  it('contributes a base layer and one starter layer, like everyone else', () => {
    for (const starter of ['coming-soon', 'full'] as const) {
      const layers = resolveWithAdapters(nextManifest({ starter }), TEMPLATES_ROOT)
        .contributions.filter((entry) => entry.owner === 'framework:nextjs')
        .flatMap((entry) => entry.templateLayers);
      expect(layers.map((layer) => layer.name)).toEqual(['base', `modes/${starter}`]);
      expect(layers[0]!.order).toBeLessThan(layers[1]!.order);
      expect(layers.every((layer) => layer.owner === 'framework:nextjs')).toBe(true);
    }
  });

  it('requires the starter guarantee, resolved through its own architecture', () => {
    const { project } = resolveProject(nextManifest(), adapters);
    expect(project.requiredRoles).toContain('page.home');
    expect(resolveRole(project.architecture, 'page.home')).toBe('app/page.tsx');
  });

  it('the two starters differ in the page and share everything else', () => {
    const comingSoon = new Set(pathsOf());
    const full = new Set(pathsOf({ starter: 'full' }));
    expect(comingSoon.has('app/page.tsx')).toBe(true);
    expect(full.has('app/page.tsx')).toBe(true);
    expect(fileAt('app/page.tsx')).not.toBe(fileAt('app/page.tsx', { starter: 'full' }));
    // The full starter adds one component; nothing else moves.
    expect([...full].filter((file) => !comingSoon.has(file))).toEqual([
      'components/ui/Section.tsx',
    ]);
  });

  it('adds no starter definition of its own', () => {
    // Three frameworks, still two starters. The Stage 21 invariant, checked
    // from the far side.
    expect(readdirSync(path.join(NEXT_TEMPLATE, 'modes')).sort()).toEqual(['coming-soon', 'full']);
  });
});

// ---------------------------------------------------------------------------
// Structural: nothing anywhere else learned that Next exists
// ---------------------------------------------------------------------------

describe('nothing outside the adapter knows about Next', () => {
  it('the compatibility engine never mentions it', () => {
    for (const file of [
      'src/domain/compatibility.ts',
      'src/domain/capabilities.ts',
      'src/adapters/selection.ts',
    ]) {
      expect(code(file).toLowerCase(), `${file} mentions next`).not.toContain('next');
    }
  });

  it('the starter contract knows no Next path and no Next name', () => {
    const starter = code('src/domain/starter.ts').toLowerCase();
    expect(starter).not.toContain('next');
    expect(starter).not.toContain('app/');
    expect(starter).not.toContain('.tsx');
  });

  it('the feature adapters are unchanged by its arrival', () => {
    for (const file of [
      'src/adapters/seo.ts',
      'src/adapters/structured-data.ts',
      'src/adapters/accessibility.ts',
      'src/adapters/not-found.ts',
      'src/adapters/client-route-fallback.ts',
    ]) {
      expect(code(file).toLowerCase(), `${file} mentions next`).not.toContain('next');
    }
  });

  it('no other adapter names it', () => {
    for (const file of [
      'src/adapters/astro.ts',
      'src/adapters/react.ts',
      'src/adapters/tailwind.ts',
      'src/adapters/bootstrap.ts',
      'src/adapters/react-router.ts',
      'src/adapters/vite.ts',
    ]) {
      expect(code(file).toLowerCase(), `${file} mentions nextjs`).not.toContain('nextjs');
    }
    /*
     * MUI is checked differently since Stage 26. Its adapter names
     * `@mui/material-nextjs` - MUI's own package, named by its vendor after the
     * framework it targets - in a dependency entry and a template import. What
     * it must not contain is a *branch* on the framework.
     */
    const mui = code('src/adapters/mui.ts');
    expect(mui).not.toMatch(/framework\s*[=!]==/);
    expect(mui).toContain("capabilities.has('server-inserted-head')");
  });

  it('the Next adapter imports no Vite and no other adapter', () => {
    const next = code('src/adapters/nextjs.ts');
    expect(next).not.toContain('vite');
    expect(next).not.toMatch(/from '\.\/(astro|react|tailwind|bootstrap|mui|vite)/);
  });

  it('the Next adapter touches no filesystem or process API', () => {
    const next = code('src/adapters/nextjs.ts');
    for (const module of ['node:fs', 'node:child_process', 'node:process', 'node:os']) {
      expect(next.includes(`'${module}'`), `imports ${module}`).toBe(false);
    }
  });

  it('contribution is a pure function of the resolved project', () => {
    const { project } = resolveProject(nextManifest(), adapters);
    const next = adapters.framework('nextjs');
    expect(next.contribute(project)).toEqual(next.contribute(project));
  });

  it('Astro and React still declare exactly what they did', () => {
    // A third framework must not have moved the other two. `composed-metadata`
    // is the one addition, on Astro, and it is additive.
    expect(ASTRO_DECLARATION.provides).toContain('vite-plugins');
    expect(ASTRO_DECLARATION.provides).not.toContain('react-runtime');
    expect(REACT_DECLARATION.provides).not.toContain('file-based-routing');
    expect(REACT_DECLARATION.provides).not.toContain('document-metadata');
  });
});

// ---------------------------------------------------------------------------
// Selection and the CLI
// ---------------------------------------------------------------------------

describe('selection treats Next like any other framework', () => {
  it('selects the framework adapter and no build-tool adapter', () => {
    const refs = selectAdapters(nextManifest(), adapters).adapters.map((entry) => entry.ref);
    expect(refs).toContain('framework:nextjs');
    // Next is its own build tool, so there is nothing else to select - and no
    // styling adapter either, because the template ships the stylesheet.
    expect(refs).toEqual(['framework:nextjs']);
  });

  it('derives the whole stack from the framework alone', async () => {
    const resolution = await resolveContext({
      flags: parseCliArgs(['acme-site', '--yes', '--framework', 'nextjs']),
      cwd: TEST_CWD,
      env: {},
      prompter: new NonInteractivePrompter('test'),
      registry: v1Registry,
      cliVersion: '9.9.9',
      now: new Date('2026-01-01T00:00:00.000Z'),
      templatesRoot: TEMPLATES_ROOT,
      fs: emptyFs,
    });
    expect(resolution.manifest).toMatchObject({
      framework: 'nextjs',
      buildTool: 'next',
      language: 'ts',
      styling: 'none',
      uiLibrary: 'none',
      router: 'file-based',
      architecture: 'next-app',
      starter: 'coming-soon',
      features: [],
    });
  });

  it('a config file naming only the framework resolves the same way', async () => {
    const resolution = await resolveContext({
      flags: parseCliArgs(['acme-site', '--yes', '--from', 'clientkit.json']),
      cwd: TEST_CWD,
      env: {},
      prompter: new NonInteractivePrompter('test'),
      registry: v1Registry,
      cliVersion: '9.9.9',
      now: new Date('2026-01-01T00:00:00.000Z'),
      templatesRoot: TEMPLATES_ROOT,
      fs: emptyFs,
      readFile: () => JSON.stringify({ stack: { framework: 'nextjs' } }),
    });
    expect(resolution.manifest.framework).toBe('nextjs');
    expect(resolution.manifest.buildTool).toBe('next');
    expect(resolution.manifest.styling).toBe('none');
  });

  it('credits the framework, not the built-in default, for what it settles', async () => {
    const resolution = await resolveContext({
      flags: parseCliArgs(['acme-site', '--yes', '--framework', 'nextjs']),
      cwd: TEST_CWD,
      env: {},
      prompter: new NonInteractivePrompter('test'),
      registry: v1Registry,
      cliVersion: '9.9.9',
      now: new Date('2026-01-01T00:00:00.000Z'),
      templatesRoot: TEMPLATES_ROOT,
      fs: emptyFs,
    });
    // Stage 19's vocabulary, unchanged: a value the adapter decided reads as
    // `adapter`, not as `default`.
    expect(resolution.stack['styling']).toBe('adapter');
    expect(resolution.stack['uiLibrary']).toBe('adapter');
  });

  it('an explicit styling flag beats the framework default', async () => {
    /*
     * The important half of `defaultStyling`: it settles the unstated case
     * only. Through Stage 23 this was provable by a refusal - Bootstrap was
     * rejected, so the flag had demonstrably survived. Every styling value Next
     * accepts now resolves, so the same claim is made positively instead: each
     * one arrives at the manifest as itself rather than as `none`.
     */
    for (const styling of ['tailwind', 'bootstrap', 'none'] as const) {
      const { project } = resolveProject(nextManifest({ styling }), adapters);
      expect(project.manifest.styling, styling).toBe(styling);
    }
  });
});

// ---------------------------------------------------------------------------
// Interactive
// ---------------------------------------------------------------------------

describe('choosing Next.js asks nothing that has one answer', () => {
  const menus = async (answers: FakeAnswers) => {
    const prompter = new FakePrompter({ dir: 'acme-site', ...answers });
    const resolution = await resolveContext({
      flags: parseCliArgs(['acme-site']),
      cwd: TEST_CWD,
      env: {},
      prompter,
      registry: v1Registry,
      cliVersion: '9.9.9',
      now: new Date('2026-01-01T00:00:00.000Z'),
      templatesRoot: TEMPLATES_ROOT,
      fs: emptyFs,
    });
    return { asked: prompter.asked, manifest: resolution.manifest };
  };

  it('skips every question with one viable answer', async () => {
    const { asked } = await menus({ dimensions: { framework: 'nextjs' } });
    // `uiLibrary` left this list in Stage 26: MUI resolves on Next now, so the
    // question has two viable answers and is worth asking. The menu is filtered
    // by the engine, not by a framework branch.
    for (const dimension of ['router', 'buildTool', 'language', 'architecture']) {
      expect(asked, `asked for ${dimension}`).not.toContain(dimension);
    }
    expect(asked).toContain('uiLibrary');
  });

  it('does ask for styling, because Tailwind and plain CSS both resolve', async () => {
    // This was skipped through Stage 22, when `none` was the only viable
    // answer. It is a real choice now, and the menu is filtered by the engine
    // rather than by a list: Bootstrap is absent because Next provides no
    // `composed-stylesheet`, not because anything here says so.
    const { asked } = await menus({ dimensions: { framework: 'nextjs' } });
    expect(asked).toContain('styling');
  });

  it('and still derives every one of them correctly', async () => {
    const { manifest } = await menus({ dimensions: { framework: 'nextjs' } });
    expect(manifest.framework).toBe('nextjs');
    expect(manifest.buildTool).toBe('next');
    expect(manifest.styling).toBe('none');
    expect(manifest.uiLibrary).toBe('none');
    expect(manifest.router).toBe('file-based');
    expect(manifest.architecture).toBe('next-app');
  });

  it('still asks the other two frameworks what it always asked', async () => {
    // A third framework skipping questions must not have made them disappear
    // for everyone else.
    const { asked } = await menus({ dimensions: { framework: 'react' } });
    expect(asked).toContain('styling');
  });
});

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

describe('golden: Next.js + TypeScript', () => {
  const scenarios = [
    { name: 'Coming Soon + URL', file: './golden/next-coming-soon-url.txt', over: {} },
    {
      name: 'Full + URL',
      file: './golden/next-full-url.txt',
      over: { starter: 'full' } as Partial<ProjectManifest>,
    },
    {
      name: 'URL-less',
      file: './golden/next-url-less.txt',
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
    it(`golden: Next ${scenario.name}`, async () => {
      await expect(renderPlan(planNext(scenario.over).plan, TEMPLATES_ROOT)).toMatchFileSnapshot(
        scenario.file,
      );
    });
  }
});
