import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { mergeScripts } from '../src/domain/package-composition.js';

import { planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import {
  REACT_ARCHITECTURE,
  REACT_DECLARATION,
  REACT_TEMPLATE_MANIFEST,
} from '../src/adapters/react.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import { TAILWIND_DECLARATION } from '../src/adapters/tailwind.js';
import { VITE_DECLARATION } from '../src/adapters/vite.js';
import { definesRole, evaluateCombination, resolveRole } from '../src/domain/index.js';
import type { ProjectManifest } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * The React + Vite stack.
 *
 * These are the Stage 4 proof. The claim is not "a React project was
 * generated" - it is that a second framework and a separate build tool compose
 * through the same generic machinery, with no case for React in the
 * compatibility engine, no edit to the Tailwind adapter, and no movement in
 * Astro's output.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const REACT_TEMPLATE = path.join(TEMPLATES_ROOT, 'react-vite');
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const reactManifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-app'),
  projectName: 'acme-app',
  framework: 'react',
  buildTool: 'vite',
  language: 'ts',
  styling: 'tailwind',
  uiLibrary: 'none',
  router: 'none',
  architecture: 'react-standard',
  features: ['starter:coming-soon'],
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

const planReact = (over: Partial<ProjectManifest> = {}) =>
  planManifest(reactManifest(over), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: over.features?.includes('starter:full') === true ? 'full' : 'coming-soon',
  });

