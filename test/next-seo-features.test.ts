import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import ts from 'typescript';

import { parseCliArgs } from '../src/args.js';
import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { checkCompatibility } from '../src/adapters/selection.js';
import { runCreate } from '../src/commands/create.js';
import { runUpgrade } from '../src/commands/upgrade.js';
import type { FeatureId, ProjectManifest } from '../src/domain/index.js';
import type { FileOperation } from '../src/generate/files.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { CLI_VERSION } from '../src/version.js';
import { TEST_CWD, tempDir, testLogger } from './helpers.js';

/**
 * Native Next.js SEO features: robots, sitemap and structured data.
 *
 * Each is a feature in the strict sense - selecting it produces its output,
 * not selecting it produces none - and the tests below hold all three to that
 * from both ends. Where a claim is about behaviour rather than text, the
 * generated modules are transpiled and *run*, so "the sitemap is empty without
 * a URL" is observed rather than inferred from a string.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const SEARCH: readonly FeatureId[] = ['robots', 'sitemap', 'structured-data'];

interface SiteOverrides {
  readonly name?: string;
  readonly url?: string | null;
  readonly description?: string;
}

const manifestFor = (
  framework: 'nextjs' | 'astro' | 'react',
  features: readonly FeatureId[],
  site: SiteOverrides = {},
  starter: 'full' | 'coming-soon' = 'full',
): ProjectManifest => {
  const stack =
    framework === 'nextjs'
      ? { buildTool: 'next', router: 'file-based', architecture: 'next-app', styling: 'none' }
      : framework === 'astro'
        ? {
            buildTool: 'astro',
            router: 'file-based',
            architecture: 'astro-standard',
            styling: 'tailwind',
          }
        : {
            buildTool: 'vite',
            router: 'none',
            architecture: 'react-standard',
            styling: 'tailwind',
          };

  return {
    targetDir: path.join(TEST_CWD, 'acme-site'),
    projectName: 'acme-site',
    framework,
    language: 'ts',
    uiLibrary: 'none',
    ...stack,
    starter,
    features,
    site: {
      name: site.name ?? 'Acme Ltd',
      url: site.url === undefined ? 'https://acme.example' : site.url,
      description: site.description ?? 'Bespoke widgets.',
      locale: 'en-GB',
      author: null,
    },
    packageManager: 'npm',
    git: true,
    install: true,
  } as ProjectManifest;
};

const planOf = (manifest: ProjectManifest) =>
  planManifest(manifest, {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: manifest.starter,
  });

const nextOps = (
  features: readonly FeatureId[],
  site: SiteOverrides = {},
  starter: 'full' | 'coming-soon' = 'full',
): readonly FileOperation[] =>
  planOf(manifestFor('nextjs', features, site, starter)).plan.operations;

const paths = (operations: readonly FileOperation[]): readonly string[] =>
  operations.map((entry) => entry.path);

const written = (operations: readonly FileOperation[], file: string): FileOperation => {
  const found = operations.find((entry) => entry.path === file);
  if (found?.type !== 'write') throw new Error(`nothing written at ${file}`);
  return found;
};

const content = (operations: readonly FileOperation[], file: string): string => {
  const found = written(operations, file);
  return found.type === 'write' ? found.content : '';
};

const template = (...segments: string[]): string =>
  readFileSync(path.join(TEMPLATES_ROOT, ...segments), 'utf8');

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

// ---------------------------------------------------------------------------
// Running the generated modules
// ---------------------------------------------------------------------------

/** What a generated project's search modules do, observed by running them. */
interface Loaded {
  readonly seo: {
    siteOrigin(url: string): string;
    absoluteUrl(origin: string, path: string): string;
    jsonLdScript(data: unknown): string;
  };
  robots(): { rules: unknown; sitemap?: string };
  sitemap(): readonly { url: string; lastModified?: unknown }[];
  structuredData(): { type: string; props: Record<string, unknown> };
}

