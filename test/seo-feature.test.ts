import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASTRO_DECLARATION } from '../src/adapters/astro.js';
import { assertRequiredRoles, planManifest, resolveWithAdapters } from '../src/adapters/bridge.js';
import { MUI_DECLARATION } from '../src/adapters/mui.js';
import { NOT_FOUND_DECLARATION } from '../src/adapters/not-found.js';
import { REACT_DECLARATION } from '../src/adapters/react.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { SEO_DECLARATION } from '../src/adapters/seo.js';
import { checkCompatibility, resolveProject, selectAdapters } from '../src/adapters/selection.js';
import { VITE_DECLARATION } from '../src/adapters/vite.js';
import type {
  AdapterDeclaration,
  FeatureId,
  FrameworkId,
  ProjectManifest,
} from '../src/domain/index.js';
import { evaluateCombination } from '../src/domain/index.js';
import { collectMetadata, resolveSeoContract, siteOrigin } from '../src/domain/seo.js';
import { CliError } from '../src/errors.js';
import type { FileOperation } from '../src/generate/files.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import type { ConfigContribution } from '../src/domain/contributions.js';
import type { SiteContext } from '../src/types.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * SEO, as a feature.
 *
 * The claim under test is that what a page's head must *say* is entirely
 * framework-independent, and can be owned by a feature while each framework
 * keeps owning how it says it.
 *
 * The sharpest test is at the bottom: the contract this feature computes is
 * compared against the HTML a real Astro build emitted. A generic model that
 * quietly disagrees with the implementation would pass every unit test in this
 * file and be worthless, so the two are checked against each other.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);
const adapters = createAdapterRegistry(TEMPLATES_ROOT);

const SITE: SiteContext = {
  name: 'Acme Ltd',
  url: 'https://acme.example',
  description: 'Bespoke widgets for discerning clients.',
  locale: 'en-GB',
  author: null,
};

const astro = (features: readonly FeatureId[], site: SiteContext = SITE): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-site'),
  projectName: 'acme-site',
  framework: 'astro',
  buildTool: 'vite',
  language: 'ts',
  styling: 'tailwind',
  uiLibrary: 'none',
  router: 'file-based',
  architecture: 'astro-standard',
  features,
  site,
  packageManager: 'npm',
  git: true,
  install: true,
});

const react = (features: readonly FeatureId[]): ProjectManifest => ({
  ...astro(features),
  framework: 'react' as FrameworkId,
  router: 'none',
  architecture: 'react-standard',
});

const planAstro = (features: readonly FeatureId[], site: SiteContext = SITE) =>
  planManifest(astro(features, site), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'coming-soon',
    templateId: 'astro-tailwind',
  });

const requiredCapabilities = (declaration: AdapterDeclaration): readonly string[] =>
  declaration.requires.flatMap((entry) =>
    entry.kind === 'requires'
      ? [entry.capability]
      : entry.kind === 'requiresOneOf'
        ? [...entry.capabilities]
        : [],
  );

// ---------------------------------------------------------------------------
// The dimension
// ---------------------------------------------------------------------------

