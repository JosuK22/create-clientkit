import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import type { ProjectManifest } from '../src/domain/index.js';
import { PROVENANCE_FILE } from '../src/generate/provenance.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * What `.client-site.json` records, and what it can therefore answer.
 *
 * ## The history this file carries
 *
 * Stage 55 found provenance was written and never read. Stage 56 tried to write
 * an upgrade command against it and could not: it recorded who generated a
 * project - CLI version, template, mode, site, features - and nothing about the
 * **stack**, so two configurations that generate different files produced
 * byte-identical documents. Stage 57 decided what the file is: ClientKit-owned
 * generator metadata, additively evolvable, not immutable V1 template output.
 *
 * Stage 58 is the change that decision sanctioned. The stack is recorded now,
 * and the tests that used to pin its absence pin its presence instead - which
 * is the point of having written them that way round.
 *
 * Everything else is unchanged and asserted to be: the existing fields, their
 * order, the allow-list that keeps machine-specific data out, and the fact that
 * this is the one file in a generated project the CLI writes about itself.
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
    // Astro's template lives in the V1 disk registry under its V1 name; React
    // and Next declare their own on the adapter.
    ...(over.framework === 'astro' ? { templateId: 'astro-tailwind' } : {}),
  });

interface RecordedStack {
  framework: string;
  buildTool: string;
  language: string;
  styling: string;
  uiLibrary: string;
  router: string;
  architecture: string;
}

const provenanceOf = (over: Partial<ProjectManifest>): Record<string, unknown> => {
  const operation = generate(over).plan.operations.find((entry) => entry.path === PROVENANCE_FILE);
  if (operation?.type !== 'write') throw new Error('no provenance was written');
  return JSON.parse(operation.content) as Record<string, unknown>;
};

const stackOf = (over: Partial<ProjectManifest>): RecordedStack =>
  provenanceOf(over).stack as RecordedStack;

const filesOf = (over: Partial<ProjectManifest>): string[] =>
  generate(over)
    .plan.operations.map((entry) => entry.path)
    .sort();

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