interface ConfigEdits {
  /** Replaces `SITE.url` as written, the way a developer would edit it later. */
  readonly url?: string;
  readonly email?: string;
  readonly phone?: string;
}

/**
 * Generates a Next project with every search feature, then transpiles and
 * imports its modules.
 *
 * Type-only imports are erased by transpilation, so `next` is never needed.
 * JSX is compiled to a plain object factory, so a component's output is data
 * to inspect rather than markup to parse. Relative imports are rewritten to
 * the emitted `.mjs` files, which is the only change made to the source.
 */
async function load(site: SiteOverrides = {}, edits: ConfigEdits = {}): Promise<Loaded> {
  const operations = nextOps(SEARCH, site);
  const { dir, cleanup } = tempDir('next-seo');
  cleanups.push(cleanup);

  const files = [
    'lib/site.config.ts',
    'lib/seo.ts',
    'app/robots.ts',
    'app/sitemap.ts',
    'components/StructuredData.tsx',
  ];

  for (const file of files) {
    let source = content(operations, file);
    if (file === 'lib/site.config.ts') {
      if (edits.url !== undefined) {
        source = source.replace(/ {2}url: '[^']*',/, `  url: ${JSON.stringify(edits.url)},`);
      }
      if (edits.email !== undefined) {
        source = source.replace("  email: '',", `  email: ${JSON.stringify(edits.email)},`);
      }
      if (edits.phone !== undefined) {
        source = source.replace("  phone: '',", `  phone: ${JSON.stringify(edits.phone)},`);
      }
    }

    const output = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        jsxFactory: 'h',
      },
    }).outputText;

    const js =
      (file.endsWith('.tsx') ? 'const h = (type, props) => ({ type, props });\n' : '') +
      output.replace(/from '(\.\.?\/[^']+)'/g, "from '$1.mjs'");

    const target = path.join(dir, file.replace(/\.tsx?$/, '.mjs'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, js);
  }

  const imported = async (file: string) =>
    (await import(pathToFileURL(path.join(dir, file)).href)) as Record<string, unknown>;

  const seo = await imported('lib/seo.mjs');
  const robots = await imported('app/robots.mjs');
  const sitemap = await imported('app/sitemap.mjs');
  const component = await imported('components/StructuredData.mjs');

  return {
    seo: seo as unknown as Loaded['seo'],
    robots: robots['default'] as Loaded['robots'],
    sitemap: sitemap['default'] as Loaded['sitemap'],
    structuredData: component['StructuredData'] as Loaded['structuredData'],
  };
}

