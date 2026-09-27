import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import { createAdapterRegistry } from '../src/adapters/registry.js';
import { parseCliArgs } from '../src/args.js';
import { main } from '../src/cli.js';
import { runDetect } from '../src/commands/detect.js';
import {
  detectProject,
  type DetectEntry,
  type DetectFs,
  type ProjectDetection,
} from '../src/detect/detect.js';
import { resolveDetectedStack } from '../src/detect/stack.js';
import { DetectionError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { enumerateCombinations } from './accepted-combinations.js';
import { tempDir, testLogger } from './helpers.js';

/**
 * Project detection: what a directory is, from its own files, changing nothing.
 *
 * Fixtures are written inline as file maps rather than checked in as
 * directories. Each is two or three files, and keeping the map beside the
 * assertion it serves is what makes a failure readable - a checked-in
 * `package.json` three folders away is not. Most run against an in-memory
 * filesystem; the read-only and CLI tests write the same maps to a real
 * temporary directory.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const registry = createRegistry(TEMPLATES_ROOT);

const ROOT = path.resolve('/ck-detect/project');

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// In-memory, read-only filesystem
// ---------------------------------------------------------------------------

interface MemoryOptions {
  /** Top-level name -> absolute target, reported as a symlink. */
  readonly links?: Readonly<Record<string, string>>;
  /** Override a file's reported size. */
  readonly sizes?: Readonly<Record<string, number>>;
  readonly reverse?: boolean;
}

function memoryFs(
  files: Readonly<Record<string, string>>,
  options: MemoryOptions = {},
): DetectFs & { readonly listed: string[]; readonly read: string[] } {
  const listed: string[] = [];
  const read: string[] = [];
  const entries = new Map<string, DetectEntry>();
  for (const key of Object.keys(files)) {
    const [first, ...rest] = key.split('/');
    if (first === undefined) continue;
    if (!entries.has(first) || rest.length > 0) {
      entries.set(first, { name: first, kind: rest.length > 0 ? 'directory' : 'file' });
    }
  }
  for (const name of Object.keys(options.links ?? {})) entries.set(name, { name, kind: 'symlink' });

  const relative = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');
  return {
    listed,
    read,
    list(dir) {
      listed.push(dir);
      if (dir !== ROOT) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const all = [...entries.values()];
      return options.reverse === true ? all.reverse() : all;
    },
    realpath(target) {
      const link = options.links?.[relative(target)];
      return link ?? target;
    },
    size(file) {
      const name = relative(file);
      return options.sizes?.[name] ?? Buffer.byteLength(files[name] ?? '');
    },
    readText(file) {
      const name = relative(file);
      read.push(name);
      const content = files[name];
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    },
  };
}

const pkg = (json: Record<string, unknown>): string => JSON.stringify(json);
const deps = (dependencies: Record<string, string>, devDependencies: Record<string, string> = {}) =>
  pkg({ name: 'fixture', dependencies, devDependencies });

function detect(files: Record<string, string>, options: MemoryOptions = {}): ProjectDetection {
  return detectProject({ root: ROOT, fs: memoryFs(files, options) });
}

const value = (finding: ProjectDetection[keyof ProjectDetection]): unknown => {
  const f = finding as { status: string; value?: string; name?: string; candidates?: string[] };
  if (f.status === 'detected') return f.value;
  if (f.status === 'unsupported') return `unsupported:${f.name}`;
  if (f.status === 'ambiguous') return `ambiguous:${f.candidates?.join(',')}`;
  return f.status;
};

// ---------------------------------------------------------------------------
// Every accepted stack, round-tripped
// ---------------------------------------------------------------------------

