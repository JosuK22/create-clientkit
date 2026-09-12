import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../src/args.js';
import { NonInteractivePrompter } from '../src/context/prompts.js';
import { resolveContext } from '../src/context/resolve.js';
import { planWithAdapters } from '../src/adapters/bridge.js';
import { plan } from '../src/generate/plan.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import type { GenerationPlan } from '../src/generate/files.js';
import type { ProjectContext, ResolutionResult, TemplateMode } from '../src/types.js';
import { emptyFs, makeContext, TEST_CWD, TEST_HOME } from './helpers.js';

/**
 * Golden snapshots of what create-clientkit@1.0.2 generates.
 *
 * These are a safety net for the V2 adapter refactor, not ordinary unit tests.
 * They record the complete `FileOperation[]` contract - every path, every byte
 * of content, and the order the operations come out in - so that a change to
 * how generation works can be proved not to have changed what it generates.
 *
 * The snapshots were produced by running this code against the real template
 * on disk. Nothing in them was hand-written, reformatted or tidied.
 *
 * ## Treat these as immutable
 *
 * A failure here means the generated output changed. That is a defect until
 * someone demonstrates otherwise. Do not re-record the snapshots to make the
 * suite green - read the diff, find out what moved, and decide deliberately.
 * Re-recording is correct only when a product change to the output has been
 * agreed, and then the snapshot diff is the review artifact.
 *
 * See docs/golden-snapshots.md.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);

// ---------------------------------------------------------------------------
// Normalisation
//
// Deliberately minimal: two substitutions, both for values that are genuinely
// machine-specific and therefore cannot be part of a portable contract. Content
// is not touched - production already normalises line endings to LF and emits
// POSIX-separated paths, so there is nothing left to canonicalise.
// ---------------------------------------------------------------------------

const TARGET_DIR = '<TARGET_DIR>';
const TEMPLATES = '<TEMPLATES>';

/** Absolute path inside the shipped templates directory -> `<TEMPLATES>/...`. */
function normaliseSource(absolute: string): string {
  const relative = path.relative(TEMPLATES_ROOT, absolute).split(path.sep).join('/');
  return `${TEMPLATES}/${relative}`;
}

/**
 * Renders a plan as diff-friendly text.
 *
 * Two blocks on purpose. ORDER lists the operations in the sequence `plan()`
 * emits them, so a reordering shows up as a small, obvious diff rather than
 * being buried. FILES carries the content, so a content change shows up local
 * to the file that changed instead of shifting everything after it.
 */
function render(generated: GenerationPlan): string {
  const lines: string[] = [];

  lines.push('== PLAN ==');
  lines.push(`templateId       ${generated.templateId}`);
  lines.push(`templateVersion  ${generated.templateVersion}`);
  lines.push(`mode             ${generated.mode}`);
  lines.push(`targetDir        ${TARGET_DIR}`);
  lines.push(`operationCount   ${generated.operations.length}`);
  lines.push('');

  lines.push('== ORDER ==');
  for (const operation of generated.operations) {
    lines.push(`${operation.type.padEnd(5)}  ${operation.path}`);
  }
  lines.push('');

  lines.push('== FILES ==');
  for (const operation of generated.operations) {
    lines.push('');
    lines.push(`---- ${operation.path} ----`);
    lines.push(`type    ${operation.type}`);
    lines.push(`origin  ${operation.origin}`);
    if (operation.type === 'copy') {
      lines.push(`source  ${normaliseSource(operation.source)}`);
      lines.push('(binary; copied byte-for-byte, never token-substituted)');
      continue;
    }
    lines.push('----');
    lines.push(operation.content);
  }

  return `${lines.join('\n')}\n`;
}