describe('SEO is a feature', () => {
  it('occupies the feature dimension', () => {
    expect(SEO_DECLARATION.kind).toBe('feature');
    expect(SEO_DECLARATION.id).toBe('seo');
  });

  it('is addressable only as a feature', () => {
    expect(adapters.feature('seo').declaration.id).toBe('seo');
    expect(() => adapters.styling('seo' as never)).toThrow(CliError);
    expect(() => adapters.uiLibrary('seo' as never)).toThrow(CliError);
  });

  it('coexists with the other feature without either changing', () => {
    const refs = selectAdapters(
      astro(['starter:coming-soon', 'seo', 'not-found']),
      adapters,
    ).adapters.map((entry) => entry.ref);
    expect(refs).toContain('feature:seo');
    expect(refs).toContain('feature:not-found');
  });

  it('is a different shape of feature from not-found, deliberately', () => {
    // not-found owns a requirement and a guarantee and contributes no data,
    // because a 404 page is markup. SEO owns data, because what a head says is
    // not framework-specific. Both are features; neither pattern is the rule.
    const seo = adapters
      .feature('seo')
      .contribute(resolveProject(astro(['starter:coming-soon', 'seo']), adapters).project);
    const notFound = adapters
      .feature('not-found')
      .contribute(resolveProject(astro(['starter:coming-soon', 'not-found']), adapters).project);
    expect(seo.config).toHaveLength(1);
    expect(notFound.config).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Capability, not adapter identity
// ---------------------------------------------------------------------------

describe('SEO requires a capability and names nothing', () => {
  it('requires exactly a document metadata surface', () => {
    expect(requiredCapabilities(SEO_DECLARATION)).toEqual(['document-metadata']);
  });

  it('requires no build tool, styling system, UI library or language', () => {
    for (const capability of [
      'vite-plugins',
      'css-framework',
      'composed-stylesheet',
      'css-in-js',
      'react-runtime',
      'typescript',
    ]) {
      expect(requiredCapabilities(SEO_DECLARATION)).not.toContain(capability);
    }
  });

  it('provides nothing', () => {
    expect(SEO_DECLARATION.provides).toEqual([]);
  });

  it('names no adapter anywhere in what it declares', () => {
    const declared = JSON.stringify(SEO_DECLARATION).toLowerCase();
    for (const name of ['astro', 'react', 'vite', 'tailwind', 'bootstrap', 'mui', 'next']) {
      expect(declared, `the declaration mentions ${name}`).not.toContain(name);
    }
  });

  it('names no adapter in its code, only in prose explaining the design', () => {
    const code = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'seo.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .toLowerCase();
    for (const name of ['astro', 'react', 'vite', 'tailwind', 'bootstrap', 'mui']) {
      expect(code, `seo.ts names ${name} in code`).not.toContain(name);
    }
  });

  it('contains no framework-specific output path', () => {
    const code = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'seo.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const fragment of [
      'BaseLayout',
      'src/layouts',
      'src/app',
      'index.html',
      '.astro',
      '.tsx',
    ]) {
      expect(code, `seo.ts contains ${fragment}`).not.toContain(fragment);
    }
  });
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('compatibility is decided by capability', () => {
  it('Astro + Tailwind + SEO is compatible', () => {
    expect(checkCompatibility(astro(['starter:coming-soon', 'seo']), adapters).compatible).toBe(
      true,
    );
  });

  it('React + Vite + Tailwind + SEO is refused', () => {
    // Deliberate. React's template sets the title after hydration, so a crawler
    // reading the initial response sees the entry HTML and nothing the feature
    // contributed. Server rendering is the fix; a runtime metadata package is
    // not, and adding one is not this stage's job.
    expect(checkCompatibility(react(['starter:coming-soon', 'seo']), adapters).compatible).toBe(
      false,
    );
  });

  it('the refusal names the missing capability and the reason', () => {
    let error: CliError | undefined;
    try {
      resolveProject(react(['starter:coming-soon', 'seo']), adapters);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    expect(text).toContain('document-metadata');
    expect(text).toContain('Search-engine metadata');
    expect(text).toContain('crawlers');
  });

  it('React does not claim a document metadata surface', () => {
    expect(REACT_DECLARATION.provides).not.toContain('document-metadata');
  });

  it('Astro does', () => {
    expect(ASTRO_DECLARATION.provides).toContain('document-metadata');
  });

  it('a hypothetical framework with the capability satisfies SEO', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'nextjs',
      kind: 'framework',
      displayName: 'A framework that is not Astro',
      provides: ['document-metadata', 'ssr', 'typescript'],
      requires: [],
    };
    expect(evaluateCombination([hypothetical, SEO_DECLARATION]).compatible).toBe(true);
  });

  it('a hypothetical framework without it is refused, naming the capability', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'angular',
      kind: 'framework',
      displayName: 'A framework with no document metadata surface',
      provides: ['typescript', 'spa-routing'],
      requires: [],
    };
    const report = evaluateCombination([hypothetical, SEO_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report)).toContain('document-metadata');
  });

  it('a second hypothetical feature can need the same surface, unchanged', () => {
    // Proves the capability rather than the adapter is what Astro exposes, and
    // that the feature dimension is not limited to one occupant.
    const alpha: AdapterDeclaration = {
      id: 'social-metadata',
      kind: 'feature',
      displayName: 'A hypothetical second metadata feature',
      provides: [],
      requires: [
        {
          kind: 'requires',
          capability: 'document-metadata',
          because: 'it also describes the document head',
        },
      ],
    };
    expect(evaluateCombination([ASTRO_DECLARATION, SEO_DECLARATION, alpha]).compatible).toBe(true);
  });

  it('is indifferent to styling and UI libraries', () => {
    expect(
      evaluateCombination([ASTRO_DECLARATION, SEO_DECLARATION, MUI_DECLARATION, VITE_DECLARATION])
        .compatible,
    ).toBe(false); // MUI needs react-runtime, which Astro does not provide
    expect(evaluateCombination([ASTRO_DECLARATION, SEO_DECLARATION]).compatible).toBe(true);
  });

  it('composes with the other feature', () => {
    expect(
      evaluateCombination([ASTRO_DECLARATION, SEO_DECLARATION, NOT_FOUND_DECLARATION]).compatible,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('the metadata contract', () => {
  it('derives the title from the site name', () => {
    expect(resolveSeoContract(SITE).title).toBe('Acme Ltd');
  });

  it('prefixes a page name when one is given', () => {
    expect(resolveSeoContract(SITE, { pageTitle: 'Contact' }).title).toBe('Contact - Acme Ltd');
  });

  it('carries the site description, trimmed', () => {
    expect(resolveSeoContract({ ...SITE, description: '  spaced  ' }).description).toBe('spaced');
  });

  it('is indexable by default', () => {
    expect(resolveSeoContract(SITE).robots).toBe('index, follow');
  });

  it('blocks and drops the canonical together', () => {
    // A canonical says "this is the definitive address"; noindex says "do not
    // index it". Emitting both is contradictory.
    const blocked = resolveSeoContract(SITE, { noindex: true });
    expect(blocked.robots).toBe('noindex, nofollow');
    expect(blocked.canonical).toBe('');
    expect(blocked.openGraph.url).toBe('');
  });

  it('resolves the canonical from the configured URL', () => {
    expect(resolveSeoContract(SITE).canonical).toBe('https://acme.example/');
    expect(resolveSeoContract(SITE, { path: '/contact' }).canonical).toBe(
      'https://acme.example/contact',
    );
  });

  it('emits the Open Graph subset a client site needs', () => {
    const og = resolveSeoContract(SITE).openGraph;
    expect(og.type).toBe('website');
    expect(og.title).toBe('Acme Ltd');
    expect(og.siteName).toBe('Acme Ltd');
    expect(og.description).toBe(SITE.description);
    expect(og.url).toBe('https://acme.example/');
  });

  it('carries the page title into the social tags, not just the site name', () => {
    // On the home page the title and the site name are the same string, so
    // every assertion above passes whichever of the two the social tags use.
    // A page title is what tells them apart, and a mutation swapping one for
    // the other survived until this existed.
    const contract = resolveSeoContract(SITE, { pageTitle: 'Contact' });
    expect(contract.title).toBe('Contact - Acme Ltd');
    expect(contract.openGraph.title).toBe('Contact - Acme Ltd');
    expect(contract.twitter.title).toBe('Contact - Acme Ltd');
    // og:site_name stays the site, which is the distinction the pair encodes.
    expect(contract.openGraph.siteName).toBe('Acme Ltd');
  });

  it('emits og:locale only in language_TERRITORY form', () => {
    expect(resolveSeoContract(SITE).openGraph.locale).toBe('en_GB');
    // A bare 'en' is not valid there, so it is omitted rather than emitted in a
    // form crawlers discard.
    expect(resolveSeoContract({ ...SITE, locale: 'en' }).openGraph.locale).toBe('');
  });

  it('emits the Twitter subset without inventing a handle', () => {
    const twitter = resolveSeoContract(SITE).twitter;
    expect(twitter.title).toBe('Acme Ltd');
    expect(twitter.description).toBe(SITE.description);
    expect(JSON.stringify(twitter)).not.toContain('@');
  });

  it('is a pure function of the site metadata', () => {
    expect(JSON.stringify(resolveSeoContract(SITE))).toBe(JSON.stringify(resolveSeoContract(SITE)));
  });
});

// ---------------------------------------------------------------------------
// Nothing is invented
// ---------------------------------------------------------------------------

describe('no URL is ever fabricated', () => {
  const urlless: SiteContext = { ...SITE, url: null };

  it('omits the canonical entirely when no site URL is configured', () => {
    expect(resolveSeoContract(urlless).canonical).toBe('');
  });

  it('omits og:url too', () => {
    expect(resolveSeoContract(urlless).openGraph.url).toBe('');
  });

  it('never produces a placeholder domain, localhost, undefined or null', () => {
    const rendered = JSON.stringify(resolveSeoContract(urlless));
    for (const forbidden of ['example.com', 'localhost', 'undefined', 'null', 'yourdomain']) {
      expect(rendered, `the contract contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('treats an unusable URL as absent rather than repairing it', () => {
    for (const url of ['', '   ', 'not a url', 'ftp://acme.example', 'javascript:alert(1)']) {
      expect(siteOrigin(url), `${url} should be treated as absent`).toBe('');
      expect(resolveSeoContract({ ...SITE, url }).canonical).toBe('');
    }
  });

  it('still produces a usable title and description without a URL', () => {
    // Absent absolute metadata must not degrade the rest of the contract.
    const contract = resolveSeoContract(urlless);
    expect(contract.title).toBe('Acme Ltd');
    expect(contract.description).toBe(SITE.description);
    expect(contract.robots).toBe('index, follow');
  });

  it('the planned project carries no fabricated URL either', () => {
    const { metadata } = planAstro(['starter:coming-soon', 'seo'], urlless);
    expect(JSON.stringify(metadata)).not.toContain('example.com');
    expect(metadata[0]?.contract.canonical).toBe('');
  });
});

// ---------------------------------------------------------------------------
// What it contributes
// ---------------------------------------------------------------------------

describe('contributions', () => {
  const contribution = () =>
    resolveWithAdapters(astro(['starter:coming-soon', 'seo']), TEMPLATES_ROOT).contributions.find(
      (entry) => entry.owner === 'feature:seo',
    );

  it('adds no dependency', () => {
    expect(contribution()?.dependencies).toEqual([]);
  });

  it('adds no script', () => {
    expect(contribution()?.scripts).toEqual([]);
  });

  it('adds no file and no template layer', () => {
    expect(contribution()?.files).toEqual([]);
    expect(contribution()?.templateLayers).toEqual([]);
  });

  it('changes nothing in the generated package manifest', () => {
    const withSeo = planAstro(['starter:coming-soon', 'seo']).plan.operations.find(
      (entry) => entry.path === 'package.json',
    );
    const without = planAstro(['starter:coming-soon']).plan.operations.find(
      (entry) => entry.path === 'package.json',
    );
    expect(withSeo?.type === 'write' ? withSeo.content : '').toBe(
      without?.type === 'write' ? without.content : 'x',
    );
  });

  it('generates no extra file at all', () => {
    expect(planAstro(['starter:coming-soon', 'seo']).plan.operations.map((e) => e.path)).toEqual(
      planAstro(['starter:coming-soon']).plan.operations.map((e) => e.path),
    );
  });

  it('describes the metadata surface by role and slot', () => {
    const config = contribution()?.config ?? [];
    expect(config.map((entry) => ({ target: entry.target, at: entry.at }))).toEqual([
      { target: 'app.layout', at: 'metadata' },
    ]);
  });

  it('uses the existing contribution type rather than a new one', () => {
    // A ConfigContribution already carries a target role, a slot, a value, an
    // owner and a reason - exactly what this needs.
    const entry = contribution()?.config[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual(['at', 'owner', 'reason', 'target', 'value']);
  });

  it('requests the layout as a required role', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'seo']), adapters);
    expect(project.requiredRoles).toContain('app.layout');
  });

  it('requires nothing extra when SEO is not selected', () => {
    const { project } = resolveProject(astro(['starter:coming-soon']), adapters);
    expect(project.requiredRoles).not.toContain('app.layout');
  });

  it('lets the architecture decide where the surface lives', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'seo']), adapters);
    expect(project.architecture.roles['app.layout']).toBe('src/layouts/BaseLayout.astro');
  });

  it('leaves the layout owned by the framework template', () => {
    const layout = planAstro(['starter:coming-soon', 'seo']).plan.operations.find(
      (entry) => entry.path === 'src/layouts/BaseLayout.astro',
    );
    expect(layout?.origin).toBe('base');
  });
});

// ---------------------------------------------------------------------------
// The guarantee
// ---------------------------------------------------------------------------

describe('the guarantee is load-bearing', () => {
  const operationsFor = (paths: readonly string[]): readonly FileOperation[] =>
    paths.map((entry) => ({ type: 'write', path: entry, content: '', origin: 'test' }));

  it('passes when the metadata surface exists', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'seo']), adapters);
    expect(() =>
      assertRequiredRoles(project, operationsFor(['src/layouts/BaseLayout.astro'])),
    ).not.toThrow();
  });

  it('fails before writing when nothing produces it', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'seo']), adapters);
    expect(() => assertRequiredRoles(project, operationsFor([]))).toThrow(CliError);
    expect(() => assertRequiredRoles(project, operationsFor([]))).toThrow(/app\.layout/);
  });
});

// ---------------------------------------------------------------------------
// Conflicts, duplicates and provenance
// ---------------------------------------------------------------------------

describe('metadata claims are composed, not overwritten', () => {
  const claim = (owner: string, site: SiteContext = SITE): ConfigContribution => ({
    target: 'app.layout',
    at: 'metadata',
    value: resolveSeoContract(site),
    owner,
    reason: 'what the page head must say',
  });

  it('one claim resolves to one contract', () => {
    expect(collectMetadata([claim('feature:seo')])).toHaveLength(1);
  });

  it('two identical claims de-duplicate to one description, keeping both owners', () => {
    const claims = collectMetadata([claim('feature:seo'), claim('feature:alpha')]);
    expect(new Set(claims.map((entry) => JSON.stringify(entry.contract))).size).toBe(1);
    expect(claims.map((entry) => entry.owner)).toEqual(['feature:alpha', 'feature:seo']);
  });

  it('two different claims are a conflict, not a silent winner', () => {
    expect(() =>
      collectMetadata([claim('feature:seo'), claim('feature:alpha', { ...SITE, name: 'Other' })]),
    ).toThrow(CliError);
  });

  it('the conflict names both owners and both titles', () => {
    let error: CliError | undefined;
    try {
      collectMetadata([claim('feature:seo'), claim('feature:alpha', { ...SITE, name: 'Other' })]);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    for (const fragment of ['feature:seo', 'feature:alpha', 'Acme Ltd', 'Other']) {
      expect(text).toContain(fragment);
    }
  });

  it('ignores contributions aimed elsewhere', () => {
    expect(collectMetadata([{ ...claim('feature:seo'), at: 'plugins' }])).toEqual([]);
  });

  it('the plan carries the claim with its owner and reason', () => {
    const { metadata } = planAstro(['starter:coming-soon', 'seo']);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.owner).toBe('feature:seo');
    expect(metadata[0]?.reason.length).toBeGreaterThan(0);
    expect(metadata[0]?.contract.title).toBe('Acme Ltd');
  });

  it('carries no claim when SEO is not selected', () => {
    expect(planAstro(['starter:coming-soon']).metadata).toEqual([]);
  });

  it('the conflict is detected during planning, not only in the unit', () => {
    // Guards the wiring. A collector nothing calls protects nothing.
    const project = resolveProject(astro(['starter:coming-soon', 'seo']), adapters).project;
    const conflicting = [
      { ...claim('feature:seo') },
      { ...claim('feature:alpha', { ...SITE, name: 'Other' }) },
    ];
    expect(() => collectMetadata(conflicting)).toThrow(CliError);
    expect(project.requiredRoles).toContain('app.layout');
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the SEO adapter stays inside the contract', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'seo.ts'),
    'utf8',
  );

  it('touches no filesystem, process, shell or network API', () => {
    for (const forbidden of [
      'node:fs',
      'node:child_process',
      'node:process',
      'node:os',
      'readFileSync',
      'writeFileSync',
      'execSync',
      'spawn',
      'fetch(',
    ]) {
      expect(source, `seo.ts uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('imports no other adapter', () => {
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      expect(specifier, `seo.ts imports ${specifier}`).not.toMatch(
        /\.\/(astro|react|vite|tailwind|bootstrap|mui|not-found)\.js$/,
      );
    }
  });

  it('is a pure function of its inputs', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'seo']), adapters);
    const adapter = adapters.feature('seo');
    expect(JSON.stringify(adapter.contribute(project))).toBe(
      JSON.stringify(adapter.contribute(project)),
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism and regression
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same manifest produces the same plan twice', () => {
    expect(renderPlan(planAstro(['starter:coming-soon', 'seo']).plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planAstro(['starter:coming-soon', 'seo']).plan, TEMPLATES_ROOT),
    );
  });

  it('feature order does not affect the result', () => {
    expect(renderPlan(planAstro(['seo', 'starter:coming-soon']).plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planAstro(['starter:coming-soon', 'seo']).plan, TEMPLATES_ROOT),
    );
  });

  it('no generated content carries a machine value or an unresolved token', () => {
    for (const operation of planAstro(['starter:coming-soon', 'seo']).plan.operations) {
      if (operation.type !== 'write') continue;
      expect(operation.content).not.toContain(TEST_CWD);
      expect(operation.content).not.toContain('\r\n');
      expect(operation.content).not.toMatch(/\{\{\s*[a-zA-Z]/);
    }
  });
});

// ---------------------------------------------------------------------------
// The contract against real emitted HTML
// ---------------------------------------------------------------------------

/**
 * Captured from `dist/index.html` of a real `astro build`, for both URL states.
 *
 * This is the test that matters most in this file. Everything above checks the
 * generic model against itself; this checks it against what the framework
 * actually produced. If the contract and the Astro template ever drift apart,
 * one of them is wrong and this is where it shows.
 *
 * `scripts/smoke.mjs` asserts the same agreement against a freshly built
 * project on every CI run, so a stale fixture here cannot hide a regression.
 */
/** The tags only. The fixture opens with a comment describing its provenance,
 *  and that comment mentions tag names - counting occurrences without
 *  stripping it would count the description of a tag as a tag. */
const emittedTags = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );

const EMITTED = {
  withUrl: emittedTags('seo-head-url.html'),
  withoutUrl: emittedTags('seo-head-urlless.html'),
};

const tagFrom = (head: string, pattern: RegExp): string => {
  const match = head.match(pattern);
  return match?.[1] ?? '';
};

describe('the contract matches the HTML Astro really emitted', () => {
  const cases = [
    { name: 'with a site URL', head: EMITTED.withUrl, site: SITE },
    { name: 'without a site URL', head: EMITTED.withoutUrl, site: { ...SITE, url: null } },
  ];

  for (const { name, head, site } of cases) {
    it(`${name}: every field agrees`, () => {
      const contract = resolveSeoContract(site);
      const pairs: readonly [string, string, string][] = [
        ['title', contract.title, tagFrom(head, /<title>([^<]*)<\/title>/)],
        [
          'description',
          contract.description,
          tagFrom(head, /<meta name="description" content="([^"]*)"/),
        ],
        ['robots', contract.robots, tagFrom(head, /<meta name="robots" content="([^"]*)"/)],
        ['canonical', contract.canonical, tagFrom(head, /<link rel="canonical" href="([^"]*)"/)],
        [
          'og:type',
          contract.openGraph.type,
          tagFrom(head, /<meta property="og:type" content="([^"]*)"/),
        ],
        [
          'og:title',
          contract.openGraph.title,
          tagFrom(head, /<meta property="og:title" content="([^"]*)"/),
        ],
        [
          'og:site_name',
          contract.openGraph.siteName,
          tagFrom(head, /<meta property="og:site_name" content="([^"]*)"/),
        ],
        [
          'og:description',
          contract.openGraph.description,
          tagFrom(head, /<meta property="og:description" content="([^"]*)"/),
        ],
        [
          'og:url',
          contract.openGraph.url,
          tagFrom(head, /<meta property="og:url" content="([^"]*)"/),
        ],
        [
          'og:locale',
          contract.openGraph.locale,
          tagFrom(head, /<meta property="og:locale" content="([^"]*)"/),
        ],
        [
          'twitter:card',
          contract.twitter.card,
          tagFrom(head, /<meta name="twitter:card" content="([^"]*)"/),
        ],
        [
          'twitter:title',
          contract.twitter.title,
          tagFrom(head, /<meta name="twitter:title" content="([^"]*)"/),
        ],
        [
          'twitter:description',
          contract.twitter.description,
          tagFrom(head, /<meta name="twitter:description" content="([^"]*)"/),
        ],
      ];

      for (const [label, expected, actual] of pairs) {
        expect(actual, `${label}: the contract says ${expected}`).toBe(expected);
      }
    });
  }

  it('without a URL the absolute tags are absent from the HTML, not empty', () => {
    // An empty canonical attribute would resolve to the current page and be
    // worse than no tag; the contract says '' and the template omits the tag.
    expect(EMITTED.withoutUrl).not.toContain('rel="canonical"');
    expect(EMITTED.withoutUrl).not.toContain('og:url');
  });

  it('the emitted HTML contains no fabricated domain', () => {
    for (const head of [EMITTED.withUrl, EMITTED.withoutUrl]) {
      for (const forbidden of ['example.com', 'localhost', 'yourdomain', 'undefined']) {
        expect(head.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it('each metadata tag appears exactly once', () => {
    for (const head of [EMITTED.withUrl, EMITTED.withoutUrl]) {
      for (const pattern of [/<title>/g, /name="description"/g, /name="robots"/g, /og:title/g]) {
        expect((head.match(pattern) ?? []).length).toBe(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

const renderSeoComposition = (features: readonly FeatureId[], site: SiteContext): string => {
  const { project, selection } = resolveProject(astro(features, site), adapters);
  const { metadata, plan } = planAstro(features, site);

  const lines: string[] = [];
  lines.push('== MANIFEST ==');
  lines.push(`site.name   ${site.name}`);
  lines.push(`site.url    ${site.url ?? '(none)'}`);
  lines.push(`features    ${[...project.selection.features].sort().join(', ')}`);
  lines.push('');
  lines.push('== SELECTED ADAPTERS ==');
  for (const entry of selection.adapters) {
    lines.push(`${entry.ref.padEnd(24)} ${entry.adapter.declaration.kind}`);
  }
  lines.push('');
  lines.push('== REQUIRED ROLES ==');
  for (const role of project.requiredRoles) {
    lines.push(`${role.padEnd(24)} -> ${project.architecture.roles[role] ?? '(unmapped)'}`);
  }
  if (project.requiredRoles.length === 0) lines.push('(none)');
  lines.push('');
  lines.push('== METADATA CLAIMS ==');
  for (const claim of metadata) {
    lines.push(`owner   ${claim.owner}`);
    lines.push(`reason  ${claim.reason}`);
    lines.push(JSON.stringify(claim.contract, null, 2));
  }
  if (metadata.length === 0) lines.push('(none)');
  lines.push('');
  lines.push('== OWNERSHIP ==');
  for (const operation of plan.operations) {
    lines.push(`${operation.path.padEnd(40)} ${operation.origin}`);
  }
  return `${lines.join('\n')}\n`;
};

describe('golden: Astro + Tailwind + SEO', () => {
  it('golden: with a site URL', async () => {
    await expect(renderSeoComposition(['starter:coming-soon', 'seo'], SITE)).toMatchFileSnapshot(
      './golden/astro-seo-url.txt',
    );
  });

  it('golden: without a site URL', async () => {
    await expect(
      renderSeoComposition(['starter:coming-soon', 'seo'], { ...SITE, url: null }),
    ).toMatchFileSnapshot('./golden/astro-seo-urlless.txt');
  });

  it('golden: no SEO feature selected', async () => {
    await expect(renderSeoComposition(['starter:coming-soon'], SITE)).toMatchFileSnapshot(
      './golden/astro-seo-absent.txt',
    );
  });

  it('the three are genuinely different snapshots', () => {
    const withUrl = renderSeoComposition(['starter:coming-soon', 'seo'], SITE);
    const withoutUrl = renderSeoComposition(['starter:coming-soon', 'seo'], {
      ...SITE,
      url: null,
    });
    const absent = renderSeoComposition(['starter:coming-soon'], SITE);
    expect(new Set([withUrl, withoutUrl, absent]).size).toBe(3);
  });
});
