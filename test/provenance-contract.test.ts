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