/** The JSON-LD a rendered component carries, as the raw script text. */
const scriptText = (element: { props: Record<string, unknown> }): string =>
  (element.props['dangerouslySetInnerHTML'] as { __html: string }).__html;

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('each feature is accepted on Next and refused where it cannot be kept', () => {
  it.each(SEARCH)('accepts %s on Next.js', (feature) => {
    expect(checkCompatibility(manifestFor('nextjs', [feature]), adapters).compatible).toBe(true);
  });

  it('accepts all of them together, and with seo', () => {
    expect(checkCompatibility(manifestFor('nextjs', [...SEARCH, 'seo']), adapters).compatible).toBe(
      true,
    );
  });

  it.each([
    ['react', 'robots'],
    ['react', 'sitemap'],
  ] as const)('refuses %s + %s, naming both ways it could be satisfied', (framework, feature) => {
    const report = checkCompatibility(manifestFor(framework, [feature]), adapters);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('metadata-routes');
    expect(JSON.stringify(report.violations)).toContain('template-crawler-files');
  });

  describe('Astro accepts robots and sitemap as documented no-ops', () => {
    const astroOps = (features: readonly FeatureId[]) =>
      planOf(manifestFor('astro', features)).plan.operations;

    it.each([['robots'], ['sitemap'], ['robots', 'sitemap']] as FeatureId[][])(
      'accepts %s, satisfied by what the template already ships',
      (...features) => {
        expect(checkCompatibility(manifestFor('astro', features), adapters).compatible).toBe(true);
      },
    );

    it('writes every file byte-for-byte as without the features, except the record', () => {
      const baseline = astroOps([]);
      const withBoth = astroOps(['robots', 'sitemap']);
      expect(paths(withBoth)).toEqual(paths(baseline));
      for (const operation of baseline.filter((entry) => entry.path !== '.client-site.json')) {
        expect(
          withBoth.find((entry) => entry.path === operation.path),
          operation.path,
        ).toEqual(operation);
      }
    });

    it('claims no ownership of the template’s robots route or sitemap', () => {
      for (const operation of astroOps(['robots', 'sitemap'])) {
        expect(operation.origin ?? '', operation.path).not.toMatch(/feature:(robots|sitemap)/);
      }
    });

    it('still ships the robots route and sitemap integration it always did', () => {
      const operations = astroOps(['robots', 'sitemap']);
      expect(paths(operations)).toContain('src/pages/robots.txt.ts');
      expect(content(operations, 'astro.config.mjs')).toContain('@astrojs/sitemap');
    });

    it('records the selection truthfully', () => {
      const record = JSON.parse(content(astroOps(['robots', 'sitemap']), '.client-site.json')) as {
        config: { features: string[] };
      };
      expect([...record.config.features].sort()).toEqual(['robots', 'sitemap']);
    });
  });

  it('refuses structured data on React, which renders in the browser', () => {
    const report = checkCompatibility(manifestFor('react', ['structured-data']), adapters);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report.violations)).toContain('document-metadata');
  });

  it('still accepts structured data on Astro, and leaves its output alone', () => {
    // Astro's template ships StructuredData.astro unconditionally. The feature
    // states nothing positive there, so the file set is the baseline's.
    const astro = (features: readonly FeatureId[]) =>
      paths(planOf(manifestFor('astro', features)).plan.operations);
    expect(checkCompatibility(manifestFor('astro', ['structured-data']), adapters).compatible).toBe(
      true,
    );
    expect(astro(['structured-data'])).toEqual(astro([]));
  });
});

// ---------------------------------------------------------------------------
// What each feature generates, and nothing more
// ---------------------------------------------------------------------------

