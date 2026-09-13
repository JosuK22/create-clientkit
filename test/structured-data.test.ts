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
import { STRUCTURED_DATA_DECLARATION } from '../src/adapters/structured-data.js';
import { TAILWIND_DECLARATION } from '../src/adapters/tailwind.js';
import { VITE_DECLARATION } from '../src/adapters/vite.js';
import { collectClaims } from '../src/domain/claims.js';
import type { ConfigContribution } from '../src/domain/contributions.js';
import type {
  AdapterDeclaration,
  FeatureId,
  FrameworkId,
  ProjectManifest,
} from '../src/domain/index.js';
import { evaluateCombination } from '../src/domain/index.js';
import type { OrganizationContract } from '../src/domain/structured-data.js';
import {
  ORGANIZATION_FIELDS,
  resolveOrganization,
  serialiseOrganization,
} from '../src/domain/structured-data.js';
import { CliError } from '../src/errors.js';
import type { FileOperation } from '../src/generate/files.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import type { SiteContext } from '../src/types.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * Structured data, as a feature.
 *
 * The claim under test is that a schema.org description of the organisation is
 * a feature of its own - a sibling of SEO, not a part of it - and that it works
 * through capabilities and semantic roles without knowing any framework.
 *
 * The sharpest test is at the bottom: the Organization object the feature
 * computes is compared against the JSON-LD a real Astro build emitted, parsed
 * rather than string-matched. Structured data that looks right and does not
 * parse is worse than none.
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

