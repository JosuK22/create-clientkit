import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest, planWithAdapters } from '../src/adapters/bridge.js';
import { collectBuildPlugins, emitViteConfig } from '../src/domain/build-config.js';
import type {
  ConfigContribution,
  Contribution,
  DependencyContribution,
  ScriptContribution,
} from '../src/domain/contributions.js';
import { emptyContribution } from '../src/domain/contributions.js';
import {
  composePackage,
  mergeDependencies,
  mergeScripts,
} from '../src/domain/package-composition.js';
import type { ProjectManifest, StylingId } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { makeContext, TEST_CWD } from './helpers.js';

/**
 * The composition engine.
 *
 * Stage 6's claim is that the generated package and build configuration can be
 * explained entirely by the base plus the selected adapters' contributions plus
 * generic rules - with no hidden template knowledge and no branch on which
 * framework or styling system was chosen.
 *
 * These tests are deliberately mostly synthetic. Every case below uses invented
 * adapters called `framework:alpha` and `styling:beta`, because a composition
 * engine that only works for the four adapters that happen to exist is not a
 * composition engine. The real stacks are covered at the bottom, and by the
 * golden suite.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);

const dependency = (over: Partial<DependencyContribution> = {}): DependencyContribution => ({
  name: 'left-pad',
  version: '1.0.0',
  kind: 'prod',
  owner: 'framework:alpha',
  reason: 'the framework needs it',
  ...over,
});

const script = (over: Partial<ScriptContribution> = {}): ScriptContribution => ({
  name: 'build',
  command: 'alpha build',
  owner: 'framework:alpha',
  order: 0,
  reason: 'production build',
  ...over,
});

const config = (over: Partial<ConfigContribution> = {}): ConfigContribution => ({
  target: 'config.build',
  at: 'plugins',
  value: { importName: 'alpha', importFrom: '@alpha/plugin', call: 'alpha()' },
  owner: 'framework:alpha',
  reason: 'the framework needs its plugin',
  ...over,
});

const bundle = (owner: string, over: Partial<Contribution> = {}): Contribution => ({
  ...emptyContribution(owner),
  ...over,
});

const BASE = { name: 'acme', version: '0.1.0', private: true } as const;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

describe('composing dependencies', () => {
  it('takes a single contribution through unchanged', () => {
    const merged = mergeDependencies([dependency()]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('left-pad');
    expect(merged[0]?.version).toBe('1.0.0');
  });

  it('combines contributions from several adapters', () => {
    const merged = mergeDependencies([
      dependency({ name: 'zeta', owner: 'framework:alpha' }),
      dependency({ name: 'alpha-pkg', owner: 'styling:beta' }),
    ]);
    expect(merged.map((entry) => entry.name)).toEqual(['alpha-pkg', 'zeta']);
  });

  it('de-duplicates an identical request from two adapters', () => {
    const merged = mergeDependencies([
      dependency({ owner: 'framework:alpha' }),
      dependency({ owner: 'styling:beta' }),
    ]);
    expect(merged).toHaveLength(1);
  });

  it('keeps every contributor when it de-duplicates', () => {
    // The JSON can only hold one entry, but "why is this in my project?" has
    // two answers and both are worth keeping.
    const merged = mergeDependencies([
      dependency({ owner: 'styling:beta', reason: 'the stylesheet imports it' }),
      dependency({ owner: 'framework:alpha', reason: 'the framework needs it' }),
    ]);
    expect(merged[0]?.contributors.map((entry) => entry.owner)).toEqual([
      'framework:alpha',
      'styling:beta',
    ]);
    expect(merged[0]?.contributors.map((entry) => entry.reason)).toEqual([
      'the framework needs it',
      'the stylesheet imports it',
    ]);
  });

  it('refuses two different versions of one package', () => {
    expect(() =>
      mergeDependencies([
        dependency({ version: '1.0.0', owner: 'framework:alpha' }),
        dependency({ version: '2.0.0', owner: 'styling:beta' }),
      ]),
    ).toThrow(CliError);
  });

  it('names the package, both versions, both owners and both reasons', () => {
    // A conflict the user cannot act on is barely better than a silent choice.
    let error: CliError | undefined;
    try {
      mergeDependencies([
        dependency({
          version: '1.0.0',
          owner: 'framework:alpha',
          reason: 'the framework needs it',
        }),
        dependency({ version: '2.0.0', owner: 'styling:beta', reason: 'the theme needs it' }),
      ]);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    for (const fragment of [
      'left-pad',
      '1.0.0',
      '2.0.0',
      'framework:alpha',
      'styling:beta',
      'the framework needs it',
      'the theme needs it',
    ]) {
      expect(text, `the error never mentions ${fragment}`).toContain(fragment);
    }
  });

  it('refuses the same version under two different kinds', () => {
    // Not a merge with a winner. One ships in the bundle and one does not, and
    // nothing in the model says which contributor is wrong.
    expect(() =>
      mergeDependencies([
        dependency({ kind: 'prod', owner: 'framework:alpha' }),
        dependency({ kind: 'dev', owner: 'styling:beta' }),
      ]),
    ).toThrow(/runtime or development/);
  });

  it('sorts by name so the output never depends on adapter order', () => {
    const forwards = mergeDependencies([
      dependency({ name: 'c' }),
      dependency({ name: 'a' }),
      dependency({ name: 'b' }),
    ]);
    const backwards = mergeDependencies([
      dependency({ name: 'b' }),
      dependency({ name: 'c' }),
      dependency({ name: 'a' }),
    ]);
    expect(forwards.map((entry) => entry.name)).toEqual(['a', 'b', 'c']);
    expect(backwards.map((entry) => entry.name)).toEqual(forwards.map((entry) => entry.name));
  });

  it('sorts scoped packages by code unit, not by locale', () => {
    // `localeCompare` would be free to place "@scope/x" differently on a
    // small-ICU Node than a full-ICU one, and generated bytes must not move
    // between a developer's machine and CI.
    const merged = mergeDependencies([
      dependency({ name: 'tailwindcss' }),
      dependency({ name: '@tailwindcss/vite' }),
      dependency({ name: 'Zed' }),
    ]);
    expect(merged.map((entry) => entry.name)).toEqual(['@tailwindcss/vite', 'Zed', 'tailwindcss']);
  });
});

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

describe('composing scripts', () => {
  it('combines scripts from several adapters', () => {
    const merged = mergeScripts([
      script({ name: 'build', order: 1 }),
      script({ name: 'dev', command: 'alpha dev', order: 0 }),
    ]);
    expect(merged.map((entry) => entry.name)).toEqual(['dev', 'build']);
  });

  it('de-duplicates an identical command and keeps both contributors', () => {
    const merged = mergeScripts([
      script({ owner: 'framework:alpha' }),
      script({ owner: 'styling:beta' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.contributors).toHaveLength(2);
  });

  it('refuses one name with two different commands', () => {
    expect(() =>
      mergeScripts([
        script({ command: 'alpha build', owner: 'framework:alpha' }),
        script({ command: 'beta build', owner: 'styling:beta' }),
      ]),
    ).toThrow(CliError);
  });

  it('names both commands and both owners in the conflict', () => {
    let error: CliError | undefined;
    try {
      mergeScripts([
        script({ command: 'alpha build', owner: 'framework:alpha' }),
        script({ command: 'beta build', owner: 'styling:beta' }),
      ]);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    for (const fragment of [
      'build',
      'alpha build',
      'beta build',
      'framework:alpha',
      'styling:beta',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('orders by the declared position rather than by contribution order', () => {
    const merged = mergeScripts([
      script({ name: 'typecheck', command: 'tsc', order: 10 }),
      script({ name: 'dev', command: 'alpha dev', order: 0 }),
      script({ name: 'build', order: 1 }),
    ]);
    expect(merged.map((entry) => entry.name)).toEqual(['dev', 'build', 'typecheck']);
  });

  it('breaks ties on owner then name, never on input order', () => {
    const forwards = mergeScripts([
      script({ name: 'b', command: 'b', order: 0, owner: 'framework:alpha' }),
      script({ name: 'a', command: 'a', order: 0, owner: 'framework:alpha' }),
    ]);
    const backwards = mergeScripts([
      script({ name: 'a', command: 'a', order: 0, owner: 'framework:alpha' }),
      script({ name: 'b', command: 'b', order: 0, owner: 'framework:alpha' }),
    ]);
    expect(forwards.map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(backwards.map((entry) => entry.name)).toEqual(forwards.map((entry) => entry.name));
  });

  it('lets the lowest requested position win a shared script', () => {
    // Otherwise an adapter could push another's script down the list simply by
    // asking for a larger number, which is influence it should not have.
    const merged = mergeScripts([
      script({ order: 50, owner: 'styling:beta' }),
      script({ order: 1, owner: 'framework:alpha' }),
    ]);
    expect(merged[0]?.order).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The finished manifest
// ---------------------------------------------------------------------------

describe('composing package.json', () => {
  it('keeps the base fields, in the base order', () => {
    const { json } = composePackage({ ...BASE, type: 'module' }, []);
    expect(Object.keys(json)).toEqual(['name', 'version', 'private', 'type']);
  });

  it('appends the composed blocks after the base fields', () => {
    const { json } = composePackage({ ...BASE }, [
      bundle('framework:alpha', { dependencies: [dependency()], scripts: [script()] }),
    ]);
    expect(Object.keys(json)).toEqual(['name', 'version', 'private', 'scripts', 'dependencies']);
  });

  it('splits dependencies into fields by kind', () => {
    const { json } = composePackage({ ...BASE }, [
      bundle('framework:alpha', {
        dependencies: [
          dependency({ name: 'runtime-pkg', kind: 'prod' }),
          dependency({ name: 'tool-pkg', kind: 'dev' }),
          dependency({ name: 'peer-pkg', kind: 'peer' }),
        ],
      }),
    ]);
    expect(json['dependencies']).toEqual({ 'runtime-pkg': '1.0.0' });
    expect(json['devDependencies']).toEqual({ 'tool-pkg': '1.0.0' });
    expect(json['peerDependencies']).toEqual({ 'peer-pkg': '1.0.0' });
  });

  it('omits a block nobody contributed to', () => {
    const { json } = composePackage({ ...BASE }, [
      bundle('framework:alpha', { dependencies: [dependency()] }),
    ]);
    expect('devDependencies' in json).toBe(false);
    expect('scripts' in json).toBe(false);
  });

  it('ignores a stale block the base still carries', () => {
    // "Authoritative" has to mean this. A template that grows a dependencies
    // block back does not quietly get its way.
    const { json } = composePackage(
      { ...BASE, dependencies: { 'ghost-pkg': '9.9.9' }, scripts: { ghost: 'ghost' } },
      [bundle('framework:alpha', { dependencies: [dependency()] })],
    );
    expect(json['dependencies']).toEqual({ 'left-pad': '1.0.0' });
    expect('scripts' in json).toBe(false);
  });

  it('is a pure function of its inputs', () => {
    const inputs = [bundle('framework:alpha', { dependencies: [dependency()] })];
    const first = composePackage({ ...BASE }, inputs);
    const second = composePackage({ ...BASE }, inputs);
    expect(JSON.stringify(first.json)).toBe(JSON.stringify(second.json));
  });

  it('retains provenance the JSON cannot carry', () => {
    const composed = composePackage({ ...BASE }, [
      bundle('framework:alpha', {
        dependencies: [dependency({ reason: 'the framework needs it' })],
      }),
      bundle('styling:beta', {
        dependencies: [dependency({ owner: 'styling:beta', reason: 'the theme needs it' })],
      }),
    ]);
    expect(JSON.stringify(composed.json)).not.toContain('needs it');
    expect(composed.dependencies[0]?.contributors.map((entry) => entry.reason)).toEqual([
      'the framework needs it',
      'the theme needs it',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('composing build configuration', () => {
  it('emits a base configuration with no contributions', () => {
    const emitted = emitViteConfig([]);
    expect(emitted).toContain('defineConfig');
    expect(emitted).toContain('plugins: [');
    expect(emitted.endsWith('\n')).toBe(true);
  });

  it('emits one contribution', () => {
    const plugins = collectBuildPlugins([config()]);
    const emitted = emitViteConfig(plugins);
    expect(emitted).toContain("import alpha from '@alpha/plugin';");
    expect(emitted).toContain('alpha(),');
  });

  it('emits several contributions in a deterministic order', () => {
    const entries = [
      config({
        owner: 'styling:beta',
        value: { importName: 'beta', importFrom: '@beta/plugin', call: 'beta()' },
      }),
      config({ owner: 'framework:alpha' }),
    ];
    const forwards = collectBuildPlugins(entries).map((plugin) => plugin.entry.importName);
    const backwards = collectBuildPlugins([...entries].reverse()).map(
      (plugin) => plugin.entry.importName,
    );
    expect(forwards).toEqual(['alpha', 'beta']);
    expect(backwards).toEqual(forwards);
  });

  it('ignores contributions aimed at another config file', () => {
    expect(collectBuildPlugins([config({ target: 'config.framework' })])).toEqual([]);
  });

  it('de-duplicates an identical plugin two adapters both need', () => {
    const plugins = collectBuildPlugins([
      config({ owner: 'framework:alpha' }),
      config({ owner: 'styling:beta' }),
    ]);
    expect(plugins).toHaveLength(1);
  });

  it('refuses two adapters claiming one local binding for different modules', () => {
    // Emitting both would produce a module with two clashing imports - invalid
    // TypeScript, discovered in the user's project rather than here.
    expect(() =>
      collectBuildPlugins([
        config({ owner: 'framework:alpha' }),
        config({
          owner: 'styling:beta',
          value: { importName: 'alpha', importFrom: '@beta/plugin', call: 'alpha()' },
        }),
      ]),
    ).toThrow(CliError);
  });

  it('names both owners and both modules in the conflict', () => {
    let error: CliError | undefined;
    try {
      collectBuildPlugins([
        config({ owner: 'framework:alpha' }),
        config({
          owner: 'styling:beta',
          value: { importName: 'alpha', importFrom: '@beta/plugin', call: 'alpha()' },
        }),
      ]);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    for (const fragment of [
      'alpha',
      '@alpha/plugin',
      '@beta/plugin',
      'framework:alpha',
      'styling:beta',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('rejects a malformed entry, naming who sent it', () => {
    expect(() => collectBuildPlugins([config({ value: { importName: 'x' } })])).toThrow(
      /framework:alpha/,
    );
  });
});

// ---------------------------------------------------------------------------
// The real stacks
// ---------------------------------------------------------------------------

const manifestFor = (styling: StylingId): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-app'),
  projectName: 'acme-app',
  framework: 'react',
  buildTool: 'vite',
  language: 'ts',
  styling,
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
});

const planFor = (styling: StylingId) =>
  planManifest(manifestFor(styling), {
    registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'coming-soon',
  });

const packageOf = (styling: StylingId): Record<string, Record<string, string>> => {
  const operation = planFor(styling).plan.operations.find((entry) => entry.path === 'package.json');
  if (operation === undefined || operation.type !== 'write') throw new Error('no package.json');
  return JSON.parse(operation.content) as Record<string, Record<string, string>>;
};

describe('the real stacks compose to exactly what their adapters declared', () => {
  for (const styling of ['tailwind', 'bootstrap'] as const) {
    it(`React + Vite + ${styling}: every dependency traces to a contribution`, () => {
      const { composedPackage } = planFor(styling);
      const generated = packageOf(styling);
      const installed = { ...generated['dependencies'], ...generated['devDependencies'] };

      expect(composedPackage).toBeDefined();
      for (const [name, version] of Object.entries(installed)) {
        const resolved = composedPackage?.dependencies.find((entry) => entry.name === name);
        expect(resolved, `${name} is installed but nothing contributed it`).toBeDefined();
        expect(resolved?.version).toBe(version);
        expect(resolved?.contributors.length).toBeGreaterThan(0);
        for (const contributor of resolved?.contributors ?? []) {
          expect(contributor.reason.length).toBeGreaterThan(0);
        }
      }
    });

    it(`React + Vite + ${styling}: every script traces to a contribution`, () => {
      const { composedPackage } = planFor(styling);
      for (const [name, command] of Object.entries(packageOf(styling)['scripts'] ?? {})) {
        const resolved = composedPackage?.scripts.find((entry) => entry.name === name);
        expect(resolved, `${name} is a script nobody contributed`).toBeDefined();
        expect(resolved?.command).toBe(command);
      }
    });
  }

  it('the styling system is the only difference between the two manifests', () => {
    const tailwind = packageOf('tailwind');
    const bootstrap = packageOf('bootstrap');

    const strip = (pkg: Record<string, Record<string, string>>) => {
      const all = { ...pkg['dependencies'], ...pkg['devDependencies'] };
      for (const name of ['tailwindcss', '@tailwindcss/vite', 'bootstrap']) delete all[name];
      return all;
    };
    expect(strip(tailwind)).toEqual(strip(bootstrap));
    expect(tailwind['scripts']).toEqual(bootstrap['scripts']);
  });

  it('neither stack carries the other styling system anywhere in its manifest', () => {
    expect(JSON.stringify(packageOf('tailwind'))).not.toContain('bootstrap');
    expect(JSON.stringify(packageOf('bootstrap'))).not.toContain('tailwind');
  });

  it('Bootstrap contributes no build plugin, so its Vite config has no dead import', () => {
    const viteConfig = planFor('bootstrap').plan.operations.find(
      (entry) => entry.path === 'vite.config.ts',
    );
    const content = viteConfig?.type === 'write' ? viteConfig.content : '';
    expect(content).toContain('react()');
    expect(content).not.toContain('tailwind');
    expect(content).not.toContain('bootstrap');
  });

  it('Tailwind still contributes its plugin', () => {
    const viteConfig = planFor('tailwind').plan.operations.find(
      (entry) => entry.path === 'vite.config.ts',
    );
    const content = viteConfig?.type === 'write' ? viteConfig.content : '';
    expect(content).toContain("import tailwindcss from '@tailwindcss/vite';");
    expect(content).toContain('tailwindcss(),');
  });

  it('Astro composes a manifest too, from a framework that owns its own build tooling', () => {
    // The engine is not React-shaped: the same code path produces Astro's
    // manifest from an adapter with no separate build-tool adapter at all.
    const { composedPackage, plan } = planWithAdapters(makeContext(), { registry });
    expect(composedPackage?.scripts.map((entry) => entry.name)).toEqual([
      'dev',
      'build',
      'preview',
      'check',
      'astro',
    ]);
    const operation = plan.operations.find((entry) => entry.path === 'package.json');
    const parsed = JSON.parse(operation?.type === 'write' ? operation.content : '{}') as Record<
      string,
      Record<string, string>
    >;
    expect(Object.keys(parsed['dependencies'] ?? {})).toEqual(['@astrojs/sitemap', 'astro']);
  });
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe('drift between what is declared and what is generated', () => {
  const templateFor = (name: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, '..', 'templates', name, 'base', '_package.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;

  it('no template declares packages or scripts any more', () => {
    for (const template of ['astro-tailwind', 'react-vite']) {
      const raw = templateFor(template);
      for (const field of ['dependencies', 'devDependencies', 'scripts']) {
        expect(raw[field], `${template} still declares ${field}`).toBeUndefined();
      }
    }
  });

  it('templates keep exactly the identity fields, and no more', () => {
    for (const template of ['astro-tailwind', 'react-vite']) {
      expect(Object.keys(templateFor(template))).toEqual([
        'name',
        'version',
        'private',
        'license',
        'type',
        'engines',
        'keywords',
      ]);
    }
  });

  it('a template that grew a dependency back would not affect the output', () => {
    // Proving the direction of authority: the composer reads the base and
    // discards these fields, so the drift test above is the only thing standing
    // between a stale template block and a reader who believes it.
    const { json } = composePackage({ ...BASE, dependencies: { react: '18.0.0' } }, [
      bundle('framework:alpha', {
        dependencies: [dependency({ name: 'react', version: '19.3.0' })],
      }),
    ]);
    expect(json['dependencies']).toEqual({ react: '19.3.0' });
  });

  it('the generated manifest and the declared contributions cannot disagree', () => {
    for (const styling of ['tailwind', 'bootstrap'] as const) {
      const { composedPackage } = planFor(styling);
      const generated = packageOf(styling);
      const installed = { ...generated['dependencies'], ...generated['devDependencies'] };
      const declared = Object.fromEntries(
        (composedPackage?.dependencies ?? []).map((entry) => [entry.name, entry.version]),
      );
      expect(installed).toEqual(declared);
    }
  });
});
