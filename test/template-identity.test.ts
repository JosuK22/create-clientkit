import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAdapterRegistry } from '../src/adapters/registry.js';
import {
  checkRecordedTemplate,
  describeTemplate,
  discoverableTemplates,
} from '../src/adapters/template-identity.js';
import { planManifest } from '../src/adapters/bridge.js';
import type { ProjectManifest } from '../src/domain/index.js';
import { PROVENANCE_FILE } from '../src/generate/provenance.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * Template identity, and the three things it is not.
 *
 * Stage 61 found identity, content location and discoverability collapsed into
 * one bit: `createRegistry` discovers a template by finding `template.json` in
 * its directory, so being identifiable and being listed were the same
 * condition. React and Next stayed unlisted by having no manifest on disk -
 * which also left them unidentifiable through the registry - and Astro was
 * identified through `TEMPLATE_ID_PLACEHOLDER`, a constant whose own comment
 * calls it "a reserved identifier, not a template".
 *
 * So the map from a recorded `stack.framework` to a template identity had a
 * hole in it exactly where a recorded project needed one. These tests pin the
 * contract that closes it.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const adapters = createAdapterRegistry(TEMPLATES_ROOT);
const v1Registry = createRegistry(TEMPLATES_ROOT);

const IMPLEMENTED = ['astro', 'react', 'nextjs'] as const;

// ---------------------------------------------------------------------------
// Every framework can say what it generates
// ---------------------------------------------------------------------------

