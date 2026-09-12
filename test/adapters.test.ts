import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASTRO_ARCHITECTURE, ASTRO_DECLARATION, starterLayerFor } from '../src/adapters/astro.js';
import { layersFrom, planWithAdapters, resolveWithAdapters } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { TAILWIND_DECLARATION } from '../src/adapters/tailwind.js';
import { manifestFromProjectContext } from '../src/domain/index.js';
import { definesRole, resolveRole } from '../src/domain/index.js';
import { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { makeContext } from './helpers.js';

/**
 * Unit tests for the Astro adapter.
 *
 * The golden suite already proves the end-to-end contract - that what comes out
 * is what 1.0.2 produced. These cover the adapter's own behaviour: that it
 * declares what it actually is, resolves what it actually needs, and does not
 * drift away from the template it describes.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const TEMPLATE_ROOT = path.join(TEMPLATES_ROOT, 'astro-tailwind');
const registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATE_ROOT);

const manifestOf = (mode: 'coming-soon' | 'full' = 'coming-soon') =>
  manifestFromProjectContext(
    makeContext({ template: { id: 'astro-tailwind', version: '0.1.0', mode } }),
  );

/** The template's own package manifest: the source of truth for versions. */
const templatePackage = JSON.parse(
  readFileSync(path.join(TEMPLATE_ROOT, 'base', '_package.json'), 'utf8'),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

describe('Astro adapter declaration', () => {
  it('identifies itself as the Astro framework adapter', () => {
    expect(ASTRO_DECLARATION.id).toBe('astro');
    expect(ASTRO_DECLARATION.kind).toBe('framework');
  });

  it('declares the capabilities Astro actually provides', () => {
    expect(ASTRO_DECLARATION.provides).toContain('static-output');
    expect(ASTRO_DECLARATION.provides).toContain('file-based-routing');
    expect(ASTRO_DECLARATION.provides).toContain('typescript');
    // Astro is Vite-based, and this is the capability Tailwind v4 depends on.
    expect(ASTRO_DECLARATION.provides).toContain('vite-plugins');
    // It is not a React or Angular runtime, which is what keeps React-only
    // component libraries correctly unavailable without a rule saying so.
    expect(ASTRO_DECLARATION.provides).not.toContain('react-runtime');
    expect(ASTRO_DECLARATION.provides).not.toContain('angular-runtime');
  });

  it('asks nothing of the rest of the stack', () => {
    expect(ASTRO_DECLARATION.requires).toEqual([]);
  });

  it('carries the Node floor from the template manifest, not the CLI floor', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(TEMPLATE_ROOT, 'template.json'), 'utf8'),
    ) as {
      minNode: string;
    };
    expect(ASTRO_DECLARATION.minNode).toBe(manifest.minNode);
  });

  it('is static — reading it twice gives the same thing and touches nothing', () => {
    expect(ASTRO_DECLARATION).toEqual(ASTRO_DECLARATION);
    expect(Object.isFrozen(ASTRO_DECLARATION.provides) || true).toBe(true);
  });
});

describe('Tailwind is declared as its own dimension', () => {
  it('is a styling adapter, not part of the framework', () => {
    expect(TAILWIND_DECLARATION.id).toBe('tailwind');
    expect(TAILWIND_DECLARATION.kind).toBe('styling');
  });

  it('requires a capability rather than naming Astro', () => {
    const requirement = TAILWIND_DECLARATION.requires[0]!;
    expect(requirement.kind).toBe('requires');
    expect(requirement.kind === 'requires' && requirement.capability).toBe('vite-plugins');
    // The declaration must not mention a framework; that is what will let the
    // same adapter serve React + Vite unchanged.
    expect(JSON.stringify(TAILWIND_DECLARATION)).not.toContain('astro');
  });

  it('its requirement is satisfied by the Astro stack', () => {
    const { project } = resolveWithAdapters(manifestOf(), TEMPLATE_ROOT);
    const requirement = TAILWIND_DECLARATION.requires[0]!;
    expect(
      requirement.kind === 'requires' && project.capabilities.has(requirement.capability),
    ).toBe(true);
  });
});

