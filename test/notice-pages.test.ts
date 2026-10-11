import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { tempDir, testLogger } from './helpers.js';

/**
 * The launch page and the not-found page, as a person receives them.
 *
 * React and Next render both pages through the shared style contract: the
 * markup names what a thing is (`notice-title`, `status-label`) and whichever
 * stylesheet the styling choice contributed decides how it looks. These tests
 * generate real projects through the CLI and hold the two halves to each other,
 * so a class added to a page cannot ship unstyled under one styling system.
 *
 * Astro's pages are its own `.astro` files with scoped styles and are covered
 * by the Astro golden snapshots; they are not part of this contract.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Stack {
  readonly name: string;
  readonly flags: readonly string[];
  /** Where the stylesheet and the two pages land in this framework. */
  readonly stylesheet: string;
  readonly launch: string;
  readonly notFound: string;
}

const REACT = { stylesheet: 'src/styles/index.css', launch: 'src/pages/HomePage.tsx' };
const ROUTED = ['--router', 'react-router', '--features', 'client-route-fallback'];
const NEXT = {
  stylesheet: 'styles/globals.css',
  launch: 'app/page.tsx',
  notFound: 'app/not-found.tsx',
};

const STACKS: readonly Stack[] = [
  {
    name: 'React + Tailwind',
    flags: ['--framework', 'react', '--styling', 'tailwind', ...ROUTED],
    ...REACT,
    notFound: 'src/pages/NotFoundPage.tsx',
  },
  {
    name: 'React + Bootstrap',
    flags: ['--framework', 'react', '--styling', 'bootstrap', ...ROUTED],
    ...REACT,
    notFound: 'src/pages/NotFoundPage.tsx',
  },
  {
    name: 'React + Tailwind + MUI',
    flags: ['--framework', 'react', '--styling', 'tailwind', '--ui-library', 'mui', ...ROUTED],
    ...REACT,
    notFound: 'src/pages/NotFoundPage.tsx',
  },
  { name: 'Next (plain CSS)', flags: ['--framework', 'nextjs'], ...NEXT },
  { name: 'Next + Tailwind', flags: ['--framework', 'nextjs', '--styling', 'tailwind'], ...NEXT },
  {
    name: 'Next + Bootstrap',
    flags: ['--framework', 'nextjs', '--styling', 'bootstrap'],
    ...NEXT,
  },
  {
    name: 'Next + Chakra',
    flags: ['--framework', 'nextjs', '--ui-library', 'chakra'],
    ...NEXT,
  },
];

async function generate(flags: readonly string[]): Promise<string> {
  const { dir, cleanup } = tempDir('notice-pages');
  cleanups.push(cleanup);
  const { logger } = testLogger();
  const code = await runCreate({
    flags: parseCliArgs([
      'acme',
      '--yes',
      '--name',
      'Acme Studio',
      '--mode',
      'coming-soon',
      '--no-install',
      '--no-git',
      ...flags,
    ]),
    logger,
    registry,
    cliVersion: '9.9.9',
    cwd: dir,
    env: {},
    isTTY: false,
    nodeVersion: '24.0.0',
  });
  expect(code).toBe(0);
  return path.join(dir, 'acme');
}

const read = (root: string, file: string): string => readFileSync(path.join(root, file), 'utf8');

/** Every class a JSX file asks for, from its `className` string literals. */
function classesUsed(source: string): Set<string> {
  const found = new Set<string>();
  for (const [, list] of source.matchAll(/className="([^"]+)"/g)) {
    for (const name of (list ?? '').split(/\s+/)) if (name !== '') found.add(name);
  }
  return found;
}

/** Every class a stylesheet defines a rule for. */
function classesDefined(css: string): Set<string> {
  return new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1] ?? ''));
}

/** Classes the shared components contribute, beyond the page files themselves. */
const SHARED = ['brand', 'brand-sm', 'brand-mark', 'brand-name', 'container-page'];

