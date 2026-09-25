import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAdapterRegistry } from '../src/adapters/registry.js';
import { describeTemplate } from '../src/adapters/template-identity.js';
import {
  planUpgrade,
  type RecordedConfiguration,
  type UpgradePlanOptions,
} from '../src/adapters/upgrade-plan.js';
import type { ProjectManifest } from '../src/domain/index.js';
import { planUpgradePaths } from '../src/domain/upgrade-paths.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { enumerateCombinations, type Combination } from './accepted-combinations.js';
import { TEST_CWD } from './helpers.js';

/**
 * What an upgrade would do to the file list, and what it refuses to claim.
 *
 * Stage 60 found an old plan cannot be rebuilt: the description and author are
 * not recorded, and `plan()` refuses without them. Stage 61 measured that this
 * does not matter for ownership, because the path set is a function of the
 * stack and mode alone - 104/104 stacks, every site field changed at once, file
 * list byte-identical. This planner is that measurement turned into a
 * mechanism.
 *
 * The distinction these tests defend is between *path membership* and *file
 * ownership*. `orphanCandidates` names paths the recorded configuration
 * produced and the current one does not. It does not name files ClientKit may
 * delete, and nothing here may grow into saying it does.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const v1Registry = createRegistry(TEMPLATES_ROOT);
const enumeration = enumerateCombinations(adapters);

const OPTIONS: UpgradePlanOptions = {
  adapters,
  plan: {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
  },
};

const BASE_SITE = {
  name: 'Acme Ltd',
  url: 'https://acme.example' as string | null,
  description: 'Bespoke widgets.',
  locale: 'en',
  author: null as string | null,
};

const manifestOf = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  ({
    targetDir: path.join(TEST_CWD, 'acme-site'),
    projectName: 'acme-site',
    framework: 'react',
    buildTool: 'vite',
    language: 'ts',
    styling: 'tailwind',
    uiLibrary: 'none',
    router: 'none',
    architecture: 'react-standard',
    starter: 'full',
    features: [],
    site: BASE_SITE,
    packageManager: 'npm',
    git: false,
    install: false,
    ...over,
  }) as ProjectManifest;

/** The provenance a project with this manifest would carry. */
const recordedOf = (manifest: ProjectManifest): RecordedConfiguration => ({
  stack: {
    framework: manifest.framework,
    buildTool: manifest.buildTool,
    language: manifest.language,
    styling: manifest.styling,
    uiLibrary: manifest.uiLibrary,
    router: manifest.router,
    architecture: manifest.architecture,
  },
  mode: manifest.starter,
  template: {
    id: describeTemplate(manifest.framework, adapters).identity.id,
    framework: describeTemplate(manifest.framework, adapters).identity.framework,
  },
});

/** Plan an upgrade between two manifests, insisting it was not refused. */
const between = (before: ProjectManifest, after: ProjectManifest) => {
  const result = planUpgrade(recordedOf(before), after, OPTIONS);
  if (result.status !== 'planned') throw new Error(`refused: ${result.because}`);
  return result.paths;
};

