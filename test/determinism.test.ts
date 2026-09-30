import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyMerges,
  contributedFiles,
  layersFrom,
  planManifest,
  resolveWithAdapters,
} from '../src/adapters/bridge.js';
import { createAdapterRegistry, type AdapterRegistry } from '../src/adapters/registry.js';
import { createTemplateCatalog } from '../src/adapters/template-catalog.js';
import { parseCliArgs } from '../src/args.js';
import { NonInteractivePrompter } from '../src/context/prompts.js';
import { resolveContext } from '../src/context/resolve.js';
import type { ProjectManifest } from '../src/domain/manifest.js';
import type { GenerationPlan } from '../src/generate/files.js';
import { planPostSteps } from '../src/generate/postSteps.js';
import { realPlanFs, type PlanFs } from '../src/generate/plan.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { validateTemplate } from '../src/templates/validation.js';
import { compareText } from '../src/util/order.js';
import { emptyFs, TEST_CWD } from './helpers.js';

/**
 * Stage 6: deterministic generation.
 *
 * The Generation Plan is the boundary: the same inputs give the same plan -
 * operations, order, sources, destinations and bytes - whatever order the
 * filesystem lists a directory in, whatever the machine's locale, wherever
 * the command is run from. Everything here compares plans directly.
 *
 * Fresh processes and the packed package are compared in `scripts/smoke.mjs`,
 * which runs the built CLI; this suite runs the source.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const registry = createRegistry(TEMPLATES_ROOT);

const NOW = '2026-01-01T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A spread of stacks: all three frameworks, each mode, and the composition-heavy ones. */
const STACKS: readonly (readonly string[])[] = [
  [],
  ['--mode', 'full'],
  ['--framework', 'astro', '--features', 'seo,structured-data,accessibility,not-found'],
  ['--preset', 'react-tailwind'],
  [
    '--framework',
    'react',
    '--styling',
    'bootstrap',
    '--ui-library',
    'mui',
    '--router',
    'react-router',
    '--features',
    'client-route-fallback',
    '--mode',
    'full',
  ],
  ['--preset', 'nextjs-tailwind', '--mode', 'full'],
  ['--framework', 'nextjs', '--ui-library', 'chakra', '--features', 'seo,not-found'],
];

async function resolved(
  argv: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return resolveContext({
    flags: parseCliArgs(['acme-site', '--yes', ...argv]),
    cwd: options.cwd ?? TEST_CWD,
    env: options.env ?? {},
    prompter: new NonInteractivePrompter('test'),
    registry,
    cliVersion: '9.9.9',
    now: new Date(NOW),
    templatesRoot: TEMPLATES_ROOT,
    fs: emptyFs,
  });
}

async function planOf(
  argv: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; fs?: PlanFs; now?: string } = {},
): Promise<GenerationPlan> {
  const resolution = await resolved(argv, options);
  return planManifest(resolution.manifest, {
    registry,
    cliVersion: '9.9.9',
    generatedAt: options.now ?? NOW,
    mode: resolution.context.template.mode,
    templateId: resolution.context.template.id,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  }).plan;
}

/** A filesystem listing every directory backwards. */
const reversedFs: PlanFs = {
  ...realPlanFs,
  readDir: (dir) => [...realPlanFs.readDir(dir)].reverse(),
};

/** A filesystem listing every directory in an order unrelated to its names. */
const rotatedFs: PlanFs = {
  ...realPlanFs,
  readDir: (dir) => {
    const entries = [...realPlanFs.readDir(dir)];
    return [
      ...entries.slice(Math.floor(entries.length / 2)),
      ...entries.slice(0, Math.floor(entries.length / 2)),
    ];
  },
};

/** Every locale-default comparison answers as Turkish would. */
function turkish(): void {
  const tr = new Intl.Collator('tr');
  const RealCollator = Intl.Collator;
  vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
    this: string,
    that: string,
  ) {
    return tr.compare(String(this), that);
  });
  vi.spyOn(Intl, 'Collator').mockImplementation(
    ((locales?: string | string[], options?: Intl.CollatorOptions) =>
      new RealCollator(locales ?? 'tr', options)) as unknown as typeof Intl.Collator,
  );
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('the same inputs give the same plan', () => {
  for (const argv of STACKS) {
    it(`repeatedly, with no state carried between calls: ${argv.join(' ') || '(defaults)'}`, async () => {
      const first = await planOf(argv);
      for (let run = 0; run < 5; run += 1) expect(await planOf(argv)).toEqual(first);
    });
  }

  it('interleaved with other stacks, so no call is shaped by the one before it', async () => {
    const baseline = await Promise.all(STACKS.map((argv) => planOf(argv)));
    const shuffled = [...STACKS.keys()].reverse();
    for (const index of shuffled) {
      expect(await planOf(STACKS[index] as string[])).toEqual(baseline[index]);
    }
  });
});