describe('every framework adapter declares a template identity', () => {
  it.each(IMPLEMENTED)('%s has a non-empty id and version', (framework) => {
    const { identity } = describeTemplate(framework, adapters);
    expect(identity.id).not.toBe('');
    expect(identity.version).not.toBe('');
    expect(identity.framework).not.toBe('');
  });

  it('never identifies a framework by the placeholder', () => {
    /*
     * The specific defect. `TEMPLATE_ID_PLACEHOLDER` exists so a
     * `ProjectContext` has a well-typed value before a template is chosen; it
     * is not an answer to "which template does this framework generate".
     */
    for (const framework of IMPLEMENTED) {
      const { identity } = describeTemplate(framework, adapters);
      expect(identity.id, `${framework} identified by a placeholder`).not.toBe(
        'TEMPLATE_ID_PLACEHOLDER',
      );
      expect(identity.framework).toBe(
        framework === 'react' ? 'react' : framework === 'nextjs' ? 'nextjs' : 'astro',
      );
    }
  });

  it('gives each framework a distinct template', () => {
    const ids = IMPLEMENTED.map((f) => describeTemplate(f, adapters).identity.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('answers the same way every time', () => {
    const once = IMPLEMENTED.map((f) => describeTemplate(f, adapters));
    const again = IMPLEMENTED.map((f) =>
      describeTemplate(f, createAdapterRegistry(TEMPLATES_ROOT)),
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(once));
  });
});

// ---------------------------------------------------------------------------
// Astro: one source of truth
// ---------------------------------------------------------------------------

describe('Astro identity agrees with its template.json', () => {
  const onDisk = JSON.parse(
    readFileSync(path.join(TEMPLATES_ROOT, 'astro-tailwind', 'template.json'), 'utf8'),
  ) as { id: string; version: string; framework: string };

  it('reads the manifest rather than restating it', () => {
    /*
     * The test Stage 62 was asked for. Astro's identity must not become a
     * second constant that drifts from the file: if someone bumps the version
     * in template.json and the adapter kept its own copy, this fails.
     */
    const { identity } = describeTemplate('astro', adapters);
    expect(identity.id).toBe(onDisk.id);
    expect(identity.version).toBe(onDisk.version);
    expect(identity.framework).toBe(onDisk.framework);
  });

  it('agrees with what the V1 disk registry serves', () => {
    const fromRegistry = v1Registry.get(onDisk.id);
    const { identity } = describeTemplate('astro', adapters);
    expect(identity.id).toBe(fromRegistry.id);
    expect(identity.version).toBe(fromRegistry.version);
  });
});

// ---------------------------------------------------------------------------
// React and Next: identity without a manifest on disk
// ---------------------------------------------------------------------------

describe('React and Next are identifiable without a filesystem manifest', () => {
  it.each(['react', 'nextjs'] as const)('%s ships no template.json', (framework) => {
    const { identity } = describeTemplate(framework, adapters);
    // The physical asymmetry the contract tolerates: content on disk, manifest
    // in code. Adding a template.json here would change --list-templates.
    expect(() =>
      readFileSync(path.join(TEMPLATES_ROOT, identity.id, 'template.json'), 'utf8'),
    ).toThrow();
  });

  it.each(['react', 'nextjs'] as const)('%s is identifiable anyway', (framework) => {
    const { identity } = describeTemplate(framework, adapters);
    expect(identity.id).not.toBe('');
    expect(identity.version).not.toBe('');
  });

  it('has template content on disk for all three, wherever the manifest lives', () => {
    for (const framework of IMPLEMENTED) {
      const { identity } = describeTemplate(framework, adapters);
      expect(() =>
        readFileSync(path.join(TEMPLATES_ROOT, identity.id, 'base', 'README.md'), 'utf8'),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Discoverability is a separate property
// ---------------------------------------------------------------------------

describe('discoverability is declared, not inferred', () => {
  it('offers Astro by name and the others not', () => {
    expect(describeTemplate('astro', adapters).discoverable).toBe(true);
    expect(describeTemplate('react', adapters).discoverable).toBe(false);
    expect(describeTemplate('nextjs', adapters).discoverable).toBe(false);
  });

  it('matches exactly what --list-templates prints', () => {
    /*
     * The two mechanisms are independent - one is a declaration, the other a
     * directory scan - so this is the test that stops them diverging. If a
     * framework is ever declared discoverable without its template being
     * listed, or listed without being declared, this fails.
     */
    const declared = discoverableTemplates(adapters)
      .map((identity) => identity.id)
      .sort();
    const listed = v1Registry
      .list()
      .map((summary) => summary.id)
      .sort();
    expect(declared).toEqual(listed);
  });

  it('keeps identity and discoverability independent', () => {
    // Being identifiable must not imply being offered: React and Next are
    // fully identifiable generation targets that no user can select by name.
    const identifiable = IMPLEMENTED.filter(
      (f) => describeTemplate(f, adapters).identity.id !== '',
    );
    const offered = IMPLEMENTED.filter((f) => describeTemplate(f, adapters).discoverable);
    expect(identifiable.length).toBe(3);
    expect(offered.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Checking a recorded project
// ---------------------------------------------------------------------------

describe('a recorded template identity is checked against its stack', () => {
  const manifestFor = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
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

  /** A real document, produced by the writer rather than typed out here. */
  const recordedOf = (over: Partial<ProjectManifest> = {}) => {
    const operation = planManifest(manifestFor(over), {
      registry: v1Registry,
      cliVersion: '1.0.2',
      generatedAt: '2026-01-01T00:00:00.000Z',
      mode: (over.starter ?? 'full') as 'coming-soon' | 'full',
      templateId: describeTemplate((over.framework ?? 'react') as never, adapters).identity.id,
    }).plan.operations.find((entry) => entry.path === PROVENANCE_FILE);
    if (operation?.type !== 'write') throw new Error('no provenance was written');
    const document = JSON.parse(operation.content) as {
      stack: { framework: string };
      template: { id: string; framework: string };
    };
    return {
      framework: document.stack.framework,
      id: document.template.id,
      templateFramework: document.template.framework,
    };
  };

  it('accepts a document ClientKit itself wrote', () => {
    for (const framework of IMPLEMENTED) {
      const recorded = recordedOf(
        framework === 'react'
          ? {}
          : framework === 'astro'
            ? {
                framework: 'astro',
                buildTool: 'astro',
                router: 'file-based',
                architecture: 'astro-standard',
              }
            : {
                framework: 'nextjs',
                buildTool: 'next',
                router: 'file-based',
                architecture: 'next-app',
              },
      );
      const result = checkRecordedTemplate(recorded, adapters);
      expect(result.status, `${framework}: ${JSON.stringify(recorded)}`).toBe('ok');
    }
  });

  it('rejects a template belonging to another framework', () => {
    const recorded = { ...recordedOf(), id: 'astro-tailwind' };
    const result = checkRecordedTemplate(recorded, adapters);
    expect(result.status).toBe('unknown-template');
  });

  it('rejects a template block that contradicts the stack', () => {
    // The Stage 60 example: individually valid, collectively impossible.
    const recorded = { ...recordedOf(), templateFramework: 'astro' };
    const result = checkRecordedTemplate(recorded, adapters);
    expect(result.status).toBe('framework-mismatch');
  });

  it('rejects an unknown template id', () => {
    const result = checkRecordedTemplate({ ...recordedOf(), id: 'svelte-kit' }, adapters);
    expect(result.status).toBe('unknown-template');
  });

  it('rejects a framework with no adapter, without pretending it is unknown', () => {
    const known = checkRecordedTemplate(
      { framework: 'angular', id: 'angular', templateFramework: 'angular' },
      adapters,
    );
    expect(known.status).toBe('unknown-framework');
    expect(known.status === 'unknown-framework' ? known.because : '').toContain('no adapter');

    const unknown = checkRecordedTemplate(
      { framework: 'ember', id: 'ember', templateFramework: 'ember' },
      adapters,
    );
    expect(unknown.status).toBe('unknown-framework');
  });

  it('rejects malformed identity rather than coercing it', () => {
    for (const recorded of [
      { framework: null, id: 'react-vite', templateFramework: 'react' },
      { framework: 'react', id: undefined, templateFramework: 'react' },
      { framework: 'react', id: 'react-vite', templateFramework: 42 },
      { framework: '', id: 'react-vite', templateFramework: 'react' },
      { framework: 'react', id: '', templateFramework: 'react' },
    ]) {
      expect(checkRecordedTemplate(recorded, adapters).status).toBe('malformed');
    }
  });

  it('never falls back to the template this CLI would pick now', () => {
    /*
     * The safety property. A project generated from one template is not
     * upgraded by quietly generating a different one, so a disagreement is
     * reported and never repaired.
     */
    const result = checkRecordedTemplate({ ...recordedOf(), id: 'astro-tailwind' }, adapters);
    expect(result.status).not.toBe('ok');
    expect(result).not.toHaveProperty('identity');
  });

  it('does not compare versions, because a differing version is the normal case', () => {
    // An upgrade is precisely the situation where the recorded version differs
    // from the shipped one, and Stage 61 settled that no historical bytes are
    // kept to compare against.
    const recorded = recordedOf();
    expect(checkRecordedTemplate(recorded, adapters).status).toBe('ok');
  });

  it('reaches its verdict without looking at any project file', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'adapters', 'template-identity.ts'),
      'utf8',
    );
    for (const forbidden of [
      'node:fs',
      'readFileSync',
      'existsSync',
      'readdirSync',
      'node:child_process',
    ]) {
      expect(source, `template-identity.ts reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });
});
