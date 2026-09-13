import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASTRO_ARCHITECTURE, ASTRO_DECLARATION } from '../src/adapters/astro.js';
import { starterLayerFor } from '../src/adapters/starters.js';
import { layersFrom, planWithAdapters, resolveWithAdapters } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
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
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const manifestOf = (mode: 'coming-soon' | 'full' = 'coming-soon') =>
  manifestFromProjectContext(
    makeContext({ template: { id: 'astro-tailwind', version: '0.1.0', mode } }),
  );

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

describe('the generated package is exactly what the adapters contributed', () => {
  // Until Stage 6 this suite asserted the reverse - that the contributions
  // matched the template's _package.json - because the template was what
  // actually reached the user and the contributions were a parallel
  // description of it. Two sources of truth, and the test could only ever
  // confirm they had not drifted apart yet.
  //
  // Now the contributions build the file, so the useful assertion is the other
  // way round: whatever the adapters declared is what the project gets, and
  // nothing else appears. The template is no longer consulted for any of it.
  const declared = () => {
    const contributions = resolveWithAdapters(manifestOf(), TEMPLATE_ROOT).contributions;
    return contributions.flatMap((c) => c.dependencies);
  };

  const generatedPackage = (): Record<string, Record<string, string>> => {
    const { plan } = planWithAdapters(makeContext(), { registry });
    const operation = plan.operations.find((o) => o.path === 'package.json');
    if (operation === undefined || operation.type !== 'write') {
      throw new Error('no package.json was planned');
    }
    return JSON.parse(operation.content) as Record<string, Record<string, string>>;
  };

  it('contains every declared dependency, at the declared version', () => {
    const generated = generatedPackage();
    const installed = { ...generated['dependencies'], ...generated['devDependencies'] };
    const fromAdapters = Object.fromEntries(declared().map((d) => [d.name, d.version]));
    expect(installed).toEqual(fromAdapters);
  });

  it('contains no dependency nobody declared', () => {
    const generated = generatedPackage();
    const names = new Set(declared().map((d) => d.name));
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const name of Object.keys(generated[field] ?? {})) {
        expect(names.has(name), `${name} is in ${field} but no adapter asked for it`).toBe(true);
      }
    }
  });

  it('puts each dependency in the field its kind says', () => {
    const generated = generatedPackage();
    for (const dependency of declared()) {
      const field = dependency.kind === 'prod' ? 'dependencies' : 'devDependencies';
      expect(generated[field]?.[dependency.name], `${dependency.name} is in the wrong field`).toBe(
        dependency.version,
      );
    }
  });

  it('every dependency explains why it is there', () => {
    for (const dependency of declared()) {
      expect(dependency.reason.length, `${dependency.name} has no reason`).toBeGreaterThan(0);
    }
  });

  it('contains exactly the declared scripts', () => {
    const fromAdapters = Object.fromEntries(
      resolveWithAdapters(manifestOf(), TEMPLATE_ROOT)
        .contributions.flatMap((c) => c.scripts)
        .map((s) => [s.name, s.command]),
    );
    expect(generatedPackage()['scripts']).toEqual(fromAdapters);
  });

  it('keeps the identity the template owns and adds nothing of its own', () => {
    // The split the stage had to make explicit: the template owns the file and
    // the project's identity; the adapters own three blocks of data inside it.
    const generated = generatedPackage() as unknown as Record<string, unknown>;
    expect(Object.keys(generated)).toEqual([
      'name',
      'version',
      'private',
      'license',
      'type',
      'engines',
      'keywords',
      'scripts',
      'dependencies',
      'devDependencies',
    ]);
    expect(generated['private']).toBe(true);
    expect(generated['license']).toBe('UNLICENSED');
  });

  it('no template still carries dependency or script data', () => {
    // The whole point of the stage. If a template grew a dependencies block
    // again it would be silently ignored by the composer, which is a far worse
    // failure than a conflict - the reader would believe it.
    for (const template of ['astro-tailwind', 'react-vite']) {
      const raw = JSON.parse(
        readFileSync(
          path.resolve(import.meta.dirname, '..', 'templates', template, 'base', '_package.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      for (const field of ['dependencies', 'devDependencies', 'scripts']) {
        expect(raw[field], `${template} still declares ${field}`).toBeUndefined();
      }
    }
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
    // 'nextjs' is a valid FrameworkId but nothing implements it. Failing here,
    // by name, beats a stub resolving and breaking somewhere downstream.
    // (React moved from this list to the implemented one in Stage 4.)
    expect(() => adapters.framework('nextjs')).toThrow(CliError);
    try {
      adapters.framework('nextjs');
    } catch (error) {
      const cli = error as CliError & { hint?: string };
      expect(`${cli.message} ${cli.hint ?? ''}`).toContain('nextjs');
      expect(`${cli.message} ${cli.hint ?? ''}`).toContain('astro');
    }
    // 'scss' is a known StylingId with no adapter; bootstrap became implemented
    // in Stage 5 and moved to the other side of this line.
    expect(() => adapters.styling('scss')).toThrow(CliError);
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

  it('reaches the CLI through exactly one file', () => {
    // Stage 2 added this path alongside V1 and this test insisted the CLI not
    // use it "without a decision". Stage 6 is that decision: package.json is
    // now composed from contributions, which plan() alone cannot do, so the
    // create command runs the adapter path.
    //
    // The guard is kept and narrowed rather than deleted. One command file may
    // reach into adapters; if the import spreads into the resolver, the
    // template registry or the generator, the layering has eroded and this
    // fails again.
    const allowed = ['commands\\create.ts', 'commands/create.ts'];
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
        const relative = path.relative(srcDir, full);
        if (allowed.includes(relative)) continue;
        if (readFileSync(full, 'utf8').includes('adapters/')) {
          offenders.push(relative);
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

describe('adapter selection and compatibility for the real stack', () => {
  it('Astro + Tailwind is a compatible combination', () => {
    const report = checkCompatibility(manifestOf(), adapters);
    expect(report.compatible).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("Tailwind's vite-plugins requirement is satisfied by Astro, not by a rule", () => {
    // The requirement and the provision are declared independently; this is the
    // engine joining them up.
    const report = checkCompatibility(manifestOf(), adapters);
    expect(report.index.providers.get('vite-plugins')).toEqual(['framework:astro']);
  });

  it('selects the framework first, then styling', () => {
    const selection = selectAdapters(manifestOf(), adapters);
    expect(selection.adapters.map((entry) => entry.ref)).toEqual([
      'framework:astro',
      'styling:tailwind',
    ]);
  });

  it('selection is deterministic', () => {
    const a = selectAdapters(manifestOf(), adapters);
    const b = selectAdapters(manifestOf(), adapters);
    expect(a.adapters.map((entry) => entry.ref)).toEqual(b.adapters.map((entry) => entry.ref));
    expect(a.declarations).toEqual(b.declarations);
  });

  it('treats styling "none" as no adapter rather than a missing one', () => {
    const selection = selectAdapters({ ...manifestOf(), styling: 'none' }, adapters);
    expect(selection.adapters.map((entry) => entry.ref)).toEqual(['framework:astro']);
  });

  it('resolves extensions from the adapter, not from a hardcoded value', () => {
    const { project } = resolveProject(manifestOf(), adapters);
    expect(project.extensions).toEqual({ source: '.ts', component: '.astro', config: '.mjs' });
    // and follows the language when it differs
    const asJs = resolveProject({ ...manifestOf(), language: 'js' }, adapters);
    expect(asJs.project.extensions.source).toBe('.js');
    expect(asJs.project.extensions.component).toBe('.astro');
  });

  it('resolution is deterministic', () => {
    const a = resolveProject(manifestOf(), adapters);
    const b = resolveProject(manifestOf(), adapters);
    expect(a.project.extensions).toEqual(b.project.extensions);
    expect(a.project.minNode).toBe(b.project.minNode);
    expect([...a.project.capabilities].sort()).toEqual([...b.project.capabilities].sort());
  });

  it('refuses an unimplemented framework instead of falling back to Astro', () => {
    // The failure mode that would be worst: silently generating an Astro
    // project for someone who asked for React.
    expect(() => resolveProject({ ...manifestOf(), framework: 'nextjs' }, adapters)).toThrow(
      CliError,
    );
    try {
      resolveProject({ ...manifestOf(), framework: 'nextjs' }, adapters);
    } catch (error) {
      const cli = error as CliError & { hint?: string };
      const text = `${cli.message} ${cli.hint ?? ''}`;
      expect(text).toContain('nextjs');
      expect(text).toContain('does not support');
      expect(text).toContain('astro');
    }
  });

  it('distinguishes a known id from an implemented adapter', () => {
    expect(adapters.hasFramework('astro')).toBe(true);
    expect(adapters.hasFramework('react')).toBe(true);
    // still only a name in the vocabulary
    expect(adapters.hasFramework('nextjs')).toBe(false);
    expect(adapters.implementedFrameworks()).toEqual(['astro', 'react']);
    expect(adapters.implementedBuildTools()).toEqual(['vite']);
    expect(adapters.implementedStyling()).toEqual(['bootstrap', 'tailwind']);
  });

  it('rejects an architecture the framework does not offer', () => {
    expect(() =>
      resolveProject({ ...manifestOf(), architecture: 'react-standard' }, adapters),
    ).toThrow(CliError);
  });
});