const templatePackage = JSON.parse(
  readFileSync(path.join(REACT_TEMPLATE, 'base', '_package.json'), 'utf8'),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

// ---------------------------------------------------------------------------

describe('React and Vite are separate dimensions', () => {
  it('React does not claim to be a build tool', () => {
    // The whole point of the stage. If React provided vite-plugins, a bundler
    // with no plugin system would satisfy Tailwind's requirement and the
    // compatibility engine could not tell.
    expect(REACT_DECLARATION.provides).not.toContain('vite-plugins');
    expect(VITE_DECLARATION.provides).toContain('vite-plugins');
  });

  it('React declares that it does not own a build tool', () => {
    expect(adapters.framework('react').ownsBuildTool).toBe(false);
    expect(adapters.framework('astro').ownsBuildTool).toBe(true);
  });

  it('offers Vite as a choice rather than fixing it', () => {
    const react = adapters.framework('react');
    expect(react.buildTools.kind).toBe('choice');
    expect(adapters.framework('astro').buildTools.kind).toBe('fixed');
  });

  it('there is no react-vite framework id', () => {
    // The failure mode this stage exists to avoid: a combined product masking
    // two dimensions as one.
    expect(adapters.implementedFrameworks()).toEqual(['astro', 'react']);
    expect(adapters.implementedBuildTools()).toEqual(['vite']);
  });

  it('Vite contributes nothing that knows React exists', () => {
    // Asserted on what the adapter produces rather than on its source text: the
    // file's comments explain the separation and say "React" while doing so,
    // which is documentation, not coupling. What matters is that nothing Vite
    // declares or contributes varies with, or refers to, the framework.
    const vite = adapters.buildTool('vite');
    const { project } = resolveProject(reactManifest(), adapters);
    const emitted = JSON.stringify([
      vite.declaration,
      vite.resolve(reactManifest()),
      vite.contribute(project),
    ]);
    expect(emitted.toLowerCase()).not.toContain('react');

    // and it resolves identically whichever framework asked for it
    expect(vite.resolve(reactManifest())).toEqual(
      vite.resolve({ ...reactManifest(), framework: 'astro' }),
    );
  });
});

describe('React capabilities and compatibility', () => {
  it('provides the runtime a future component library will require', () => {
    expect(REACT_DECLARATION.provides).toContain('react-runtime');
    expect(REACT_DECLARATION.provides).toContain('jsx');
  });

  it('React + Vite + Tailwind is compatible', () => {
    const report = checkCompatibility(reactManifest(), adapters);
    expect(report.compatible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("Tailwind's requirement is satisfied by Vite here, and by Astro there", () => {
    // The same unmodified Tailwind declaration, satisfied by two different
    // providers. This is the capability model doing the work.
    const onReact = checkCompatibility(reactManifest(), adapters);
    expect(onReact.index.providers.get('vite-plugins')).toEqual(['build-tool:vite']);

    const onAstro = evaluateCombination([
      adapters.framework('astro').declaration,
      TAILWIND_DECLARATION,
    ]);
    expect(onAstro.index.providers.get('vite-plugins')).toEqual(['framework:astro']);
    expect(onAstro.compatible).toBe(true);
  });

  it('the Tailwind adapter still names no framework', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src/adapters/tailwind.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/if\s*\(.*framework/i);
    expect(JSON.stringify(TAILWIND_DECLARATION)).not.toContain('react');
    expect(JSON.stringify(TAILWIND_DECLARATION)).not.toContain('astro');
  });

  it('rejects React paired with a build tool that provides no plugin pipeline', () => {
    // A hypothetical bundler, not an implementation. Tailwind's requirement is
    // unsatisfied and the engine says so without any rule naming either side.
    const plainBundler = {
      id: 'plainish',
      kind: 'build-tool' as const,
      displayName: 'Plainish',
      provides: [],
      requires: [],
    };
    const report = evaluateCombination([REACT_DECLARATION, plainBundler, TAILWIND_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(report.violations[0]?.adapter).toBe('styling:tailwind');
  });
});

describe('React selection and resolution', () => {
  it('selects framework, build tool and styling', () => {
    const selection = selectAdapters(reactManifest(), adapters);
    expect(selection.adapters.map((entry) => entry.ref)).toEqual([
      'framework:react',
      'build-tool:vite',
      'styling:tailwind',
    ]);
  });

  it('Astro still selects no build-tool adapter', () => {
    const astro = selectAdapters(
      {
        ...reactManifest(),
        framework: 'astro',
        buildTool: 'astro',
        architecture: 'astro-standard',
      },
      adapters,
    );
    expect(astro.adapters.map((entry) => entry.ref)).toEqual([
      'framework:astro',
      'styling:tailwind',
    ]);
  });

  it('resolves .tsx components, where Astro resolved .astro', () => {
    const { project } = resolveProject(reactManifest(), adapters);
    expect(project.extensions).toEqual({ source: '.ts', component: '.tsx', config: '.ts' });
  });

  it('takes the Node floor the stack actually needs', () => {
    const { project } = resolveProject(reactManifest(), adapters);
    // React and Vite both say 20.19; nothing here needs 22.12 the way Astro does.
    expect(project.minNode).toBe('>=20.19.0');
  });

  it('resolution is deterministic', () => {
    const a = resolveProject(reactManifest(), adapters);
    const b = resolveProject(reactManifest(), adapters);
    expect(a.project.extensions).toEqual(b.project.extensions);
    expect([...a.project.capabilities].sort()).toEqual([...b.project.capabilities].sort());
    expect(a.selection.adapters.map((x) => x.ref)).toEqual(b.selection.adapters.map((x) => x.ref));
  });

  it('rejects an architecture React does not offer', () => {
    expect(() =>
      resolveProject({ ...reactManifest(), architecture: 'astro-standard' }, adapters),
    ).toThrow(CliError);
  });
});

describe('React file roles', () => {
  it('maps roles onto a completely different tree from Astro', () => {
    expect(resolveRole(REACT_ARCHITECTURE, 'app.entry')).toBe('src/main.tsx');
    expect(resolveRole(REACT_ARCHITECTURE, 'app.root')).toBe('src/App.tsx');
    expect(resolveRole(REACT_ARCHITECTURE, 'styles.global')).toBe('src/styles/index.css');
    expect(resolveRole(REACT_ARCHITECTURE, 'config.build')).toBe('vite.config.ts');
  });

  it('maps the roles Astro leaves unmapped, and leaves ones Astro maps', () => {
    // The asymmetry the role indirection exists to absorb. Astro has no entry
    // module and no separate build config; React has no framework config file
    // and, without a router, no 404 page.
    const astro = adapters.framework('astro').architectureDefinitions[0]!;
    expect(definesRole(REACT_ARCHITECTURE, 'app.entry')).toBe(true);
    expect(definesRole(astro, 'app.entry')).toBe(false);
    expect(definesRole(REACT_ARCHITECTURE, 'config.build')).toBe(true);
    expect(definesRole(astro, 'config.build')).toBe(false);
    expect(definesRole(REACT_ARCHITECTURE, 'config.framework')).toBe(false);
    expect(definesRole(astro, 'config.framework')).toBe(true);
    expect(definesRole(REACT_ARCHITECTURE, 'page.notFound')).toBe(false);
    expect(definesRole(astro, 'page.notFound')).toBe(true);
  });

  it('every mapped role points at a file the plan actually produces', () => {
    const paths = new Set(planReact().plan.operations.map((operation) => operation.path));
    for (const [role, target] of Object.entries(REACT_ARCHITECTURE.roles)) {
      if (role === 'assets.public') continue; // a directory
      expect(paths.has(target), `role "${role}" -> ${target} is not generated`).toBe(true);
    }
  });

  it('claims only directories the generated project really has', () => {
    const produced = new Set<string>();
    for (const operation of planReact().plan.operations) {
      const dir = operation.path.split('/').slice(0, -1).join('/');
      if (dir !== '') produced.add(dir);
    }
    produced.add('public');
    for (const directory of REACT_ARCHITECTURE.directories) {
      expect(
        produced.has(directory),
        `architecture claims "${directory}" but nothing is in it`,
      ).toBe(true);
    }
  });
});

describe('React contributions', () => {
  const contributionsOf = (over: Partial<ProjectManifest> = {}) =>
    resolveWithAdapters(reactManifest(over), TEMPLATES_ROOT).contributions;

  it('declared dependencies match the package.json actually generated', () => {
    // Compared against the composed result rather than the template, because
    // as of Stage 5 they no longer come from one place: the framework template
    // carries React's and Vite's, and the styling adapter merges its own in.
    // Asserting on the end result is both correct and stronger - it catches a
    // declaration drifting from either source.
    const pkg = planReact().plan.operations.find((operation) => operation.path === 'package.json');
    const generated = JSON.parse(pkg?.type === 'write' ? pkg.content : '{}') as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const fromGenerated = { ...generated.dependencies, ...generated.devDependencies };
    const fromAdapters = Object.fromEntries(
      contributionsOf()
        .flatMap((c) => c.dependencies)
        .map((d) => [d.name, d.version]),
    );
    expect(fromAdapters).toEqual(fromGenerated);
  });

  it('the framework template carries no packages at all', () => {
    // Stage 5 removed the styling packages from here, which stopped every React
    // project installing Tailwind. Stage 6 removed the rest: the template now
    // describes the project's identity and the adapters describe its packages.
    // A dependency reappearing here would not break the build - the composer
    // ignores the field - which is precisely why it is worth asserting.
    expect(templatePackage.dependencies).toBeUndefined();
    expect(templatePackage.devDependencies).toBeUndefined();
    expect(templatePackage.scripts).toBeUndefined();
  });

  it('the framework and build tool contribute exactly the packages they own', () => {
    const declared = contributionsOf()
      .flatMap((c) => c.dependencies)
      .filter((d) => d.owner !== 'styling:tailwind' && d.owner !== 'styling:bootstrap');
    expect(declared.map((d) => d.name).sort()).toEqual([
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'react',
      'react-dom',
      'typescript',
      'vite',
    ]);
  });

  it('classifies prod and dev by what actually ships in the bundle', () => {
    const kinds = Object.fromEntries(
      contributionsOf()
        .flatMap((c) => c.dependencies)
        .map((d) => [d.name, d.kind]),
    );
    // Only what the browser loads at runtime is a production dependency.
    expect(kinds['react']).toBe('prod');
    expect(kinds['react-dom']).toBe('prod');
    for (const name of [
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'typescript',
      'vite',
      'tailwindcss',
      '@tailwindcss/vite',
    ]) {
      expect(kinds[name], `${name} should be a dev dependency`).toBe('dev');
    }
  });

  it('splits dependency ownership across the three adapters', () => {
    const byOwner = new Map<string, string[]>();
    for (const dependency of contributionsOf().flatMap((c) => c.dependencies)) {
      byOwner.set(dependency.owner, [...(byOwner.get(dependency.owner) ?? []), dependency.name]);
    }
    expect(byOwner.get('build-tool:vite')).toEqual(['vite']);
    expect(byOwner.get('styling:tailwind')?.sort()).toEqual(['@tailwindcss/vite', 'tailwindcss']);
    // @vitejs/plugin-react is React's: it exists because React was selected and
    // would be replaced wholesale if the framework changed.
    expect(byOwner.get('framework:react')).toContain('@vitejs/plugin-react');
    expect(byOwner.get('framework:react')).toContain('react');
  });

  it('scripts come from the right owners, in a deterministic order', () => {
    const scripts = contributionsOf().flatMap((c) => c.scripts);
    expect(Object.fromEntries(scripts.map((s) => [s.name, s.command]))).toEqual({
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
      typecheck: 'tsc --noEmit',
    });
    const owners = Object.fromEntries(scripts.map((s) => [s.name, s.owner]));
    expect(owners['dev']).toBe('build-tool:vite');
    expect(owners['build']).toBe('build-tool:vite');
    expect(owners['typecheck']).toBe('framework:react');

    // React resolves before Vite, so contribution order alone would put
    // typecheck first. The emitted order is the declared one instead, which is
    // what makes it independent of how adapters happen to be selected.
    expect(mergeScripts(scripts).map((s) => s.name)).toEqual([
      'dev',
      'build',
      'preview',
      'typecheck',
    ]);
  });

  it('every contribution carries an owner and a reason', () => {
    for (const contribution of contributionsOf()) {
      for (const item of [
        ...contribution.dependencies,
        ...contribution.scripts,
        ...contribution.templateLayers,
        ...contribution.config,
      ]) {
        expect(item.owner).toMatch(/^(framework|build-tool|styling):/);
        expect(item.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('selects the starter layer from the feature', () => {
    expect(
      contributionsOf()
        .flatMap((c) => c.templateLayers)
        .map((l) => l.name),
    ).toEqual(['base', 'modes/coming-soon']);
    expect(
      contributionsOf({ features: ['starter:full'] })
        .flatMap((c) => c.templateLayers)
        .map((l) => l.name),
    ).toEqual(['base', 'modes/full']);
  });
});

describe('vite.config.ts is composed, not templated', () => {
  it('is not a file in the React template', () => {
    // If it were, the template would hardcode Tailwind and break the moment
    // someone picks React without it.
    const base = readdirSync(path.join(REACT_TEMPLATE, 'base'));
    expect(base).not.toContain('vite.config.ts');
  });

  it('is produced by composing both adapters contributions', () => {
    const config = planReact().plan.operations.find(
      (operation) => operation.path === 'vite.config.ts',
    );
    expect(config).toBeDefined();
    expect(config?.origin).toContain('framework:react');
    expect(config?.origin).toContain('styling:tailwind');

    const content = config?.type === 'write' ? config.content : '';
    expect(content).toContain("import react from '@vitejs/plugin-react';");
    expect(content).toContain("import tailwindcss from '@tailwindcss/vite';");
    expect(content).toContain('react(),');
    expect(content).toContain('tailwindcss(),');
  });

  it('composes nothing for Astro, whose architecture defines no build config', () => {
    const astro = adapters.framework('astro').architectureDefinitions[0]!;
    expect(definesRole(astro, 'config.build')).toBe(false);
  });
});

describe('golden: React + Vite + TypeScript + Tailwind', () => {
  const scenarios = [
    { name: 'Coming Soon + URL', file: './golden/react-coming-soon-url.txt', over: {} },
    {
      name: 'Full + URL',
      file: './golden/react-full-url.txt',
      over: { features: ['starter:full'] as ProjectManifest['features'] },
    },
    {
      name: 'URL-less',
      file: './golden/react-url-less.txt',
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
    it(`golden: React ${scenario.name}`, async () => {
      const { plan: generated } = planReact(scenario.over);
      await expect(renderPlan(generated, TEMPLATES_ROOT)).toMatchFileSnapshot(scenario.file);
    });
  }

  it('is deterministic across repeated planning', () => {
    expect(renderPlan(planReact().plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planReact().plan, TEMPLATES_ROOT),
    );
  });

  it('emits no unresolved tokens', () => {
    for (const operation of planReact().plan.operations) {
      if (operation.type !== 'write') continue;
      expect(/\{\{\s*\w+\s*\}\}/.test(operation.content), operation.path).toBe(false);
    }
  });

  it('never writes CRLF or an absolute path', () => {
    for (const operation of planReact().plan.operations) {
      expect(operation.path).not.toContain('\\');
      expect(path.isAbsolute(operation.path)).toBe(false);
      if (operation.type === 'write') expect(operation.content.includes('\r\n')).toBe(false);
    }
  });

  it('URL-less writes no fabricated domain', () => {
    const urlLess = planReact({
      site: {
        name: 'Acme Ltd',
        url: null,
        description: 'Bespoke widgets.',
        locale: 'en',
        author: null,
      },
    });
    const config = urlLess.plan.operations.find(
      (operation) => operation.path === 'src/config/site.config.ts',
    );
    expect(config?.type === 'write' && config.content).toContain("url: ''");
  });
});

describe('React generation structure', () => {
  const paths = () =>
    planReact()
      .plan.operations.map((operation) => operation.path)
      .sort();

  it('produces the files a React + Vite project needs to build', () => {
    const produced = new Set(paths());
    for (const required of [
      'package.json',
      'index.html',
      'tsconfig.json',
      'vite.config.ts',
      'src/main.tsx',
      'src/App.tsx',
      'src/styles/index.css',
      'src/config/site.config.ts',
      'src/layouts/BaseLayout.tsx',
      'src/pages/HomePage.tsx',
      'src/vite-env.d.ts',
      '.gitignore',
      'README.md',
    ]) {
      expect(produced.has(required), `missing ${required}`).toBe(true);
    }
  });

  it('generates no .jsx or .js application source', () => {
    for (const file of paths()) {
      expect(file.endsWith('.jsx'), file).toBe(false);
      if (file.startsWith('src/')) expect(file.endsWith('.js'), file).toBe(false);
    }
  });

  it('keeps the generated project private and unlicensed', () => {
    const pkg = planReact().plan.operations.find((o) => o.path === 'package.json');
    const parsed = JSON.parse(pkg?.type === 'write' ? pkg.content : '{}') as Record<
      string,
      unknown
    >;
    expect(parsed['private']).toBe(true);
    expect(parsed['license']).toBe('UNLICENSED');
  });

  it('records React provenance, not Astro', () => {
    const provenance = planReact().plan.operations.find((o) => o.path === '.client-site.json');
    const parsed = JSON.parse(provenance?.type === 'write' ? provenance.content : '{}') as {
      template: { id: string; framework: string };
    };
    expect(parsed.template.id).toBe('react-vite');
    expect(parsed.template.framework).toBe('react');
  });
});

describe('the React template stays out of the V1 CLI', () => {
  it('is not discoverable by the V1 registry', () => {
    // No template.json on disk, so --list-templates and --template are
    // unchanged and React has no public selection path yet.
    expect(v1Registry.list().map((entry) => entry.id)).toEqual(['astro-tailwind']);
    expect(v1Registry.has('react-vite')).toBe(false);
    expect(readdirSync(REACT_TEMPLATE)).not.toContain('template.json');
  });

  it('the adapter declares the identity the planner needs', () => {
    expect(REACT_TEMPLATE_MANIFEST.id).toBe('react-vite');
    expect(REACT_TEMPLATE_MANIFEST.framework).toBe('react');
    expect(REACT_TEMPLATE_MANIFEST.supportedModes).toEqual(['coming-soon', 'full']);
  });
});

describe('structural isolation', () => {
  it('the React and Vite adapters touch no filesystem or process API', () => {
    for (const file of ['react.ts', 'vite.ts', 'starters.ts']) {
      const source = readFileSync(
        path.resolve(import.meta.dirname, '..', 'src', 'adapters', file),
        'utf8',
      );
      for (const module of ['node:fs', 'node:child_process', 'node:process', 'node:os']) {
        expect(source.includes(`'${module}'`), `${file} imports ${module}`).toBe(false);
      }
    }
  });

  it('contribution is a pure function of the resolved project', () => {
    const { project } = resolveProject(reactManifest(), adapters);
    const react = adapters.framework('react');
    expect(react.contribute(project)).toEqual(react.contribute(project));
  });
});