describe('provenance records how a project was made', () => {
  it('is written by every generated project', () => {
    expect(filesOf({})).toContain(PROVENANCE_FILE);
  });

  it('records the generator, the template, the stack and the site', () => {
    const provenance = provenanceOf({});
    expect(Object.keys(provenance).sort()).toEqual([
      '$schema',
      'cliVersion',
      'config',
      'generatedAt',
      'mode',
      'stack',
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

  it('keeps every field it recorded before the stack was added', () => {
    /*
     * The additive half of Stage 57's policy, asserted rather than promised.
     * Nothing was removed or renamed to make room, so a reader written against
     * the older shape still finds everything it knew about.
     */
    const provenance = provenanceOf({});
    expect(provenance.$schema).toBe('https://create-clientkit.dev/schema/client-site.json');
    expect(provenance.cliVersion).toBe('9.9.9');
    expect(provenance.mode).toBe('full');
    expect(provenance.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(provenance.template).toEqual({
      id: 'react-vite',
      version: expect.any(String),
      framework: 'react',
      frameworkVersion: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

describe('provenance records the resolved stack', () => {
  it('records every dimension the resolver settles', () => {
    expect(Object.keys(stackOf({})).sort()).toEqual([
      'architecture',
      'buildTool',
      'framework',
      'language',
      'router',
      'styling',
      'uiLibrary',
    ]);
  });

  it('records what the project resolved to, taken from the manifest itself', () => {
    // The manifest is the object selection and compatibility were given; the
    // recorded stack is a projection of it, not a second description.
    const requested = manifestFor({ styling: 'bootstrap', uiLibrary: 'mui' });
    expect(stackOf({ styling: 'bootstrap', uiLibrary: 'mui' })).toEqual({
      framework: requested.framework,
      buildTool: requested.buildTool,
      language: requested.language,
      styling: requested.styling,
      uiLibrary: requested.uiLibrary,
      router: requested.router,
      architecture: requested.architecture,
    });
  });

  it('does not duplicate the starter or the feature list', () => {
    /*
     * Both are already recorded - `mode` and `config.features` - and a document
     * holding each of them twice would eventually hold two different answers.
     */
    const stack = stackOf({
      starter: 'coming-soon',
      features: ['client-route-fallback'],
      router: 'react-router',
    });
    expect(stack).not.toHaveProperty('starter');
    expect(stack).not.toHaveProperty('mode');
    expect(stack).not.toHaveProperty('features');
    expect(provenanceOf({ starter: 'coming-soon' }).mode).toBe('coming-soon');
  });

  it('tells two stacks apart, which is the whole reason it exists', () => {
    /*
     * The measurement that blocked Stage 56, inverted. These two configurations
     * generate different files, and their provenance now says so - which is
     * what a future upgrade needs in order to name what a new configuration
     * would no longer generate rather than guess at it.
     */
    const rich = { styling: 'tailwind', uiLibrary: 'mui', router: 'react-router' } as const;
    const plain = { styling: 'bootstrap', uiLibrary: 'none', router: 'none' } as const;

    expect(provenanceOf(rich)).not.toEqual(provenanceOf(plain));
    expect(stackOf(rich)).not.toEqual(stackOf(plain));

    const onlyInRich = filesOf(rich).filter((file) => !filesOf(plain).includes(file));
    expect(onlyInRich).toEqual(['src/components/ui/AppProviders.tsx', 'src/routes/AppRouter.tsx']);
  });

  it('distinguishes a change in any single dimension', () => {
    const base = stackOf({});
    for (const [dimension, over] of [
      ['styling', { styling: 'bootstrap' }],
      ['uiLibrary', { uiLibrary: 'mui' }],
      ['router', { router: 'react-router' }],
    ] as [string, Partial<ProjectManifest>][]) {
      expect(stackOf(over), dimension).not.toEqual(base);
    }
  });

  it('records the Astro stack for an Astro project', () => {
    // A second framework, so the recorded stack is demonstrably a function of
    // the project rather than of one adapter's defaults.
    expect(
      stackOf({
        framework: 'astro',
        buildTool: 'astro',
        styling: 'tailwind',
        router: 'file-based',
        architecture: 'astro-standard',
      }),
    ).toEqual({
      framework: 'astro',
      buildTool: 'astro',
      language: 'ts',
      styling: 'tailwind',
      uiLibrary: 'none',
      router: 'file-based',
      architecture: 'astro-standard',
    });
  });
});

// ---------------------------------------------------------------------------
// Ownership: who writes this file, and on whose behalf
// ---------------------------------------------------------------------------

describe('provenance is the generator writing about itself', () => {
  it('is the only operation the CLI claims as its own', () => {
    /*
     * The structural fact the Stage 57 decision rested on, and the reason
     * Stage 58 could change these bytes at all. Every other file in a generated
     * project comes from a template layer or an adapter and says so in its
     * origin. Exactly one carries `cli`.
     */
    const operations = generate({}).plan.operations;
    const byCli = operations.filter((entry) => entry.origin === 'cli').map((entry) => entry.path);
    expect(byCli).toEqual([PROVENANCE_FILE]);
    expect(operations.length).toBeGreaterThan(15);
  });

  it('is synthesised rather than copied from a template', () => {
    const operation = generate({}).plan.operations.find((entry) => entry.path === PROVENANCE_FILE);
    expect(operation?.type).toBe('write');
    expect(operation?.origin).toBe('cli');
  });

  it('records nothing about the machine that ran the generator', () => {
    // The allow-list its own doc comment describes: no environment, no absolute
    // paths, no credentials, no author. Adding the stack smuggled none of them
    // in.
    const serialised = JSON.stringify(provenanceOf({}));
    expect(serialised).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//);
    expect(serialised).not.toContain('author');
    expect(serialised).not.toContain('targetDir');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('provenance serialisation is deterministic', () => {
  it('is byte-identical for the same inputs', () => {
    const content = (): string => {
      const operation = generate({}).plan.operations.find((e) => e.path === PROVENANCE_FILE);
      return operation?.type === 'write' ? operation.content : '<none>';
    };
    expect(content()).toBe(content());
  });

  it('orders its keys the same way every time', () => {
    const keys = (over: Partial<ProjectManifest>): string[] => Object.keys(provenanceOf(over));
    expect(keys({ styling: 'bootstrap' })).toEqual(keys({ uiLibrary: 'mui' }));
    expect(keys({})).toEqual([
      '$schema',
      'cliVersion',
      'template',
      'stack',
      'mode',
      'generatedAt',
      'config',
    ]);
  });

  it('orders the stack the same way every time', () => {
    const order = (over: Partial<ProjectManifest>): string[] => Object.keys(stackOf(over));
    expect(order({})).toEqual([
      'framework',
      'buildTool',
      'language',
      'styling',
      'uiLibrary',
      'router',
      'architecture',
    ]);
    expect(order({ styling: 'bootstrap', uiLibrary: 'mui' })).toEqual(order({}));
  });

  it('varies with the configuration it is a record of, and with nothing else', () => {
    const base = provenanceOf({});
    expect(provenanceOf({ starter: 'coming-soon' })).not.toEqual(base);
    expect(provenanceOf({ styling: 'bootstrap' })).not.toEqual(base);
    // The project name is part of the record; the directory it was written to
    // is not, and does not become part of it.
    expect(provenanceOf({ targetDir: path.join(TEST_CWD, 'elsewhere') })).toEqual(base);
  });
});
