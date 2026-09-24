import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import type { ProjectManifest } from '../src/domain/index.js';
import { PROVENANCE_FILE } from '../src/generate/provenance.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * What `.client-site.json` records, and what it therefore cannot answer.
 *
 * ## Why this file exists
 *
 * Stage 55 found that provenance is written and never read, and noted that a
 * future `upgrade` command would have the information it needs. Stage 56 set
 * out to write that command and found the second half of the sentence is not
 * true: provenance records *who* generated the project - CLI version, template,
 * mode, site identity, features - and nothing about the **stack**. No styling
 * system, no component library, no router, no architecture, no file list.
 *
 * The consequence is not subtle, and the second test below is the whole reason
 * Stage 56 stopped:
 *
 *     react + tailwind + mui + react-router
 *     react + bootstrap                        -> byte-identical provenance
 *
 * Those two projects differ by `AppProviders.tsx` and `AppRouter.tsx`. An
 * upgrade command reading only provenance cannot tell which of them it is
 * looking at, so it cannot say which files the old configuration generated, so
 * it cannot report "this file would no longer be generated" - the one thing
 * Stage 56 most needed it to say, and the one thing it must never guess at,
 * because the alternative reading of an unplanned file is that the developer
 * wrote it.
 *
 * These tests pin the fields as they are. They are expected to fail the day
 * someone adds the stack to provenance, which is exactly right: that change
 * moves the bytes of every generated project and therefore the V1 golden, and
 * it should not happen quietly.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);

const manifestFor = (over: Partial<ProjectManifest>): ProjectManifest =>
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
    site: {
      name: 'Acme Ltd',
      url: 'https://acme.example',
      description: 'Bespoke widgets.',
      locale: 'en',
      author: null,
    },
    packageManager: 'npm',
    git: false,
    install: false,
    ...over,
  }) as ProjectManifest;

const generate = (over: Partial<ProjectManifest>) =>
  planManifest(manifestFor(over), {
    registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: (over.starter ?? 'full') as 'coming-soon' | 'full',
  });

const provenanceOf = (over: Partial<ProjectManifest>): Record<string, unknown> => {
  const operation = generate(over).plan.operations.find((entry) => entry.path === PROVENANCE_FILE);
  if (operation?.type !== 'write') throw new Error('no provenance was written');
  return JSON.parse(operation.content) as Record<string, unknown>;
};

const filesOf = (over: Partial<ProjectManifest>): string[] =>
  generate(over)
    .plan.operations.map((entry) => entry.path)
    .sort();

describe('provenance records how a project was made', () => {
  it('is written by every generated project', () => {
    expect(filesOf({})).toContain(PROVENANCE_FILE);
  });

  it('records the generator, the template and the site, and exactly those', () => {
    const provenance = provenanceOf({});
    expect(Object.keys(provenance).sort()).toEqual([
      '$schema',
      'cliVersion',
      'config',
      'generatedAt',
      'mode',
      'template',
    ]);
    expect(Object.keys(provenance.config as object).sort()).toEqual([
      'features',
      'locale',
      'packageManager',
      'projectName',
      'siteName',
      'siteUrl',
    ]);
  });

  it('records no stack dimension at all', () => {
    /*
     * Not an oversight to be quietly filled in: this is the fact that blocked
     * Stage 56. Adding any of these changes the bytes of every generated
     * project, and the four V1 goldens with them.
     */
    const serialised = JSON.stringify(provenanceOf({ styling: 'bootstrap', uiLibrary: 'mui' }));
    for (const absent of ['styling', 'uiLibrary', 'router', 'architecture', 'buildTool']) {
      expect(serialised, `provenance now records ${absent}`).not.toContain(`"${absent}"`);
    }
    // And nothing records which files were generated.
    expect(serialised).not.toContain('"files"');
  });
});