const manifestFor = (combination: Combination): ProjectManifest =>
  manifestOf({
    framework: combination.framework as never,
    buildTool: combination.buildTool as never,
    language: combination.language as never,
    styling: combination.styling as never,
    uiLibrary: combination.uiLibrary as never,
    router: combination.router as never,
    architecture: combination.architecture as never,
    starter: combination.starter as never,
    features: combination.features as never,
  });

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe('the set arithmetic is exactly what it says', () => {
  it('splits two sets into intersection and both differences', () => {
    const result = planUpgradePaths(['b', 'a', 'gone'], ['a', 'b', 'new']);
    expect(result.unchanged).toEqual(['a', 'b']);
    expect(result.added).toEqual(['new']);
    expect(result.orphanCandidates).toEqual(['gone']);
  });

  it('does not confuse the two directions', () => {
    // The mutation that matters most: swapping these silently turns "we would
    // add this" into "this is no longer generated".
    const result = planUpgradePaths(['only-old'], ['only-current']);
    expect(result.orphanCandidates).toEqual(['only-old']);
    expect(result.added).toEqual(['only-current']);
  });

  it('treats a path set as a set', () => {
    const result = planUpgradePaths(['a', 'a', 'a'], ['a', 'a']);
    expect(result.oldPaths).toEqual(['a']);
    expect(result.currentPaths).toEqual(['a']);
    expect(result.unchanged).toEqual(['a']);
  });

  it('orders every array the same way whatever order it was given', () => {
    const forwards = planUpgradePaths(['a', 'b', 'c'], ['c', 'b', 'z']);
    const backwards = planUpgradePaths(['c', 'b', 'a'], ['z', 'b', 'c']);
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });

  it('sorts by code unit, not by locale', () => {
    // localeCompare would reorder these under a different ICU build, and a
    // file list that reorders by machine is not a plan anyone can review.
    const result = planUpgradePaths(['B', 'a', 'A', 'b'], []);
    expect(result.oldPaths).toEqual(['A', 'B', 'a', 'b']);
  });

  it('says nothing about deletion or ownership', () => {
    const result = planUpgradePaths(['gone'], []);
    for (const forbidden of ['deletable', 'owned', 'safeToRemove', 'delete', 'clientkitOwned']) {
      expect(result).not.toHaveProperty(forbidden);
    }
    expect(Object.keys(result).sort()).toEqual([
      'added',
      'currentPaths',
      'oldPaths',
      'orphanCandidates',
      'unchanged',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Nothing changed
// ---------------------------------------------------------------------------

describe('an unchanged configuration plans no change', () => {
  it('reports every path unchanged and nothing else', () => {
    const manifest = manifestOf();
    const result = between(manifest, manifest);
    expect(result.added).toEqual([]);
    expect(result.orphanCandidates).toEqual([]);
    expect(result.unchanged).toEqual(result.currentPaths);
    expect(result.oldPaths).toEqual(result.currentPaths);
  });

  it('invents no duplicates', () => {
    const result = between(manifestOf(), manifestOf());
    expect(new Set(result.currentPaths).size).toBe(result.currentPaths.length);
  });

  /*
   * A generous budget, not a slow test excused.
   *
   * This plans all 104 supported combinations. On an idle machine it takes
   * one to three seconds; under load - a mutation campaign, an integration
   * matrix - it crosses the 5s default and fails on time rather than on an
   * assertion. That made the release gate flaky, which is worse than slow:
   * it teaches people to re-run until green. The assertion is unchanged.
   */
  it('holds for every accepted stack', { timeout: 60_000 }, () => {
    const wrong: string[] = [];
    for (const combination of enumeration.accepted) {
      const manifest = manifestFor(combination);
      const result = between(manifest, manifest);
      if (result.added.length > 0 || result.orphanCandidates.length > 0) wrong.push(combination.id);
    }
    expect(wrong).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Site fields must never move a path
// ---------------------------------------------------------------------------

describe('the path set does not depend on site configuration', () => {
  it(
    'is identical when every site field changes, across all accepted stacks',
    { timeout: 60_000 },
    () => {
      /*
       * Stage 61's measurement, kept as a regression. The upgrade contract rests
       * on it: if a template ever branched on `{{locale}}` to emit a different
       * file, ownership would start depending on prose and this planner would
       * report a stranger's edits as orphans.
       */
      const variant = {
        projectName: 'totally-different',
        site: {
          name: 'Zenith Industries',
          url: null,
          description: 'An entirely unrelated sentence about something else.',
          locale: 'fr',
          author: 'Jane Doe',
        },
        packageManager: 'pnpm',
      };

      const differing: string[] = [];
      for (const combination of enumeration.accepted) {
        const before = manifestFor(combination);
        const after = manifestOf({ ...before, ...variant } as Partial<ProjectManifest>);
        const result = between(before, after);
        if (result.added.length > 0 || result.orphanCandidates.length > 0) {
          differing.push(combination.id);
        }
      }
      expect(differing).toEqual([]);
    },
  );

  it('covers the whole accepted matrix rather than one representative', () => {
    expect(enumeration.accepted.length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Stack changes must move paths
// ---------------------------------------------------------------------------

describe('the path set does depend on the stack', () => {
  const react = (over: Partial<ProjectManifest>) => manifestOf(over);

  it('identifies exactly the files a MUI and router removal strands', () => {
    /*
     * The Stage 55 case, measured on disk at the time: React + MUI + React
     * Router re-generated without either leaves two files importing packages
     * that are no longer installed, and `tsc --noEmit` fails with two TS2307s.
     * Detected here with no historical bytes, because both plans render
     * against the same current templates and the difference is attributable to
     * the stack change alone.
     */
    const result = between(
      react({ uiLibrary: 'mui', router: 'react-router' }),
      react({ uiLibrary: 'none', router: 'none' }),
    );
    expect(result.orphanCandidates).toEqual([
      'src/components/ui/AppProviders.tsx',
      'src/routes/AppRouter.tsx',
    ]);
    expect(result.added).toEqual([]);
  });

  it('reports a UI library removal alone', () => {
    const result = between(react({ uiLibrary: 'mui' }), react({ uiLibrary: 'none' }));
    expect(result.orphanCandidates).toEqual(['src/components/ui/AppProviders.tsx']);
  });

  it('reports a router removal alone', () => {
    const result = between(react({ router: 'react-router' }), react({ router: 'none' }));
    expect(result.orphanCandidates).toEqual(['src/routes/AppRouter.tsx']);
  });

  it('reports an addition as added, not as an orphan', () => {
    const result = between(react({ uiLibrary: 'none' }), react({ uiLibrary: 'mui' }));
    expect(result.added).toEqual(['src/components/ui/AppProviders.tsx']);
    expect(result.orphanCandidates).toEqual([]);
  });

  it('handles the MUI and router stack moving to Bootstrap', () => {
    // Stage 63's named scenario: both a removal and a styling change at once.
    const result = between(
      react({ styling: 'tailwind', uiLibrary: 'mui', router: 'react-router' }),
      react({ styling: 'bootstrap', uiLibrary: 'none', router: 'none' }),
    );
    expect(result.orphanCandidates).toEqual([
      'src/components/ui/AppProviders.tsx',
      'src/routes/AppRouter.tsx',
    ]);
    // A styling swap changes content rather than the file list, which is
    // exactly the kind of difference this layer must not report.
    expect(result.added).toEqual([]);
  });

  it('produces more than one distinct path set across the matrix', { timeout: 60_000 }, () => {
    const sets = new Set(
      enumeration.accepted.map((combination) =>
        between(manifestFor(combination), manifestFor(combination)).currentPaths.join('\n'),
      ),
    );
    expect(sets.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Mode is part of the configuration
// ---------------------------------------------------------------------------

describe('the path set depends on the mode as well as the stack', () => {
  /*
   * Measured rather than assumed: of the three frameworks, only Next moves a
   * path between modes. Astro and React ship the same file list for
   * coming-soon and full and differ in content, which is why the contract is
   * `pathSet = f(stack, mode)` and not `f(stack)` - one framework is enough to
   * make dropping the mode a defect, and a test using React would have passed
   * for the wrong reason.
   */
  const next = (starter: 'coming-soon' | 'full') =>
    manifestOf({
      framework: 'nextjs' as never,
      buildTool: 'next' as never,
      router: 'file-based' as never,
      architecture: 'next-app' as never,
      starter,
    });

  it('adds the file the fuller mode brings with it', () => {
    const result = between(next('coming-soon'), next('full'));
    expect(result.added).toEqual(['components/ui/Section.tsx']);
    expect(result.orphanCandidates).toEqual([]);
  });

  it('reports the same file as an orphan candidate in the other direction', () => {
    const result = between(next('full'), next('coming-soon'));
    expect(result.orphanCandidates).toEqual(['components/ui/Section.tsx']);
    expect(result.added).toEqual([]);
  });

  it('uses the recorded mode for the old plan, not the current one', () => {
    /*
     * The mutation this defends against is dropping `mode` when rebuilding the
     * recorded configuration. If that happened, coming-soon -> full would
     * compare full against full and report no difference at all.
     */
    const changed = between(next('coming-soon'), next('full'));
    const unchanged = between(next('full'), next('full'));
    expect(changed.oldPaths).not.toEqual(unchanged.oldPaths);
    expect(changed.added).not.toEqual(unchanged.added);
  });

  it('notes which frameworks are insensitive to mode, so the test is not vacuous', () => {
    // If Astro or React ever started moving a path between modes this would
    // fail, which is the point: the measurement above would be stale.
    for (const manifest of [
      manifestOf({ starter: 'coming-soon' }),
      manifestOf({
        framework: 'astro' as never,
        buildTool: 'astro' as never,
        router: 'file-based' as never,
        architecture: 'astro-standard' as never,
        starter: 'coming-soon',
      }),
    ]) {
      const full = manifestOf({ ...manifest, starter: 'full' } as Partial<ProjectManifest>);
      const result = between(manifest, full);
      expect(result.added).toEqual([]);
      expect(result.orphanCandidates).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Every framework, through one abstraction
// ---------------------------------------------------------------------------

describe('every framework plans through the same path', () => {
  const stacks = {
    astro: manifestOf({
      framework: 'astro' as never,
      buildTool: 'astro' as never,
      router: 'file-based' as never,
      architecture: 'astro-standard' as never,
    }),
    react: manifestOf(),
    nextjs: manifestOf({
      framework: 'nextjs' as never,
      buildTool: 'next' as never,
      router: 'file-based' as never,
      architecture: 'next-app' as never,
    }),
  };

  it.each(Object.keys(stacks) as (keyof typeof stacks)[])('plans %s', (framework) => {
    const result = between(stacks[framework], stacks[framework]);
    expect(result.currentPaths.length).toBeGreaterThan(0);
    expect(result.added).toEqual([]);
    expect(result.orphanCandidates).toEqual([]);
  });

  it('gives each framework a different file list', () => {
    const lists = Object.values(stacks).map((manifest) =>
      between(manifest, manifest).currentPaths.join('\n'),
    );
    expect(new Set(lists).size).toBe(lists.length);
  });

  it('plans a change of framework from the recorded stack', () => {
    /*
     * The transition the current configuration model does represent: the
     * recorded stack names one framework and the requested one names another.
     * Both plans still render against today's templates, so the whole
     * difference is attributable to the framework change.
     *
     * This is also what proves the recorded *stack* is being used rather than
     * the current one. Every other scenario here varies a dimension within one
     * framework, so a planner that quietly substituted the current framework
     * would pass all of them.
     */
    const result = between(stacks.astro, stacks.react);

    expect(result.oldPaths).toEqual(between(stacks.astro, stacks.astro).currentPaths);
    expect(result.currentPaths).toEqual(between(stacks.react, stacks.react).currentPaths);
    expect(result.orphanCandidates.length).toBeGreaterThan(0);
    expect(result.added.length).toBeGreaterThan(0);

    // Astro's pages are .astro files; React's are .tsx. Neither survives into
    // the other's plan, so each appears on exactly one side.
    expect(result.orphanCandidates.some((p) => p.endsWith('.astro'))).toBe(true);
    expect(result.added.some((p) => p.endsWith('.tsx'))).toBe(true);
    expect(result.orphanCandidates.some((p) => p.endsWith('.tsx'))).toBe(false);
  });

  it('plans a framework change in the other direction too', () => {
    const forwards = between(stacks.astro, stacks.nextjs);
    const backwards = between(stacks.nextjs, stacks.astro);
    // The two directions must mirror each other exactly.
    expect(forwards.added).toEqual(backwards.orphanCandidates);
    expect(forwards.orphanCandidates).toEqual(backwards.added);
  });
});

// ---------------------------------------------------------------------------
// The provenance gate
// ---------------------------------------------------------------------------

describe('planning refuses a document it cannot trust', () => {
  const recorded = recordedOf(manifestOf());

  it('plans a document ClientKit itself would have written', () => {
    expect(planUpgrade(recorded, manifestOf(), OPTIONS).status).toBe('planned');
  });

  it('refuses a template belonging to another framework', () => {
    const result = planUpgrade(
      { ...recorded, template: { ...recorded.template, id: 'astro-tailwind' } },
      manifestOf(),
      OPTIONS,
    );
    expect(result.status).toBe('refused');
    expect(result.status === 'refused' ? result.reason : '').toBe('unknown-template');
  });

  it('refuses a template block that contradicts the stack', () => {
    const result = planUpgrade(
      { ...recorded, template: { ...recorded.template, framework: 'astro' } },
      manifestOf(),
      OPTIONS,
    );
    expect(result.status).toBe('refused');
    expect(result.status === 'refused' ? result.reason : '').toBe('framework-mismatch');
  });

  it('refuses an unsupported framework', () => {
    const result = planUpgrade(
      {
        ...recorded,
        stack: { ...recorded.stack, framework: 'angular' as never },
        template: { id: 'angular', framework: 'angular' },
      },
      manifestOf(),
      OPTIONS,
    );
    expect(result.status).toBe('refused');
    expect(result.status === 'refused' ? result.reason : '').toBe('unknown-framework');
  });

  it('refuses malformed identity rather than planning around it', () => {
    const result = planUpgrade(
      { ...recorded, template: { id: '' as never, framework: 'react' } },
      manifestOf(),
      OPTIONS,
    );
    expect(result.status).toBe('refused');
    expect(result.status === 'refused' ? result.reason : '').toBe('malformed');
  });

  it('returns no paths at all when it refuses', () => {
    // A refusal must not be mistakable for "nothing would change".
    const result = planUpgrade(
      { ...recorded, template: { ...recorded.template, id: 'astro-tailwind' } },
      manifestOf(),
      OPTIONS,
    );
    expect(result).not.toHaveProperty('paths');
  });

  it('explains the real reason rather than reporting an orphan', () => {
    const result = planUpgrade(
      { ...recorded, template: { ...recorded.template, framework: 'astro' } },
      manifestOf(),
      OPTIONS,
    );
    const because = result.status === 'refused' ? result.because : '';
    expect(because).toContain('stack');
    expect(because.toLowerCase()).not.toContain('orphan');
  });
});

// ---------------------------------------------------------------------------
// Determinism and purity
// ---------------------------------------------------------------------------

describe('the planner is deterministic and touches nothing', () => {
  it('produces byte-identical results for the same inputs', () => {
    const before = manifestOf({ uiLibrary: 'mui' });
    const after = manifestOf({ uiLibrary: 'none' });
    expect(JSON.stringify(between(before, after))).toBe(JSON.stringify(between(before, after)));
  });

  it('does not vary with the timestamp or the CLI version', () => {
    const before = manifestOf({ uiLibrary: 'mui' });
    const after = manifestOf({ uiLibrary: 'none' });
    const other: UpgradePlanOptions = {
      adapters,
      plan: {
        registry: v1Registry,
        cliVersion: '1.2.3',
        generatedAt: '2031-07-04T10:11:12.000Z',
      },
    };
    const one = planUpgrade(recordedOf(before), after, OPTIONS);
    const two = planUpgrade(recordedOf(before), after, other);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it('carries no timestamp, absolute path or machine detail in its result', () => {
    const serialised = JSON.stringify(between(manifestOf({ uiLibrary: 'mui' }), manifestOf()));
    expect(serialised).not.toContain(TEST_CWD.replace(/\\/g, '\\\\'));
    expect(serialised).not.toContain('2026-01-01');
    expect(serialised).not.toContain('9.9.9');
    expect(serialised).not.toContain(':\\');
  });

  it('emits POSIX paths, so a Windows run matches a Linux one', () => {
    const result = between(manifestOf(), manifestOf());
    for (const generated of result.currentPaths) {
      expect(generated, `${generated} is not POSIX`).not.toContain('\\');
    }
  });

  it('keeps the set arithmetic free of the filesystem', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'upgrade-paths.ts'),
      'utf8',
    );
    for (const forbidden of ['node:fs', 'node:child_process', 'readFileSync', 'existsSync']) {
      expect(source, `upgrade-paths.ts reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never writes, deletes or copies from the composing layer either', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'upgrade-plan.ts'),
      'utf8',
    );
    for (const forbidden of [
      'writeFileSync',
      'rmSync',
      'unlinkSync',
      'mkdirSync',
      'node:child_process',
      'execSync',
    ]) {
      expect(source, `upgrade-plan.ts reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('names no framework in the generic planning layer', () => {
    // Framework-specific behaviour belongs in the adapters, which is what
    // Stage 62's identity contract made possible.
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'upgrade-plan.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const framework of ["'astro'", "'react'", "'nextjs'"]) {
      expect(source, `upgrade-plan.ts branches on ${framework}`).not.toContain(framework);
    }
  });
});