describe('every stack ClientKit generates is detected as itself', () => {
  const { accepted } = enumerateCombinations(adapters);

  it(
    'plans, detects and resolves back to the same stack, for all of them',
    { timeout: 60_000 },
    () => {
      const mismatches: string[] = [];
      for (const combination of accepted) {
        const { plan } = planManifest(
          {
            targetDir: ROOT,
            projectName: 'acme',
            ...combination,
            site: { name: 'Acme', url: null, description: 'd', locale: 'en', author: null },
            packageManager: 'npm',
            git: true,
            install: true,
          } as never,
          {
            registry,
            cliVersion: '9.9.9',
            generatedAt: '2026-01-01T00:00:00.000Z',
            mode: combination.starter as 'coming-soon' | 'full',
            templateId:
              adapters.framework(combination.framework as never).templateManifest?.id ??
              'astro-tailwind',
          },
        );
        const files = Object.fromEntries(
          plan.operations.map((operation) => [
            operation.path,
            operation.type === 'write' ? operation.content : '',
          ]),
        );

        const detection = detect(files);
        const stack = resolveDetectedStack(detection, adapters);
        if (stack.status !== 'resolved') {
          mismatches.push(`${combination.id}: ${stack.problems.join(' ')}`);
          continue;
        }
        const got = stack.dimensions;
        const want = combination;
        for (const key of [
          'framework',
          'buildTool',
          'language',
          'styling',
          'uiLibrary',
          'router',
          'architecture',
        ] as const) {
          if (got[key] !== want[key]) {
            mismatches.push(`${combination.id}: ${key} ${got[key]} != ${want[key]}`);
          }
        }
        // Nothing the project has may be papered over with a default.
        for (const filled of stack.filled) {
          if (filled.by !== 'fixed') {
            mismatches.push(`${combination.id}: ${filled.dimension} defaulted`);
          }
        }
      }
      expect(mismatches).toEqual([]);
      expect(accepted.length).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

describe('framework', () => {
  it.each([
    ['astro', { astro: '5' }, 'astro'],
    ['nextjs', { next: '15', react: '19', 'react-dom': '19' }, 'nextjs'],
    ['react', { react: '19', 'react-dom': '19' }, 'react'],
    ['angular', { '@angular/core': '20' }, 'angular'],
  ])('detects %s', (_name, dependencies, expected) => {
    expect(value(detect({ 'package.json': deps(dependencies) }).framework)).toBe(expected);
  });

  it('lets a framework that owns its runtime outrank the runtime', () => {
    const detection = detect({ 'package.json': deps({ astro: '5', react: '19' }) });
    expect(value(detection.framework)).toBe('astro');
  });

  it('identifies an unsupported framework by name instead of calling it unknown', () => {
    expect(value(detect({ 'package.json': deps({ vue: '3' }) }).framework)).toBe('unsupported:Vue');
    // Gatsby brings React along; it is still Gatsby, not React.
    expect(value(detect({ 'package.json': deps({ gatsby: '5', react: '18' }) }).framework)).toBe(
      'unsupported:Gatsby',
    );
  });

  it('reports two owning frameworks as ambiguous rather than picking one', () => {
    expect(value(detect({ 'package.json': deps({ astro: '5', next: '15' }) }).framework)).toBe(
      'ambiguous:astro,nextjs',
    );
  });

  it('is absent when package.json names none, and unknown without package.json', () => {
    expect(value(detect({ 'package.json': deps({ lodash: '4' }) }).framework)).toBe('absent');
    expect(value(detect({ 'README.md': '# hi' }).framework)).toBe('unknown');
  });

  it('refuses an Angular project in the registry’s words, not its own', () => {
    const stack = resolveDetectedStack(
      detect({ 'package.json': deps({ '@angular/core': '20' }) }),
      adapters,
    );
    expect(stack.status).toBe('unresolved');
    if (stack.status === 'unresolved') {
      expect(stack.problems[0]).toBe('ClientKit does not support framework "angular" yet.');
    }
  });

  it('corroborates with the config file and lists it as evidence', () => {
    const detection = detect({
      'package.json': deps({ next: '15', react: '19' }),
      'next.config.ts': '',
    });
    expect(detection.framework).toEqual({
      status: 'detected',
      value: 'nextjs',
      evidence: [
        { source: 'package.json', path: 'package.json', detail: 'dependencies.next' },
        { source: 'config', path: 'next.config.ts', detail: 'configuration file' },
      ],
    });
  });
});

describe('build tool', () => {
  it.each([
    [{ react: '19' }, { vite: '7' }, 'vite'],
    [{ next: '15', react: '19' }, {}, 'next'],
    [{ astro: '5' }, {}, 'astro'],
    [{ '@angular/core': '20' }, { '@angular/cli': '20' }, 'angular-cli'],
    [{ react: '19', 'react-scripts': '5' }, {}, 'unsupported:Create React App'],
  ])('detects %j + %j as %s', (dependencies, devDependencies, expected) => {
    const detection = detect({ 'package.json': deps(dependencies, devDependencies) });
    expect(value(detection.buildTool)).toBe(expected);
  });

  it('does not infer a build tool from a config file alone', () => {
    const detection = detect({ 'package.json': deps({ react: '19' }), 'vite.config.ts': '' });
    expect(value(detection.buildTool)).toBe('absent');
  });
});

describe('language', () => {
  it('is ts with a tsconfig.json or a typescript dependency', () => {
    expect(value(detect({ 'package.json': deps({}), 'tsconfig.json': '{}' }).language)).toBe('ts');
    expect(value(detect({ 'package.json': deps({}, { typescript: '5' }) }).language)).toBe('ts');
  });

  it('prefers ts in a mixed project that has both configs', () => {
    const detection = detect({
      'package.json': deps({}),
      'tsconfig.json': '',
      'jsconfig.json': '',
    });
    expect(value(detection.language)).toBe('ts');
  });

  it('is js with a jsconfig.json, or with neither signal, saying why', () => {
    expect(value(detect({ 'package.json': deps({}), 'jsconfig.json': '' }).language)).toBe('js');
    const plainJs = detect({ 'package.json': deps({ react: '19' }) });
    expect(plainJs.language).toEqual({
      status: 'detected',
      value: 'js',
      evidence: [
        {
          source: 'package.json',
          path: 'package.json',
          detail: 'no typescript dependency, and no tsconfig.json',
        },
      ],
    });
  });

  it('still reads tsconfig.json when there is no package.json', () => {
    expect(value(detect({ 'tsconfig.json': '{}' }).language)).toBe('ts');
  });
});

describe('styling', () => {
  it.each([
    [{ tailwindcss: '4' }, 'tailwind'],
    [{ bootstrap: '5' }, 'bootstrap'],
    [{ sass: '1' }, 'scss'],
    [{ 'sass-embedded': '1' }, 'scss'],
    [{ less: '4' }, 'unsupported:Less'],
    [{ tailwindcss: '4', bootstrap: '5' }, 'ambiguous:bootstrap,tailwind'],
    [{}, 'absent'],
  ])('%j -> %s', (devDependencies, expected) => {
    const detection = detect({ 'package.json': deps({ react: '19' }, devDependencies) });
    expect(value(detection.styling)).toBe(expected);
  });

  it('does not resolve an ambiguous styling system into either one', () => {
    const stack = resolveDetectedStack(
      detect({
        'package.json': deps({ react: '19', vite: '7', tailwindcss: '4', bootstrap: '5' }),
      }),
      adapters,
    );
    expect(stack).toMatchObject({
      status: 'unresolved',
      problems: ['Its styling is ambiguous: bootstrap, tailwind.'],
    });
  });
});

describe('UI library', () => {
  it.each([
    [{ '@mui/material': '7' }, 'mui'],
    [{ '@chakra-ui/react': '3' }, 'chakra'],
    [{ '@angular/material': '20' }, 'angular-material'],
    [{ antd: '5' }, 'unsupported:Ant Design'],
    [{ '@mui/material': '7', '@chakra-ui/react': '3' }, 'ambiguous:chakra,mui'],
    [{}, 'absent'],
  ])('%j -> %s', (dependencies, expected) => {
    const detection = detect({ 'package.json': deps({ react: '19', ...dependencies }) });
    expect(value(detection.uiLibrary)).toBe(expected);
  });
});

describe('router', () => {
  it.each([
    [{ 'react-router': '7' }, 'react-router'],
    [{ 'react-router-dom': '7' }, 'react-router'],
    [{ '@angular/router': '20' }, 'angular-router'],
    [{ '@tanstack/react-router': '1' }, 'unsupported:TanStack Router'],
    [{}, 'absent'],
  ])('%j -> %s', (dependencies, expected) => {
    const detection = detect({ 'package.json': deps({ react: '19', ...dependencies }) });
    expect(value(detection.router)).toBe(expected);
  });

  it('reads no router as "none" on React and leaves file routing to Next.js', () => {
    const react = resolveDetectedStack(
      detect({
        'package.json': deps({ react: '19' }, { vite: '7', typescript: '5', tailwindcss: '4' }),
      }),
      adapters,
    );
    expect(react.status === 'resolved' && react.dimensions.router).toBe('none');

    const next = resolveDetectedStack(
      detect({ 'package.json': deps({ next: '15', react: '19' }, { typescript: '5' }) }),
      adapters,
    );
    expect(next.status === 'resolved' && next.dimensions.router).toBe('file-based');
    expect(next.status === 'resolved' && next.filled).toContainEqual({
      dimension: 'router',
      value: 'file-based',
      by: 'fixed',
    });
  });
});

describe('package manager', () => {
  it.each([
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ])('%s -> %s, without opening it', (lockfile, expected) => {
    const fs = memoryFs({ 'package.json': deps({}), [lockfile]: 'NOT READ' });
    const detection = detectProject({ root: ROOT, fs });
    expect(value(detection.packageManager)).toBe(expected);
    expect(fs.read).toEqual(['package.json']);
  });

  it('reads the packageManager field', () => {
    const detection = detect({ 'package.json': pkg({ packageManager: 'pnpm@9.1.0+sha512.abc' }) });
    expect(value(detection.packageManager)).toBe('pnpm');
  });

  it('agrees when the field and the lockfile agree', () => {
    const detection = detect({
      'package.json': pkg({ packageManager: 'yarn@4.1.0' }),
      'yarn.lock': '',
    });
    expect(value(detection.packageManager)).toBe('yarn');
  });

  it('refuses to choose between two lockfiles', () => {
    const detection = detect({
      'package.json': deps({}),
      'package-lock.json': '',
      'pnpm-lock.yaml': '',
    });
    expect(detection.packageManager).toEqual({
      status: 'ambiguous',
      candidates: ['npm', 'pnpm'],
      evidence: [
        { source: 'lockfile', path: 'package-lock.json', detail: 'lockfile' },
        { source: 'lockfile', path: 'pnpm-lock.yaml', detail: 'lockfile' },
      ],
    });
  });

  it('refuses to choose between the field and a lockfile that disagree', () => {
    const detection = detect({
      'package.json': pkg({ packageManager: 'pnpm@9' }),
      'package-lock.json': '',
    });
    expect(value(detection.packageManager)).toBe('ambiguous:npm,pnpm');
  });

  it('names a package manager ClientKit does not support', () => {
    expect(
      value(detect({ 'package.json': pkg({ packageManager: 'deno@2' }) }).packageManager),
    ).toBe('unsupported:deno');
  });

  it('is unknown with no lockfile and no field, and still found without package.json', () => {
    expect(value(detect({ 'package.json': deps({}) }).packageManager)).toBe('unknown');
    expect(value(detect({ 'pnpm-lock.yaml': '' }).packageManager)).toBe('pnpm');
  });
});

// ---------------------------------------------------------------------------
// Incomplete, broken and unusual projects
// ---------------------------------------------------------------------------

describe('incomplete and unusual projects', () => {
  it('reports an empty directory, or one holding only .git, as empty', () => {
    expect(detect({}).state).toBe('empty');
    expect(detect({ '.git/HEAD': 'ref' }).state).toBe('empty');
    expect(value(detect({}).framework)).toBe('unknown');
  });

  it('reports a directory without package.json, and says the stack cannot be determined', () => {
    const detection = detect({ 'index.html': '<p>', 'src/app.js': '' });
    expect(detection.state).toBe('no-package-json');
    expect(resolveDetectedStack(detection, adapters)).toMatchObject({
      status: 'unresolved',
      kind: 'undetermined',
    });
  });

  it.each([
    ['{ not json', /not valid JSON/],
    ['[1, 2]', /does not contain a JSON object/],
    ['"text"', /does not contain a JSON object/],
  ])('survives a malformed package.json: %s', (content, reason) => {
    const detection = detect({ 'package.json': content, 'yarn.lock': '' });
    expect(detection.state).toBe('unreadable-package-json');
    expect(detection.notes[0]).toMatch(reason);
    expect(value(detection.framework)).toBe('unknown');
    // What does not need package.json is still found.
    expect(value(detection.packageManager)).toBe('yarn');
  });

  it('ignores a dependencies block that is not an object, and says so', () => {
    const detection = detect({ 'package.json': pkg({ dependencies: ['react'] }) });
    expect(detection.state).toBe('package-json');
    expect(detection.notes).toContain(
      'package.json "dependencies" is not an object, so it was ignored.',
    );
  });

  it('tolerates a byte-order mark', () => {
    expect(
      value(
        detect({ 'package.json': String.fromCharCode(0xfeff) + deps({ react: '19' }) }).framework,
      ),
    ).toBe('react');
  });

  it('does not read a package.json that links outside the project', () => {
    const detection = detect(
      {},
      { links: { 'package.json': path.resolve('/elsewhere/package.json') } },
    );
    expect(detection.state).toBe('unreadable-package-json');
    expect(detection.notes[0]).toMatch(/outside the project/);
  });

  it('reads a package.json that links inside the project', () => {
    const fs = memoryFs(
      { 'real/package.json': deps({ react: '19' }), 'package.json': deps({ react: '19' }) },
      { links: { 'package.json': path.join(ROOT, 'real', 'package.json') } },
    );
    expect(value(detectProject({ root: ROOT, fs }).framework)).toBe('react');
  });

  it('refuses to read an implausibly large package.json', () => {
    const detection = detect({ 'package.json': deps({}) }, { sizes: { 'package.json': 2 ** 21 } });
    expect(detection.notes[0]).toMatch(/larger than 1 MiB/);
  });

  it('detects a partial project and says what the resolver had to supply', () => {
    const detection = detect({
      'package.json': deps({ react: '19', bootstrap: '5' }),
      'tsconfig.json': '{}',
    });
    expect(value(detection.buildTool)).toBe('absent');
    const stack = resolveDetectedStack(detection, adapters);
    expect(stack.status).toBe('resolved');
    if (stack.status === 'resolved') {
      expect(stack.filled).toContainEqual({ dimension: 'buildTool', value: 'vite', by: 'default' });
    }
  });

  it('inspects exactly the given directory: never a parent, never a child', () => {
    const fs = memoryFs({ 'apps/web/package.json': deps({ next: '15' }), 'README.md': '' });
    const detection = detectProject({ root: ROOT, fs });
    expect(detection.state).toBe('no-package-json');
    expect(fs.listed).toEqual([ROOT]);
    expect(fs.read).toEqual([]);
  });

  it('notes ClientKit provenance without reading it', () => {
    const fs = memoryFs({ 'package.json': deps({ astro: '5' }), '.client-site.json': '{}' });
    const detection = detectProject({ root: ROOT, fs });
    expect(detection.notes.join(' ')).toMatch(/\.client-site\.json is present/);
    expect(fs.read).toEqual(['package.json']);
  });

  it('fails only when the directory itself cannot be read', () => {
    expect(() => detectProject({ root: path.resolve('/nope'), fs: memoryFs({}) })).toThrow(
      DetectionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

const RICH = {
  'package.json': deps(
    { react: '19', 'react-router-dom': '7', '@mui/material': '7', antd: '5' },
    { vite: '7', typescript: '5', tailwindcss: '4', bootstrap: '5' },
  ),
  'vite.config.ts': '',
  'tsconfig.json': '{}',
  'package-lock.json': '',
  'yarn.lock': '',
  'src/main.tsx': '',
};

describe('determinism', () => {
  it('returns identical results on repeated runs', () => {
    const first = detect(RICH);
    for (let run = 0; run < 5; run += 1) expect(detect(RICH)).toEqual(first);
  });

  it('does not depend on the order the directory is listed in', () => {
    expect(detect(RICH, { reverse: true })).toEqual(detect(RICH));
  });

  it('never consults locale-sensitive comparison', () => {
    const expected = detect(RICH);
    const compare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('localeCompare used');
    });
    const collator = vi.spyOn(Intl, 'Collator').mockImplementation(() => {
      throw new Error('Intl.Collator used');
    });
    try {
      expect(detect(RICH)).toEqual(expected);
    } finally {
      compare.mockRestore();
      collator.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Against a real directory: read-only, and the command
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function writeProject(files: Record<string, string>): string {
  const { dir, cleanup } = tempDir('detect');
  cleanups.push(cleanup);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stats = statSync(full);
        out[path.relative(root, full)] =
          `${stats.size}:${stats.mtimeMs}:${readFileSync(full, 'base64')}`;
      }
    }
  };
  walk(root);
  return out;
}

describe('read-only', () => {
  it('changes no file, no content and no timestamp, and creates nothing', async () => {
    const dir = writeProject({
      ...RICH,
      'package.json': '{ "name": "broken", ',
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'node_modules/react/package.json': '{}',
    });
    const before = snapshot(dir);
    const parentBefore = readdirSync(path.dirname(dir)).sort();

    const { logger } = testLogger();
    expect(await main(['detect', dir], { logger })).toBe(0);
    detectProject({ root: dir });

    expect(snapshot(dir)).toEqual(before);
    expect(readdirSync(path.dirname(dir)).sort()).toEqual(parentBefore);
  });
});

describe('the detect command', () => {
  it('prints the stack with its evidence and exits 0', async () => {
    const dir = writeProject({
      'package.json': deps(
        { react: '19', 'react-router-dom': '7' },
        { vite: '7', typescript: '5', tailwindcss: '4' },
      ),
      'tsconfig.json': '{}',
      'pnpm-lock.yaml': '',
    });
    const { logger, out, err } = testLogger();
    expect(await main(['detect', dir], { logger, cwd: path.dirname(dir) })).toBe(0);

    const text = plain(out.text);
    expect(text).toMatch(/Framework\s+react\s+dependencies\.react/);
    expect(text).toMatch(/Package manager\s+pnpm\s+pnpm-lock\.yaml/);
    expect(text).toMatch(/--framework react --build-tool vite --language ts --styling tailwind/);
    expect(text).toContain('supported');
    expect(plain(err.text)).toContain('Detection complete. Nothing was changed.');
  });

  it('defaults to the working directory', async () => {
    const dir = writeProject({ 'package.json': deps({ astro: '5' }) });
    const { logger, out } = testLogger();
    expect(await main(['detect'], { logger, cwd: dir })).toBe(0);
    expect(plain(out.text)).toMatch(/Directory\s+\./);
  });

  it('exits 0 for an unsupported project, and says why', async () => {
    const dir = writeProject({ 'package.json': deps({ vue: '3' }) });
    const { logger, out } = testLogger();
    expect(await main(['detect', dir], { logger })).toBe(0);
    expect(plain(out.text)).toContain('Vue (not supported)');
    expect(plain(out.text)).toContain('Vue is not a framework ClientKit supports.');
  });

  it('exits 2 for a directory that does not exist, or is a file', async () => {
    const dir = writeProject({ 'file.txt': 'x' });
    for (const target of [path.join(dir, 'missing'), path.join(dir, 'file.txt')]) {
      const { logger, err } = testLogger();
      expect(await main(['detect', target], { logger })).toBe(2);
      expect(plain(err.text)).toMatch(/does not exist|is not a directory/);
    }
  });

  it('refuses generation options rather than ignoring them', () => {
    const { logger } = testLogger();
    const flags = parseCliArgs(['detect', '.', '--framework', 'react', '--yes']);
    expect(() => runDetect({ flags, logger, cwd: process.cwd() })).toThrow(
      'detect does not take --framework, --yes.',
    );
  });

  it('is a typed command; ./detect still names a directory to create', () => {
    expect(parseCliArgs(['detect', './site'])).toMatchObject({
      command: 'detect',
      positionals: ['./site'],
    });
    expect(parseCliArgs(['./detect'])).toMatchObject({
      command: 'create',
      positionals: ['./detect'],
    });
  });
});