/** Renders a resolution result: the CLI-input -> ProjectContext half of the contract. */
function renderResolution(result: ResolutionResult): string {
  const context: ProjectContext = result.context;
  const lines: string[] = [];

  lines.push('== CONTEXT ==');
  lines.push(`targetDir        ${TARGET_DIR}`);
  lines.push(`projectName      ${context.projectName}`);
  lines.push(`site.name        ${context.site.name}`);
  lines.push(`site.url         ${context.site.url === null ? '(null)' : context.site.url}`);
  lines.push(`site.description ${context.site.description}`);
  lines.push(`site.locale      ${context.site.locale}`);
  lines.push(`site.author      ${context.site.author === null ? '(null)' : context.site.author}`);
  lines.push(`template.id      ${context.template.id}`);
  lines.push(`template.version ${context.template.version ?? '(null)'}`);
  lines.push(`template.mode    ${context.template.mode}`);
  lines.push(`features         [${context.features.join(', ')}]`);
  lines.push(`packageManager   ${context.packageManager}`);
  lines.push(`git              ${context.git}`);
  lines.push(`install          ${context.install}`);
  lines.push(`cliVersion       ${context.cliVersion}`);
  lines.push(`generatedAt      ${context.generatedAt}`);
  lines.push('');

  lines.push('== SOURCES ==');
  // Sorted by key: SourceMap is a plain object and V1 makes no promise about
  // its key order, so ordering it here is normalisation rather than contract.
  for (const key of Object.keys(result.sources).sort()) {
    lines.push(`${key.padEnd(16)} ${result.sources[key]}`);
  }

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Scenario {
  readonly name: string;
  readonly file: string;
  readonly context: ProjectContext;
}

const withMode = (mode: TemplateMode, url: string | null): ProjectContext =>
  makeContext({
    template: { id: 'astro-tailwind', version: '0.1.0', mode },
    site: {
      name: 'Acme Ltd',
      url,
      description: 'Bespoke widgets.',
      locale: 'en',
      author: null,
    },
  });

const scenarios: readonly Scenario[] = [
  {
    name: 'Coming Soon + URL',
    file: './golden/coming-soon-url.txt',
    context: withMode('coming-soon', 'https://acme.example'),
  },
  {
    name: 'Full + URL',
    file: './golden/full-url.txt',
    context: withMode('full', 'https://acme.example'),
  },
  {
    name: 'URL-less',
    file: './golden/url-less.txt',
    context: withMode('coming-soon', null),
  },
];

describe('golden: generation output for create-clientkit@1.0.2', () => {
  for (const scenario of scenarios) {
    it(`golden: ${scenario.name}`, async () => {
      const generated = plan(scenario.context, { registry });
      await expect(render(generated)).toMatchFileSnapshot(scenario.file);
    });
  }

  it('golden: CLI resolution path', async () => {
    // The other three scenarios build a ProjectContext directly, which skips
    // the resolver entirely. This one drives the real flag -> defaults ->
    // context path so the CLI half of the contract is pinned too, including
    // which layer each value came from.
    const result = await resolveContext({
      flags: parseCliArgs(['acme-website', '--yes', '--name', 'Acme Ltd', '--mode', 'full']),
      cwd: TEST_CWD,
      home: TEST_HOME,
      env: {},
      prompter: new NonInteractivePrompter('test'),
      registry,
      cliVersion: '9.9.9',
      now: new Date('2026-01-01T00:00:00.000Z'),
      fs: emptyFs,
    });

    await expect(renderResolution(result)).toMatchFileSnapshot('./golden/cli-resolution.txt');
  });
});

describe('golden: determinism', () => {
  it.each(scenarios.map((s) => [s.name, s.context] as const))(
    'planning %s twice produces identical output',
    (_name, context) => {
      expect(render(plan(context, { registry }))).toBe(render(plan(context, { registry })));
    },
  );

  it('operation order is the order plan() emits, not an accident of the snapshot', () => {
    // plan() sorts by path with localeCompare, which is deliberate and part of
    // the contract. Asserting it here means a change to the sort is reported as
    // an ordering failure rather than only as a large, hard-to-read diff.
    const generated = plan(scenarios[0]!.context, { registry });
    const paths = generated.operations.map((operation) => operation.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it('every operation path is POSIX-separated and relative', () => {
    for (const scenario of scenarios) {
      for (const operation of plan(scenario.context, { registry }).operations) {
        expect(operation.path, `${scenario.name}: ${operation.path}`).not.toContain('\\');
        expect(path.isAbsolute(operation.path), `${scenario.name}: ${operation.path}`).toBe(false);
      }
    }
  });

  it('no generated text content carries CRLF', () => {
    for (const scenario of scenarios) {
      for (const operation of plan(scenario.context, { registry }).operations) {
        if (operation.type !== 'write') continue;
        expect(operation.content.includes('\r\n'), `${scenario.name}: ${operation.path}`).toBe(
          false,
        );
      }
    }
  });
});

/**
 * The Stage 2 migration gate.
 *
 * These assert the same four baselines against output produced through the V2
 * adapter path. Pointing them at the identical snapshot files is the strongest
 * available statement of the requirement: whatever the adapters do, what comes
 * out the other end is what 1.0.2 produced.
 *
 * The direct equality assertions exist alongside them because a snapshot
 * failure says "the output changed" while an equality failure says "the two
 * paths disagree", and during a migration the second is the more useful diff.
 */
describe('golden: the V2 adapter path reproduces V1 byte for byte', () => {
  for (const scenario of scenarios) {
    it(`golden via adapters: ${scenario.name}`, async () => {
      const { plan: generated } = planWithAdapters(scenario.context, { registry });
      await expect(render(generated)).toMatchFileSnapshot(scenario.file);
    });

    it(`V2 output is identical to V1 for ${scenario.name}`, () => {
      const viaAdapters = render(planWithAdapters(scenario.context, { registry }).plan);
      const viaV1 = render(plan(scenario.context, { registry }));
      expect(viaAdapters).toBe(viaV1);
    });
  }

  it('the adapter path drives the layers rather than letting plan() assume them', () => {
    // If the bridge stopped supplying layers, plan() would fall back to its own
    // defaults and the snapshots above would still pass - proving nothing. This
    // asserts the layers actually came from the adapter.
    const { contributions } = planWithAdapters(scenarios[0]!.context, { registry });
    const layers = contributions.flatMap((contribution) => contribution.templateLayers);
    expect(layers.map((layer) => layer.name)).toEqual(['base', 'modes/coming-soon']);
    expect(layers.every((layer) => layer.owner === 'framework:astro')).toBe(true);
  });

  it('the full starter selects the other mode layer', () => {
    const { contributions } = planWithAdapters(scenarios[1]!.context, { registry });
    const layers = contributions.flatMap((contribution) => contribution.templateLayers);
    expect(layers.map((layer) => layer.name)).toEqual(['base', 'modes/full']);
  });
});
