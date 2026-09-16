import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACCESSIBILITY_DECLARATION } from '../src/adapters/accessibility.js';
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
import type { AccessibilityContract } from '../src/domain/accessibility.js';
import {
  ACCESSIBILITY_GUARANTEES,
  ACCESSIBILITY_OUT_OF_SCOPE,
  isValidLanguageTag,
  resolveAccessibilityContract,
  serialiseAccessibilityContract,
} from '../src/domain/accessibility.js';
import { collectClaims } from '../src/domain/claims.js';
import type { ConfigContribution } from '../src/domain/contributions.js';
import type {
  AdapterDeclaration,
  FeatureId,
  FrameworkId,
  ProjectManifest,
} from '../src/domain/index.js';
import { evaluateCombination } from '../src/domain/index.js';
import type { StarterId } from '../src/domain/starter.js';
import { validateLocale } from '../src/context/validate.js';
import { CliError } from '../src/errors.js';
import type { FileOperation } from '../src/generate/files.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import type { SiteContext } from '../src/types.js';
import { renderPlan, TEST_CWD } from './helpers.js';

/**
 * Accessibility, as a feature.
 *
 * The claim under test is that ClientKit can state - precisely, verifiably, and
 * without exaggeration - what the shell it generates guarantees, and that the
 * statement is framework-independent.
 *
 * The two halves of that matter equally. A contract that over-claims is worse
 * than none, because a team that believes a generated project is already
 * accessible stops checking. So the tests below assert the guarantees hold in
 * real built HTML *and* that the out-of-scope list stays honest.
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

const astro = (
  features: readonly FeatureId[],
  site: SiteContext = SITE,
  starter: StarterId = 'coming-soon',
): ProjectManifest => ({
  targetDir: path.join(TEST_CWD, 'acme-site'),
  projectName: 'acme-site',
  framework: 'astro',
  buildTool: 'vite',
  language: 'ts',
  styling: 'tailwind',
  uiLibrary: 'none',
  router: 'file-based',
  architecture: 'astro-standard',
  starter,
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
  starter: 'coming-soon',
});

const planAstro = (
  features: readonly FeatureId[],
  site: SiteContext = SITE,
  starter: StarterId = 'coming-soon',
) =>
  planManifest(astro(features, site, starter), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: starter,
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

describe('accessibility is a feature', () => {
  it('occupies the feature dimension', () => {
    expect(ACCESSIBILITY_DECLARATION.kind).toBe('feature');
    expect(ACCESSIBILITY_DECLARATION.id).toBe('accessibility');
  });

  it('is addressable only as a feature', () => {
    expect(adapters.feature('accessibility').declaration.id).toBe('accessibility');
    expect(() => adapters.styling('accessibility' as never)).toThrow(CliError);
    expect(() => adapters.uiLibrary('accessibility' as never)).toThrow(CliError);
  });

  it('is one of the implemented features', () => {
    expect(adapters.implementedFeatures()).toContain('accessibility');
    expect(adapters.hasFeature('accessibility')).toBe(true);
  });

  it('is selectable on its own', () => {
    const refs = selectAdapters(astro(['accessibility']), adapters).adapters.map(
      (entry) => entry.ref,
    );
    expect(refs).toContain('feature:accessibility');
    expect(refs).not.toContain('feature:seo');
    expect(refs).not.toContain('feature:structured-data');
  });

  it('is selectable alongside every other feature', () => {
    const refs = selectAdapters(
      astro(['accessibility', 'seo', 'structured-data', 'not-found'], SITE, 'full'),
      adapters,
    ).adapters.map((entry) => entry.ref);
    for (const ref of [
      'feature:accessibility',
      'feature:seo',
      'feature:structured-data',
      'feature:not-found',
    ]) {
      expect(refs).toContain(ref);
    }
  });
});

// ---------------------------------------------------------------------------
// Capability, not adapter identity
// ---------------------------------------------------------------------------

describe('it requires a capability and names nothing', () => {
  it('requires exactly a document metadata surface', () => {
    // Every guarantee is about the document *before any script runs*, which is
    // the property that capability already names. A second capability for one
    // requirement would fragment the vocabulary.
    // `composed-metadata` was split out of `document-metadata` in Stage 22:
    // a head rendered before the response is sent is not the same as a head
    // this generator writes into, and Next has the first without the second.
    expect(requiredCapabilities(ACCESSIBILITY_DECLARATION)).toEqual([
      'document-metadata',
      'composed-metadata',
    ]);
  });

  it('requires no build tool, styling system, UI library or language', () => {
    // Contrast is a colour decision; requiring Tailwind would make an
    // accessibility guarantee contingent on a design choice.
    for (const capability of [
      'vite-plugins',
      'css-framework',
      'composed-stylesheet',
      'css-in-js',
      'react-runtime',
      'typescript',
    ]) {
      expect(requiredCapabilities(ACCESSIBILITY_DECLARATION)).not.toContain(capability);
    }
  });

  it('provides nothing', () => {
    expect(ACCESSIBILITY_DECLARATION.provides).toEqual([]);
  });

  it('names no adapter anywhere in what it declares', () => {
    const declared = JSON.stringify(ACCESSIBILITY_DECLARATION).toLowerCase();
    for (const name of [
      'astro',
      'react',
      'vite',
      'tailwind',
      'bootstrap',
      'mui',
      'next',
      'seo',
      'structured-data',
      'not-found',
    ]) {
      expect(declared, `the declaration mentions ${name}`).not.toContain(name);
    }
  });

  it('names no adapter in its code, only in prose explaining the design', () => {
    const code = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'accessibility.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .toLowerCase();
    for (const name of ['astro', 'react', 'vite', 'tailwind', 'bootstrap', 'mui']) {
      expect(code, `accessibility.ts names ${name} in code`).not.toContain(name);
    }
  });

  it('contains no framework-specific output path', () => {
    const code = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'accessibility.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const fragment of [
      'BaseLayout',
      'src/layouts',
      'src/pages',
      'src/components',
      'src/app',
      'index.html',
      '.astro',
      '.tsx',
      '.jsx',
    ]) {
      expect(code, `accessibility.ts contains ${fragment}`).not.toContain(fragment);
    }
  });

  it('depends on no other feature adapter', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'accessibility.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map((m) => m[1]);
    for (const forbidden of ['./seo.js', './structured-data.js', './not-found.js']) {
      expect(imports, `it imports ${forbidden}`).not.toContain(forbidden);
    }
    for (const capability of ['seo', 'structured-data', 'not-found']) {
      expect(requiredCapabilities(ACCESSIBILITY_DECLARATION)).not.toContain(capability);
    }
  });
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

describe('compatibility is decided by capability', () => {
  it('Astro + Tailwind + accessibility is compatible', () => {
    expect(checkCompatibility(astro(['accessibility']), adapters).compatible).toBe(true);
  });

  it('React + Vite + Tailwind + accessibility is refused', () => {
    // The React shell is assembled after hydration, so nothing in the response
    // carries the language, landmarks or heading the contract guarantees.
    expect(checkCompatibility(react(['accessibility']), adapters).compatible).toBe(false);
  });

  it('the refusal names the missing capability and the reason', () => {
    let error: CliError | undefined;
    try {
      resolveProject(react(['accessibility']), adapters);
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    expect(text).toContain('document-metadata');
    expect(text).toContain('Accessibility baseline');
    expect(text).toContain('before any script runs');
  });

  it('a hypothetical framework with the capability satisfies it', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'nextjs',
      kind: 'framework',
      displayName: 'A framework that is not Astro',
      provides: ['document-metadata', 'composed-metadata', 'ssr'],
      requires: [],
    };
    expect(evaluateCombination([hypothetical, ACCESSIBILITY_DECLARATION]).compatible).toBe(true);
  });

  it('a hypothetical framework without it is refused, naming the capability', () => {
    const hypothetical: AdapterDeclaration = {
      id: 'angular',
      kind: 'framework',
      displayName: 'A framework with no document metadata surface',
      provides: ['typescript', 'spa-routing'],
      requires: [],
    };
    const report = evaluateCombination([hypothetical, ACCESSIBILITY_DECLARATION]);
    expect(report.compatible).toBe(false);
    expect(JSON.stringify(report)).toContain('document-metadata');
  });

  it('is indifferent to styling and the UI library', () => {
    expect(
      evaluateCombination([ASTRO_DECLARATION, TAILWIND_DECLARATION, ACCESSIBILITY_DECLARATION])
        .compatible,
    ).toBe(true);
    expect(evaluateCombination([ASTRO_DECLARATION, ACCESSIBILITY_DECLARATION]).compatible).toBe(
      true,
    );
    // MUI is refused for its own reason - react-runtime - not because of this.
    expect(
      evaluateCombination([
        REACT_DECLARATION,
        VITE_DECLARATION,
        MUI_DECLARATION,
        ACCESSIBILITY_DECLARATION,
      ]).compatible,
    ).toBe(false);
  });

  it('composes with every other implemented feature', () => {
    expect(
      evaluateCombination([
        ASTRO_DECLARATION,
        SEO_DECLARATION,
        STRUCTURED_DATA_DECLARATION,
        NOT_FOUND_DECLARATION,
        ACCESSIBILITY_DECLARATION,
      ]).compatible,
    ).toBe(true);
  });

  it('refuses a known but unimplemented feature, with no fallback', () => {
    for (const id of ['sitemap', 'social-metadata'] as const) {
      expect(() => adapters.feature(id)).toThrow(CliError);
    }
    let refs: readonly string[];
    try {
      refs = selectAdapters(astro(['sitemap']), adapters).adapters.map((entry) => entry.ref);
    } catch {
      refs = [];
    }
    expect(refs).not.toContain('feature:accessibility');
  });
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('the contract states only what the generator controls', () => {
  it('guarantees exactly the eight document properties', () => {
    expect(resolveAccessibilityContract(SITE).guarantees).toEqual([
      'document-language',
      'document-title',
      'main-landmark',
      'skip-link',
      'contentinfo-landmark',
      'primary-heading',
      'navigation-landmark-when-present',
      'scalable-viewport',
    ]);
  });

  it('records what it deliberately does not guarantee', () => {
    // The honest half. Without it a reader assumes a generated project has
    // already handled these, and stops checking.
    expect(resolveAccessibilityContract(SITE).outOfScope).toEqual([
      'wcag-conformance',
      'colour-contrast',
      'authored-content',
      'image-alternative-text',
      'third-party-components',
      'authored-interaction',
    ]);
  });

  it('never claims WCAG conformance', () => {
    const serialised = serialiseAccessibilityContract(resolveAccessibilityContract(SITE));
    expect(serialised).toContain('wcag-conformance');
    expect(resolveAccessibilityContract(SITE).guarantees as readonly string[]).not.toContain(
      'wcag-conformance',
    );
  });

  it('phrases the navigation guarantee conditionally, because it is', () => {
    // The coming-soon page renders no navigation at all, so "every page has a
    // nav landmark" would be false. What is always true is that navigation,
    // when present, is marked up as one.
    expect(ACCESSIBILITY_GUARANTEES).toContain('navigation-landmark-when-present');
    expect(ACCESSIBILITY_GUARANTEES as readonly string[]).not.toContain('navigation-landmark');
  });

  it('guarantees and out-of-scope entries never overlap', () => {
    for (const guarantee of ACCESSIBILITY_GUARANTEES) {
      expect(ACCESSIBILITY_OUT_OF_SCOPE as readonly string[]).not.toContain(guarantee);
    }
  });

  it('takes the document language from the site configuration', () => {
    expect(resolveAccessibilityContract(SITE).documentLanguage).toBe('en-GB');
    expect(resolveAccessibilityContract({ ...SITE, locale: 'fr' }).documentLanguage).toBe('fr');
  });

  it('accepts a bare primary subtag, which is valid HTML', () => {
    // Unlike og:locale, which needs language_TERRITORY. Different rule,
    // different consumer.
    expect(isValidLanguageTag('en')).toBe(true);
    expect(isValidLanguageTag('en-GB')).toBe(true);
    expect(isValidLanguageTag('pt-BR')).toBe(true);
  });

  it('rejects a malformed tag rather than repairing it', () => {
    for (const bad of ['', '   ', 'English', 'e', 'en_GB', 'Not A Locale', '123']) {
      expect(isValidLanguageTag(bad.trim()), `${bad} should be rejected`).toBe(false);
    }
  });

  it('agrees with the configuration resolver about what a locale is', () => {
    // The domain copy exists because the resolver's module reads the
    // filesystem and the contract must stay pure. This is the drift guard on
    // that duplication.
    for (const tag of ['en', 'en-GB', 'pt-BR', 'zh-Hant-TW', 'English', 'en_GB', '', 'e']) {
      expect(isValidLanguageTag(tag), `disagreement on "${tag}"`).toBe(
        validateLocale(tag) === null,
      );
    }
  });

  it('is a pure function of the site metadata', () => {
    expect(JSON.stringify(resolveAccessibilityContract(SITE))).toBe(
      JSON.stringify(resolveAccessibilityContract(SITE)),
    );
  });

  it('serialises in a fixed field order', () => {
    expect(
      Object.keys(JSON.parse(serialiseAccessibilityContract(resolveAccessibilityContract(SITE)))),
    ).toEqual(['documentLanguage', 'documentLanguageValid', 'guarantees', 'outOfScope']);
  });
});

// ---------------------------------------------------------------------------
// Nothing is invented
// ---------------------------------------------------------------------------

describe('no accessibility semantics are fabricated', () => {
  it('refuses to generate when the language tag is malformed', () => {
    // Substituting a plausible default would put a language on the document
    // that nobody chose, and assistive technology would announce it as fact.
    expect(() => planAstro(['accessibility'], { ...SITE, locale: 'Nope' })).toThrow(CliError);
  });

  it('the refusal says it will not guess', () => {
    let hint = '';
    try {
      planAstro(['accessibility'], { ...SITE, locale: 'Nope' });
    } catch (error) {
      hint = (error as CliError).hint ?? '';
    }
    expect(hint).toMatch(/will not guess/i);
    expect(hint).toContain('BCP-47');
  });

  it('does not substitute a default language of its own', () => {
    const contract = resolveAccessibilityContract({ ...SITE, locale: 'Nope' });
    expect(contract.documentLanguage).toBe('Nope');
    expect(contract.documentLanguage).not.toBe('en');
    expect(contract.documentLanguageValid).toBe(false);
  });

  it('substitutes nothing when the language is missing entirely', () => {
    // The gap a mutation found: the earlier cases all pass a *malformed* tag,
    // and a fabricated default only appears for an *empty* one. An empty locale
    // must stay empty and stay invalid, not quietly become "en".
    for (const empty of ['', '   ']) {
      const contract = resolveAccessibilityContract({ ...SITE, locale: empty });
      expect(contract.documentLanguage).toBe('');
      expect(contract.documentLanguage).not.toBe('en');
      expect(contract.documentLanguageValid).toBe(false);
    }
  });

  it('refuses to generate when the language is missing entirely', () => {
    expect(() => planAstro(['accessibility'], { ...SITE, locale: '' })).toThrow(CliError);
  });

  it('invents no accessible names, labels or descriptions', () => {
    const serialised = serialiseAccessibilityContract(resolveAccessibilityContract(SITE));
    for (const invented of ['aria-label', 'alt=', 'Image', 'Logo', 'Untitled', 'Navigation menu']) {
      expect(serialised, `the contract contains ${invented}`).not.toContain(invented);
    }
  });

  it('makes no claim about images, because the generator ships none needing one', () => {
    expect(ACCESSIBILITY_OUT_OF_SCOPE as readonly string[]).toContain('image-alternative-text');
    expect(ACCESSIBILITY_GUARANTEES as readonly string[]).not.toContain('image-alternative-text');
  });

  it('makes no keyboard claim about elements it did not create', () => {
    expect(ACCESSIBILITY_OUT_OF_SCOPE as readonly string[]).toContain('authored-interaction');
  });
});

// ---------------------------------------------------------------------------
// What it contributes
// ---------------------------------------------------------------------------

describe('contributions', () => {
  const contribution = () =>
    resolveWithAdapters(astro(['accessibility']), TEMPLATES_ROOT).contributions.find(
      (entry) => entry.owner === 'feature:accessibility',
    );

  it('adds no dependency, script, file or template layer', () => {
    expect(contribution()?.dependencies).toEqual([]);
    expect(contribution()?.scripts).toEqual([]);
    expect(contribution()?.files).toEqual([]);
    expect(contribution()?.templateLayers).toEqual([]);
  });

  it('changes nothing in the generated package manifest', () => {
    const withFeature = planAstro(['accessibility']).plan.operations.find(
      (entry) => entry.path === 'package.json',
    );
    const without = planAstro([]).plan.operations.find((entry) => entry.path === 'package.json');
    expect(withFeature?.type === 'write' ? withFeature.content : '').toBe(
      without?.type === 'write' ? without.content : 'x',
    );
  });

  it('generates no extra file at all', () => {
    expect(planAstro(['accessibility']).plan.operations.map((e) => e.path)).toEqual(
      planAstro([]).plan.operations.map((e) => e.path),
    );
  });

  it('describes its own slot on the shared shell role', () => {
    const config = contribution()?.config ?? [];
    expect(config.map((entry) => ({ target: entry.target, at: entry.at }))).toEqual([
      { target: 'app.layout', at: 'accessibility' },
    ]);
  });

  it('uses a slot no other feature uses', () => {
    const all = resolveWithAdapters(
      astro(['accessibility', 'seo', 'structured-data'], SITE, 'full'),
      TEMPLATES_ROOT,
    ).contributions.flatMap((entry) => entry.config);
    const slots = all.filter((entry) => entry.target === 'app.layout').map((entry) => entry.at);
    expect(new Set(slots)).toEqual(new Set(['metadata', 'structured-data', 'accessibility']));
    expect(slots.length).toBe(new Set(slots).size);
  });

  it('requests the shell as a required role', () => {
    const { project } = resolveProject(astro(['accessibility']), adapters);
    expect(project.requiredRoles).toContain('app.layout');
  });

  it('requires nothing extra when the feature is not selected', () => {
    const { project } = resolveProject(astro([]), adapters);
    expect(project.requiredRoles).not.toContain('app.layout');
  });

  it('leaves the shell owned by the framework template', () => {
    const layout = planAstro(['accessibility']).plan.operations.find(
      (entry) => entry.path === 'src/layouts/BaseLayout.astro',
    );
    expect(layout?.origin).toBe('base');
  });
});

// ---------------------------------------------------------------------------
// The guarantee
// ---------------------------------------------------------------------------

describe('the required role is load-bearing', () => {
  const operationsFor = (paths: readonly string[]): readonly FileOperation[] =>
    paths.map((entry) => ({ type: 'write', path: entry, content: '', origin: 'test' }));

  it('passes when the shell exists', () => {
    const { project } = resolveProject(astro(['accessibility']), adapters);
    // The home page is in this list because the starter guarantees `page.home`,
    // not because accessibility asks for it. A plan without one is not a
    // project, so the minimal plan this feature runs against has to contain it.
    expect(() =>
      assertRequiredRoles(
        project,
        operationsFor(['src/layouts/BaseLayout.astro', 'src/pages/index.astro']),
      ),
    ).not.toThrow();
  });

  it('fails before writing when nothing produces it', () => {
    const { project } = resolveProject(astro(['accessibility']), adapters);
    expect(() => assertRequiredRoles(project, operationsFor([]))).toThrow(/app\.layout/);
  });
});

// ---------------------------------------------------------------------------
// Claims: duplicates, conflicts, provenance
// ---------------------------------------------------------------------------

describe('claims are composed, not overwritten', () => {
  const claim = (owner: string, site: SiteContext = SITE): ConfigContribution => ({
    target: 'app.layout',
    at: 'accessibility',
    value: resolveAccessibilityContract(site),
    owner,
    reason: 'the accessibility properties the generated shell guarantees',
  });

  it('two identical claims de-duplicate, keeping both owners', () => {
    const claims = collectClaims<AccessibilityContract>(
      [claim('feature:accessibility'), claim('feature:alpha')],
      'app.layout',
      'accessibility',
    );
    expect(new Set(claims.map((entry) => JSON.stringify(entry.value))).size).toBe(1);
    expect(claims.map((entry) => entry.owner)).toEqual(['feature:accessibility', 'feature:alpha']);
  });

  it('two different claims are a conflict, not a silent winner', () => {
    expect(() =>
      collectClaims(
        [claim('feature:accessibility'), claim('feature:alpha', { ...SITE, locale: 'fr' })],
        'app.layout',
        'accessibility',
      ),
    ).toThrow(CliError);
  });

  it('the conflict names the field, both owners and both values', () => {
    let error: CliError | undefined;
    try {
      collectClaims(
        [claim('feature:accessibility'), claim('feature:alpha', { ...SITE, locale: 'fr' })],
        'app.layout',
        'accessibility',
      );
    } catch (thrown) {
      error = thrown as CliError;
    }
    const text = `${error?.message ?? ''}\n${error?.hint ?? ''}`;
    for (const fragment of [
      'documentLanguage',
      'feature:accessibility',
      'feature:alpha',
      'en-GB',
      'fr',
    ]) {
      expect(text, `the error never mentions ${fragment}`).toContain(fragment);
    }
  });

  it('ignores claims on the other slots, so the features never collide', () => {
    expect(
      collectClaims([{ ...claim('feature:seo'), at: 'metadata' }], 'app.layout', 'accessibility'),
    ).toEqual([]);
  });

  it('the plan carries the claim with its owner and reason', () => {
    const { accessibility } = planAstro(['accessibility']);
    expect(accessibility).toHaveLength(1);
    expect(accessibility[0]?.owner).toBe('feature:accessibility');
    expect(accessibility[0]?.reason.length).toBeGreaterThan(0);
    expect(accessibility[0]?.value.documentLanguage).toBe('en-GB');
  });

  it('carries no claim when the feature is not selected', () => {
    expect(planAstro([]).accessibility).toEqual([]);
  });

  it('carries all four claims independently when every feature is selected', () => {
    const { metadata, structuredData, accessibility } = planAstro(
      ['accessibility', 'seo', 'structured-data', 'not-found'],
      SITE,
      'full',
    );
    expect(metadata).toHaveLength(1);
    expect(structuredData).toHaveLength(1);
    expect(accessibility).toHaveLength(1);
    expect(accessibility[0]?.owner).toBe('feature:accessibility');
  });
});

// ---------------------------------------------------------------------------
// Structural isolation
// ---------------------------------------------------------------------------

describe('the adapter stays inside the contract', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'accessibility.ts'),
    'utf8',
  );
  const domain = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'domain', 'accessibility.ts'),
    'utf8',
  );

  it('touches no filesystem, process, shell or network API', () => {
    for (const file of [source, domain]) {
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
        expect(file, `it uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the domain contract imports nothing that reads the filesystem', () => {
    const imports = [...domain.matchAll(/^import[^;]*from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports).not.toContain('../context/validate.js');
  });

  it('is a pure function of its inputs', () => {
    const { project } = resolveProject(astro(['accessibility']), adapters);
    const adapter = adapters.feature('accessibility');
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
    expect(renderPlan(planAstro(['accessibility']).plan, TEMPLATES_ROOT)).toBe(
      renderPlan(planAstro(['accessibility']).plan, TEMPLATES_ROOT),
    );
  });

  it('feature order does not affect the result', () => {
    const forwards = planAstro(['seo', 'accessibility', 'structured-data'], SITE, 'full');
    const backwards = planAstro(['structured-data', 'accessibility', 'seo'], SITE, 'full');
    expect(renderPlan(forwards.plan, TEMPLATES_ROOT)).toBe(
      renderPlan(backwards.plan, TEMPLATES_ROOT),
    );
    expect(JSON.stringify(forwards.accessibility)).toBe(JSON.stringify(backwards.accessibility));
  });

  it('no generated content carries a machine value or an unresolved token', () => {
    for (const operation of planAstro(['accessibility']).plan.operations) {
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
 * The structural skeleton of a page a real `astro build` produced.
 *
 * Everything above checks the contract against itself. This checks it against
 * what the framework actually emitted - including the case the conditional
 * navigation guarantee exists for, where the page has no navigation at all.
 *
 * `scripts/smoke.mjs` re-checks the same guarantees on a freshly built project
 * every CI run, so a stale fixture cannot hide a regression.
 */
