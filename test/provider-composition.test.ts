import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  composedProviderShell,
  planManifest,
  resolveWithAdapters,
} from '../src/adapters/bridge.js';
import { MUI_DECLARATION } from '../src/adapters/mui.js';
import { NEXTJS_ARCHITECTURE } from '../src/adapters/nextjs.js';
import { REACT_ARCHITECTURE } from '../src/adapters/react.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { resolveProject } from '../src/adapters/selection.js';
import {
  appRootEntries,
  composesAppRoot,
  composesProviderShell,
  emitProviderShell,
} from '../src/domain/app-composition.js';
import type { AppRootWrapper } from '../src/domain/app-composition.js';
import type { ConfigContribution, Contribution, ProjectManifest } from '../src/domain/index.js';
import { definesRole, resolveRole } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * The provider composition contract.
 *
 * ## The gap this closes
 *
 * Stage 26 gave Next one provider slot, hard-wired into the layout. That works
 * for one contributor and has no answer for two: a second would collide on the
 * file, and nothing anywhere said which of them should be outermost. The Stage
 * 26 report named the risk - *"two wrappers would have no declared nesting
 * order"* - and this stage closes it before a second contributor exists.
 *
 * ## The model
 *
 * The one React has used since Stage 7, generalised rather than replaced:
 *
 *     each wrapper declares an integer `order`; lower is further out
 *     ties break on the owner's adapter ref, which is a stable string
 *
 * That is all of it. It cannot express a cycle, because integers are totally
 * ordered and the tiebreak is total, so there is no graph and nothing to detect
 * one in. A `before`/`after` model could express a contradiction and would need
 * detection, resolution and an error vocabulary to earn behaviour this already
 * has.
 *
 * ## What is framework-specific and what is not
 *
 *     the contribution     what wraps the application, and where it belongs
 *     the ordering rule    the nesting, identically for every architecture
 *     the architecture     whether there is a shell at all, and where it lives
 *     the emitter          the one thing that genuinely differs
 *
 * React composes a root that renders *the page*; Next composes a shell that
 * renders *children*. Everything above those two lines is shared, and neither
 * emitter knows which adapter produced a wrapper.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
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

const planFor = (manifest: ProjectManifest) =>
  planManifest(manifest, {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: manifest.starter,
  });

const fileAt = (manifest: ProjectManifest, file: string): string => {
  const operation = planFor(manifest).plan.operations.find((entry) => entry.path === file);
  if (operation === undefined) throw new Error(`no operation for ${file}`);
  return operation.type === 'write' ? operation.content : '';
};

