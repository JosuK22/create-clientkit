import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { NEXTJS_TEMPLATE_MANIFEST } from '../src/adapters/nextjs.js';
import { REACT_TEMPLATE_MANIFEST } from '../src/adapters/react.js';
import { createAdapterRegistry, type AdapterRegistry } from '../src/adapters/registry.js';
import {
  createTemplateCatalog,
  validateTemplateCatalog,
} from '../src/adapters/template-catalog.js';
import type { FrameworkId } from '../src/domain/dimensions.js';
import type { ProjectManifest } from '../src/domain/manifest.js';
import { PlanningError } from '../src/errors.js';
import { realPlanFs, type PlanFs } from '../src/generate/plan.js';
import { defineTemplate, type TemplateDefinition } from '../src/templates/definition.js';
import type { TemplateManifest } from '../src/templates/manifest.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import {
  assertValidTemplate,
  formatValidation,
  inspectTemplateFiles,
  validateTemplate,
  type TemplateIssue,
  type TemplateValidationResult,
} from '../src/templates/validation.js';
import { verifyTemplatePlans } from '../src/verify/templates.js';
import { memoryPlanFs, TEST_CWD } from './helpers.js';

/**
 * Stage 5: template validation. Every problem reported at once, with a stable
 * code, before anything is planned from the template - and every shipped
 * template VALID at every level.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const registry = createRegistry(TEMPLATES_ROOT);
const catalog = createTemplateCatalog(adapters, TEMPLATES_ROOT);

const ROOT = path.resolve('/ck-validate');

const define = (over: Record<string, unknown> = {}): TemplateDefinition =>
  defineTemplate(
    { ...REACT_TEMPLATE_MANIFEST, id: 'synthetic', tokens: ['siteName', 'projectName'], ...over },
    { source: { kind: 'built-in', root: ROOT }, discoverable: false, label: 'test' },
  );

const files = (entries: Record<string, string>): PlanFs =>
  memoryPlanFs(
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [path.join(ROOT, key), value]),
    ),
  );

/** Uses both declared tokens, and gives each mode a file. */
const GOOD = {
  'base/package.json': '{ "name": "{{projectName}}" }',
  'base/index.html': '<title>{{siteName}}</title>',
  'modes/coming-soon/src/page.tsx': 'export const page = 1;',
  'modes/full/src/page.tsx': 'export const page = 2;',
};

const codes = (result: TemplateValidationResult): string[] =>
  [...result.errors, ...result.warnings].map((issue) => issue.code);

const only = (result: TemplateValidationResult, code: string): TemplateIssue => {
  const found = [...result.errors, ...result.warnings].filter((issue) => issue.code === code);
  expect(found, `${code} in ${formatValidation(result)}`).toHaveLength(1);
  return found[0] as TemplateIssue;
};

function declaring(overrides: Partial<Record<FrameworkId, unknown>>): AdapterRegistry {
  return {
    ...adapters,
    framework: (id) => {
      const adapter = adapters.framework(id);
      const templateManifest = overrides[id];
      return templateManifest === undefined
        ? adapter
        : { ...adapter, templateManifest: templateManifest as TemplateManifest };
    },
  };
}

// ---------------------------------------------------------------------------
// Every shipped template
// ---------------------------------------------------------------------------

