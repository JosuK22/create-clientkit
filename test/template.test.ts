import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { plan } from '../src/generate/plan.js';
import { findTokens } from '../src/generate/tokens.js';
import { KNOWN_TOKENS } from '../src/templates/manifest.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { isTextFile } from '../src/generate/files.js';
import { makeContext, tempDir, testLogger } from './helpers.js';

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function scratch(): string {
  const { dir, cleanup } = tempDir('tpl');
  cleanups.push(cleanup);
  return dir;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('registry discovery', () => {
  it('finds the templates directory from the source tree', () => {
    expect(existsSync(path.join(TEMPLATES_ROOT, 'astro-tailwind', 'template.json'))).toBe(true);
  });

  it('discovers astro-tailwind', () => {
    expect(registry.has('astro-tailwind')).toBe(true);
    expect(registry.list().map((t) => t.id)).toEqual(['astro-tailwind']);
  });

  it('exposes a validated manifest', () => {
    const manifest = registry.get('astro-tailwind');
    expect(manifest.framework).toBe('astro');
    expect(manifest.frameworkVersion).toBe('7.3.2');
    expect(manifest.supportedModes).toEqual(['coming-soon', 'full']);
    expect(manifest.availableFeatures).toEqual([]);
    expect(manifest.postSteps).toEqual(['install', 'git-init']);
  });

  it('supplies template defaults to the resolver', () => {
    expect(registry.defaultsFor('astro-tailwind')).toEqual({ mode: 'coming-soon', locale: 'en' });
  });

  it('validates which modes are supported', () => {
    expect(registry.supportsMode('astro-tailwind', 'full')).toBe(true);
    expect(registry.supportsMode('astro-tailwind', 'coming-soon')).toBe(true);
    expect(registry.supportsMode('nope', 'full')).toBe(false);
  });

  it('rejects an unknown template by name', () => {
    expect(() => registry.get('nextjs')).toThrow(/Unknown template "nextjs"/);
    expect(() => registry.rootFor('nextjs')).toThrow(/Unknown template/);
  });

  it('resolves the template root', () => {
    expect(registry.rootFor('astro-tailwind')).toBe(path.join(TEMPLATES_ROOT, 'astro-tailwind'));
  });
});

// ---------------------------------------------------------------------------
// Planning the real template
// ---------------------------------------------------------------------------

describe('planning astro-tailwind', () => {
  const context = (mode: 'coming-soon' | 'full') =>
    makeContext({ template: { id: 'astro-tailwind', version: '0.1.0', mode } });

  it('produces the expected file set for coming-soon', () => {
    const result = plan(context('coming-soon'), { registry });
    expect([...result.operations.map((op) => op.path)].sort()).toEqual([
      '.client-site.json',
      '.gitattributes',
      '.gitignore',
      'README.md',
      'astro.config.mjs',
      'package.json',
      'public/favicon.svg',
      'src/components/Brand.astro',
      'src/components/Footer.astro',
      'src/components/Header.astro',
      'src/components/LaunchNotice.astro',
      'src/components/Seo.astro',
      'src/components/SocialLinks.astro',
      'src/components/StructuredData.astro',
      'src/config/site.config.ts',
      'src/layouts/BaseLayout.astro',
      'src/lib/seo.ts',
      'src/pages/404.astro',
      'src/pages/index.astro',
      'src/pages/robots.txt.ts',
      'src/styles/global.css',
      'tsconfig.json',
    ]);
  });

  it('produces the same file set for full mode', () => {
    const comingSoon = plan(context('coming-soon'), { registry }).operations.map((op) => op.path);
    const full = plan(context('full'), { registry }).operations.map((op) => op.path);
    expect(full).toEqual(comingSoon);
  });

  it('overrides the base placeholder page with the mode page', () => {
    const page = plan(context('full'), { registry }).operations.find(
      (op) => op.path === 'src/pages/index.astro',
    );
    const content = page && page.type === 'write' ? page.content : '';
    expect(content).toContain('Work');
    expect(content).not.toContain('This page comes from the template');
  });

  it('merges keywords from base and mode without duplicates', () => {
    const read = (mode: 'coming-soon' | 'full') => {
      const pkg = plan(context(mode), { registry }).operations.find(
        (op) => op.path === 'package.json',
      );
      return JSON.parse(pkg && pkg.type === 'write' ? pkg.content : '{}');
    };
    expect(read('coming-soon').keywords).toEqual(['astro', 'client-site', 'landing-page']);
    expect(read('full').keywords).toEqual(['astro', 'client-site', 'website']);
  });

  it('pins exact dependency versions and marks the project private', () => {
    const pkg = plan(context('full'), { registry }).operations.find(
      (op) => op.path === 'package.json',
    );
    const parsed = JSON.parse(pkg && pkg.type === 'write' ? pkg.content : '{}');

    expect(parsed.private).toBe(true);
    expect(parsed.license).toBe('UNLICENSED');
    expect(parsed.dependencies.astro).toBe('7.3.2');
    expect(parsed.devDependencies.tailwindcss).toBe('4.3.3');
    expect(parsed.devDependencies['@tailwindcss/vite']).toBe('4.3.3');
    expect(parsed.devDependencies.typescript).toBe('5.9.3');
    expect(parsed.devDependencies['@astrojs/check']).toBe('0.9.10');
    expect(parsed.scripts.check).toBe('astro check');

    // Exact pins only - no ranges anywhere in the generated manifest.
    for (const version of Object.values({
      ...parsed.dependencies,
      ...parsed.devDependencies,
    })) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('does not ship an MIT licence into the generated project', () => {
    const paths = plan(context('full'), { registry }).operations.map((op) => op.path);
    expect(paths).not.toContain('LICENSE');
  });

  it('leaves no unsubstituted tokens anywhere', () => {
    for (const mode of ['coming-soon', 'full'] as const) {
      for (const operation of plan(context(mode), { registry }).operations) {
        if (operation.type !== 'write') continue;
        expect(findTokens(operation.content), `in ${operation.path}`).toEqual([]);
      }
    }
  });

  it('only declares tokens the engine knows', () => {
    for (const token of registry.get('astro-tailwind').tokens) {
      expect(KNOWN_TOKENS).toContain(token);
    }
  });

  it('omits Astro site config when no production URL is set', () => {
    const noUrl = makeContext({
      template: { id: 'astro-tailwind', version: '0.1.0', mode: 'coming-soon' },
      site: { name: 'Acme', url: null, description: 'd', locale: 'en', author: null },
    });
    const config = plan(noUrl, { registry }).operations.find(
      (op) => op.path === 'src/config/site.config.ts',
    );
    const content = config && config.type === 'write' ? config.content : '';
    expect(content).toContain("url: ''");
    // The interface declares `url: string` and the doc comment mentions
    // example.com; only the assigned value matters here.
    const urlValue = content.split('\n').find((line) => /^\s*url: '/.test(line));
    expect(urlValue?.trim()).toBe("url: '',");
  });

  it('classifies every template file the engine will touch', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
      );
    const files = walk(path.join(TEMPLATES_ROOT, 'astro-tailwind'));
    expect(files.length).toBeGreaterThan(10);
    // Everything in this template is text; nothing should fall through as binary
    // and silently skip token substitution.
    for (const file of files) expect(isTextFile(file), file).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End to end through main()
// ---------------------------------------------------------------------------

describe('generation through the CLI', () => {
  it('--dry-run lists real files and writes nothing', async () => {
    const cwd = scratch();
    const { logger, out } = testLogger();

    const code = await main(['my-site', '--yes', '--dry-run'], {
      logger,
      cwd,
      isTTY: false,
      env: {},
    });

    expect(code).toBe(0);
    expect(out.text).toContain('DRY RUN');
    expect(out.text).toContain('astro-tailwind');
    expect(out.text).toContain('src/pages/index.astro');
    expect(out.text).toContain('Total: 22 files');
    expect(readdirSync(cwd)).toEqual([]);
  });

  it('generates a project with --no-install --no-git', async () => {
    const cwd = scratch();
    const { logger } = testLogger();

    const code = await main(
      ['my-site', '--yes', '--no-install', '--no-git', '--name', 'Acme Ltd'],
      { logger, cwd, isTTY: false, env: {} },
    );

    expect(code).toBe(0);
    const target = path.join(cwd, 'my-site');
    expect(existsSync(path.join(target, 'package.json'))).toBe(true);
    expect(existsSync(path.join(target, '.client-site.json'))).toBe(true);
    expect(existsSync(path.join(target, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(target, '.git'))).toBe(false);

    const config = readFileSync(path.join(target, 'src/config/site.config.ts'), 'utf8');
    expect(config).toContain("name: 'Acme Ltd'");
  });

  it('writes LF line endings on every platform', async () => {
    const cwd = scratch();
    const { logger } = testLogger();
    await main(['my-site', '--yes', '--no-install', '--no-git'], {
      logger,
      cwd,
      isTTY: false,
      env: {},
    });

    for (const file of ['package.json', 'README.md', '.gitignore', 'src/pages/index.astro']) {
      expect(readFileSync(path.join(cwd, 'my-site', file), 'utf8'), file).not.toContain('\r\n');
    }
  });

  it('refuses a non-empty directory in non-interactive mode', async () => {
    const cwd = scratch();
    const { logger, err } = testLogger();
    const target = path.join(cwd, 'my-site');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'existing.txt'), 'keep');

    const code = await main(['my-site', '--yes', '--no-install', '--no-git'], {
      logger,
      cwd,
      isTTY: false,
      env: {},
    });

    expect(code).toBe(1);
    expect(err.text).toContain('not empty');
    expect(readdirSync(target)).toEqual(['existing.txt']);
  });

  it('--list-templates shows the real template', async () => {
    const { logger, out } = testLogger();
    const code = await main(['--list-templates'], { logger, cwd: scratch() });

    expect(code).toBe(0);
    expect(out.text).toContain('Available templates:');
    expect(out.text).toContain('astro-tailwind');
    expect(out.text).toContain('Astro + TypeScript + Tailwind');
    expect(out.text).toContain('coming-soon, full');
  });

  it('rejects a mode the template does not support', async () => {
    const { logger, err } = testLogger();
    const code = await main(['my-site', '--yes', '--mode', 'landing'], {
      logger,
      cwd: scratch(),
      isTTY: false,
      env: {},
    });

    expect(code).toBe(1);
    expect(err.text).toContain('Unknown mode "landing"');
  });
});

// ---------------------------------------------------------------------------
// M3 structural conformance
// ---------------------------------------------------------------------------

describe('M3 structure in both modes', () => {
  const modes = ['coming-soon', 'full'] as const;

  const build = (mode: (typeof modes)[number]) =>
    plan(makeContext({ template: { id: 'astro-tailwind', version: '0.1.0', mode } }), {
      registry,
    });

  const read = (mode: (typeof modes)[number], file: string): string => {
    const op = build(mode).operations.find((entry) => entry.path === file);
    return op && op.type === 'write' ? op.content : '';
  };

  it.each(modes)('%s ships the required files', (mode) => {
    const paths = build(mode).operations.map((op) => op.path);
    for (const required of [
      'src/pages/index.astro',
      'src/pages/404.astro',
      'src/layouts/BaseLayout.astro',
      'src/components/Header.astro',
      'src/components/Footer.astro',
      'src/components/Brand.astro',
      'src/components/SocialLinks.astro',
      'src/components/LaunchNotice.astro',
      'src/config/site.config.ts',
      'src/styles/global.css',
    ]) {
      expect(paths, `${mode} is missing ${required}`).toContain(required);
    }
  });

  it.each(modes)('%s leaves no unresolved tokens', (mode) => {
    for (const op of build(mode).operations) {
      if (op.type !== 'write') continue;
      expect(findTokens(op.content), `in ${op.path}`).toEqual([]);
    }
  });

  // NAV reaches the page through exactly one route: BaseLayout renders
  // <Header items={nav} />, and only when showHeader is true. That makes
  // showHeader the switch that decides whether NAV is visible at all, and the
  // two modes answer it differently on purpose.
  //
  // A real-device pass noticed the asymmetry - configured NAV entries appear
  // on a coming-soon site's 404 page but not its home page - and it is
  // deliberate: the launch page carries its own brand lockup, and a menu
  // pointing at pages that do not exist yet works against the point of it.
  //
  // These assertions exist so the decision stays a decision. If someone later
  // removes showHeader={false}, or drops the NAV-aware override in full mode,
  // that is a behaviour change for every generated site and should fail here
  // rather than surprise a user.
  describe('navigation contract', () => {
    /**
     * The opening <BaseLayout ...> tag only.
     *
     * Matching the whole file is not good enough: these pages carry comments
     * explaining the showHeader decision, and those comments quote the prop
     * verbatim. A naive /showHeader=\{false\}/ over the file therefore passes
     * on the prose alone - which it did, until deleting the real prop failed
     * to fail this test.
     */
    const layoutTag = (mode: (typeof modes)[number], file: string): string => {
      const match = read(mode, file).match(/<BaseLayout\b[^>]*>/s);
      return match ? match[0] : '';
    };

    it('coming-soon opts its home page out of the header deliberately', () => {
      const tag = layoutTag('coming-soon', 'src/pages/index.astro');
      expect(tag, 'no <BaseLayout> tag found').not.toBe('');
      expect(tag).toMatch(/showHeader=\{false\}/);
      // and the reason has to travel with the decision, in the file itself
      expect(read('coming-soon', 'src/pages/index.astro')).toMatch(/NAV/);
    });

    it('full leaves its home page header on, and lets NAV win when set', () => {
      const index = read('full', 'src/pages/index.astro');
      expect(index).not.toBe('');
      expect(layoutTag('full', 'src/pages/index.astro')).not.toMatch(/showHeader=\{false\}/);
      // NAV.length > 0 ? NAV : <section anchors> - the user's config wins
      expect(index).toMatch(/NAV\.length\s*>\s*0/);
      expect(index).toMatch(/nav=\{pageNav\}/);
    });

    it.each(modes)('%s keeps the header on its 404 page', (mode) => {
      expect(read(mode, 'src/pages/404.astro')).not.toBe('');
      expect(layoutTag(mode, 'src/pages/404.astro')).not.toMatch(/showHeader=\{false\}/);
    });

    it('BaseLayout is the only thing that mounts the header, and defaults it on', () => {
      const layout = read('coming-soon', 'src/layouts/BaseLayout.astro');
      expect(layout).toMatch(/showHeader\s*=\s*true/);
      expect(layout).toMatch(/showHeader\s*&&\s*<Header items=\{nav\}\s*\/>/);
      expect(layout).toMatch(/nav\s*=\s*NAV/);
    });

    it('the header renders no menu when NAV is empty', () => {
      const header = read('coming-soon', 'src/components/Header.astro');
      expect(header).toMatch(/items\.length\s*>\s*0/);
    });

    it('documents in site.config.ts where NAV does and does not appear', () => {
      const config = read('coming-soon', 'src/config/site.config.ts');
      expect(config).toMatch(/coming-soon mode the home page deliberately has no header/i);
    });
  });

  it.each(modes)('%s index page uses the layout and the config', (mode) => {
    const page = read(mode, 'src/pages/index.astro');
    expect(page).toContain('BaseLayout');
    expect(page).toContain('site.config.ts');
  });

  it('the 404 page uses the same layout and offers a way home', () => {
    const page = read('coming-soon', 'src/pages/404.astro');
    expect(page).toContain('BaseLayout');
    expect(page).toContain('href="/"');
    expect(page).toContain('btn btn-primary');
  });

  it('site config exposes the full M3 model', () => {
    const config = read('coming-soon', 'src/config/site.config.ts');
    for (const symbol of ['SITE', 'NAV', 'SOCIAL', 'CONTACT', 'LAUNCH', 'THEME']) {
      expect(config, `missing export ${symbol}`).toContain(`export const ${symbol}`);
    }
    for (const type of ['NavItem', 'SocialLink', 'ContactDetails', 'LaunchSettings']) {
      expect(config).toContain(`interface ${type}`);
    }
  });

  it('ships no fabricated client data by default', () => {
    const config = read('coming-soon', 'src/config/site.config.ts');
    // Empty defaults everywhere: no invented accounts, contacts or launch date.
    expect(config).toContain('export const NAV: NavItem[] = [];');
    expect(config).toContain('export const SOCIAL: SocialLink[] = [];');
    expect(config).toMatch(/email: '',/);
    expect(config).toMatch(/enabled: false,/);
  });

  it('defines the design system as semantic tokens, not scattered hexes', () => {
    const css = read('coming-soon', 'src/styles/global.css');
    for (const token of [
      '--color-background',
      '--color-foreground',
      '--color-muted',
      '--color-accent',
      '--text-display',
      '--radius-md',
      '--shadow-subtle',
    ]) {
      expect(css, `missing token ${token}`).toContain(token);
    }
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('prefers-reduced-motion: no-preference');
  });

  it.each(modes)('%s pages reference tokens rather than raw hex colours', (mode) => {
    for (const file of ['src/pages/index.astro', 'src/pages/404.astro']) {
      const content = read(mode, file);
      expect(content, `${file} hard-codes a hex colour`).not.toMatch(/#[0-9a-f]{6}\b/i);
    }
  });

  it.each(modes)('%s keeps the accessibility baseline in the layout', (mode) => {
    const layout = read(mode, 'src/layouts/BaseLayout.astro');
    expect(layout).toContain('Skip to content');
    expect(layout).toContain('<main');
    expect(layout).toContain('lang={SITE.locale}');
  });

  it('does not depend on a third-party font or icon CDN', () => {
    for (const mode of modes) {
      for (const op of build(mode).operations) {
        if (op.type !== 'write') continue;
        expect(op.content, `${op.path} loads a remote font`).not.toContain('fonts.googleapis.com');
        expect(op.content, `${op.path} loads a remote asset`).not.toMatch(
          /<link[^>]+href="https?:\/\//,
        );
      }
    }
  });

  it('keeps the generated runtime dependencies minimal and deliberate', () => {
    const pkg = JSON.parse(read('coming-soon', 'package.json'));
    // Astro plus the official sitemap integration, and nothing else.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@astrojs/sitemap', 'astro']);
  });
});
