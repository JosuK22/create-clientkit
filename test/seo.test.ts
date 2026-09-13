import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planWithAdapters } from '../src/adapters/bridge.js';
import { findTokens } from '../src/generate/tokens.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { makeContext } from './helpers.js';

// The template's own SEO helpers are imported directly, so these are real unit
// tests of the code that ships to clients rather than assertions about strings.
import {
  absoluteUrl,
  assetUrl,
  jsonLdScript,
  siteOrigin,
} from '../templates/astro-tailwind/base/src/lib/seo.js';

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);
const modes = ['coming-soon', 'full'] as const;

// The adapter path, which is what the CLI runs since Stage 6 - package.json is
// composed from contributions and plan() alone would report no dependencies.
const build = (mode: (typeof modes)[number]) =>
  planWithAdapters(makeContext({ template: { id: 'astro-tailwind', version: '0.1.0', mode } }), {
    registry,
  }).plan;

const read = (mode: (typeof modes)[number], file: string): string => {
  const op = build(mode).operations.find((entry) => entry.path === file);
  return op && op.type === 'write' ? op.content : '';
};

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

describe('siteOrigin', () => {
  it('normalises every form of a configured URL to one origin', () => {
    expect(siteOrigin('https://client.example')).toBe('https://client.example');
    expect(siteOrigin('https://client.example/')).toBe('https://client.example');
    expect(siteOrigin('https://client.example/agency/')).toBe('https://client.example');
    expect(siteOrigin('  https://client.example  ')).toBe('https://client.example');
    expect(siteOrigin('http://localhost:4321')).toBe('http://localhost:4321');
  });

  it('returns empty for anything unusable, so callers omit the tag', () => {
    expect(siteOrigin('')).toBe('');
    expect(siteOrigin('   ')).toBe('');
    expect(siteOrigin('not a url')).toBe('');
    expect(siteOrigin('example.com')).toBe('');
    expect(siteOrigin('ftp://client.example')).toBe('');
    expect(siteOrigin('javascript:alert(1)')).toBe('');
  });

  it('never invents a domain', () => {
    for (const input of ['', '   ', 'nonsense']) {
      expect(siteOrigin(input)).not.toMatch(/example\.com|yourdomain|client-site/);
    }
  });
});

describe('absoluteUrl', () => {
  it('joins without producing a double slash', () => {
    expect(absoluteUrl('https://a.example', '/')).toBe('https://a.example/');
    expect(absoluteUrl('https://a.example', '/about')).toBe('https://a.example/about');
    expect(absoluteUrl('https://a.example', 'about')).toBe('https://a.example/about');
    expect(absoluteUrl('https://a.example', '//about')).toBe('https://a.example/about');
  });

  it('returns empty without an origin', () => {
    expect(absoluteUrl('', '/about')).toBe('');
  });
});