describe('provenance cannot tell two stacks apart', () => {
  it('is identical for configurations that generate different files', () => {
    const rich = { styling: 'tailwind', uiLibrary: 'mui', router: 'react-router' } as const;
    const plain = { styling: 'bootstrap', uiLibrary: 'none', router: 'none' } as const;

    expect(provenanceOf(rich)).toEqual(provenanceOf(plain));

    const onlyInRich = filesOf(rich).filter((file) => !filesOf(plain).includes(file));
    expect(onlyInRich).toEqual(['src/components/ui/AppProviders.tsx', 'src/routes/AppRouter.tsx']);
  });

  it('leaves an upgrade unable to name what a new configuration would drop', () => {
    /*
     * Stated as the question an upgrade command would have to answer. Given the
     * provenance of the richer project and a request for the plainer one, the
     * two files above are what "would no longer be generated" - and nothing in
     * the recorded provenance distinguishes them from a file the developer
     * wrote. Until that changes, the only safe answer an upgrade can give is
     * to refuse.
     */
    const recorded = provenanceOf({
      styling: 'tailwind',
      uiLibrary: 'mui',
      router: 'react-router',
    });
    const everythingKnownAboutTheStack = [
      (recorded.template as { framework?: string }).framework,
      recorded.mode,
      (recorded.config as { features?: string[] }).features,
    ];
    expect(everythingKnownAboutTheStack).toEqual(['react', 'full', []]);
  });
});

// ---------------------------------------------------------------------------
// Ownership: who writes this file, and on whose behalf
// ---------------------------------------------------------------------------

describe('provenance is the generator writing about itself', () => {
  it('is the only operation the CLI claims as its own', () => {
    /*
     * The structural fact the Stage 57 decision rests on. Every other file in a
     * generated project comes from a template layer or an adapter and says so
     * in its origin - `base`, `base + modes/coming-soon`, `styling:tailwind`.
     * Exactly one carries `cli`, and it is this one: the project is what the
     * templates produced, and `.client-site.json` is ClientKit's note about
     * having produced it.
     */
    const operations = generate({}).plan.operations;
    const byCli = operations.filter((entry) => entry.origin === 'cli').map((entry) => entry.path);
    expect(byCli).toEqual([PROVENANCE_FILE]);
    expect(operations.length).toBeGreaterThan(15);
  });

  it('is synthesised rather than copied from a template', () => {
    // A template-shipped file arrives as a copy or carries a template origin.
    // This one is built in the planner, which is why no `templates/**` path
    // contains it and why its bytes are a function of the context alone.
    const operation = generate({}).plan.operations.find((entry) => entry.path === PROVENANCE_FILE);
    expect(operation?.type).toBe('write');
    expect(operation?.origin).toBe('cli');
  });

  it('records nothing about the machine that ran the generator', () => {
    // The allow-list its own doc comment describes: no environment, no
    // absolute paths, no credentials, no author.
    const serialised = JSON.stringify(provenanceOf({}));
    expect(serialised).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
    expect(serialised).not.toContain('author');
    expect(serialised).not.toContain('targetDir');
  });
});

describe('provenance serialisation is deterministic', () => {
  it('is byte-identical for the same inputs', () => {
    const first = generate({}).plan.operations.find((e) => e.path === PROVENANCE_FILE);
    const second = generate({}).plan.operations.find((e) => e.path === PROVENANCE_FILE);
    expect(first?.type === 'write' ? first.content : '').toBe(
      second?.type === 'write' ? second.content : '<none>',
    );
  });

  it('orders its keys the same way every time', () => {
    // Key order is part of the bytes, and the bytes are in a golden. Asserted
    // so a future reader can rely on the shape rather than on luck.
    const keys = (over: Partial<ProjectManifest>): string[] => Object.keys(provenanceOf(over));
    expect(keys({ styling: 'bootstrap' })).toEqual(keys({ uiLibrary: 'mui' }));
    expect(keys({})).toEqual([
      '$schema',
      'cliVersion',
      'template',
      'mode',
      'generatedAt',
      'config',
    ]);
  });

  it('varies only with the configuration it is a record of', () => {
    const base = provenanceOf({});
    expect(provenanceOf({ starter: 'coming-soon' })).not.toEqual(base);
    expect(
      provenanceOf({ features: ['client-route-fallback'], router: 'react-router' }),
    ).not.toEqual(base);
    // ...and not with the dimensions it does not record, which is the gap.
    expect(provenanceOf({ styling: 'bootstrap' })).toEqual(base);
  });
});