// ---------------------------------------------------------------------------
// Enumeration order
// ---------------------------------------------------------------------------

describe('the order a filesystem lists directories in changes nothing', () => {
  for (const argv of STACKS) {
    it(`reversed and rotated listings: ${argv.join(' ') || '(defaults)'}`, async () => {
      const normal = await planOf(argv);
      expect(await planOf(argv, { fs: reversedFs })).toEqual(normal);
      expect(await planOf(argv, { fs: rotatedFs })).toEqual(normal);
    });
  }

  it('template validation reports the same result for reversed listings', () => {
    for (const definition of createTemplateCatalog(adapters, TEMPLATES_ROOT).list()) {
      expect(validateTemplate(definition, { fs: reversedFs })).toEqual(
        validateTemplate(definition),
      );
    }
  });
});

describe('the order adapters and frameworks are enumerated in changes nothing', () => {
  const reversedRegistry: AdapterRegistry = {
    ...adapters,
    implementedFrameworks: () => [...adapters.implementedFrameworks()].reverse(),
    implementedStyling: () => [...adapters.implementedStyling()].reverse(),
    implementedUiLibraries: () => [...adapters.implementedUiLibraries()].reverse(),
    implementedRouters: () => [...adapters.implementedRouters()].reverse(),
    implementedFeatures: () => [...adapters.implementedFeatures()].reverse(),
  };

  it('builds the same catalog', () => {
    const normal = createTemplateCatalog(adapters, TEMPLATES_ROOT);
    const reversed = createTemplateCatalog(reversedRegistry, TEMPLATES_ROOT);
    expect(reversed.list()).toEqual(normal.list());
    for (const framework of ['astro', 'react', 'nextjs'] as const) {
      expect(reversed.resolve({ framework, mode: 'full' })).toEqual(
        normal.resolve({ framework, mode: 'full' }),
      );
    }
  });

  it('orders layers, contributed files and merges the same from reversed contributions', async () => {
    for (const argv of STACKS) {
      const { manifest } = await resolved(argv);
      const { project, contributions } = resolveWithAdapters(
        manifest as ProjectManifest,
        TEMPLATES_ROOT,
      );
      const reversed = [...contributions].reverse();

      expect(layersFrom(reversed), argv.join(' ')).toEqual(layersFrom(contributions));

      const read = realPlanFs.readText;
      const files = contributedFiles(project, contributions, read);
      expect(contributedFiles(project, reversed, read), argv.join(' ')).toEqual(files);
      expect(applyMerges(project, reversed, files), argv.join(' ')).toEqual(
        applyMerges(project, contributions, files),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

describe('the machine locale changes nothing', () => {
  it('the stub is real: Turkish collation orders differently from English', () => {
    const words = ['ı', 'i', 'I', 'İ', 'h', 'j'];
    const en = [...words].sort(new Intl.Collator('en').compare);
    const tr = [...words].sort(new Intl.Collator('tr').compare);
    expect(tr).not.toEqual(en);
  });

  for (const argv of STACKS) {
    it(`gives the same plan under a Turkish default locale: ${argv.join(' ') || '(defaults)'}`, async () => {
      const normal = await planOf(argv);
      turkish();
      expect(await planOf(argv)).toEqual(normal);
    });
  }

  it('gives the same plan when locale-default comparison is unavailable', async () => {
    const normal = await Promise.all(STACKS.map((argv) => planOf(argv)));
    vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('localeCompare used during generation');
    });
    for (const [index, argv] of STACKS.entries()) {
      expect(await planOf(argv)).toEqual(normal[index]);
    }
  });

  it('orders through one pinned comparator', () => {
    turkish();
    // A default Collator now answers in Turkish; the shared one does not.
    expect(['i', 'ı'].sort(compareText)).toEqual(['i', 'ı'].sort(new Intl.Collator('en').compare));
  });
});

// ---------------------------------------------------------------------------
// Paths and the working directory
// ---------------------------------------------------------------------------

describe('paths and the working directory', () => {
  const root = path.parse(process.cwd()).root;
  const parent = path.join(root, 'ck-det', 'clients');

  const planAt = (target: string, cwd: string) =>
    resolveContext({
      flags: parseCliArgs([target, '--yes']),
      cwd,
      env: {},
      prompter: new NonInteractivePrompter('test'),
      registry,
      cliVersion: '9.9.9',
      now: new Date(NOW),
      templatesRoot: TEMPLATES_ROOT,
      fs: emptyFs,
    }).then(
      (resolution) =>
        planManifest(resolution.manifest, {
          registry,
          cliVersion: '9.9.9',
          generatedAt: NOW,
          mode: resolution.context.template.mode,
          templateId: resolution.context.template.id,
        }).plan,
    );

  it('resolves relative, absolute and redundant spellings of one target identically', async () => {
    const absolute = await planAt(path.join(parent, 'acme'), path.join(root, 'elsewhere'));
    for (const [target, cwd] of [
      ['acme', parent],
      ['./acme', parent],
      ['acme/', parent],
      [path.join('clients', 'acme'), path.join(root, 'ck-det')],
      [path.join('..', 'clients', 'acme'), path.join(parent, '..', 'other')],
      [path.join('x', '..', 'acme'), parent],
    ] as const) {
      expect(await planAt(target, cwd), `${target} from ${cwd}`).toEqual(absolute);
    }
  });

  it('accepts either separator on Windows for the same target', async () => {
    if (process.platform !== 'win32') return;
    const cwd = path.join(root, 'ck-det');
    expect(await planAt('clients\\acme', cwd)).toEqual(await planAt('clients/acme', cwd));
  });

  it('never writes the caller’s location into a generated file', async () => {
    const here = await planAt('acme', path.join(root, 'ck-det', 'one'));
    const there = await planAt('acme', path.join(root, 'ck-det', 'two', 'deeper'));
    expect(here.targetDir).not.toBe(there.targetDir);
    // Only the target differs; every operation - path, type, content - is equal.
    expect(there.operations).toEqual(here.operations);
    for (const operation of here.operations) {
      if (operation.type !== 'write') continue;
      expect(operation.content, operation.path).not.toContain('ck-det');
    }
  });
});

// ---------------------------------------------------------------------------
// Time, environment and randomness
// ---------------------------------------------------------------------------

describe('time, environment and randomness', () => {
  it('lets the generation time reach only generatedAt in .client-site.json', async () => {
    const earlier = await planOf([], { now: '2026-01-01T00:00:00.000Z' });
    const later = await planOf([], { now: '2031-07-15T12:34:56.789Z' });
    const differing = later.operations.filter(
      (operation, index) => JSON.stringify(operation) !== JSON.stringify(earlier.operations[index]),
    );
    expect(differing.map((operation) => operation.path)).toEqual(['.client-site.json']);
    const parse = (plan: GenerationPlan) => {
      const operation = plan.operations.find((entry) => entry.path === '.client-site.json');
      return JSON.parse(operation?.type === 'write' ? operation.content : '{}') as Record<
        string,
        unknown
      >;
    };
    const { generatedAt: a, ...restEarlier } = parse(earlier);
    const { generatedAt: b, ...restLater } = parse(later);
    expect([a, b]).toEqual(['2026-01-01T00:00:00.000Z', '2031-07-15T12:34:56.789Z']);
    expect(restLater).toEqual(restEarlier);
  });

  it('ignores incidental environment: user, home, shell, locale, time zone', async () => {
    const quiet = await planOf(STACKS[4] as string[], { env: {} });
    const busy = await planOf(STACKS[4] as string[], {
      env: {
        USER: 'someone',
        USERNAME: 'someone',
        HOME: '/home/someone',
        USERPROFILE: 'C:\\Users\\someone',
        SHELL: '/bin/zsh',
        LANG: 'tr_TR.UTF-8',
        LC_ALL: 'tr_TR.UTF-8',
        TZ: 'Pacific/Kiritimati',
        CI: 'true',
      },
    });
    expect(busy).toEqual(quiet);
  });

  it('reads one environment variable, and only into the package manager it names', async () => {
    const npm = await planOf([], { env: { npm_config_user_agent: 'npm/10.9.0 node/v22.12.0' } });
    const pnpm = await planOf([], {
      env: { npm_config_user_agent: 'pnpm/9.15.0 npm/? node/v22.12.0' },
    });
    const differing = pnpm.operations.filter(
      (operation, index) => JSON.stringify(operation) !== JSON.stringify(npm.operations[index]),
    );
    expect(differing.map((operation) => operation.path)).toEqual(['.client-site.json']);
    const content = differing[0]?.type === 'write' ? differing[0].content : '';
    expect(JSON.parse(content).config.packageManager).toBe('pnpm');
    // --pm is the explicit form, and beats the environment.
    expect(
      await planOf(['--pm', 'npm'], { env: { npm_config_user_agent: 'pnpm/9.15.0' } }),
    ).toEqual(npm);
  });

  it('contains no random value: two plans of one input are byte-equal', async () => {
    for (const argv of STACKS) {
      expect(JSON.stringify(await planOf(argv))).toBe(JSON.stringify(await planOf(argv)));
    }
  });
});

// ---------------------------------------------------------------------------
// CLI inputs, metadata and post steps
// ---------------------------------------------------------------------------

describe('equivalent inputs resolve to one plan', () => {
  it.each([
    [[], ['--framework', 'astro', '--styling', 'tailwind', '--mode', 'coming-soon']],
    [
      ['--features', 'seo,accessibility'],
      ['--features', 'accessibility', '--features', 'seo'],
    ],
    [
      ['--features', 'seo,accessibility'],
      ['--features', ' accessibility , seo '],
    ],
    [
      ['--preset', 'react-tailwind'],
      ['--framework', 'react', '--styling', 'tailwind'],
    ],
    [
      ['--framework', 'react', '--language', 'ts'],
      ['--framework', 'react', '--language', 'typescript'],
    ],
  ])('%j equals %j', async (implicit, explicit) => {
    expect(await planOf(explicit)).toEqual(await planOf(implicit));
  });
});

describe('generated metadata comes from the resolved stack alone', () => {
  it('records the stack, template, mode and features the plan was built from', async () => {
    const resolution = await resolved(STACKS[4] as string[]);
    const plan = await planOf(STACKS[4] as string[]);
    const operation = plan.operations.find((entry) => entry.path === '.client-site.json');
    const record = JSON.parse(operation?.type === 'write' ? operation.content : '{}');
    const { manifest } = resolution;
    expect(record.stack).toEqual({
      framework: manifest.framework,
      buildTool: manifest.buildTool,
      language: manifest.language,
      styling: manifest.styling,
      uiLibrary: manifest.uiLibrary,
      router: manifest.router,
      architecture: manifest.architecture,
    });
    expect(record.template).toMatchObject({ id: plan.templateId, version: plan.templateVersion });
    expect(record.mode).toBe(plan.mode);
    expect(record.config.features).toEqual([...manifest.features].sort());
    // An allow-list: no path, no environment.
    expect(JSON.stringify(record)).not.toMatch(/ck-test|ck-det|[A-Z]:\\|\/home\//);
  });
});

describe('post steps', () => {
  it('are planned in the order the template declares, every time', async () => {
    const { context } = await resolved(['--pm', 'pnpm']);
    const first = planPostSteps(context, ['install', 'git-init']);
    for (let run = 0; run < 5; run += 1) {
      expect(planPostSteps(context, ['install', 'git-init'])).toEqual(first);
    }
    expect(first).toEqual([
      { step: 'install', command: ['pnpm', 'install'] },
      { step: 'git-init', command: ['git', 'init', '--quiet'] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The audit, kept
// ---------------------------------------------------------------------------

describe('ordering stays pinned', () => {
  it('has no locale-default comparison anywhere in src, and one collator', () => {
    const offenders: string[] = [];
    const srcDir = path.resolve(import.meta.dirname, '..', 'src');
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const relative = path.relative(srcDir, full).split(path.sep).join('/');
        readFileSync(full, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            const code = line.trim();
            if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
            const bare = /\.localeCompare\(/.test(code);
            const collator = /Intl\.Collator\(/.test(code) && relative !== 'util/order.ts';
            if (bare || collator) offenders.push(`${relative}:${index + 1}: ${code}`);
          });
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