describe.each(STACKS)('$name', (stack) => {
  it('styles every class the launch page and the not-found page use', async () => {
    const root = await generate(stack.flags);
    const defined = classesDefined(read(root, stack.stylesheet));
    const used = new Set([
      ...classesUsed(read(root, stack.launch)),
      ...classesUsed(read(root, stack.notFound)),
      ...SHARED,
    ]);
    const missing = [...used].filter((name) => !defined.has(name));
    expect(missing, `unstyled under ${stack.name}`).toEqual([]);
  });

  it('ships the launch page with its status, headline and copy', async () => {
    const root = await generate(stack.flags);
    const page = read(root, stack.launch);
    expect(page).toContain('<p className="status-label">Coming soon</p>');
    expect(page).toContain('<h1 className="notice-title">Something great is on the way.</h1>');
    expect(page).toContain('putting the finishing touches on our new website');
    // The only action is real: a mailto that renders only once an email is set.
    expect(page).toMatch(/CONTACT\.email (!== '' )?(&&|\?)/);
    expect(page).toContain('href={`mailto:${CONTACT.email}`}');
  });

  it('ships the not-found page with a working way home', async () => {
    const root = await generate(stack.flags);
    const page = read(root, stack.notFound);
    expect(page).toContain('<h1 className="notice-title">Page not found</h1>');
    expect(page).toMatch(/(<a|<Link) href="\/" className="button-primary">\s*Back to home/);
    // The big numeral is decoration; the heading carries the meaning.
    expect(page).toContain('<p className="notice-code" aria-hidden="true">');
  });

  it('adds no form, handler, remote asset or leftover token', async () => {
    const root = await generate(stack.flags);
    for (const file of [stack.launch, stack.notFound, stack.stylesheet]) {
      const content = read(root, file);
      expect(content, file).not.toMatch(/<form|onClick|onSubmit|https?:\/\/|url\(/);
      expect(content, file).not.toContain('{{');
    }
  });
});

describe('the not-found view under React Router', () => {
  it('is still what the catch-all route renders', async () => {
    const root = await generate(['--framework', 'react', '--styling', 'tailwind', ...ROUTED]);
    const router = read(root, 'src/routes/AppRouter.tsx');
    expect(router).toMatch(/path="\*"/);
    expect(router).toContain('NotFoundPage');
    expect(existsSync(path.join(root, 'src/pages/NotFoundPage.tsx'))).toBe(true);
  });

  it('is not generated for React without a router', async () => {
    const root = await generate(['--framework', 'react', '--styling', 'tailwind']);
    expect(existsSync(path.join(root, 'src/pages/NotFoundPage.tsx'))).toBe(false);
    // And the launch page still renders through the same contract.
    expect(read(root, 'src/pages/HomePage.tsx')).toContain('notice-title');
  });
});

describe('the full starter', () => {
  it.each([
    ['react', ['--framework', 'react', '--styling', 'tailwind'], 'src/pages/HomePage.tsx'],
    ['nextjs', ['--framework', 'nextjs'], 'app/page.tsx'],
  ] as const)(
    '%s keeps its own home page, untouched by the notice classes',
    async (_, flags, home) => {
      const { dir, cleanup } = tempDir('notice-full');
      cleanups.push(cleanup);
      const { logger } = testLogger();
      await runCreate({
        flags: parseCliArgs([
          'acme',
          '--yes',
          '--mode',
          'full',
          '--no-install',
          '--no-git',
          ...flags,
        ]),
        logger,
        registry,
        cliVersion: '9.9.9',
        cwd: dir,
        env: {},
        isTTY: false,
        nodeVersion: '24.0.0',
      });
      const page = readFileSync(path.join(dir, 'acme', home), 'utf8');
      expect(page).toMatch(/className="(container-page )?intro"/);
      expect(page).not.toContain('notice');
    },
  );
});

describe('the Astro pages', () => {
  it('keep their own scoped styles and are not part of this contract', () => {
    const astro = path.join(TEMPLATES_ROOT, 'astro-tailwind');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(astro);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), path.relative(astro, file)).not.toContain('notice-');
    }
  });
});