describe('assetUrl', () => {
  it('passes absolute URLs through untouched', () => {
    expect(assetUrl('https://a.example', 'https://cdn.example/og.png')).toBe(
      'https://cdn.example/og.png',
    );
    expect(assetUrl('', 'https://cdn.example/og.png')).toBe('https://cdn.example/og.png');
  });

  it('makes a site-relative path absolute', () => {
    expect(assetUrl('https://a.example', '/og.png')).toBe('https://a.example/og.png');
  });

  it('returns empty when unset, or when relative with no origin to resolve against', () => {
    expect(assetUrl('https://a.example', '')).toBe('');
    expect(assetUrl('', '/og.png')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// JSON-LD serialisation and script-context safety
// ---------------------------------------------------------------------------

describe('jsonLdScript', () => {
  it('produces valid JSON that round-trips exactly', () => {
    const value = { name: 'A&B "Studio" <Test>' };
    const parsed = JSON.parse(jsonLdScript(value));
    expect(parsed).toEqual(value);
  });

  it('escapes every character that could break out of a script element', () => {
    const output = jsonLdScript({ name: 'a<b>c&d' });
    expect(output).not.toContain('<');
    expect(output).not.toContain('>');
    expect(output).not.toContain('&');
    expect(output).toContain('\\u003c');
    expect(output).toContain('\\u003e');
    expect(output).toContain('\\u0026');
  });

  it('neutralises a closing script tag', () => {
    const attack = 'Evil</script><script>alert(1)</script>';
    const output = jsonLdScript({ name: attack });

    expect(output.toLowerCase()).not.toContain('</script');
    // The payload survives intact as data - it is escaped, not stripped.
    expect(JSON.parse(output).name).toBe(attack);
  });

  it.each([
    'A & B Design Studio',
    'Acme "Creative" Labs',
    "O'Reilly Studio",
    'Studio <Test>',
    'A/B Design',
    'Very Long Client Company International Holdings',
    'Ångström Sørensen 中文 studio',
  ])('keeps %s valid and intact', (name) => {
    const output = jsonLdScript({ '@type': 'Organization', name });
    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output).name).toBe(name);
    expect(output).not.toMatch(/[<>&]/);
  });

  it('is not defeated by an escape table written with the literal character', () => {
    // Guards the exact bug this helper had during development: writing '<'
    // instead of a backslash escape makes the replacement a silent no-op.
    expect(jsonLdScript({ a: '<' })).toBe('{"a":"\\u003c"}');
  });
});

// ---------------------------------------------------------------------------
// Template structure
// ---------------------------------------------------------------------------

describe('M4 files ship in both modes', () => {
  it.each(modes)('%s includes the SEO layer', (mode) => {
    const paths = build(mode).operations.map((op) => op.path);
    for (const required of [
      'src/components/Seo.astro',
      'src/components/StructuredData.astro',
      'src/lib/seo.ts',
      'src/pages/robots.txt.ts',
      'public/favicon.svg',
    ]) {
      expect(paths, `${mode} is missing ${required}`).toContain(required);
    }
  });

  it.each(modes)('%s leaves no unresolved tokens in the SEO layer', (mode) => {
    for (const file of [
      'src/components/Seo.astro',
      'src/components/StructuredData.astro',
      'src/lib/seo.ts',
      'src/pages/robots.txt.ts',
      'src/config/site.config.ts',
    ]) {
      expect(findTokens(read(mode, file)), `in ${file}`).toEqual([]);
    }
  });

  it('every asset the layout references is shipped', () => {
    const layout = read('coming-soon', 'src/layouts/BaseLayout.astro');
    const paths = build('coming-soon').operations.map((op) => op.path);

    for (const match of layout.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
      const reference = match[1] ?? '';
      // Route references are pages, not files in public/.
      if (reference === '/' || reference.startsWith('/#')) continue;
      expect(paths, `${reference} is referenced but not shipped`).toContain(`public${reference}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Configuration model
// ---------------------------------------------------------------------------

describe('SEO configuration', () => {
  const config = read('coming-soon', 'src/config/site.config.ts');

  it('exposes an SEO block with a typed shape', () => {
    expect(config).toContain('export const SEO: SeoSettings');
    expect(config).toContain('interface SeoSettings');
    expect(config).toMatch(/image: string;/);
    expect(config).toMatch(/twitterCard: TwitterCard;/);
    expect(config).toMatch(/noindex: boolean;/);
  });

  it('defaults to indexable with no social image', () => {
    // noindex defaults to false on purpose: a stale `noindex` after launch
    // hurts far more than a holding page being indexed and then replaced.
    expect(config).toMatch(/noindex: false,/);
    expect(config).toMatch(/image: '',/);
    expect(config).toMatch(/twitterCard: 'summary_large_image',/);
  });

  it('does not duplicate identity that already lives in SITE', () => {
    const seoBlock = config.slice(config.indexOf('export const SEO'));
    expect(seoBlock).not.toMatch(/\btitle:/);
    expect(seoBlock).not.toMatch(/\bdescription:/);
    expect(seoBlock).not.toMatch(/\burl:/);
  });
});

// ---------------------------------------------------------------------------
// No fabricated data
// ---------------------------------------------------------------------------

describe('no fabricated values reach the output', () => {
  const FAKE =
    /yourdomain|your-domain|client-site\.com|@yourcompany|555-0100|example@|@example\.com/i;

  it.each(modes)('%s ships no placeholder identity anywhere', (mode) => {
    for (const op of build(mode).operations) {
      if (op.type !== 'write') continue;
      expect(op.content, `${op.path} contains placeholder data`).not.toMatch(FAKE);
    }
  });

  it('the SEO components hard-code no domain except the schema.org context', () => {
    for (const file of [
      'src/components/Seo.astro',
      'src/components/StructuredData.astro',
      'src/pages/robots.txt.ts',
    ]) {
      const source = read('coming-soon', file);
      const urls = [...source.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
      for (const url of urls) {
        expect(url, `${file} hard-codes ${url}`).toBe('https://schema.org');
      }
    }
  });

  it('structured data emits optional fields only when configured', () => {
    const source = read('coming-soon', 'src/components/StructuredData.astro');
    for (const field of ['email', 'telephone', 'sameAs', 'location']) {
      const assignment = source.indexOf(`organization['${field}']`);
      expect(assignment, `${field} is never assigned`).toBeGreaterThan(-1);
      // Every optional property must sit behind a guard, so an unconfigured
      // value is omitted rather than emitted empty.
      const preceding = source.slice(Math.max(0, assignment - 160), assignment);
      expect(preceding, `${field} is emitted unconditionally`).toContain('if (');
    }
    // Nothing we cannot know about is ever assigned into the payload.
    for (const forbidden of ['aggregateRating', 'review', 'award', 'foundingDate', 'logo']) {
      expect(source, `${forbidden} is claimed`).not.toContain(`organization['${forbidden}']`);
    }
  });
});

// ---------------------------------------------------------------------------
// Conditional emission and the sitemap/noindex policy
// ---------------------------------------------------------------------------

describe('conditional metadata', () => {
  const seo = read('coming-soon', 'src/components/Seo.astro');

  it.each([
    ['description', /metaDescription !== '' && <meta name="description"/],
    ['canonical', /canonical !== '' && <link rel="canonical"/],
    ['og:url', /canonical !== '' && <meta property="og:url"/],
    ['og:image', /socialImage !== '' && <meta property="og:image"/],
    ['twitter:image', /socialImage !== '' && <meta name="twitter:image"/],
  ])('%s is only emitted when a value exists', (_label, pattern) => {
    expect(seo).toMatch(pattern);
  });

  it('suppresses the canonical tag on a blocked page', () => {
    expect(seo).toMatch(/origin === '' \|\| blocked/);
  });

  it('gates the sitemap on both a real URL and an indexable site', () => {
    const config = read('coming-soon', 'astro.config.mjs');
    expect(config).toMatch(/const wantsSitemap = origin !== '' && !SEO\.noindex/);
    expect(config).toMatch(/filter:/);
    expect(config).toContain('/404');
  });

  it('robots.txt advertises a sitemap only when one is built', () => {
    const robots = read('coming-soon', 'src/pages/robots.txt.ts');
    expect(robots).toMatch(/if \(SEO\.noindex\)/);
    expect(robots).toMatch(/Disallow: \//);
    expect(robots).toMatch(/if \(origin !== ''\)/);
    expect(robots).toContain('sitemap-index.xml');
  });

  it('the 404 opts out of indexing and structured data', () => {
    const page = read('coming-soon', 'src/pages/404.astro');
    expect(page).toContain('noindex={true}');
    expect(page).toContain('structuredData={false}');
    // Not the site's marketing description.
    expect(page).not.toContain('description={SITE.description}');
  });
});

describe('generated package', () => {
  it('pins the sitemap integration and keeps the runtime lean', () => {
    const pkg = JSON.parse(read('coming-soon', 'package.json'));
    expect(pkg.dependencies['@astrojs/sitemap']).toBe('3.7.4');
    expect(pkg.dependencies['astro']).toBe('7.3.2');
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@astrojs/sitemap', 'astro']);
    expect(pkg.scripts.check).toBe('astro check');
    expect(pkg.scripts.build).toBe('astro build');
  });

  it('keeps the M3 pins untouched', () => {
    const pkg = JSON.parse(read('coming-soon', 'package.json'));
    expect(pkg.devDependencies.tailwindcss).toBe('4.3.3');
    expect(pkg.devDependencies['@tailwindcss/vite']).toBe('4.3.3');
    expect(pkg.devDependencies.typescript).toBe('5.9.3');
    expect(pkg.devDependencies['@astrojs/check']).toBe('0.9.10');
  });
});