describe('structured data is a feature, and a sibling of SEO', () => {
  it('occupies the feature dimension', () => {
    expect(STRUCTURED_DATA_DECLARATION.kind).toBe('feature');
    expect(STRUCTURED_DATA_DECLARATION.id).toBe('structured-data');
  });

  it('is addressable only as a feature', () => {
    expect(adapters.feature('structured-data').declaration.id).toBe('structured-data');
    expect(() => adapters.styling('structured-data' as never)).toThrow(CliError);
    expect(() => adapters.uiLibrary('structured-data' as never)).toThrow(CliError);
  });

  it('is a separate adapter from SEO, not a part of it', () => {
    // Folding this into SEO would have made SEO the place every future
    // search-related feature goes - the monolith the dimension exists to avoid.
    expect(STRUCTURED_DATA_DECLARATION.id).not.toBe(SEO_DECLARATION.id);
    expect(adapters.implementedFeatures()).toContain('seo');
    expect(adapters.implementedFeatures()).toContain('structured-data');
  });

  it('can be selected without SEO', () => {
    const refs = selectAdapters(
      astro(['starter:coming-soon', 'structured-data']),
      adapters,
    ).adapters.map((entry) => entry.ref);
    expect(refs).toContain('feature:structured-data');
    expect(refs).not.toContain('feature:seo');
  });

  it('can be selected with SEO', () => {
    const refs = selectAdapters(
      astro(['starter:coming-soon', 'seo', 'structured-data']),
      adapters,
    ).adapters.map((entry) => entry.ref);
    expect(refs).toContain('feature:structured-data');
    expect(refs).toContain('feature:seo');
  });

  it('composes with every other implemented feature', () => {
    expect(
      evaluateCombination([
        ASTRO_DECLARATION,
        SEO_DECLARATION,
        STRUCTURED_DATA_DECLARATION,
        NOT_FOUND_DECLARATION,
      ]).compatible,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Capability, not adapter identity
// ---------------------------------------------------------------------------

describe('it requires a capability and names nothing', () => {
  it('requires exactly a document metadata surface', () => {
    // The same capability SEO requires, deliberately. A JSON-LD block is a
    // script in the document head that must be in the response a crawler
    // reads - which is exactly what document-metadata already means. A second
    // capability for the same requirement would fragment the vocabulary.
    expect(requiredCapabilities(STRUCTURED_DATA_DECLARATION)).toEqual(['document-metadata']);
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
      expect(requiredCapabilities(STRUCTURED_DATA_DECLARATION)).not.toContain(capability);
    }
  });

  it('provides nothing', () => {
    expect(STRUCTURED_DATA_DECLARATION.provides).toEqual([]);
  });

  it('names no adapter anywhere in what it declares', () => {
    const declared = JSON.stringify(STRUCTURED_DATA_DECLARATION).toLowerCase();
    for (const name of ['astro', 'react', 'vite', 'tailwind', 'bootstrap', 'mui', 'next', 'seo']) {
      expect(declared, `the declaration mentions ${name}`).not.toContain(name);
    }
  });

  it('names no adapter in its code, only in prose explaining the design', () => {
    const code = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'structured-data.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .toLowerCase();
    for (const name of ['astro', 'react', 'vite', 'tailwind', 'bootstrap', 'mui']) {
      expect(code, `structured-data.ts names ${name} in code`).not.toContain(name);
    }
  });

  it('contains no framework-specific output path', () => {
    const code = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'structured-data.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const fragment of [
      'BaseLayout',
      // The component file Astro renders this through. Its own factory is
      // called createStructuredDataAdapter, so the bare word would match
      // itself - the framework's filename is what must not appear.
      'StructuredData.astro',
      'src/layouts',
      'src/components',
      'index.html',
      '.astro',
      '.tsx',
    ]) {
      expect(code, `structured-data.ts contains ${fragment}`).not.toContain(fragment);
    }
  });

  it('does not depend on the SEO feature by name', () => {
    // They share a capability and a role. Neither names the other, so either
    // can be selected alone.
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'structured-data.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports).not.toContain('./seo.js');
    expect(requiredCapabilities(STRUCTURED_DATA_DECLARATION)).not.toContain('seo');
  });
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('compatibility is decided by capability', () => {
  it('Astro + Tailwind + structured-data is compatible', () => {
    expect(
      checkCompatibility(astro(['starter:coming-soon', 'structured-data']), adapters).compatible,
    ).toBe(true);
  });

  it('React + Vite + Tailwind + structured-data is refused', () => {
    expect(
      checkCompatibility(react(['starter:coming-soon', 'structured-data']), adapters).compatible,
    ).toBe(false);
  });

  it('the refusal names the missing capability and the reason', () => {
    let error: CliError | undefined;
    try {
      resolveProject(react(['starter:coming-soon', 'structured-data']), adapters);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    expect(text).toContain('document-metadata');
    expect(text).toContain('Structured data');
    expect(text).toContain('crawler');
  });

  it('a hypothetical framework with the capability satisfies it', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'nextjs',
      kind: 'framework',
      displayName: 'A framework that is not Astro',
      provides: ['document-metadata', 'ssr'],
      requires: [],
    };
    expect(evaluateCombination([hypothetical, STRUCTURED_DATA_DECLARATION]).compatible).toBe(true);
  });

  it('a hypothetical framework without it is refused, naming the capability', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'angular',
      kind: 'framework',
      displayName: 'A framework with no document metadata surface',
      provides: ['typescript', 'spa-routing'],
      requires: [],
    };
    const report = evaluateCombination([hypothetical, STRUCTURED_DATA_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report)).toContain('document-metadata');
  });

  it('is indifferent to styling and to the UI library', () => {
    expect(
      evaluateCombination([ASTRO_DECLARATION, TAILWIND_DECLARATION, STRUCTURED_DATA_DECLARATION])
        .compatible,
    ).toBe(true);
    expect(evaluateCombination([ASTRO_DECLARATION, STRUCTURED_DATA_DECLARATION]).compatible).toBe(
      true,
    );
    // MUI is refused for its own reason - react-runtime - not because of this.
    expect(
      evaluateCombination([
        REACT_DECLARATION,
        VITE_DECLARATION,
        MUI_DECLARATION,
        STRUCTURED_DATA_DECLARATION,
      ]).compatible,
    ).toBe(false);
  });

  it('refuses a known but unimplemented feature, with no fallback', () => {
    for (const id of ['sitemap', 'social-metadata'] as const) {
      expect(() => adapters.feature(id)).toThrow(CliError);
    }
    let refs: readonly string[];
    try {
      refs = selectAdapters(astro(['starter:coming-soon', 'sitemap']), adapters).adapters.map(
        (entry) => entry.ref,
      );
    } catch {
      refs = [];
    }
    expect(refs).not.toContain('feature:structured-data');
  });
});

// ---------------------------------------------------------------------------
// The Organization contract
// ---------------------------------------------------------------------------

describe('the Organization contract', () => {
  it('uses the canonical HTTPS schema.org context', () => {
    expect(resolveOrganization(SITE)['@context']).toBe('https://schema.org');
  });

  it('declares the Organization type', () => {
    expect(resolveOrganization(SITE)['@type']).toBe('Organization');
  });

  it('takes the name from the site, never a placeholder', () => {
    expect(resolveOrganization(SITE).name).toBe('Acme Ltd');
    expect(resolveOrganization({ ...SITE, name: 'Other Co' }).name).toBe('Other Co');
  });

  it('resolves the URL from the configured site URL', () => {
    expect(resolveOrganization(SITE).url).toBe('https://acme.example');
  });

  it('carries the description, trimmed', () => {
    expect(resolveOrganization({ ...SITE, description: '  spaced  ' }).description).toBe('spaced');
  });

  it('omits the description entirely when there is none', () => {
    expect('description' in resolveOrganization({ ...SITE, description: '   ' })).toBe(false);
  });

  it('models no logo, because a path cannot become an absolute URL truthfully', () => {
    // The project configures a social image as a path. Turning it into the
    // absolute URL a crawler requires would mean inventing the domain, so the
    // contract does not claim one.
    expect(JSON.stringify(resolveOrganization(SITE))).not.toContain('logo');
  });

  it('models no sameAs, because the manifest carries no social profiles', () => {
    expect(JSON.stringify(resolveOrganization(SITE))).not.toContain('sameAs');
  });

  it('is a pure function of the site metadata', () => {
    expect(JSON.stringify(resolveOrganization(SITE))).toBe(
      JSON.stringify(resolveOrganization(SITE)),
    );
  });
});

// ---------------------------------------------------------------------------
// Nothing is invented
// ---------------------------------------------------------------------------

describe('no value is ever fabricated', () => {
  const urlless: SiteContext = { ...SITE, url: null };

  it('omits url entirely when no site URL is configured', () => {
    expect('url' in resolveOrganization(urlless)).toBe(false);
  });

  it('emits no null, undefined, localhost or placeholder domain', () => {
    const serialised = serialiseOrganization(resolveOrganization(urlless));
    for (const forbidden of ['null', 'undefined', 'localhost', 'example.com', 'yourdomain']) {
      expect(serialised, `the contract contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('treats an unusable URL as absent rather than repairing it', () => {
    for (const url of ['', '   ', 'not a url', 'ftp://acme.example']) {
      expect('url' in resolveOrganization({ ...SITE, url })).toBe(false);
    }
  });

  it('still produces a valid Organization without a URL', () => {
    // A missing optional field must not degrade the rest into something a
    // consumer would reject.
    const organization = resolveOrganization(urlless);
    expect(organization['@context']).toBe('https://schema.org');
    expect(organization['@type']).toBe('Organization');
    expect(organization.name).toBe('Acme Ltd');
  });

  it('the planned project carries no fabricated value either', () => {
    const { structuredData } = planAstro(['starter:coming-soon', 'structured-data'], urlless);
    const serialised = JSON.stringify(structuredData);
    expect(serialised).not.toContain('example.com');
    expect(structuredData[0]?.value.url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

describe('serialisation is deterministic and valid', () => {
  it('parses back to the same object', () => {
    const organization = resolveOrganization(SITE);
    expect(JSON.parse(serialiseOrganization(organization))).toEqual(organization);
  });

  it('emits fields in a fixed order, not insertion order', () => {
    // Insertion order is a property of how an object happened to be built, and
    // golden snapshots compare bytes.
    const built: OrganizationContract = {
      description: 'later',
      name: 'Acme Ltd',
      '@type': 'Organization',
      '@context': 'https://schema.org',
      url: 'https://acme.example',
    } as OrganizationContract;
    expect(Object.keys(JSON.parse(serialiseOrganization(built)))).toEqual([
      '@context',
      '@type',
      'name',
      'url',
      'description',
    ]);
  });

  it('the declared field order covers every field the contract can hold', () => {
    const keys = Object.keys(resolveOrganization(SITE));
    for (const key of keys) {
      expect(ORGANIZATION_FIELDS as readonly string[]).toContain(key);
    }
  });

  it('omits absent fields rather than emitting null', () => {
    // A null in structured data is a claim that the value is empty, which is
    // not the same as making no claim.
    const serialised = serialiseOrganization(resolveOrganization({ ...SITE, url: null }));
    expect(serialised).not.toContain('null');
    expect(JSON.parse(serialised)).not.toHaveProperty('url');
  });

  it('never produces [object Object]', () => {
    expect(serialiseOrganization(resolveOrganization(SITE))).not.toContain('[object Object]');
  });

  it('produces the same bytes twice', () => {
    expect(serialiseOrganization(resolveOrganization(SITE))).toBe(
      serialiseOrganization(resolveOrganization(SITE)),
    );
  });
});

// ---------------------------------------------------------------------------
// What it contributes
// ---------------------------------------------------------------------------

describe('contributions', () => {
  const contribution = () =>
    resolveWithAdapters(
      astro(['starter:coming-soon', 'structured-data']),
      TEMPLATES_ROOT,
    ).contributions.find((entry) => entry.owner === 'feature:structured-data');

  it('adds no dependency, script, file or template layer', () => {
    expect(contribution()?.dependencies).toEqual([]);
    expect(contribution()?.scripts).toEqual([]);
    expect(contribution()?.files).toEqual([]);
    expect(contribution()?.templateLayers).toEqual([]);
  });

  it('changes nothing in the generated package manifest', () => {
    const withFeature = planAstro(['starter:coming-soon', 'structured-data']).plan.operations.find(
      (entry) => entry.path === 'package.json',
    );
    const without = planAstro(['starter:coming-soon']).plan.operations.find(
      (entry) => entry.path === 'package.json',
    );
    expect(withFeature?.type === 'write' ? withFeature.content : '').toBe(
      without?.type === 'write' ? without.content : 'x',
    );
  });

  it('generates no extra file at all', () => {
    expect(
      planAstro(['starter:coming-soon', 'structured-data']).plan.operations.map((e) => e.path),
    ).toEqual(planAstro(['starter:coming-soon']).plan.operations.map((e) => e.path));
  });

  it('describes its own slot on the shared role', () => {
    const config = contribution()?.config ?? [];
    expect(config.map((entry) => ({ target: entry.target, at: entry.at }))).toEqual([
      { target: 'app.layout', at: 'structured-data' },
    ]);
  });

  it('uses a different slot from SEO, which is what lets them compose', () => {
    const all = resolveWithAdapters(
      astro(['starter:coming-soon', 'seo', 'structured-data']),
      TEMPLATES_ROOT,
    ).contributions.flatMap((entry) => entry.config);
    const slots = all.filter((entry) => entry.target === 'app.layout').map((entry) => entry.at);
    expect(new Set(slots)).toEqual(new Set(['metadata', 'structured-data']));
  });

  it('requests the layout as a required role', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'structured-data']), adapters);
    expect(project.requiredRoles).toContain('app.layout');
  });

  it('requires nothing extra when the feature is not selected', () => {
    const { project } = resolveProject(astro(['starter:coming-soon']), adapters);
    expect(project.requiredRoles).not.toContain('app.layout');
  });

  it('leaves the implementation owned by the framework template', () => {
    const layout = planAstro(['starter:coming-soon', 'structured-data']).plan.operations.find(
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

  it('passes when the surface exists', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'structured-data']), adapters);
    expect(() =>
      assertRequiredRoles(project, operationsFor(['src/layouts/BaseLayout.astro'])),
    ).not.toThrow();
  });

  it('fails before writing when nothing produces it', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'structured-data']), adapters);
    expect(() => assertRequiredRoles(project, operationsFor([]))).toThrow(/app\.layout/);
  });
});

// ---------------------------------------------------------------------------
// Claims: duplicates, conflicts, provenance
// ---------------------------------------------------------------------------

describe('claims are composed, not overwritten', () => {
  const claim = (owner: string, site: SiteContext = SITE): ConfigContribution => ({
    target: 'app.layout',
    at: 'structured-data',
    value: resolveOrganization(site),
    owner,
    reason: 'what machines should be told about the organisation',
  });

  it('one claim resolves to one Organization', () => {
    expect(
      collectClaims([claim('feature:structured-data')], 'app.layout', 'structured-data'),
    ).toHaveLength(1);
  });

  it('two identical claims de-duplicate to one description, keeping both owners', () => {
    const claims = collectClaims<OrganizationContract>(
      [claim('feature:structured-data'), claim('feature:alpha')],
      'app.layout',
      'structured-data',
    );
    expect(new Set(claims.map((entry) => JSON.stringify(entry.value))).size).toBe(1);
    expect(claims.map((entry) => entry.owner)).toEqual([
      'feature:alpha',
      'feature:structured-data',
    ]);
  });

  it('two different claims are a conflict, not a silent winner', () => {
    expect(() =>
      collectClaims(
        [claim('feature:structured-data'), claim('feature:alpha', { ...SITE, name: 'Other Co' })],
        'app.layout',
        'structured-data',
      ),
    ).toThrow(CliError);
  });

  it('the conflict names the field, both owners and both values', () => {
    let error: CliError | undefined;
    try {
      collectClaims(
        [claim('feature:structured-data'), claim('feature:alpha', { ...SITE, name: 'Other Co' })],
        'app.layout',
        'structured-data',
      );
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    for (const fragment of [
      'name',
      'feature:structured-data',
      'feature:alpha',
      'Acme Ltd',
      'Other Co',
    ]) {
      expect(text, `the error never mentions ${fragment}`).toContain(fragment);
    }
  });

  it('names an absent field rather than printing undefined', () => {
    let error: CliError | undefined;
    try {
      collectClaims(
        [claim('feature:structured-data'), claim('feature:alpha', { ...SITE, url: null })],
        'app.layout',
        'structured-data',
      );
    } catch (thrown) {
      error = thrown as CliError;
    }
    expect(`${error?.hint ?? ''}`).toContain('(absent)');
  });

  it('ignores claims on the other slot, so SEO never collides with it', () => {
    expect(
      collectClaims([{ ...claim('feature:seo'), at: 'metadata' }], 'app.layout', 'structured-data'),
    ).toEqual([]);
  });

  it('the plan carries the claim with its owner and reason', () => {
    const { structuredData } = planAstro(['starter:coming-soon', 'structured-data']);
    expect(structuredData).toHaveLength(1);
    expect(structuredData[0]?.owner).toBe('feature:structured-data');
    expect(structuredData[0]?.reason.length).toBeGreaterThan(0);
    expect(structuredData[0]?.value.name).toBe('Acme Ltd');
  });

  it('carries no claim when the feature is not selected', () => {
    expect(planAstro(['starter:coming-soon']).structuredData).toEqual([]);
  });

  it('carries both claims independently when both features are selected', () => {
    const { metadata, structuredData } = planAstro([
      'starter:coming-soon',
      'seo',
      'structured-data',
    ]);
    expect(metadata).toHaveLength(1);
    expect(structuredData).toHaveLength(1);
    expect(metadata[0]?.owner).toBe('feature:seo');
    expect(structuredData[0]?.owner).toBe('feature:structured-data');
  });

  it('carries structured data without SEO', () => {
    const { metadata, structuredData } = planAstro(['starter:coming-soon', 'structured-data']);
    expect(metadata).toEqual([]);
    expect(structuredData).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the adapter stays inside the contract', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'structured-data.ts'),
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
      expect(source, `structured-data.ts uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('imports no other adapter', () => {
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      expect(specifier, `it imports ${specifier}`).not.toMatch(
        /\.\/(astro|react|vite|tailwind|bootstrap|mui|seo|not-found)\.js$/,
      );
    }
  });

  it('is a pure function of its inputs', () => {
    const { project } = resolveProject(astro(['starter:coming-soon', 'structured-data']), adapters);
    const adapter = adapters.feature('structured-data');
    expect(JSON.stringify(adapter.contribute(project))).toBe(
      JSON.stringify(adapter.contribute(project)),
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same manifest produces the same plan twice', () => {
    expect(
      renderPlan(planAstro(['starter:coming-soon', 'structured-data']).plan, TEMPLATES_ROOT),
    ).toBe(renderPlan(planAstro(['starter:coming-soon', 'structured-data']).plan, TEMPLATES_ROOT));
  });

  it('feature order does not affect the result', () => {
    expect(
      renderPlan(planAstro(['structured-data', 'seo', 'starter:full']).plan, TEMPLATES_ROOT),
    ).toBe(renderPlan(planAstro(['starter:full', 'seo', 'structured-data']).plan, TEMPLATES_ROOT));
  });
});

// ---------------------------------------------------------------------------
// The contract against real emitted JSON-LD
// ---------------------------------------------------------------------------

/**
 * The JSON-LD block from `dist/index.html` of a real `astro build`.
 *
 * The test that matters most here. Everything above checks the generic model
 * against itself; this parses what the framework actually emitted and compares
 * the two. Structured data that looks right in a plan and does not parse in a
 * browser is worse than none at all.
 *
 * `scripts/smoke.mjs` re-parses the same block from a freshly built project on
 * every CI run, so a stale fixture cannot hide a regression.
 */
const emittedJsonLd = (name: string): string => {
  const raw = readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );
  const match = raw.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (match?.[1] === undefined) throw new Error(`no JSON-LD block in ${name}`);
  return match[1];
};

describe('the contract matches the JSON-LD Astro really emitted', () => {
  const cases = [
    { name: 'with a site URL', fixture: 'jsonld-url.html', site: SITE },
    { name: 'without a site URL', fixture: 'jsonld-urlless.html', site: { ...SITE, url: null } },
  ];

  for (const { name, fixture, site } of cases) {
    it(`${name}: the emitted block is valid JSON`, () => {
      expect(() => JSON.parse(emittedJsonLd(fixture))).not.toThrow();
    });

    it(`${name}: the parsed object equals the contract`, () => {
      expect(JSON.parse(emittedJsonLd(fixture))).toEqual(resolveOrganization(site));
    });

    it(`${name}: the emitted bytes equal the contract's serialisation`, () => {
      expect(emittedJsonLd(fixture)).toBe(serialiseOrganization(resolveOrganization(site)));
    });

    it(`${name}: the parsed object is a well-formed Organization`, () => {
      const parsed = JSON.parse(emittedJsonLd(fixture)) as Record<string, unknown>;
      expect(parsed['@context']).toBe('https://schema.org');
      expect(parsed['@type']).toBe('Organization');
      expect(typeof parsed['name']).toBe('string');
      expect((parsed['name'] as string).length).toBeGreaterThan(0);
    });
  }

  it('without a URL the property is absent, not null or empty', () => {
    const parsed = JSON.parse(emittedJsonLd('jsonld-urlless.html')) as Record<string, unknown>;
    expect('url' in parsed).toBe(false);
  });

  it('the emitted block contains no fabricated value and no broken serialisation', () => {
    for (const fixture of ['jsonld-url.html', 'jsonld-urlless.html']) {
      const raw = emittedJsonLd(fixture);
      expect(raw).not.toContain('[object Object]');
      expect(raw).not.toContain('undefined');
      expect(raw).not.toContain('null');
      for (const forbidden of ['localhost', 'example.com', 'yourdomain']) {
        expect(raw.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it('the block carries no raw angle bracket that could end the script early', () => {
    // The HTML parser ends a script element at the first '</script', whatever
    // the JSON quoting says. The template escapes for this; the fixture proves
    // the escaping survived into the build.
    for (const fixture of ['jsonld-url.html', 'jsonld-urlless.html']) {
      expect(/[<>]/.test(emittedJsonLd(fixture))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

const renderComposition = (features: readonly FeatureId[], site: SiteContext): string => {
  const { project, selection } = resolveProject(astro(features, site), adapters);
  const { metadata, structuredData, plan } = planAstro(features, site);

  const lines: string[] = [];
  lines.push('== MANIFEST ==');
  lines.push(`site.name   ${site.name}`);
  lines.push(`site.url    ${site.url ?? '(none)'}`);
  lines.push(`features    ${[...project.selection.features].sort().join(', ')}`);
  lines.push('');
  lines.push('== SELECTED ADAPTERS ==');
  for (const entry of selection.adapters) {
    lines.push(`${entry.ref.padEnd(28)} ${entry.adapter.declaration.kind}`);
  }
  lines.push('');
  lines.push('== REQUIRED ROLES ==');
  for (const role of project.requiredRoles) {
    lines.push(`${role.padEnd(28)} -> ${project.architecture.roles[role] ?? '(unmapped)'}`);
  }
  if (project.requiredRoles.length === 0) lines.push('(none)');
  lines.push('');
  lines.push('== METADATA CLAIMS ==');
  lines.push(metadata.length === 0 ? '(none)' : metadata.map((c) => `owner ${c.owner}`).join('\n'));
  lines.push('');
  lines.push('== STRUCTURED-DATA CLAIMS ==');
  if (structuredData.length === 0) lines.push('(none)');
  for (const claim of structuredData) {
    lines.push(`owner   ${claim.owner}`);
    lines.push(`reason  ${claim.reason}`);
    lines.push(`json    ${serialiseOrganization(claim.value)}`);
  }
  lines.push('');
  lines.push('== OWNERSHIP ==');
  for (const operation of plan.operations) {
    lines.push(`${operation.path.padEnd(40)} ${operation.origin}`);
  }
  return `${lines.join('\n')}\n`;
};

describe('golden: Astro + Tailwind + structured-data', () => {
  it('golden: structured-data with a site URL', async () => {
    await expect(
      renderComposition(['starter:coming-soon', 'structured-data'], SITE),
    ).toMatchFileSnapshot('./golden/astro-structured-data.txt');
  });

  it('golden: structured-data without a site URL', async () => {
    await expect(
      renderComposition(['starter:coming-soon', 'structured-data'], { ...SITE, url: null }),
    ).toMatchFileSnapshot('./golden/astro-structured-data-urlless.txt');
  });

  it('golden: SEO and structured-data together', async () => {
    await expect(
      renderComposition(['starter:coming-soon', 'seo', 'structured-data'], SITE),
    ).toMatchFileSnapshot('./golden/astro-seo-structured-data.txt');
  });

  it('the three are genuinely different snapshots', () => {
    const a = renderComposition(['starter:coming-soon', 'structured-data'], SITE);
    const b = renderComposition(['starter:coming-soon', 'structured-data'], {
      ...SITE,
      url: null,
    });
    const c = renderComposition(['starter:coming-soon', 'seo', 'structured-data'], SITE);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