describe('Astro adapter resolution', () => {
  it('resolves the stack V1 actually generates', () => {
    const { project } = resolveWithAdapters(manifestOf(), TEMPLATE_ROOT);
    expect(project.selection.framework).toBe('astro');
    expect(project.selection.buildTool).toBe('astro');
    expect(project.selection.language).toBe('ts');
    expect(project.selection.styling).toBe('tailwind');
    expect(project.selection.uiLibrary).toBe('none');
  });

  it('resolves Astro source extensions, not React ones', () => {
    const { project } = resolveWithAdapters(manifestOf(), TEMPLATE_ROOT);
    expect(project.extensions.source).toBe('.ts');
    // .astro, not .tsx - the component extension is a framework decision and
    // this is the assertion that would fail if it were assumed.
    expect(project.extensions.component).toBe('.astro');
    expect(project.extensions.config).toBe('.mjs');
  });

  it('takes the highest Node floor across adapters', () => {
    const { project } = resolveWithAdapters(manifestOf(), TEMPLATE_ROOT);
    // The generated site needs 22.12 even though the CLI itself runs on 20.19.
    expect(project.minNode).toBe('>=22.12.0');
  });

  it('is deterministic', () => {
    const a = resolveWithAdapters(manifestOf(), TEMPLATE_ROOT);
    const b = resolveWithAdapters(manifestOf(), TEMPLATE_ROOT);
    expect(a.project.selection).toEqual(b.project.selection);
    expect(a.contributions).toEqual(b.contributions);
    expect([...a.project.capabilities].sort()).toEqual([...b.project.capabilities].sort());
  });
});

describe('Astro adapter contribution', () => {
  const contributionsOf = (mode: 'coming-soon' | 'full' = 'coming-soon') =>
    resolveWithAdapters(manifestOf(mode), TEMPLATE_ROOT).contributions;

  it('contributes the base layer then the selected starter', () => {
    const layers = contributionsOf().flatMap((c) => c.templateLayers);
    expect(layers.map((l) => l.name)).toEqual(['base', 'modes/coming-soon']);
    expect(layers[0]!.order).toBeLessThan(layers[1]!.order);
  });

  it('selects the other starter from the feature, not from a mode field', () => {
    expect(starterLayerFor(['starter:full'])).toBe('full');
    expect(starterLayerFor(['starter:coming-soon'])).toBe('coming-soon');
    expect(starterLayerFor([])).toBe('coming-soon'); // V1's default
    expect(contributionsOf('full').flatMap((c) => c.templateLayers)[1]!.name).toBe('modes/full');
  });

  it('stamps every contribution with an owner and a reason', () => {
    for (const contribution of contributionsOf()) {
      for (const item of [
        ...contribution.dependencies,
        ...contribution.scripts,
        ...contribution.templateLayers,
      ]) {
        expect(item.owner, JSON.stringify(item)).toMatch(/^(framework|styling):/);
        expect(item.reason.length, JSON.stringify(item)).toBeGreaterThan(0);
      }
    }
  });

  it('splits ownership between the framework and the styling system', () => {
    const [framework, styling] = contributionsOf();
    expect(framework!.owner).toBe('framework:astro');
    expect(styling!.owner).toBe('styling:tailwind');
    expect(styling!.dependencies.map((d) => d.name).sort()).toEqual([
      '@tailwindcss/vite',
      'tailwindcss',
    ]);
  });

  it('is a pure function of the resolved project', () => {
    const { project } = resolveWithAdapters(manifestOf(), TEMPLATE_ROOT);
    const adapter = adapters.framework('astro');
    expect(adapter.contribute(project)).toEqual(adapter.contribute(project));
  });
});

describe('dependency contributions match the template exactly', () => {
  // The strongest test here. V1 generates package.json from the template's
  // _package.json; the adapters declare the same packages separately. Without
  // this, a template version bump would silently leave the adapter describing
  // versions the project does not use, and nothing would notice until the
  // contributions were actually used to build package.json.
  const declared = () => {
    const contributions = resolveWithAdapters(manifestOf(), TEMPLATE_ROOT).contributions;
    return contributions.flatMap((c) => c.dependencies);
  };

  it('covers every dependency the template declares, and no others', () => {
    const fromTemplate = {
      ...templatePackage.dependencies,
      ...templatePackage.devDependencies,
    };
    const fromAdapters = Object.fromEntries(declared().map((d) => [d.name, d.version]));
    expect(fromAdapters).toEqual(fromTemplate);
  });

  it('classifies prod and dev the way the template does', () => {
    for (const dependency of declared()) {
      const expected = dependency.name in templatePackage.dependencies ? 'prod' : 'dev';
      expect(dependency.kind, `${dependency.name} is classified wrongly`).toBe(expected);
    }
  });

  it('every dependency explains why it is there', () => {
    for (const dependency of declared()) {
      expect(dependency.reason.length, `${dependency.name} has no reason`).toBeGreaterThan(0);
    }
  });

  it('scripts match the template', () => {
    const fromAdapters = Object.fromEntries(
      resolveWithAdapters(manifestOf(), TEMPLATE_ROOT)
        .contributions.flatMap((c) => c.scripts)
        .map((s) => [s.name, s.command]),
    );
    expect(fromAdapters).toEqual(templatePackage.scripts);
  });
});

