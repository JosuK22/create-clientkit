import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry, type AdapterRegistry } from '../src/adapters/registry.js';
import { REACT_TEMPLATE_MANIFEST } from '../src/adapters/react.js';
import { createTemplateCatalog } from '../src/adapters/template-catalog.js';
import type { FrameworkId } from '../src/domain/dimensions.js';
import type { ProjectManifest } from '../src/domain/manifest.js';
import { CliError, PlanningError } from '../src/errors.js';
import { realPlanFs, type PlanFs } from '../src/generate/plan.js';
import { NULLABLE_TOKENS } from '../src/generate/tokens.js';
import {
  defineTemplate,
  TEMPLATE_VARIABLES,
  templateFiles,
  type TemplateDefinition,
} from '../src/templates/definition.js';
import { KNOWN_TOKENS, type TemplateManifest } from '../src/templates/manifest.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { enumerateCombinations } from './accepted-combinations.js';
import { breathe, memoryPlanFs, TEST_CWD } from './helpers.js';

/**
 * Templates as first-class definitions: one contract for every template,
 * however its manifest is stored, resolved by one catalog and planned through
 * the one Generation Plan.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const registry = createRegistry(TEMPLATES_ROOT);
const catalog = createTemplateCatalog(adapters, TEMPLATES_ROOT);

const SYNTHETIC_ROOT = path.resolve('/ck-template');

/** A valid manifest to break one field at a time. */
const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...REACT_TEMPLATE_MANIFEST,
  id: 'synthetic',
  ...over,
});

const define = (over: Record<string, unknown> = {}): TemplateDefinition =>
  defineTemplate(manifest(over), {
    source: { kind: 'built-in', root: SYNTHETIC_ROOT },
    discoverable: false,
    label: 'test',
  });

/** A synthetic template's files, keyed relative to its root. */
const files = (entries: Record<string, string>): PlanFs =>
  memoryPlanFs(
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [path.join(SYNTHETIC_ROOT, key), value]),
    ),
  );

const MINIMAL = {
  'base/package.json': '{ "name": "{{projectName}}" }',
  'base/index.html': '<title>{{siteName}}</title>',
  'modes/coming-soon/src/page.tsx': 'export const page = 1;',
  'modes/full/src/page.tsx': 'export const page = 2;',
};

/** An adapter registry whose frameworks declare the given manifests. */
function declaring(overrides: Partial<Record<FrameworkId, TemplateManifest>>): AdapterRegistry {
  return {
    ...adapters,
    framework: (id) => {
      const adapter = adapters.framework(id);
      const templateManifest = overrides[id];
      return templateManifest === undefined ? adapter : { ...adapter, templateManifest };
    },
  };
}

const rejects = (fn: () => unknown, pattern: RegExp): void => {
  let error: unknown;
  try {
    fn();
  } catch (thrown) {
    error = thrown;
  }
  expect(error, 'expected a CliError').toBeInstanceOf(CliError);
  expect((error as Error).message).toMatch(pattern);
};

// ---------------------------------------------------------------------------
// Every shipped template
// ---------------------------------------------------------------------------