const code = (relative: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

/** The wrapper names in a composed module, outermost first. */
const nesting = (source: string): readonly string[] =>
  [...source.matchAll(/^\s*<([A-Z][A-Za-z0-9]*)>$/gm)].map((match) => match[1] as string);

// ---------------------------------------------------------------------------
// Synthetic contributors - test-only, never registered
// ---------------------------------------------------------------------------

/**
 * Three wrappers that do not exist, as bare contributions.
 *
 * Deliberately not adapters. What is under test is the ordering contract, and
 * an adapter would bring a declaration, a registry entry and a dimension id -
 * none of which the contract reads. These are the smallest thing the composer
 * actually consumes.
 */
const wrapper = (
  owner: string,
  importName: string,
  order: number,
  role: 'app.providers' | 'app.router' = 'app.providers',
): ConfigContribution => ({
  target: 'app.root',
  at: 'providers',
  value: { importName, role, order },
  owner,
  reason: 'test-only wrapper',
});

const A = wrapper('synthetic:a', 'ProviderA', 10);
const B = wrapper('synthetic:b', 'ProviderB', 20);
const C = wrapper('synthetic:c', 'ProviderC', 30);

const claimNames = (contributions: readonly ConfigContribution[]): readonly string[] =>
  appRootEntries(contributions, 'providers').map((claim) => claim.entry.importName);

const shellOf = (wrappers: readonly AppRootWrapper[]) => emitProviderShell('Providers', wrappers);
const asWrappers = (contributions: readonly ConfigContribution[]): readonly AppRootWrapper[] =>
  appRootEntries(contributions, 'providers').map((claim) => ({
    importName: claim.entry.importName,
    from: `./${claim.entry.importName}`,
  }));

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('two independent wrappers nest deterministically', () => {
  it('composes A then B, outermost first', () => {
    expect(claimNames([A, B])).toEqual(['ProviderA', 'ProviderB']);
    expect(nesting(shellOf(asWrappers([A, B])))).toEqual(['ProviderA', 'ProviderB']);
  });

  it('produces the identical nesting when contributed in the reverse order', () => {
    // The mandatory test. If this ever differs, ordering has quietly become a
    // function of which adapter was selected first.
    expect(claimNames([B, A])).toEqual(claimNames([A, B]));
    expect(shellOf(asWrappers([B, A]))).toBe(shellOf(asWrappers([A, B])));
  });

  it('nests three the same way, in any of the six orders', () => {
    // Three rather than two, so the rule cannot be accidentally hard-coded for
    // a pair - which a single reverse test would not catch.
    const permutations = [
      [A, B, C],
      [A, C, B],
      [B, A, C],
      [B, C, A],
      [C, A, B],
      [C, B, A],
    ];
    const expected = shellOf(asWrappers([A, B, C]));
    for (const permutation of permutations) {
      expect(claimNames(permutation)).toEqual(['ProviderA', 'ProviderB', 'ProviderC']);
      expect(shellOf(asWrappers(permutation))).toBe(expected);
    }
    expect(nesting(expected)).toEqual(['ProviderA', 'ProviderB', 'ProviderC']);
  });

  it('orders by the declared value, not by owner name', () => {
    // `synthetic:a` would sort first alphabetically; the declared order says
    // otherwise, and the declared order wins.
    const late = wrapper('synthetic:a', 'ProviderA', 99);
    expect(claimNames([late, B])).toEqual(['ProviderB', 'ProviderA']);
  });

  it('breaks ties on the owner, so equal orders are still deterministic', () => {
    const first = wrapper('synthetic:b', 'Beta', 50);
    const second = wrapper('synthetic:a', 'Alpha', 50);
    expect(claimNames([first, second])).toEqual(['Alpha', 'Beta']);
    expect(claimNames([second, first])).toEqual(['Alpha', 'Beta']);
  });

  it('a wrapper with no declared order is outermost, and says so by omission', () => {
    // `?? 0` rather than a throw: the field is optional in the contract, and an
    // unstated order is a real answer - "as far out as anything goes".
    const unstated: ConfigContribution = {
      target: 'app.root',
      at: 'providers',
      value: { importName: 'Unstated', role: 'app.providers' },
      owner: 'synthetic:z',
      reason: 'test-only wrapper',
    };
    expect(claimNames([A, unstated])).toEqual(['Unstated', 'ProviderA']);
  });

  it('emits a pass-through when nothing wraps anything', () => {
    const shell = shellOf([]);
    expect(shell).toContain('return <>{children}</>;');
    expect(nesting(shell)).toEqual([]);
  });

  it('the emitted module is valid whichever way it was built', () => {
    for (const wrappers of [[], asWrappers([A]), asWrappers([A, B]), asWrappers([A, B, C])]) {
      const shell = shellOf(wrappers);
      expect(shell).toContain('export function Providers({ children }: { children: ReactNode })');
      // The pass-through closes a fragment, so count named closers only.
      expect(shell.match(/<\/[A-Z]/g)?.length ?? 0).toBe(wrappers.length);
      expect(shell.endsWith('}\n')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Duplicates and conflicts
// ---------------------------------------------------------------------------

describe('two contributions for one binding', () => {
  it('collapses when they are byte-identical', () => {
    /*
     * The chosen rule, stated: an identical claim contributed twice is one
     * claim. Nesting a component inside itself is meaningless, and refusing
     * would make a legitimate duplicate - the same adapter reached twice
     * through two paths - an error for no reason.
     */
    expect(claimNames([A, A])).toEqual(['ProviderA']);
    expect(claimNames([A, A, B])).toEqual(['ProviderA', 'ProviderB']);
  });

  it('refuses when two owners want the same binding', () => {
    // Two components cannot be imported under one name. This is a genuine
    // disagreement rather than a nesting, so it fails rather than picking one.
    const rival = wrapper('synthetic:b', 'ProviderA', 20);
    expect(() => claimNames([A, rival])).toThrow(CliError);
    expect(() => claimNames([A, rival])).toThrow(/both want "ProviderA"/);
  });

  it('refuses when one owner contributes the same binding differently', () => {
    // Same owner, same name, different order: still a disagreement, because
    // the composer cannot know which was meant.
    const other = wrapper('synthetic:a', 'ProviderA', 40);
    expect(() => claimNames([A, other])).toThrow(CliError);
  });

  it('reports the same conflict whichever order it arrived in', () => {
    const rival = wrapper('synthetic:b', 'ProviderA', 20);
    const message = (list: readonly ConfigContribution[]): string => {
      try {
        claimNames(list);
      } catch (error) {
        return `${(error as CliError).message}\n${(error as CliError).hint ?? ''}`;
      }
      return '';
    };
    expect(message([A, rival])).toBe(message([rival, A]));
  });

  it('refuses a wrapper that shares the shell’s own export name', () => {
    /*
     * The one collision `appRootEntries` cannot see, because the shell's name
     * belongs to the architecture rather than to any contribution. Found while
     * building this stage: MUI exports `AppProviders` and Next's shell was
     * named the same, which emitted a module redeclaring its own export.
     */
    const { project } = resolveProject(nextManifest({ uiLibrary: 'mui' }), adapters);
    const clashing: Contribution[] = [
      {
        owner: 'synthetic:a',
        dependencies: [],
        files: [],
        scripts: [],
        config: [wrapper('synthetic:a', 'Providers', 10)],
        templateLayers: [],
        directories: [],
      },
    ];
    const operations = [
      {
        type: 'write' as const,
        path: resolveRole(project.architecture, 'app.providers'),
        content: '',
        origin: 'test',
      },
    ];
    expect(() => composedProviderShell(project, clashing, operations)).toThrow(/Providers/);
  });

  it('refuses a wrapper whose file nothing produces', () => {
    // An import of a file that is not there: a project that installs and then
    // fails to build, which is the failure this codebase treats most seriously.
    const { project } = resolveProject(nextManifest(), adapters);
    const orphan: Contribution[] = [
      {
        owner: 'synthetic:a',
        dependencies: [],
        files: [],
        scripts: [],
        config: [A],
        templateLayers: [],
        directories: [],
      },
    ];
    expect(() => composedProviderShell(project, orphan, [])).toThrow(/contributes no file/);
  });

  it('refuses a wrapper the architecture has nowhere to put', () => {
    // `app.router` is unmapped on Next, so a wrapper living there has no home.
    const { project } = resolveProject(nextManifest(), adapters);
    const homeless: Contribution[] = [
      {
        owner: 'synthetic:a',
        dependencies: [],
        files: [],
        scripts: [],
        config: [wrapper('synthetic:a', 'Homeless', 10, 'app.router')],
        templateLayers: [],
        directories: [],
      },
    ];
    expect(() => composedProviderShell(project, homeless, [])).toThrow(/maps no "app.router"/);
  });
});

// ---------------------------------------------------------------------------
// The two architectures
// ---------------------------------------------------------------------------

describe('each architecture composes where its own entry allows', () => {
  it('React composes a root that renders the page', () => {
    expect(composesAppRoot(REACT_ARCHITECTURE)).toBe(true);
    expect(composesProviderShell(REACT_ARCHITECTURE)).toBe(false);
    expect(REACT_ARCHITECTURE.rootExportName).toBe('App');
  });

  it('Next composes a shell that renders children', () => {
    expect(composesProviderShell(NEXTJS_ARCHITECTURE)).toBe(true);
    expect(composesAppRoot(NEXTJS_ARCHITECTURE)).toBe(false);
    expect(NEXTJS_ARCHITECTURE.shellExportName).toBe('Providers');
  });

  it('Next maps the chain and the occupant to different files', () => {
    // The Stage 26 arrangement had one file for both, which is why a second
    // contributor would have collided rather than nested.
    expect(resolveRole(NEXTJS_ARCHITECTURE, 'app.shell')).toBe(
      'components/providers/AppProviders.tsx',
    );
    expect(resolveRole(NEXTJS_ARCHITECTURE, 'app.providers')).toBe(
      'components/providers/UiProviders.tsx',
    );
  });

  it('no `app.root` is invented for Next', () => {
    // §11: the App Router has no SPA root, and pretending otherwise to make the
    // two architectures look symmetric would emit a component nothing renders.
    expect(definesRole(NEXTJS_ARCHITECTURE, 'app.root')).toBe(false);
    expect(NEXTJS_ARCHITECTURE.rootExportName).toBeUndefined();
  });

  it('the layout renders the composed shell, not a contributor', () => {
    const layout = fileAt(nextManifest(), 'app/layout.tsx');
    expect(layout).toContain("from '../components/providers/AppProviders'");
    expect(layout).toMatch(/<Providers>\s*\{children\}\s*<\/Providers>/);
  });

  it('the shell is composed even when nothing fills it', () => {
    const shell = fileAt(nextManifest(), 'components/providers/AppProviders.tsx');
    expect(shell).toContain('return <>{children}</>;');
    expect(planFor(nextManifest()).plan.operations).toContainEqual(
      expect.objectContaining({
        path: 'components/providers/AppProviders.tsx',
        origin: 'composed from nothing',
      }),
    );
  });

  it('the shell names its contributors in the plan', () => {
    const operation = planFor(nextManifest({ uiLibrary: 'mui' })).plan.operations.find(
      (entry) => entry.path === 'components/providers/AppProviders.tsx',
    );
    expect(operation?.origin).toBe('composed from ui-library:mui');
  });
});

// ---------------------------------------------------------------------------
// MUI through the generalised contract
// ---------------------------------------------------------------------------

describe('MUI composes through the contract on both architectures', () => {
  it('declares one wrapper, with an explicit order', () => {
    const { project } = resolveProject(nextManifest({ uiLibrary: 'mui' }), adapters);
    const claims = appRootEntries(
      adapters.uiLibrary('mui').contribute(project).config,
      'providers',
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.entry.order).toBe(10);
    expect(claims[0]?.entry.role).toBe('app.providers');
    expect(claims[0]?.owner).toBe('ui-library:mui');
  });

  it('wraps the application on Next', () => {
    const shell = fileAt(
      nextManifest({ uiLibrary: 'mui' }),
      'components/providers/AppProviders.tsx',
    );
    expect(shell).toContain("import { AppProviders } from './UiProviders';");
    expect(nesting(shell)).toEqual(['AppProviders']);
    expect(shell).toContain('{children}');
  });

  it('wraps the application on React, unchanged', () => {
    const react = nextManifest({
      framework: 'react',
      buildTool: 'vite',
      router: 'none',
      architecture: 'react-standard',
      styling: 'tailwind',
      uiLibrary: 'mui',
    });
    const root = fileAt(react, 'src/App.tsx');
    expect(nesting(root)).toEqual(['AppProviders']);
    expect(root).toContain('<HomePage />');
  });

  it('nests inside the router on React, as the declared orders say', () => {
    // MUI at 10, the router at 100: the router is innermost, so every route it
    // renders is inside the theme rather than beside it.
    const react = nextManifest({
      framework: 'react',
      buildTool: 'vite',
      router: 'react-router',
      architecture: 'react-standard',
      styling: 'tailwind',
      uiLibrary: 'mui',
    });
    expect(nesting(fileAt(react, 'src/App.tsx'))).toEqual(['AppProviders', 'AppRouter']);
  });

  it('is deterministic across repeated planning', () => {
    for (const manifest of [nextManifest({ uiLibrary: 'mui' }), nextManifest()]) {
      expect(renderPlan(planFor(manifest).plan, TEMPLATES_ROOT)).toBe(
        renderPlan(planFor(manifest).plan, TEMPLATES_ROOT),
      );
    }
  });

  it('is unchanged by the order adapters were selected in', () => {
    const { contributions } = resolveWithAdapters(
      nextManifest({ uiLibrary: 'mui' }),
      TEMPLATES_ROOT,
    );
    const { project } = resolveProject(nextManifest({ uiLibrary: 'mui' }), adapters);
    const operations = planFor(nextManifest({ uiLibrary: 'mui' })).plan.operations;

    const forwards = composedProviderShell(project, contributions, operations);
    const backwards = composedProviderShell(project, [...contributions].reverse(), operations);
    expect(forwards).toEqual(backwards);
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the composition engine knows no adapter', () => {
  it('names no framework, UI library, router or styling system', () => {
    const composition = code('src/domain/app-composition.ts').toLowerCase();
    for (const id of ['nextjs', 'next.js', 'react-router', 'mui', 'tailwind', 'bootstrap']) {
      expect(composition, `app-composition.ts mentions ${id}`).not.toContain(id);
    }
  });

  it('the shell composer reads roles and orders, never identities', () => {
    const bridge = code('src/adapters/bridge.ts');
    const shell = bridge.slice(bridge.indexOf('export function composedProviderShell'));
    const body = shell.slice(0, shell.indexOf('\n}\n') + 3);
    for (const id of ['nextjs', 'mui', 'react-router']) {
      expect(body.toLowerCase(), `composedProviderShell mentions ${id}`).not.toContain(id);
    }
    expect(body).not.toMatch(/manifest\.(framework|uiLibrary|router|styling)/);
  });

  it('MUI names no framework for its ordering', () => {
    const mui = code('src/adapters/mui.ts');
    expect(mui).not.toMatch(/framework\s*[=!]==/);
    expect(mui).toContain('order: 10');
  });

  it('Next names no UI library', () => {
    const next = code('src/adapters/nextjs.ts').toLowerCase();
    expect(next).not.toContain('mui');
    expect(next).not.toContain('emotion');
  });

  it('the architectures carry no ordering of their own', () => {
    // Where the shell lives is the architecture's business; what goes in it and
    // in what order is not. A per-architecture order would be a matrix.
    /*
     * Narrowly about *provider* order. Both files do carry `order:` on file and
     * layer contributions, which decide which claim wins a path rather than
     * which wrapper is outermost - a different concern with a different unit.
     */
    for (const file of ['src/adapters/nextjs.ts', 'src/adapters/react.ts']) {
      const source = code(file);
      expect(source, `${file} contributes a wrapper`).not.toContain("at: 'providers'");
      expect(source, `${file} names a wrapper order`).not.toMatch(/importName:[^}]*order:/);
    }
  });

  it('the synthetic contributors exist only here', () => {
    for (const file of [
      'src/adapters/registry.ts',
      'src/adapters/mui.ts',
      'src/adapters/nextjs.ts',
      'src/domain/app-composition.ts',
      'src/adapters/bridge.ts',
    ]) {
      expect(code(file), `${file} mentions a synthetic provider`).not.toContain('synthetic');
    }
    expect(MUI_DECLARATION.provides).not.toContain('synthetic' as never);
  });
});