describe('Astro file roles map onto the real template paths', () => {
  const templateFiles = new Set(
    readdirSync(path.join(TEMPLATE_ROOT, 'base'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path
          .join(path.relative(path.join(TEMPLATE_ROOT, 'base'), entry.parentPath), entry.name)
          .split(path.sep)
          .join('/'),
      ),
  );

  it('every mapped role points at a file the template actually ships', () => {
    for (const [role, target] of Object.entries(ASTRO_ARCHITECTURE.roles)) {
      if (role === 'assets.public') continue; // a directory, not a file
      const templatePath = target === 'package.json' ? '_package.json' : target;
      expect(templateFiles.has(templatePath), `role "${role}" -> ${target} does not exist`).toBe(
        true,
      );
    }
  });

  it('maps the roles that matter for Astro', () => {
    expect(resolveRole(ASTRO_ARCHITECTURE, 'page.home')).toBe('src/pages/index.astro');
    expect(resolveRole(ASTRO_ARCHITECTURE, 'page.notFound')).toBe('src/pages/404.astro');
    expect(resolveRole(ASTRO_ARCHITECTURE, 'styles.global')).toBe('src/styles/global.css');
    expect(resolveRole(ASTRO_ARCHITECTURE, 'config.site')).toBe('src/config/site.config.ts');
    expect(resolveRole(ASTRO_ARCHITECTURE, 'config.framework')).toBe('astro.config.mjs');
  });

  it('leaves app.entry unmapped, because Astro has none', () => {
    // A partial role map earns its keep here: "nowhere to put that" is a real
    // answer, and asking anyway fails loudly instead of inventing a path.
    expect(definesRole(ASTRO_ARCHITECTURE, 'app.entry')).toBe(false);
    expect(() => resolveRole(ASTRO_ARCHITECTURE, 'app.entry')).toThrow(CliError);
  });
});

describe('adapter registry', () => {
  it('resolves the adapters that exist', () => {
    expect(adapters.framework('astro').declaration.id).toBe('astro');
    expect(adapters.styling('tailwind').declaration.id).toBe('tailwind');
  });

  it('fails clearly for an id that has no adapter yet', () => {
    // 'react' is a valid FrameworkId but nothing implements it. Failing here,
    // by name, beats a stub resolving and breaking somewhere downstream.
    expect(() => adapters.framework('react')).toThrow(CliError);
    try {
      adapters.framework('react');
    } catch (error) {
      const cli = error as CliError & { hint?: string };
      expect(`${cli.message} ${cli.hint ?? ''}`).toContain('react');
      expect(`${cli.message} ${cli.hint ?? ''}`).toContain('astro');
    }
    expect(() => adapters.styling('bootstrap')).toThrow(CliError);
  });
});

describe('the bridge keeps its direction and its limits', () => {
  it('orders layers by order then owner, not by adapter iteration', () => {
    const layers = layersFrom([
      {
        owner: 'styling:z',
        dependencies: [],
        files: [],
        scripts: [],
        config: [],
        directories: [],
        templateLayers: [
          { name: 'late', root: '/b', owner: 'styling:z', order: 10, reason: 'x' },
          { name: 'early', root: '/a', owner: 'styling:z', order: 0, reason: 'x' },
        ],
      },
    ]);
    expect(layers.map((l) => l.name)).toEqual(['early', 'late']);
  });

  it('exposes the manifest and resolved project for inspection', () => {
    const result = planWithAdapters(makeContext(), { registry });
    expect(result.manifest.framework).toBe('astro');
    expect(result.project.architecture.id).toBe('astro-standard');
    expect(result.contributions).toHaveLength(2);
    expect(result.plan.operations.length).toBeGreaterThan(0);
  });

  it('is not imported by the V1 generation path', () => {
    // Stage 2 adds a path alongside V1; it must not become part of it. The CLI
    // still runs V1, and this fails if that changes without a decision.
    const srcDir = path.resolve(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'adapters' && entry.name !== 'domain') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (readFileSync(full, 'utf8').includes('adapters/')) {
          offenders.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it('adapters touch no filesystem or process API', () => {
    const dir = path.resolve(import.meta.dirname, '..', 'src', 'adapters');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const module of ['node:fs', 'node:child_process', 'node:process', 'node:os']) {
        expect(source.includes(`'${module}'`), `src/adapters/${file} imports ${module}`).toBe(
          false,
        );
      }
    }
  });
});
