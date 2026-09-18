import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { DOCUMENT_BINDING_IDS } from '../src/domain/document-value.js';
import type { FeatureId, ProjectManifest } from '../src/domain/index.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * Where a page's own metadata comes from, and how far it can travel.
 *
 * Stage 44 composed `canonical` and stopped, because `title`, `description` and
 * `robots` vary through Astro's prop channel and the composed surface could not
 * reach them. Stage 46 went and measured what that channel actually is.
 *
 * What the measurements found is an asymmetry, and this file is where it is
 * written down so it cannot be forgotten or assumed away:
 *
 *     site-wide composition   rendered inside the shell   -> sees page props
 *     page-targeted composition   rendered inside the page -> does not
 *
 * Every assertion here describes the template as it ships. None of it composes
 * anything: Stage 46 changed no production code, and these are the facts a
 * later stage has to build on.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);

const template = (file: string): string =>
  readFileSync(path.resolve(TEMPLATES_ROOT, 'astro-tailwind', 'base', file), 'utf8');

const manifest = (features: readonly FeatureId[]): ProjectManifest =>
  ({
    targetDir: path.join(TEST_CWD, 'acme-site'),
    projectName: 'acme-site',
    framework: 'astro',
    buildTool: 'astro',
    language: 'ts',
    styling: 'tailwind',
    uiLibrary: 'none',
    router: 'file-based',
    architecture: 'astro-standard',
    starter: 'coming-soon',
    features,
    site: {
      name: 'Acme Ltd',
      url: 'https://acme.example',
      description: 'Bespoke widgets.',
      locale: 'en-GB',
      author: null,
    },
    packageManager: 'npm',
    git: true,
    install: true,
  }) as ProjectManifest;

const fileIn = (features: readonly FeatureId[], target: string): string => {
  const found = planManifest(manifest(features), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'coming-soon',
    templateId: 'astro-tailwind',
  }).plan.operations.find((entry) => entry.path === target);
  if (found?.type !== 'write') throw new Error(`nothing written at ${target}`);
  return found.content;
};

// ---------------------------------------------------------------------------
// Where each value comes from
// ---------------------------------------------------------------------------

describe('the page declares its metadata through the layout', () => {
  it('takes title, description and indexing from its props', () => {
    // The single channel. A page states these by invoking the layout, which is
    // the same API a page the developer writes later uses.
    expect(template('src/layouts/BaseLayout.astro')).toContain('} = Astro.props;');
    for (const prop of ['title?: string;', 'description?: string;', 'noindex?: boolean;']) {
      expect(template('src/layouts/BaseLayout.astro')).toContain(prop);
    }
  });

  it('passes exactly those three on to the component that emits them', () => {
    expect(template('src/layouts/BaseLayout.astro')).toContain(
      '<Seo title={title} description={description} noindex={noindex} />',
    );
  });

  it('qualifies the page title with the site name, and never the reverse', () => {
    // The shape `page-title-with-site-name` was named after. An absent page
    // title means the site name alone, which is why the derivation reads an
    // empty page part as "adds nothing" rather than inventing a distinction.
    expect(template('src/components/Seo.astro')).toContain(
      'const pageTitle = title ? `${title} - ${SITE.name}` : SITE.name;',
    );
  });

  it('inherits the description from the site when the page states none', () => {
    /*
     * Inheritance is real and it lives in the template, not in the prop
     * channel: a page that says nothing gets `SITE.description`. So a
     * page-owned description binding would mean "what this page declared",
     * with absence still distinct from a value - and the fallback would be a
     * separate semantic step rather than part of the binding.
     */
    expect(template('src/components/Seo.astro')).toContain(
      'const metaDescription = (description ?? SITE.description).trim();',
    );
  });

  it('blocks indexing on the page’s own say-so or the project’s', () => {
    // Two sources, one flag. `indexing-directive` already takes that flag, so
    // the derivation is sufficient; what is missing is a binding for the
    // page's half of the disjunction.
    expect(template('src/components/Seo.astro')).toContain(
      'const blocked = noindex || SEO.noindex;',
    );
    expect(template('src/components/Seo.astro')).toContain(
      "const robots = blocked ? 'noindex, nofollow' : 'index, follow';",
    );
  });

  it('derives the canonical from the origin, the path and that same flag', () => {
    expect(template('src/components/Seo.astro')).toContain(
      "const canonical = origin === '' || blocked ? '' : absoluteUrl(origin, Astro.url.pathname);",
    );
  });
});