describe('each feature produces exactly its own output', () => {
  const baseline = paths(nextOps([]));
  const added = (features: readonly FeatureId[]) =>
    paths(nextOps(features)).filter((entry) => !baseline.includes(entry));

  it('generates none of them by default', () => {
    for (const file of [
      'app/robots.ts',
      'app/sitemap.ts',
      'components/StructuredData.tsx',
      'lib/seo.ts',
    ]) {
      expect(baseline).not.toContain(file);
    }
  });

  it('robots alone adds the policy and nothing it does not use', () => {
    expect(added(['robots'])).toEqual(['app/robots.ts']);
    expect(content(nextOps(['robots']), 'app/robots.ts')).toBe(
      template('feature', 'robots', 'robots.ts'),
    );
  });

  it('sitemap adds the route module and the URL helpers it imports', () => {
    expect(added(['sitemap'])).toEqual(['app/sitemap.ts', 'lib/seo.ts']);
    expect(content(nextOps(['sitemap']), 'app/sitemap.ts')).toBe(
      template('feature', 'sitemap', 'sitemap.ts'),
    );
  });

  it('robots with sitemap advertises it, from the variant that imports the helpers', () => {
    const operations = nextOps(['robots', 'sitemap']);
    expect(content(operations, 'app/robots.ts')).toBe(
      template('feature', 'robots', 'robots-with-sitemap.ts'),
    );
    expect(content(operations, 'app/robots.ts')).toContain("'/sitemap.xml'");
  });

  it('structured data adds the component and helpers, and renders it on the home page', () => {
    expect(added(['structured-data'])).toEqual(['components/StructuredData.tsx', 'lib/seo.ts']);
    const page = content(nextOps(['structured-data']), 'app/page.tsx');
    expect(
      page.startsWith("import { StructuredData } from '../components/StructuredData';\n"),
    ).toBe(true);
    expect(page.split('<StructuredData />').length - 1).toBe(1);
  });

  it('the helpers are one file, whoever needs them, with every owner recorded', () => {
    const operations = nextOps(SEARCH);
    expect(content(operations, 'lib/seo.ts')).toBe(template('feature', 'shared', 'seo.ts'));
    expect(written(operations, 'lib/seo.ts').origin).toBe(
      'feature:robots + feature:sitemap + feature:structured-data',
    );
  });

  it('each new file is owned by the feature that asked for it', () => {
    const operations = nextOps(SEARCH);
    expect(written(operations, 'app/robots.ts').origin).toBe('feature:robots');
    expect(written(operations, 'app/sitemap.ts').origin).toBe('feature:sitemap');
    expect(written(operations, 'components/StructuredData.tsx').origin).toBe(
      'feature:structured-data',
    );
    expect(written(operations, 'app/page.tsx').origin).toContain('composed structured data');
  });

  it('records the selected features in the provenance file', () => {
    const record = JSON.parse(content(nextOps(SEARCH), '.client-site.json')) as {
      config: { features: string[] };
    };
    expect([...record.config.features].sort()).toEqual([...SEARCH].sort());
  });

  it('robots and sitemap touch no file the template ships', () => {
    const before = nextOps([]);
    const after = nextOps(['robots', 'sitemap']);
    // The record lists the features, so it is the one shipped file that changes.
    for (const operation of before.filter((entry) => entry.path !== '.client-site.json')) {
      expect(
        after.find((entry) => entry.path === operation.path),
        operation.path,
      ).toEqual(operation);
    }
  });

  it('structured data changes only the home page among the shipped files', () => {
    const before = nextOps([]);
    const after = nextOps(['structured-data']);
    const changed = before
      .filter((operation) => {
        const now = after.find((entry) => entry.path === operation.path);
        return JSON.stringify(now) !== JSON.stringify(operation);
      })
      .map((operation) => operation.path);
    // The record changes because it lists the feature; the page because it
    // renders the component. The layout and the not-found page do not.
    expect(changed.sort()).toEqual(['.client-site.json', 'app/page.tsx']);
  });
});

// ---------------------------------------------------------------------------
// Where the JSON-LD renders
// ---------------------------------------------------------------------------