const skeleton = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );

describe('the guarantees hold in the HTML Astro really emitted', () => {
  const cases = [
    { name: 'a page with navigation', fixture: 'a11y-skeleton-with-nav.html', expectNav: true },
    { name: 'a page without navigation', fixture: 'a11y-skeleton-no-nav.html', expectNav: false },
  ];

  for (const { name, fixture, expectNav } of cases) {
    const html = () => skeleton(fixture);

    it(`${name}: the document declares the configured language`, () => {
      expect(html()).toContain(`lang="${resolveAccessibilityContract(SITE).documentLanguage}"`);
    });

    it(`${name}: there is exactly one non-empty title`, () => {
      const titles = [...html().matchAll(/<title>([^<]*)<\/title>/g)];
      expect(titles).toHaveLength(1);
      expect((titles[0]?.[1] ?? '').trim().length).toBeGreaterThan(0);
    });

    it(`${name}: there is exactly one main landmark, and it has an id`, () => {
      const mains = [...html().matchAll(/<main\b[^>]*>/g)];
      expect(mains).toHaveLength(1);
      expect(mains[0]?.[0]).toMatch(/\bid="[^"]+"/);
    });

    it(`${name}: the skip link targets the main landmark`, () => {
      const main = html().match(/<main\b[^>]*\bid="([^"]+)"/)?.[1];
      expect(html()).toContain(`<a href="#${main}"`);
    });

    it(`${name}: the skip link comes before the main landmark`, () => {
      expect(html().indexOf('<a href="#main"')).toBeLessThan(html().indexOf('<main'));
    });

    it(`${name}: there is a contentinfo landmark`, () => {
      expect([...html().matchAll(/<footer\b[^>]*>/g)].length).toBeGreaterThanOrEqual(1);
    });

    it(`${name}: there is exactly one primary heading`, () => {
      expect([...html().matchAll(/<h1\b[^>]*>/g)]).toHaveLength(1);
    });

    it(`${name}: the viewport does not prevent zooming`, () => {
      const viewport = html().match(/<meta name="viewport"[^>]*content="([^"]*)"/)?.[1] ?? '';
      expect(viewport.length).toBeGreaterThan(0);
      expect(viewport).not.toMatch(/user-scalable\s*=\s*no/);
      expect(viewport).not.toMatch(/maximum-scale\s*=\s*1\b/);
    });

    it(`${name}: navigation, where present, is a named nav landmark`, () => {
      const navs = [...html().matchAll(/<nav\b[^>]*>/g)].map((match) => match[0]);
      expect(navs.length > 0).toBe(expectNav);
      for (const nav of navs) {
        expect(nav, 'a nav landmark with no accessible name').toMatch(
          /aria-label="[^"]+"|aria-labelledby="[^"]+"/,
        );
      }
    });
  }

  it('the two fixtures differ exactly in whether navigation is present', () => {
    // Guards the pair. If both grew a nav, the conditional guarantee would stop
    // being exercised and the no-nav case would silently go untested.
    expect(skeleton('a11y-skeleton-with-nav.html')).toContain('<nav');
    expect(skeleton('a11y-skeleton-no-nav.html')).not.toContain('<nav');
  });

  it('no fabricated accessible name appears in the emitted structure', () => {
    for (const fixture of ['a11y-skeleton-with-nav.html', 'a11y-skeleton-no-nav.html']) {
      expect(skeleton(fixture)).not.toMatch(/aria-label="(Image|Photo|Logo|Untitled|Menu)"/i);
      expect(skeleton(fixture)).not.toMatch(/aria-\w+=""/);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

const renderComposition = (
  features: readonly FeatureId[],
  site: SiteContext,
  starter: StarterId = 'coming-soon',
): string => {
  const { project, selection } = resolveProject(astro(features, site, starter), adapters);
  const result = planAstro(features, site, starter);

  const lines: string[] = [];
  lines.push('== MANIFEST ==');
  lines.push(`site.name    ${site.name}`);
  lines.push(`site.locale  ${site.locale}`);
  lines.push(`starter      ${project.manifest.starter}`);
  lines.push(`features     ${[...project.selection.features].sort().join(', ') || '(none)'}`);
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
  lines.push('== CLAIMS BY SLOT ==');
  lines.push(`metadata          ${result.metadata.map((c) => c.owner).join(', ') || '(none)'}`);
  lines.push(
    `structured-data   ${result.structuredData.map((c) => c.owner).join(', ') || '(none)'}`,
  );
  lines.push(
    `accessibility     ${result.accessibility.map((c) => c.owner).join(', ') || '(none)'}`,
  );
  lines.push('');
  lines.push('== ACCESSIBILITY CONTRACT ==');
  if (result.accessibility.length === 0) lines.push('(none)');
  for (const claim of result.accessibility) {
    lines.push(`owner   ${claim.owner}`);
    lines.push(`reason  ${claim.reason}`);
    lines.push(serialiseAccessibilityContract(claim.value));
  }
  lines.push('');
  lines.push('== OWNERSHIP ==');
  for (const operation of result.plan.operations) {
    lines.push(`${operation.path.padEnd(40)} ${operation.origin}`);
  }
  return `${lines.join('\n')}\n`;
};

describe('golden: Astro + Tailwind + accessibility', () => {
  it('golden: accessibility alone', async () => {
    await expect(renderComposition(['accessibility'], SITE)).toMatchFileSnapshot(
      './golden/astro-accessibility.txt',
    );
  });

  it('golden: every feature together', async () => {
    await expect(
      renderComposition(['accessibility', 'seo', 'structured-data', 'not-found'], SITE, 'full'),
    ).toMatchFileSnapshot('./golden/astro-all-features.txt');
  });

  it('golden: no accessibility feature selected', async () => {
    await expect(renderComposition([], SITE)).toMatchFileSnapshot(
      './golden/astro-accessibility-absent.txt',
    );
  });

  it('the three are genuinely different snapshots', () => {
    const a = renderComposition(['accessibility'], SITE);
    const b = renderComposition(
      ['accessibility', 'seo', 'structured-data', 'not-found'],
      SITE,
      'full',
    );
    const c = renderComposition([], SITE);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