// ---------------------------------------------------------------------------
// How far a page value can travel
// ---------------------------------------------------------------------------

describe('the two composed positions differ in what they can see', () => {
  it('renders the site-wide document inside the shell', () => {
    /*
     * Measured, not inferred: a component in this position is evaluated in the
     * shell's scope, so `title`, `description` and `noindex` are in scope and
     * can be passed to it. A real build confirmed a page's own values arriving
     * there - including for a page written by hand after generation - and
     * confirmed that a page stating nothing arrives as absent rather than as
     * the site's values.
     */
    const shell = fileIn(['seo'], 'src/layouts/BaseLayout.astro');
    const slot = shell.indexOf('<slot name="head">');
    const destructure = shell.indexOf('} = Astro.props;');
    expect(slot).toBeGreaterThan(destructure);
    expect(shell).toContain('<slot name="head"><DocumentHead /></slot>');
  });

  it('renders a page-targeted document inside the page', () => {
    /*
     * And a page has no props of its own. A real build put
     * `{Astro.props.title}` in this position and it resolved to nothing, so the
     * only way to give this component the page's title is to write the literal
     * a second time - which is the freezing every stage since 34 has refused.
     */
    const page = fileIn(['seo'], 'src/pages/404.astro');
    expect(page).toContain('<Fragment slot="head"><DocumentHeadPageNotFound /></Fragment>');
    expect(page).not.toContain('} = Astro.props;');
    for (const name of ['const title', 'const description', 'const noindex']) {
      expect(page, `the page declares ${name}`).not.toContain(name);
    }
  });

  it('states the page’s metadata once, in the layout invocation', () => {
    // The value exists exactly once in the page. Passing it to a composed
    // component as well would make two copies that drift.
    const page = fileIn(['seo'], 'src/pages/404.astro');
    expect(page.split('title="Page not found"')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// What the vocabulary has today
// ---------------------------------------------------------------------------

describe('the binding vocabulary has no page-owned metadata', () => {
  it('names the page only by its path', () => {
    /*
     * `page.path` is build context - Astro knows which page it is rendering.
     * What a page *says about itself* has no binding, and that is the gap: page
     * identity and page metadata are different facts and only the first is
     * represented.
     */
    expect(DOCUMENT_BINDING_IDS).toContain('page.path');
    for (const absent of ['page.title', 'page.description', 'page.indexingBlocked']) {
      expect(DOCUMENT_BINDING_IDS, `${absent} exists`).not.toContain(absent);
    }
  });

  it('has a project-wide indexing flag but no page-level one', () => {
    // `document.indexingBlocked` is `SEO.noindex` - the project's half of
    // `noindex || SEO.noindex`. The page's half is unrepresented.
    expect(DOCUMENT_BINDING_IDS).toContain('document.indexingBlocked');
  });
});

// ---------------------------------------------------------------------------
// Nothing was composed
// ---------------------------------------------------------------------------

describe('Stage 46 composed nothing new', () => {
  it('still hands over only the canonical', () => {
    const metadata = fileIn(['seo'], 'src/components/Seo.astro');
    expect(metadata).not.toContain('<link rel="canonical"');
    for (const kept of ['<title>', '<meta name="description"', '<meta name="robots"']) {
      expect(metadata, `${kept} was handed over`).toContain(kept);
    }
  });

  it('leaves the canonical behaviour Stage 44 established', () => {
    expect(fileIn(['seo'], 'src/components/DocumentHead.astro')).toContain(
      'absoluteUrl(siteOrigin(SITE.url), Astro.url.pathname)',
    );
    expect(fileIn(['seo'], 'src/components/DocumentHeadPageNotFound.astro')).not.toContain('<link');
  });
});