describe('the JSON-LD renders on content pages and never on the 404', () => {
  it.each(['full', 'coming-soon'] as const)(
    'is the first thing inside the %s home page’s outermost element',
    (starter) => {
      const page = content(nextOps(['structured-data'], {}, starter), 'app/page.tsx');
      expect(page).toContain('    <div className="app-shell">\n      <StructuredData />\n');
    },
  );

  it('is not rendered by the layout, so the not-found route cannot inherit it', () => {
    const operations = nextOps(['structured-data']);
    expect(content(operations, 'app/layout.tsx')).not.toContain('StructuredData');
    expect(content(operations, 'app/not-found.tsx')).not.toContain('StructuredData');
  });

  it.each(['full', 'coming-soon'] as const)('leaves the %s page valid TypeScript', (starter) => {
    const diagnostics =
      ts.transpileModule(content(nextOps(['structured-data'], {}, starter), 'app/page.tsx'), {
        reportDiagnostics: true,
        fileName: 'app/page.tsx',
        compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext },
      }).diagnostics ?? [];
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// seo is unchanged in meaning
// ---------------------------------------------------------------------------

describe('seo still means the canonical, and only the canonical', () => {
  it('does not switch on robots, sitemap or structured data', () => {
    const files = paths(nextOps(['seo']));
    for (const file of [
      'app/robots.ts',
      'app/sitemap.ts',
      'components/StructuredData.tsx',
      'lib/seo.ts',
    ]) {
      expect(files).not.toContain(file);
    }
    expect(content(nextOps(['seo']), 'app/page.tsx')).not.toContain('StructuredData');
  });

  it('declares the origin as the metadata base, not SITE.url as written', () => {
    const layout = content(nextOps(['seo']), 'app/layout.tsx');
    expect(layout).toContain(
      "const siteBase = URL.canParse(SITE.url.trim()) ? new URL('/', SITE.url.trim()) : null;",
    );
    expect(layout).toContain('  metadataBase,\n');
    expect(layout).toContain("alternates: { canonical: metadataBase ? './' : null },");
  });

  it('keeps the not-found page out of the canonical, with every feature selected', () => {
    const operations = nextOps([...SEARCH, 'seo']);
    expect(content(operations, 'app/not-found.tsx')).toContain('alternates: { canonical: null },');
    expect(content(operations, 'app/not-found.tsx')).not.toContain('StructuredData');
  });

  it('composes canonical and structured data into different files without collision', () => {
    const operations = nextOps([...SEARCH, 'seo']);
    expect(written(operations, 'app/layout.tsx').origin).toContain('composed canonical');
    expect(written(operations, 'app/layout.tsx').origin).not.toContain('structured data');
    expect(written(operations, 'app/page.tsx').origin).toContain('composed structured data');
  });
});

// ---------------------------------------------------------------------------
// URL handling, observed
// ---------------------------------------------------------------------------

describe('one origin rule, shared by every search file', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['a root URL', 'https://acme.example', 'https://acme.example'],
    ['a trailing slash', 'https://acme.example/', 'https://acme.example'],
    ['a subpath', 'https://acme.example/en/shop', 'https://acme.example'],
    ['a query and fragment', 'https://acme.example/?ref=ad#top', 'https://acme.example'],
    ['a port', 'http://localhost:3000', 'http://localhost:3000'],
    ['an empty value', '', ''],
    ['whitespace', '   ', ''],
    ['something that is not a URL', 'acme.example', ''],
    ['a non-web scheme', 'ftp://acme.example', ''],
  ];

  it.each(cases)('reduces %s to its origin', async (_label, url, origin) => {
    const { seo } = await load();
    expect(seo.siteOrigin(url)).toBe(origin);
  });

  it.each(cases)(
    'agrees with the metadata base the canonical uses, for %s',
    (_label, url, origin) => {
      // The two declarations the layout carries, run as written against this URL.
      const layout = content(nextOps(['seo']), 'app/layout.tsx');
      const declarations = layout
        .split('\n')
        .filter(
          (line, index, lines) =>
            /^const (siteBase|metadataBase) =/.test(line) ||
            /^const metadataBase =/.test(lines[index - 1] ?? ''),
        )
        .join('\n');
      const metadataBase = new Function('SITE', `${declarations}\nreturn metadataBase;`)({
        url,
      }) as URL | null;
      expect(metadataBase === null ? '' : metadataBase.origin).toBe(origin);
      // And a base Next joins './' onto is the origin alone.
      if (metadataBase !== null) expect(metadataBase.href).toBe(`${origin}/`);
    },
  );

  it('joins paths without doubling slashes', async () => {
    const { seo } = await load();
    expect(seo.absoluteUrl('https://acme.example', '/')).toBe('https://acme.example/');
    expect(seo.absoluteUrl('https://acme.example', 'about')).toBe('https://acme.example/about');
    expect(seo.absoluteUrl('https://acme.example', '//about')).toBe('https://acme.example/about');
    expect(seo.absoluteUrl('', '/about')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// robots.txt, observed
// ---------------------------------------------------------------------------

describe('robots.txt', () => {
  it('lets every crawler index everything and advertises the sitemap by origin', async () => {
    const { robots } = await load({}, { url: 'https://acme.example/en?ref=x#top' });
    expect(robots()).toEqual({
      rules: { userAgent: '*', allow: '/' },
      sitemap: 'https://acme.example/sitemap.xml',
    });
  });

  it.each(['', 'not a url', 'ftp://acme.example'])(
    'advertises no sitemap without a usable origin (%j), and still allows indexing',
    async (url) => {
      const { robots } = await load({}, { url });
      expect(robots()).toEqual({ rules: { userAgent: '*', allow: '/' } });
    },
  );

  it('never disallows anything, whatever the URL', async () => {
    for (const url of ['', 'https://acme.example']) {
      const { robots } = await load({}, { url });
      expect(JSON.stringify(robots())).not.toContain('disallow');
    }
  });
});

// ---------------------------------------------------------------------------
// The sitemap, observed
// ---------------------------------------------------------------------------

describe('the sitemap', () => {
  it('lists the shipped page as an absolute URL, and nothing else', async () => {
    const { sitemap } = await load();
    expect(sitemap()).toEqual([{ url: 'https://acme.example/' }]);
  });

  it('uses the origin, whatever else SITE.url carries', async () => {
    const { sitemap } = await load({}, { url: 'https://acme.example/en/?utm=1#x' });
    expect(sitemap()).toEqual([{ url: 'https://acme.example/' }]);
  });

  it.each(['', 'not a url'])('is empty without a usable origin (%j)', async (url) => {
    const { sitemap } = await load({}, { url });
    expect(sitemap()).toEqual([]);
  });

  it('carries no clock-dependent field and no not-found route', async () => {
    const { sitemap } = await load();
    const entries = sitemap();
    expect(entries.every((entry) => entry.lastModified === undefined)).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/404|not-found/);
    expect(JSON.stringify(sitemap())).toBe(JSON.stringify(entries));
  });

  it('lists only routes the template ships', () => {
    const source = content(nextOps(['sitemap']), 'app/sitemap.ts');
    expect(source).toContain("const ROUTES: readonly string[] = ['/'];");
    expect(source).not.toContain('lastModified:');
  });
});

// ---------------------------------------------------------------------------
// JSON-LD, observed
// ---------------------------------------------------------------------------

describe('the Organization JSON-LD', () => {
  it('states what is configured, with the URL reduced to its origin', async () => {
    const { structuredData } = await load(
      {},
      { url: 'https://acme.example/en?ref=x', email: 'hello@acme.example', phone: '+44 20 0000' },
    );
    const element = structuredData();
    expect(element.type).toBe('script');
    expect(element.props['type']).toBe('application/ld+json');
    expect(JSON.parse(scriptText(element))).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Acme Ltd',
      url: 'https://acme.example',
      description: 'Bespoke widgets.',
      email: 'hello@acme.example',
      telephone: '+44 20 0000',
    });
  });

  it('omits every value that is not configured, and invents none', async () => {
    const { structuredData } = await load({ url: null });
    const parsed = JSON.parse(scriptText(structuredData())) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['@context', '@type', 'description', 'name']);
    for (const invented of ['logo', 'sameAs', 'address', 'location', 'url', 'email']) {
      expect(parsed, invented).not.toHaveProperty(invented);
    }
  });

  it('matches the contract the feature states, field for field', async () => {
    const { structuredData } = await load();
    const parsed = JSON.parse(scriptText(structuredData())) as Record<string, unknown>;
    const claim = planOf(manifestFor('nextjs', ['structured-data'])).structuredData[0];
    expect(claim).toBeDefined();
    expect(parsed).toEqual({ ...claim?.value });
  });

  it('cannot be broken out of by a configured value', async () => {
    const hostile = 'Acme </script><script>alert("x")</script> & <b>Co</b>';
    const { structuredData } = await load(
      { name: hostile, description: '</SCRIPT> & -->' },
      { email: '</script>@acme.example' },
    );
    const text = scriptText(structuredData());

    expect(text).not.toMatch(/[<>&]/);
    expect(text.toLowerCase()).not.toContain('</script');
    expect(text).toContain('\\u003c/script\\u003e');
    expect(text).toContain('\\u0026');

    // Still valid JSON, and the values decode back exactly.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['name']).toBe(hostile);
    expect(parsed['description']).toBe('</SCRIPT> & -->');
    expect(parsed['email']).toBe('</script>@acme.example');
  });

  it('escapes the three characters and nothing else', async () => {
    const { seo } = await load();
    expect(seo.jsonLdScript({ a: '<>&"\'é' })).toBe('{"a":"\\u003c\\u003e\\u0026\\"\'é"}');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('the output is deterministic', () => {
  it('is identical across runs', () => {
    expect(JSON.stringify(nextOps([...SEARCH, 'seo']))).toBe(
      JSON.stringify(nextOps([...SEARCH, 'seo'])),
    );
  });

  it('does not depend on the order the features were named in', () => {
    const forwards = nextOps(['robots', 'sitemap', 'structured-data', 'seo']);
    const backwards = nextOps(['seo', 'structured-data', 'sitemap', 'robots']);
    for (const file of [
      'app/robots.ts',
      'app/sitemap.ts',
      'app/page.tsx',
      'app/layout.tsx',
      'lib/seo.ts',
    ]) {
      expect(content(backwards, file), file).toBe(content(forwards, file));
      expect(written(backwards, file).origin, file).toBe(written(forwards, file).origin);
    }
  });

  it('writes no generation-time value into the new files', () => {
    const operations = nextOps(SEARCH, { url: 'https://acme.example' });
    for (const file of [
      'app/robots.ts',
      'app/sitemap.ts',
      'components/StructuredData.tsx',
      'lib/seo.ts',
    ]) {
      // Everything reads lib/site.config.ts at build time, so an edit there
      // after generation is reflected - nothing is frozen into these files.
      expect(content(operations, file), file).not.toContain('acme.example');
      expect(content(operations, file), file).not.toContain('Acme Ltd');
    }
  });
});

// ---------------------------------------------------------------------------
// Preview, idempotency, conflicts and upgrade, end to end
// ---------------------------------------------------------------------------

const BASE = [
  '--framework',
  'nextjs',
  '--name',
  'Acme Ltd',
  '--url',
  'https://acme.example',
  '--no-git',
  '--no-install',
];

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

async function create(cwd: string, argv: readonly string[]) {
  const { logger, out, err } = testLogger();
  const code = await runCreate({
    flags: parseCliArgs([...argv]),
    logger,
    registry: v1Registry,
    cliVersion: CLI_VERSION,
    cwd,
    env: {},
    isTTY: false,
    nodeVersion: process.versions.node,
  });
  return { code, text: plain(`${out.text}${err.text}`) };
}

async function upgrade(cwd: string, argv: readonly string[]) {
  const { logger, out, err } = testLogger();
  try {
    const code = await runUpgrade({
      flags: parseCliArgs([...argv]),
      logger,
      registry: v1Registry,
      cliVersion: CLI_VERSION,
      cwd,
      env: {},
      isTTY: false,
    });
    return { code, text: plain(`${out.text}${err.text}`), error: undefined };
  } catch (error) {
    return { code: -1, text: plain(`${out.text}${err.text}`), error: error as Error };
  }
}

function project(): { cwd: string; dir: string } {
  const { dir: cwd, cleanup } = tempDir('next-seo-e2e');
  cleanups.push(cleanup);
  return { cwd, dir: path.join(cwd, 'site') };
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out[path.relative(root, full)] =
          `${statSync(full).mtimeMs}:${readFileSync(full, 'base64')}`;
    }
  };
  walk(root);
  return out;
}

const FEATURES = ['--features', 'robots,sitemap,structured-data,seo'];

describe('the new files take part in preview, re-runs and upgrades', () => {
  it('previews every new file as a creation and writes nothing', async () => {
    const { cwd, dir } = project();
    const { code, text } = await create(cwd, ['site', ...BASE, ...FEATURES, '--yes', '--dry-run']);
    expect(code).toBe(0);
    for (const file of [
      'app/robots.ts',
      'app/sitemap.ts',
      'components/StructuredData.tsx',
      'lib/seo.ts',
    ]) {
      expect(text).toContain(file);
    }
    expect(() => statSync(dir)).toThrow();
  });

  it('is up to date on a second run with the same features', async () => {
    const { cwd, dir } = project();
    expect((await create(cwd, ['site', ...BASE, ...FEATURES, '--yes'])).code).toBe(0);
    expect(readFileSync(path.join(dir, 'app', 'robots.ts'), 'utf8')).toContain('sitemap');

    const { text } = await create(cwd, ['site', ...BASE, ...FEATURES, '--yes', '--dry-run']);
    expect(text).toMatch(
      /0 files to create\n {2}0 files to restore\n {2}0 files to modify\n {2}0 conflicts/,
    );
  });

  it('reports an edited feature file as a conflict rather than overwriting it', async () => {
    const { cwd, dir } = project();
    await create(cwd, ['site', ...BASE, ...FEATURES, '--yes']);
    const sitemapFile = path.join(dir, 'app', 'sitemap.ts');
    const edited = readFileSync(sitemapFile, 'utf8').replace("['/']", "['/', '/about']");
    writeFileSync(sitemapFile, edited);

    const { text } = await create(cwd, ['site', ...BASE, ...FEATURES, '--yes', '--dry-run']);
    expect(text).toMatch(/Conflicts \(1\)\n {2}! app\/sitemap\.ts/);
    expect(readFileSync(sitemapFile, 'utf8')).toBe(edited);
  });

  it('adds robots and sitemap to an existing project without replacing anything of yours', async () => {
    const { cwd, dir } = project();
    await create(cwd, ['site', ...BASE, '--yes']);
    const before = snapshot(dir);

    const preview = await upgrade(cwd, [
      'upgrade',
      'site',
      '--features',
      'robots,sitemap',
      '--dry-run',
    ]);
    expect(preview.code).toBe(0);
    expect(preview.text).toMatch(/app\/robots\.ts/);
    expect(preview.text).toMatch(/app\/sitemap\.ts/);
    expect(preview.text).toMatch(/lib\/seo\.ts/);
    expect(preview.text).toContain('Replace 1 generated file(s):\n    .client-site.json');
    expect(snapshot(dir)).toEqual(before);

    // Nothing that exists differs except the record, so no consent is needed.
    const applied = await upgrade(cwd, ['upgrade', 'site', '--features', 'robots,sitemap']);
    expect(applied.error).toBeUndefined();
    expect(applied.code).toBe(0);
    for (const file of ['app/robots.ts', 'app/sitemap.ts', 'lib/seo.ts']) {
      expect(statSync(path.join(dir, file)).isFile(), file).toBe(true);
    }
    const after = snapshot(dir);
    for (const [file, stamp] of Object.entries(before)) {
      if (file === '.client-site.json') continue;
      expect(after[file], file).toBe(stamp);
    }
  });

  it('asks before changing a page an upgrade adds structured data to, and writes nothing without an answer', async () => {
    const { cwd, dir } = project();
    await create(cwd, ['site', ...BASE, '--yes']);
    const before = snapshot(dir);

    const preview = await upgrade(cwd, [
      'upgrade',
      'site',
      '--features',
      'structured-data',
      '--dry-run',
    ]);
    expect(preview.text).toMatch(/Conflicts \(1\)\n {2}! app\/page\.tsx/);
    expect(preview.text).toContain('+ import { StructuredData }');

    // Non-interactive and no consent: refused before a single write.
    const applied = await upgrade(cwd, ['upgrade', 'site', '--features', 'structured-data']);
    expect(applied.code === 0 && applied.error === undefined).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });
});