describe('every shipped template is VALID', () => {
  it('passes catalog and template validation with no errors and no warnings', () => {
    const validation = validateTemplateCatalog(adapters, TEMPLATES_ROOT);
    expect(validation.catalog).toEqual([]);
    expect(validation.templates.map(formatValidation)).toEqual([
      'astro-tailwind: VALID',
      'nextjs: VALID',
      'react-vite: VALID',
    ]);
    expect(validation.valid).toBe(true);
  });

  it(
    'produces a valid, deterministic Generation Plan for every mode, at the recorded framework version',
    { timeout: 60_000 },
    () => {
      const results = verifyTemplatePlans(catalog, {
        adapters,
        registry,
        templatesRoot: TEMPLATES_ROOT,
      });
      expect(results.map(formatValidation)).toEqual([
        'astro-tailwind: VALID',
        'nextjs: VALID',
        'react-vite: VALID',
      ]);
    },
  );

  it('declares exactly the tokens its files use', () => {
    // Stage 5 found React and Next declaring {{mode}} they never used.
    expect(REACT_TEMPLATE_MANIFEST.tokens).not.toContain('mode');
    expect(NEXTJS_TEMPLATE_MANIFEST.tokens).not.toContain('mode');
    for (const definition of catalog.list()) {
      expect(validateTemplate(definition).warnings, definition.id).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

describe('the validation result', () => {
  it('reports every problem at once, by mode then destination, with stable codes', () => {
    const result = validateTemplate(define({ tokens: ['siteName', 'projectName', 'author'] }), {
      fs: files({
        ...GOOD,
        'base/README.md': '© {{year}}',
        'base/aux.txt': 'reserved',
        'base/.client-site.json': '{}',
      }),
    });
    expect(result.valid).toBe(false);
    // coming-soon, then full, since the base layer is checked for each mode;
    // within a mode, by destination through the pinned collator.
    const perMode = ['destination-reserved', 'destination-name', 'token-undeclared'];
    expect(codes(result)).toEqual([...perMode, ...perMode]);
    expect(result.errors.map((issue) => issue.destination)).toEqual([
      '.client-site.json',
      'aux.txt',
      'README.md',
      '.client-site.json',
      'aux.txt',
      'README.md',
    ]);
    expect(result.errors.every((issue) => issue.templateId === 'synthetic')).toBe(true);
    // {{author}} goes unused, but with errors in the files usage is not judged.
    expect(result.warnings).toEqual([]);
  });

  it('says what is wrong, where, and what to change', () => {
    const issue = only(
      validateTemplate(define(), {
        fs: files({ ...GOOD, 'base/README.md': '{{year}}' }),
        modes: ['full'],
      }),
      'token-undeclared',
    );
    expect(issue).toMatchObject({
      severity: 'error',
      templateId: 'synthetic',
      mode: 'full',
      source: 'base/README.md',
      destination: 'README.md',
      variable: 'year',
      message:
        'Template "synthetic" uses {{year}} in base/README.md, which its manifest does not declare.',
      hint: 'Declare every token a template uses in its manifest "tokens" list.',
    });
  });

  it('throws the first error as a PlanningError, the rest in the hint', () => {
    const result = validateTemplate(define(), {
      fs: files({ ...GOOD, 'base/a.txt': '{{year}}', 'base/b.txt': '{{locale}}' }),
      modes: ['coming-soon'],
    });
    let error: unknown;
    try {
      assertValidTemplate(result);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as PlanningError).message).toContain('{{year}} in base/a.txt');
    expect((error as PlanningError).hint).toContain('1 more problem:');
    expect((error as PlanningError).hint).toContain('{{locale}} in base/b.txt');
  });

  it('never throws for warnings alone', () => {
    const result = validateTemplate(define({ tokens: ['siteName', 'projectName', 'author'] }), {
      fs: files(GOOD),
    });
    expect(result.valid).toBe(true);
    expect(codes(result)).toEqual(['token-unused']);
    expect(() => assertValidTemplate(result)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Metadata, requirements and defaults
// ---------------------------------------------------------------------------

describe('metadata and requirements', () => {
  it.each(['22', '^22.12.0', '>=22', '>= 22.12.0', 'latest'])(
    'refuses the Node requirement %j',
    (minNode) => {
      const issue = only(
        validateTemplate(define({ minNode }), { fs: files(GOOD) }),
        'requirement-node',
      );
      expect(issue.message).toContain(`requires Node "${minNode}"`);
    },
  );

  it('accepts a >=MAJOR.MINOR.PATCH requirement', () => {
    expect(validateTemplate(define({ minNode: '>=22.12.0' }), { fs: files(GOOD) }).valid).toBe(
      true,
    );
  });

  it('refuses a default locale that is not a locale tag', () => {
    const issue = only(
      validateTemplate(define({ defaults: { mode: 'coming-soon', locale: 'english language' } }), {
        fs: files(GOOD),
      }),
      'default-locale',
    );
    expect(issue.message).toContain('"english language"');
  });

  it('leaves malformed manifests to the manifest validator, reported by the catalog', () => {
    const validation = validateTemplateCatalog(
      declaring({ react: { ...REACT_TEMPLATE_MANIFEST, supportedModes: ['landing'] } }),
      TEMPLATES_ROOT,
    );
    expect(validation.valid).toBe(false);
    expect(validation.catalog).toMatchObject([
      {
        code: 'manifest-invalid',
        templateId: 'react-vite',
        message: expect.stringMatching(/unsupported mode "landing"/),
      },
    ]);
    // The other two still validate.
    expect(validation.templates.map((result) => result.templateId)).toEqual([
      'astro-tailwind',
      'nextjs',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

describe('variables', () => {
  it('reports an undeclared token once per file, naming it', () => {
    const result = validateTemplate(define(), {
      fs: files({ ...GOOD, 'modes/full/src/footer.tsx': '© {{year}} {{author}}' }),
    });
    expect(codes(result)).toEqual(['token-undeclared']);
    expect(result.errors[0]?.message).toContain(
      '{{author}}, {{year}} in modes/full/src/footer.tsx',
    );
    expect(result.errors[0]?.mode).toBe('full');
  });

  it('ignores {{placeholders}} the engine does not know, as substitution does', () => {
    // Unknown names are the substitution engine's hard error at planning; a
    // template cannot declare them, so they are not a declaration problem.
    expect(
      validateTemplate(define(), { fs: files({ ...GOOD, 'base/x.md': '{{notAToken}}' }) }).valid,
    ).toBe(true);
  });

  it('warns about a declared token no mode uses, only when every mode is checked', () => {
    const definition = define({ tokens: ['siteName', 'projectName', 'locale'] });
    expect(codes(validateTemplate(definition, { fs: files(GOOD) }))).toEqual(['token-unused']);
    expect(codes(validateTemplate(definition, { fs: files(GOOD), modes: ['full'] }))).toEqual([]);
  });

  it('counts a token used by only one mode as used', () => {
    const definition = define({ tokens: ['siteName', 'projectName', 'locale'] });
    const result = validateTemplate(definition, {
      fs: files({ ...GOOD, 'modes/full/src/lang.ts': 'export const lang = "{{locale}}";' }),
    });
    expect(codes(result)).toEqual([]);
  });

  it('refuses unsupported, duplicate and malformed declarations through the catalog', () => {
    for (const [tokens, pattern] of [
      [['siteName', 'logo'], /unknown token "logo"/],
      [['siteName', 'siteName'], /"siteName" is declared twice/],
      ['siteName', /"tokens" must be an array of strings/],
    ] as const) {
      const validation = validateTemplateCatalog(
        declaring({ nextjs: { ...NEXTJS_TEMPLATE_MANIFEST, tokens } }),
        TEMPLATES_ROOT,
      );
      expect(validation.catalog[0]?.code).toBe('manifest-invalid');
      expect(validation.catalog[0]?.message).toMatch(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// Files, sources and destinations
// ---------------------------------------------------------------------------

describe('files, sources and destinations', () => {
  it('refuses a template with no directory, and one with no base layer', () => {
    expect(codes(validateTemplate(define(), { fs: files({}) }))).toEqual([
      'source-missing',
      'source-missing',
    ]);
    const noBase = files({ 'modes/coming-soon/a.txt': 'x', 'modes/full/a.txt': 'x' });
    expect(validateTemplate(define(), { fs: noBase }).errors[0]?.message).toContain(
      'no base/ layer',
    );
  });

  it('refuses an empty template and an incomplete mode', () => {
    const empty: PlanFs = { exists: () => true, readDir: () => [], readText: () => '' };
    expect(codes(validateTemplate(define(), { fs: empty }))).toEqual([
      'template-empty',
      'template-empty',
    ]);
    const { 'modes/full/src/page.tsx': _full, ...noFull } = GOOD;
    const result = validateTemplate(define(), { fs: files(noFull) });
    expect(codes(result)).toEqual(['mode-incomplete']);
    expect(result.errors[0]).toMatchObject({ mode: 'full' });
    expect(result.errors[0]?.message).toContain('no files under modes/full/');
  });

  it('refuses a mode the template does not declare', () => {
    const result = validateTemplate(define({ supportedModes: ['coming-soon'] }), {
      fs: files(GOOD),
      modes: ['full'],
    });
    expect(codes(result)).toEqual(['mode-unsupported']);
  });

  it('refuses a source linked from outside the template', () => {
    const outside = path.resolve('/elsewhere/secret.txt');
    const linked: PlanFs = {
      ...files({ ...GOOD, 'base/link.txt': 'x' }),
      realpath: (target) => (target === path.join(ROOT, 'base', 'link.txt') ? outside : target),
    };
    const issue = only(
      validateTemplate(define(), { fs: linked, modes: ['full'] }),
      'source-outside-root',
    );
    expect(issue.message).toContain(outside);
    expect(issue.source).toBe('base/link.txt');
  });

  it('refuses a source that does not resolve, or cannot be read', () => {
    const broken: PlanFs = {
      ...files({ ...GOOD, 'base/gone.txt': 'x', 'base/dir.txt': 'x' }),
      realpath: (target) => {
        if (target.endsWith('gone.txt')) throw new Error('ENOENT: no such file');
        return target;
      },
      readText: (file) => {
        if (file.endsWith('dir.txt')) throw new Error('EISDIR: illegal operation on a directory');
        return files(GOOD).readText(file);
      },
    };
    const result = validateTemplate(define(), { fs: broken, modes: ['coming-soon'] });
    expect(codes(result)).toEqual(['source-unreadable', 'source-unreadable']);
    expect(result.errors.map((issue) => issue.source)).toEqual(['base/dir.txt', 'base/gone.txt']);
  });

  it.each([
    ['aux.txt', /"aux.txt" is a reserved name on Windows/],
    ['CON', /"CON" is a reserved name/],
    // 'a:b.txt' would be a drive path, refused as absolute before its name is read.
    ['ab:c.txt', /contains a character Windows forbids/],
    ['trailing.', /ends in a dot or a space/],
  ])('refuses the destination name %j', (name, pattern) => {
    const issue = only(
      validateTemplate(define(), {
        fs: files({ ...GOOD, [`base/${name}`]: 'x' }),
        modes: ['full'],
      }),
      'destination-name',
    );
    expect(issue.message).toMatch(pattern);
  });

  it('refuses the file ClientKit writes itself', () => {
    const issue = only(
      validateTemplate(define(), {
        fs: files({ ...GOOD, 'modes/full/.client-site.json': '{}' }),
        modes: ['full'],
      }),
      'destination-reserved',
    );
    expect(issue.destination).toBe('.client-site.json');
  });

  it('refuses a path that is a file in one layer and a directory in another', () => {
    const issue = only(
      validateTemplate(define(), {
        fs: files({ ...GOOD, 'base/src': 'a file', 'modes/full/src/extra.tsx': 'x' }),
        modes: ['full'],
      }),
      'layer-file-directory',
    );
    expect(issue.message).toContain('"src" as a file and as the directory holding "src/extra.tsx"');
  });

  it('allows the same destination in two layers, which is an override', () => {
    const result = validateTemplate(define(), {
      fs: files({ ...GOOD, 'modes/full/index.html': '<title>{{siteName}}</title>' }),
    });
    expect(result.valid).toBe(true);
  });

  it('keeps Stage 4’s rules as the one walk: unsafe paths and same-layer duplicates', () => {
    const base = path.join(ROOT, 'base');
    const unsafe: PlanFs = {
      exists: () => true,
      readText: () => '',
      readDir: (dir) => {
        if (dir === base) return [{ name: '..', isDirectory: true }];
        if (dir === ROOT) return [{ name: 'escape.txt', isDirectory: false }];
        if (dir === path.join(ROOT, 'modes', 'full'))
          return [{ name: 'p.tsx', isDirectory: false }];
        return [];
      },
    };
    expect(codes(validateTemplate(define(), { fs: unsafe, modes: ['full'] }))).toEqual([
      'destination-unsafe',
    ]);
    const dup = files({ ...GOOD, 'base/_gitignore': 'a', 'base/.gitignore': 'b' });
    expect(codes(validateTemplate(define(), { fs: dup, modes: ['full'] }))).toEqual([
      'layer-duplicate',
    ]);
    // And the files list skips what it refused.
    expect(
      inspectTemplateFiles(define(), 'full', dup).files.filter(
        (f) => f.destination === '.gitignore',
      ),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

describe('the catalog', () => {
  it('reports a duplicate id and a framework it does not own, and keeps the rest', () => {
    const validation = validateTemplateCatalog(
      declaring({
        react: { ...REACT_TEMPLATE_MANIFEST, id: 'astro-tailwind' },
        nextjs: { ...NEXTJS_TEMPLATE_MANIFEST, framework: 'react' },
      }),
      TEMPLATES_ROOT,
    );
    expect(validation.catalog.map((issue) => [issue.code, issue.templateId])).toEqual([
      ['id-duplicate', 'astro-tailwind'],
      ['framework-owner', 'nextjs'],
      // React now declares "astro-tailwind", so nothing declares templates/react-vite.
      ['catalog-orphan', 'react-vite'],
    ]);
    expect(validation.templates.map((result) => result.templateId)).toEqual(['astro-tailwind']);
  });

  it('reports a template directory no framework declares', () => {
    const orphan = path.join(TEMPLATES_ROOT, 'vue-vite');
    const fs: PlanFs = {
      ...realPlanFs,
      readDir: (dir) =>
        dir === TEMPLATES_ROOT
          ? [...realPlanFs.readDir(dir), { name: 'vue-vite', isDirectory: true }]
          : realPlanFs.readDir(dir),
      exists: (dir) => dir === path.join(orphan, 'base') || realPlanFs.exists(dir),
    };
    const validation = validateTemplateCatalog(adapters, TEMPLATES_ROOT, fs);
    expect(validation.catalog).toMatchObject([{ code: 'catalog-orphan', templateId: 'vue-vite' }]);
    expect(validation.valid).toBe(false);
  });

  it('does not count the shared styling, component-library and feature material', () => {
    const shared = readdirSync(TEMPLATES_ROOT).filter(
      (name) => !catalog.list().some((definition) => definition.id === name),
    );
    expect(shared.sort()).toEqual(['feature', 'styling', 'ui-library']);
    expect(validateTemplateCatalog(adapters, TEMPLATES_ROOT).catalog).toEqual([]);
  });

  it('still fails to build at planning time on the first catalog error', () => {
    expect(() =>
      createTemplateCatalog(
        declaring({ nextjs: { ...NEXTJS_TEMPLATE_MANIFEST, framework: 'react' } }),
        TEMPLATES_ROOT,
      ),
    ).toThrow(PlanningError);
  });
});

// ---------------------------------------------------------------------------
// Plan level
// ---------------------------------------------------------------------------

describe('plan-level validation', () => {
  const verifyWith = (over: { fs?: PlanFs; templatesRoot?: string }, list = catalog) =>
    verifyTemplatePlans(list, {
      adapters,
      registry,
      templatesRoot: over.templatesRoot ?? TEMPLATES_ROOT,
      ...(over.fs === undefined ? {} : { fs: over.fs }),
    });

  it(
    'reports a recorded frameworkVersion the adapter does not install',
    { timeout: 30_000 },
    () => {
      const stale = createTemplateCatalog(
        declaring({ react: { ...REACT_TEMPLATE_MANIFEST, frameworkVersion: '18.0.0' } }),
        TEMPLATES_ROOT,
      );
      const react = verifyWith({}, stale).find((result) => result.templateId === 'react-vite');
      expect(react?.errors.map((issue) => [issue.code, issue.mode])).toEqual([
        ['framework-version', 'coming-soon'],
        ['framework-version', 'full'],
      ]);
      expect(react?.errors[0]?.message).toBe(
        'Template "react-vite" records frameworkVersion 18.0.0, but its plan installs react@19.3.0.',
      );
    },
  );

  it(
    'reports a mode that cannot be planned, with the planner’s reason',
    { timeout: 30_000 },
    () => {
      const full = path.join(TEMPLATES_ROOT, 'nextjs', 'modes', 'full');
      const fs: PlanFs = {
        ...realPlanFs,
        readDir: (dir) =>
          dir === full || dir.startsWith(`${full}${path.sep}`) ? [] : realPlanFs.readDir(dir),
      };
      const nextjs = verifyWith({ fs }).find((result) => result.templateId === 'nextjs');
      expect(nextjs?.errors.map((issue) => [issue.code, issue.mode])).toEqual([
        ['plan-invalid', 'full'],
      ]);
      expect(nextjs?.errors[0]?.message).toContain('no files under modes/full/');
    },
  );

  it('reports a plan that differs between two runs', { timeout: 30_000 }, () => {
    let reads = 0;
    const readme = path.join(TEMPLATES_ROOT, 'astro-tailwind', 'base', 'README.md');
    const fs: PlanFs = {
      ...realPlanFs,
      readText: (file) =>
        file === readme
          ? `${realPlanFs.readText(file)}\n<!-- ${(reads += 1)} -->`
          : realPlanFs.readText(file),
    };
    const astro = verifyWith({ fs }).find((result) => result.templateId === 'astro-tailwind');
    expect(astro?.errors.map((issue) => issue.code)).toContain('plan-nondeterministic');
  });

  it('reports copies from outside the shipped templates', { timeout: 30_000 }, () => {
    const results = verifyWith({ templatesRoot: path.join(TEMPLATES_ROOT, 'feature') });
    for (const result of results) {
      expect(
        result.errors.map((issue) => issue.code),
        result.templateId,
      ).toContain('plan-source-outside');
    }
  });
});

// ---------------------------------------------------------------------------
// Failure timing, and reading only
// ---------------------------------------------------------------------------

describe('failure timing and read-only', () => {
  it('refuses an invalid template at planning, so apply is never reached', () => {
    const readme = path.join(TEMPLATES_ROOT, 'react-vite', 'base', 'README.md');
    const fs: PlanFs = {
      ...realPlanFs,
      readText: (file) =>
        file === readme ? `${realPlanFs.readText(file)}\n{{year}}` : realPlanFs.readText(file),
    };
    expect(() =>
      planManifest(
        {
          targetDir: path.join(TEST_CWD, 'acme'),
          projectName: 'acme',
          framework: 'react',
          buildTool: 'vite',
          language: 'ts',
          styling: 'tailwind',
          uiLibrary: 'none',
          router: 'none',
          architecture: 'react-standard',
          starter: 'full',
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
          mode: 'full',
          fs,
        },
      ),
    ).toThrow(/Template "react-vite" uses \{\{year\}\} in base\/README\.md/);
  });

  it('validation changes no file in the shipped templates', { timeout: 60_000 }, () => {
    const snapshot = (): string[] => {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            const stats = statSync(full);
            out.push(
              `${full}:${stats.size}:${stats.mtimeMs}:${readFileSync(full, 'base64').length}`,
            );
          }
        }
      };
      walk(TEMPLATES_ROOT);
      return out.sort();
    };
    const before = snapshot();
    validateTemplateCatalog(adapters, TEMPLATES_ROOT);
    verifyTemplatePlans(catalog, { adapters, registry, templatesRoot: TEMPLATES_ROOT });
    expect(snapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const messy = files({
    ...GOOD,
    'base/aux.txt': 'x',
    'base/README.md': '{{year}}',
    'modes/full/src/z.md': '{{locale}}',
    'modes/coming-soon/.client-site.json': '{}',
  });

  it('gives the same result, in the same order, every time', () => {
    const first = validateTemplate(define({ tokens: ['siteName', 'projectName', 'author'] }), {
      fs: messy,
    });
    for (let run = 0; run < 3; run += 1) {
      expect(
        validateTemplate(define({ tokens: ['siteName', 'projectName', 'author'] }), { fs: messy }),
      ).toEqual(first);
    }
    expect(validateTemplateCatalog(adapters, TEMPLATES_ROOT)).toEqual(
      validateTemplateCatalog(adapters, TEMPLATES_ROOT),
    );
  });

  it('does not depend on the order directories are listed in', () => {
    const reversed: PlanFs = { ...messy, readDir: (dir) => [...messy.readDir(dir)].reverse() };
    expect(validateTemplate(define(), { fs: reversed })).toEqual(
      validateTemplate(define(), { fs: messy }),
    );
  });

  it('never uses locale-default comparison', () => {
    const expected = validateTemplate(define(), { fs: messy });
    const catalogExpected = validateTemplateCatalog(adapters, TEMPLATES_ROOT);
    const compare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('localeCompare used');
    });
    try {
      expect(validateTemplate(define(), { fs: messy })).toEqual(expected);
      expect(validateTemplateCatalog(adapters, TEMPLATES_ROOT)).toEqual(catalogExpected);
    } finally {
      compare.mockRestore();
    }
  });
});