describe('every shipped template is a valid definition', () => {
  it('has one definition per implemented framework, ordered by id', () => {
    expect(catalog.list().map((entry) => [entry.id, entry.framework])).toEqual([
      ['astro-tailwind', 'astro'],
      ['nextjs', 'nextjs'],
      ['react-vite', 'react'],
    ]);
  });

  it('agrees with what each framework adapter declares', () => {
    for (const definition of catalog.list()) {
      const adapter = adapters.framework(definition.framework as FrameworkId);
      expect(definition.manifest).toEqual(adapter.templateManifest);
      expect(definition.discoverable).toBe(adapter.templateDiscoverable);
      expect(definition.source).toEqual({
        kind: 'built-in',
        root: path.join(TEMPLATES_ROOT, definition.id),
      });
    }
  });

  it('lists exactly the discoverable ones where --list-templates does', () => {
    expect(
      catalog
        .list()
        .filter((entry) => entry.discoverable)
        .map((entry) => entry.id),
    ).toEqual(registry.list().map((entry) => entry.id));
  });

  it('validates the code-declared manifests with the template.json validator', () => {
    // React's and Next's manifests never went through `parseManifest` before.
    for (const definition of catalog.list()) {
      expect(() =>
        defineTemplate(definition.manifest, {
          source: definition.source,
          discoverable: definition.discoverable,
          label: definition.id,
        }),
      ).not.toThrow();
    }
  });

  for (const definition of catalog.list()) {
    for (const mode of definition.modes) {
      it(`${definition.id} (${mode}) has valid, safe files that declare their tokens`, () => {
        const list = templateFiles(definition, mode);
        expect(list.length).toBeGreaterThan(5);
        for (const file of list) {
          expect(path.isAbsolute(file.source), file.destination).toBe(true);
          expect(file.source.startsWith(definition.source.root), file.destination).toBe(true);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('identity', () => {
  it('accepts lowercase kebab-case ids', () => {
    for (const id of ['synthetic', '404-minimal', 'coming-soon-minimal', 'a1']) {
      expect(define({ id }).id).toBe(id);
    }
  });

  it.each(['Synthetic', 'has space', '-leading', 'under_score', 'dots.no', ''])(
    'rejects the id %j',
    (id) => {
      rejects(() => define({ id }), /"id"/);
    },
  );

  it('refuses two templates with one id', () => {
    const shared = { ...REACT_TEMPLATE_MANIFEST, id: 'astro-tailwind' };
    rejects(
      () => createTemplateCatalog(declaring({ react: shared }), TEMPLATES_ROOT),
      /"astro-tailwind" is declared for both astro and react/,
    );
  });

  it('is independent of the filesystem path', () => {
    const elsewhere = defineTemplate(manifest(), {
      source: { kind: 'built-in', root: path.resolve('/somewhere/else') },
      discoverable: false,
      label: 'test',
    });
    expect(elsewhere.id).toBe(define().id);
  });

  it('refuses a relative source root', () => {
    rejects(
      () =>
        defineTemplate(manifest(), {
          source: { kind: 'built-in', root: 'templates/x' },
          discoverable: false,
          label: 'test',
        }),
      /relative source root/,
    );
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('metadata', () => {
  it('exposes identity, metadata and requirements from the manifest', () => {
    const definition = catalog.get('react-vite');
    expect(definition).toMatchObject({
      id: 'react-vite',
      version: REACT_TEMPLATE_MANIFEST.version,
      displayName: REACT_TEMPLATE_MANIFEST.displayName,
      description: REACT_TEMPLATE_MANIFEST.description,
      framework: 'react',
      modes: ['coming-soon', 'full'],
      requirements: { node: REACT_TEMPLATE_MANIFEST.minNode },
    });
  });

  it.each(['displayName', 'description', 'version', 'framework', 'minNode', 'tokens'])(
    'rejects a manifest missing "%s"',
    (key) => {
      rejects(() => define({ [key]: undefined }), new RegExp(`missing required key "${key}"`));
    },
  );

  it.each([
    [{ version: 1 }, /"version" must be a non-empty string/],
    [{ displayName: '  ' }, /"displayName" must be a non-empty string/],
    [{ supportedModes: [] }, /"supportedModes" cannot be empty/],
    [{ supportedModes: ['landing'] }, /unsupported mode "landing"/],
    [{ postSteps: ['rm -rf'] }, /unknown post-step/],
    [{ website: 'x' }, /unknown key "website"/],
  ])('rejects malformed metadata %j', (over, pattern) => {
    rejects(() => define(over), pattern);
  });

  it('refuses a template claiming another framework than its adapter', () => {
    const wrong = { ...REACT_TEMPLATE_MANIFEST, framework: 'astro' };
    rejects(
      () => createTemplateCatalog(declaring({ react: wrong }), TEMPLATES_ROOT),
      /react adapter declares template "react-vite", which says it is for "astro"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('compatibility', () => {
  it("resolves a stack to its framework's template", () => {
    for (const [framework, id] of [
      ['astro', 'astro-tailwind'],
      ['react', 'react-vite'],
      ['nextjs', 'nextjs'],
    ] as const) {
      expect(catalog.resolve({ framework, mode: 'coming-soon' }).id).toBe(id);
      expect(catalog.resolve({ framework, id, mode: 'full' }).id).toBe(id);
    }
  });

  it("refuses another framework's template, naming the right one", () => {
    let error: unknown;
    try {
      catalog.resolve({ framework: 'react', id: 'astro-tailwind', mode: 'coming-soon' });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as PlanningError).message).toBe(
      'Template "astro-tailwind" is for astro, not react.',
    );
    expect((error as PlanningError).hint).toBe('The react template is "react-vite".');
  });

  it('refuses an unknown template and a framework with none', () => {
    rejects(
      () => catalog.resolve({ framework: 'astro', id: 'nope', mode: 'coming-soon' }),
      /Unknown template "nope"/,
    );
    rejects(
      () => catalog.resolve({ framework: 'angular', mode: 'coming-soon' }),
      /no template for framework "angular"/,
    );
  });

  it('refuses a mode the template does not offer', () => {
    const narrow = { ...REACT_TEMPLATE_MANIFEST, supportedModes: ['coming-soon'] };
    const limited = createTemplateCatalog(
      declaring({ react: narrow as TemplateManifest }),
      TEMPLATES_ROOT,
    );
    rejects(
      () => limited.resolve({ framework: 'react', mode: 'full' }),
      /does not support mode "full"/,
    );
  });

  // Plans every accepted stack, like the detection round-trip, and needs the
  // same allowance: under a full preflight it ran past the 5 s default.
  it('agrees with the planner for every accepted stack', { timeout: 60_000 }, async () => {
    const { accepted } = enumerateCombinations(adapters);
    expect(accepted.length).toBeGreaterThan(0);
    for (const combination of accepted) {
      await breathe();
      const definition = catalog.resolve({
        framework: combination.framework as FrameworkId,
        mode: combination.starter as 'coming-soon' | 'full',
      });
      const planned = planManifest(
        {
          targetDir: path.join(TEST_CWD, 'acme'),
          projectName: 'acme',
          ...combination,
          site: { name: 'Acme', url: null, description: 'd', locale: 'en', author: null },
          packageManager: 'npm',
          git: true,
          install: true,
        } as ProjectManifest,
        {
          registry,
          cliVersion: '9.9.9',
          generatedAt: '2026-01-01T00:00:00.000Z',
          mode: combination.starter as 'coming-soon' | 'full',
          templateId: definition.id,
        },
      );
      expect(planned.plan.templateId, combination.id).toBe(definition.id);
      expect(planned.plan.templateVersion, combination.id).toBe(definition.version);
    }
  });

  it('leaves stack compatibility to the engine, not the template', () => {
    // Astro's template resolves; Bootstrap on Astro is refused by the
    // compatibility engine, exactly as it was before templates had a catalog.
    expect(catalog.resolve({ framework: 'astro', mode: 'coming-soon' }).id).toBe('astro-tailwind');
    expect(() =>
      planManifest(
        {
          targetDir: path.join(TEST_CWD, 'acme'),
          projectName: 'acme',
          framework: 'astro',
          buildTool: 'astro',
          language: 'ts',
          styling: 'bootstrap',
          uiLibrary: 'none',
          router: 'file-based',
          architecture: 'astro-standard',
          starter: 'coming-soon',
          features: [],
          site: { name: 'Acme', url: null, description: 'd', locale: 'en', author: null },
          packageManager: 'npm',
          git: true,
          install: true,
        } as ProjectManifest,
        {
          registry,
          cliVersion: '9.9.9',
          generatedAt: '2026-01-01T00:00:00.000Z',
          mode: 'coming-soon',
        },
      ),
    ).toThrow(/composed-stylesheet|will not work|requires/);
  });
});

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

describe('variables', () => {
  it('describes every token the engine knows, and no other', () => {
    expect(Object.keys(TEMPLATE_VARIABLES).sort()).toEqual([...KNOWN_TOKENS].sort());
  });

  it('marks as optional exactly the tokens the engine lets be empty', () => {
    for (const name of KNOWN_TOKENS) {
      expect(TEMPLATE_VARIABLES[name].required, name).toBe(!NULLABLE_TOKENS.has(name));
    }
  });

  it('types a definition’s variables from its declared tokens, in order', () => {
    const definition = define({ tokens: ['siteName', 'siteUrl'] });
    expect(definition.variables).toEqual([
      { name: 'siteName', type: 'text', required: true, from: 'site.name' },
      { name: 'siteUrl', type: 'url', required: false, from: 'site.url' },
    ]);
  });

  it('carries the template’s defaults', () => {
    expect(catalog.get('astro-tailwind').defaults).toEqual({ mode: 'coming-soon', locale: 'en' });
    rejects(
      () => define({ defaults: { mode: 'full' }, supportedModes: ['coming-soon'] }),
      /"defaults.mode" \(full\) is not listed/,
    );
  });

  it('rejects a duplicate, an unknown and a malformed variable', () => {
    rejects(() => define({ tokens: ['siteName', 'siteName'] }), /"siteName" is declared twice/);
    rejects(() => define({ tokens: ['logo'] }), /unknown token "logo"/);
    rejects(() => define({ tokens: 'siteName' }), /"tokens" must be an array of strings/);
  });

  it('rejects a file using a variable the template does not declare', () => {
    const definition = define({ tokens: ['siteName', 'projectName'] });
    rejects(
      () =>
        templateFiles(
          definition,
          'coming-soon',
          files({ ...MINIMAL, 'base/README.md': '© {{year}}' }),
        ),
      /uses \{\{year\}\} in base\/README\.md, which its manifest does not declare/,
    );
  });
});

// ---------------------------------------------------------------------------
// Files and path safety
// ---------------------------------------------------------------------------

describe('files', () => {
  it('lists base and mode files, renamed and in plan order, with the mode overriding', () => {
    const definition = define({ tokens: ['siteName', 'projectName'] });
    const list = templateFiles(
      definition,
      'coming-soon',
      files({ ...MINIMAL, 'base/_gitignore': 'dist', 'base/public/logo.png': 'PNG' }),
    );
    expect(list.map((file) => [file.destination, file.kind, file.layers])).toEqual([
      ['.gitignore', 'text', ['base']],
      ['index.html', 'text', ['base']],
      ['package.json', 'text', ['base']],
      ['public/logo.png', 'binary', ['base']],
      ['src/page.tsx', 'text', ['modes/coming-soon']],
    ]);
  });

  it('records every layer that provides a destination', () => {
    const definition = define({ tokens: ['siteName', 'projectName'] });
    const list = templateFiles(
      definition,
      'full',
      files({ ...MINIMAL, 'modes/full/package.json': '{ "private": true }' }),
    );
    const pkg = list.find((file) => file.destination === 'package.json');
    expect(pkg?.layers).toEqual(['base', 'modes/full']);
    expect(pkg?.source).toBe(path.join(SYNTHETIC_ROOT, 'modes', 'full', 'package.json'));
  });

  it('refuses two files for one destination within a layer', () => {
    rejects(
      () =>
        templateFiles(
          define({ tokens: ['siteName', 'projectName'] }),
          'coming-soon',
          files({ ...MINIMAL, 'base/_gitignore': 'a', 'base/.gitignore': 'b' }),
        ),
      /two files for "\.gitignore" in base/,
    );
  });

  it.each([
    ['..', 'escape.txt', /".." segment/],
    ['C:\\evil.txt', null, /absolute/],
  ])('refuses an unsafe destination: %s', (name, child, pattern) => {
    const definition = define({ tokens: ['siteName', 'projectName'] });
    const base = path.join(SYNTHETIC_ROOT, 'base');
    const unsafe: PlanFs = {
      exists: () => true,
      readText: () => '',
      readDir: (dir) => {
        if (dir === base) return [{ name, isDirectory: child !== null }];
        if (child !== null && dir === path.join(base, name)) {
          return [{ name: child, isDirectory: false }];
        }
        // A normal mode file, so the unsafe path is the only problem.
        if (dir === path.join(SYNTHETIC_ROOT, 'modes', 'coming-soon')) {
          return [{ name: 'page.tsx', isDirectory: false }];
        }
        return [];
      },
    };
    rejects(() => templateFiles(definition, 'coming-soon', unsafe), pattern);
  });

  it('refuses a missing template, an empty one and an unsupported mode', () => {
    // No directory at all is a missing source; a directory with nothing in it
    // is an empty template.
    rejects(() => templateFiles(define(), 'coming-soon', files({})), /has no directory/);
    const emptyDirs: PlanFs = { exists: () => true, readDir: () => [], readText: () => '' };
    rejects(() => templateFiles(define(), 'coming-soon', emptyDirs), /produced no files/);
    rejects(
      () => templateFiles(define({ supportedModes: ['coming-soon'] }), 'full', files(MINIMAL)),
      /does not support mode "full"/,
    );
  });

  it('only reads', () => {
    const fs = memoryPlanFs(
      Object.fromEntries(
        Object.entries(MINIMAL).map(([key, value]) => [path.join(SYNTHETIC_ROOT, key), value]),
      ),
    );
    templateFiles(define({ tokens: ['siteName', 'projectName'] }), 'coming-soon', fs);
    // PlanFs has no write operation; reads are of text files only.
    expect(fs.reads.every((file) => !file.endsWith('.png'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Generation Plan
// ---------------------------------------------------------------------------

describe('templates reach the filesystem only through the Generation Plan', () => {
  const planFor = (definition: TemplateDefinition, mode: 'coming-soon' | 'full', fs?: PlanFs) =>
    planManifest(
      {
        targetDir: path.join(TEST_CWD, 'acme'),
        projectName: 'acme',
        framework: definition.framework as FrameworkId,
        ...(definition.framework === 'astro'
          ? { buildTool: 'astro', router: 'file-based', architecture: 'astro-standard' }
          : definition.framework === 'react'
            ? { buildTool: 'vite', router: 'none', architecture: 'react-standard' }
            : { buildTool: 'next', router: 'file-based', architecture: 'next-app' }),
        language: 'ts',
        styling: 'tailwind',
        uiLibrary: 'none',
        starter: mode,
        features: [],
        site: { name: 'Acme', url: null, description: 'd', locale: 'en', author: null },
        packageManager: 'npm',
        git: true,
        install: true,
      } as ProjectManifest,
      {
        registry,
        cliVersion: '9.9.9',
        generatedAt: '2026-01-01T00:00:00.000Z',
        mode,
        ...(fs === undefined ? {} : { fs }),
      },
    );

  for (const definition of catalog.list()) {
    for (const mode of definition.modes) {
      it(`${definition.id} (${mode}): the plan carries every template file`, () => {
        const planned = planFor(definition, mode);
        expect(planned.plan.templateId).toBe(definition.id);
        expect(planned.plan.templateVersion).toBe(definition.version);

        const paths = new Set(planned.plan.operations.map((operation) => operation.path));
        for (const file of templateFiles(definition, mode)) {
          expect(paths.has(file.destination), file.destination).toBe(true);
        }
        // And every operation that came only from the template's own layers is
        // one the template lists.
        const listed = new Set(templateFiles(definition, mode).map((file) => file.destination));
        const own = new Set(['base', `modes/${mode}`]);
        for (const operation of planned.plan.operations) {
          const origins = operation.origin.split(' + ');
          if (origins.every((origin) => own.has(origin))) {
            expect(listed.has(operation.path), operation.path).toBe(true);
          }
        }
      });
    }
  }

  it('refuses a malformed template at planning, before anything could be written', () => {
    // The real Astro template, plus one file using a token it never declared.
    const astro = catalog.get('astro-tailwind');
    const base = path.join(astro.source.root, 'base');
    const extra = path.join(base, 'NOTICE.md');
    const tampered: PlanFs = {
      ...realPlanFs,
      readDir: (dir) => [
        ...realPlanFs.readDir(dir),
        ...(dir === base ? [{ name: 'NOTICE.md', isDirectory: false }] : []),
      ],
      readText: (file) => (file === extra ? '© {{year}}' : realPlanFs.readText(file)),
      // The injected file exists only here, so it resolves to itself.
      realpath: (target) => (target === extra ? extra : (realPlanFs.realpath?.(target) ?? target)),
    };
    let error: unknown;
    try {
      planFor(astro, 'coming-soon', tampered);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as Error).message).toMatch(/\{\{year\}\}.*does not declare/);
  });

  it('resolves through the catalog in the planner, not around it', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'bridge.ts'),
      'utf8',
    );
    expect(source).toContain('createTemplateCatalog(adapters, templatesRoot).resolve(');
    // Stage 5: the one template validator, for the mode being planned.
    expect(source).toContain(
      'validateTemplate(definition, { fs: options.fs ?? realPlanFs, modes: [options.mode] })',
    );
  });

  it('adds no writer: the contract module only reads', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'templates', 'definition.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/writeFile|mkdir|rmSync|renameSync|copyFile|unlink|spawn|fetch\(/);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('builds an equal catalog, resolution and file list every time', () => {
    const again = createTemplateCatalog(createAdapterRegistry(TEMPLATES_ROOT), TEMPLATES_ROOT);
    expect(again.list()).toEqual(catalog.list());
    for (const definition of catalog.list()) {
      expect(
        again.resolve({ framework: definition.framework as FrameworkId, mode: 'full' }),
      ).toEqual(definition);
      expect(templateFiles(definition, 'full')).toEqual(templateFiles(definition, 'full'));
    }
  });

  it('does not depend on the order a directory is listed in', () => {
    const definition = catalog.get('react-vite');
    const reversed: PlanFs = {
      ...realPlanFs,
      readDir: (dir) => [...realPlanFs.readDir(dir)].reverse(),
    };
    expect(templateFiles(definition, 'coming-soon', reversed)).toEqual(
      templateFiles(definition, 'coming-soon'),
    );
  });

  it('does not use locale-default comparison', () => {
    const expected = templateFiles(catalog.get('nextjs'), 'full');
    const compare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('localeCompare used');
    });
    try {
      const fresh = createTemplateCatalog(createAdapterRegistry(TEMPLATES_ROOT), TEMPLATES_ROOT);
      expect(templateFiles(fresh.get('nextjs'), 'full')).toEqual(expected);
      expect(fresh.list().map((entry) => entry.id)).toEqual(catalog.list().map((e) => e.id));
    } finally {
      compare.mockRestore();
    }
  });
});
