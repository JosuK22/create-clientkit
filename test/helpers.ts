import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Prompter, SetupAnswer } from '../src/context/prompts.js';
import type { TargetDirFs } from '../src/context/validate.js';
import { CliError } from '../src/errors.js';
import type { GenerationPlan } from '../src/generate/files.js';
import type { PlanFs } from '../src/generate/plan.js';
import type { TemplateManifest } from '../src/templates/manifest.js';
import type { TemplateRegistry } from '../src/templates/registry.js';
import type { ProjectContext, TemplateMode } from '../src/types.js';
import { Logger } from '../src/ui/logger.js';

/** Short, non-existent cwd so path-length checks and the real fs stay out of play. */
export const TEST_CWD = path.join(path.parse(process.cwd()).root, 'ck-test');
export const TEST_HOME = path.join(path.parse(process.cwd()).root, 'ck-home');

/** Pretends every path is missing, so nothing touches the real filesystem. */
export const emptyFs: TargetDirFs = {
  statSync: () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  },
  readdirSync: () => [],
};

export function occupiedFs(entries: string[]): TargetDirFs {
  return {
    statSync: () => ({ isDirectory: () => true }),
    readdirSync: () => entries,
  };
}

export interface FakeAnswers {
  dir?: string;
  siteName?: string;
  url?: string | null;
  mode?: TemplateMode;
  setup?: SetupAnswer;
  confirmNonEmpty?: boolean;
}

/** Records which questions were asked, so precedence can be asserted directly. */
export class FakePrompter implements Prompter {
  readonly interactive = true;
  readonly asked: string[] = [];
  readonly #answers: FakeAnswers;

  constructor(answers: FakeAnswers = {}) {
    this.#answers = answers;
  }

  async projectDir(defaultValue: string): Promise<string> {
    this.asked.push('dir');
    return this.#answers.dir ?? defaultValue;
  }

  async siteName(defaultValue: string): Promise<string> {
    this.asked.push('siteName');
    return this.#answers.siteName ?? defaultValue;
  }

  async productionUrl(): Promise<string | null> {
    this.asked.push('url');
    return this.#answers.url ?? null;
  }

  async mode(defaultValue: TemplateMode): Promise<TemplateMode> {
    this.asked.push('mode');
    return this.#answers.mode ?? defaultValue;
  }

  async setup(defaults: SetupAnswer): Promise<SetupAnswer> {
    this.asked.push('setup');
    return this.#answers.setup ?? defaults;
  }

  async confirmNonEmpty(): Promise<boolean> {
    this.asked.push('confirmNonEmpty');
    return this.#answers.confirmNonEmpty ?? false;
  }
}

export class Collector {
  chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  get text(): string {
    return this.chunks.join('');
  }
}

export function testLogger(): { logger: Logger; out: Collector; err: Collector } {
  const out = new Collector();
  const err = new Collector();
  const logger = new Logger({
    streams: {
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    },
  });
  return { logger, out, err };
}

// ---------------------------------------------------------------------------
// M2: template-engine helpers
// ---------------------------------------------------------------------------

/**
 * An in-memory PlanFs built from a flat path -> content map, so composition,
 * token and planning tests never touch a real filesystem.
 *
 * `reads` records every readText call, which is how the binary-passthrough test
 * proves a file was never opened.
 */
export function memoryPlanFs(files: Record<string, string>): PlanFs & { reads: string[] } {
  const SLASH = String.fromCharCode(47);
  // Both the fixture keys and the paths the planner builds may mix separators,
  // so everything is normalised into one canonical form up front.
  const normalise = (p: string): string =>
    p.split(path.sep).join(SLASH).split(String.fromCharCode(92)).join(SLASH).replace(/\/+$/, '');

  const table = new Map<string, string>();
  for (const [key, value] of Object.entries(files)) table.set(normalise(key), value);
  const entries = [...table.keys()];
  const reads: string[] = [];

  return {
    reads,
    exists(dir) {
      const target = normalise(dir);
      return entries.some((entry) => entry === target || entry.startsWith(`${target}${SLASH}`));
    },
    readDir(dir) {
      const target = normalise(dir);
      const seen = new Map<string, boolean>();
      for (const entry of entries) {
        if (!entry.startsWith(`${target}${SLASH}`)) continue;
        const rest = entry.slice(target.length + 1);
        const head = rest.split(SLASH)[0];
        if (head === undefined) continue;
        seen.set(head, rest.includes(SLASH));
      }
      return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    readText(file) {
      const target = normalise(file);
      reads.push(target);
      const content = table.get(target);
      if (content === undefined) throw new Error(`ENOENT: ${file}`);
      return content;
    },
  };
}

export function makeContext(overrides: Partial<ProjectContext> = {}): ProjectContext {
  const base: ProjectContext = {
    targetDir: path.join(TEST_CWD, 'acme-website'),
    projectName: 'acme-website',
    site: {
      name: 'Acme Ltd',
      url: 'https://acme.example',
      description: 'Bespoke widgets.',
      locale: 'en',
      author: null,
    },
    template: { id: 'astro-tailwind', version: '0.1.0', mode: 'coming-soon' },
    features: [],
    packageManager: 'npm',
    git: true,
    install: true,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
  return Object.freeze({ ...base, ...overrides });
}

/** Registry backed by a memory filesystem, for planning tests. */
export function fakeRegistry(manifest: TemplateManifest, root: string): TemplateRegistry {
  return {
    list: () => [
      {
        id: manifest.id,
        displayName: manifest.displayName,
        description: manifest.description,
        version: manifest.version,
        modes: manifest.supportedModes,
      },
    ],
    has: (id) => id === manifest.id,
    get: (id) => {
      if (id !== manifest.id) throw new CliError(`Unknown template "${id}".`);
      return manifest;
    },
    defaultsFor: (id) => (id === manifest.id ? manifest.defaults : {}),
    rootFor: () => root,
    supportsMode: (id, mode) => id === manifest.id && manifest.supportedModes.includes(mode),
  };
}

export const FAKE_MANIFEST: TemplateManifest = {
  id: 'fake-template',
  displayName: 'Fake',
  description: 'Fixture template',
  version: '1.2.3',
  framework: 'astro',
  frameworkVersion: '7.3.2',
  minNode: '>=22.12.0',
  supportedModes: ['coming-soon', 'full'],
  defaults: { mode: 'coming-soon', locale: 'en' },
  availableFeatures: [],
  tokens: ['siteName', 'siteUrl', 'description', 'year', 'projectName', 'author', 'locale', 'mode'],
  postSteps: ['install', 'git-init'],
  nextSteps: ['Do the thing.'],
};

/** Creates a real temp directory; returns its path plus a cleanup function. */
export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `ck-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Golden plan rendering
// ---------------------------------------------------------------------------

/**
 * Renders a plan as diff-friendly text for golden snapshots.
 *
 * Lifted out of golden.test.ts in Stage 4 so the React suite renders through
 * exactly the same code. Two suites with two copies of a renderer drift, and
 * the first symptom would be a snapshot difference that means nothing.
 *
 * Two blocks on purpose. ORDER lists operations in the sequence the planner
 * emits them, so a reordering is a small obvious diff rather than being buried.
 * FILES carries content, so a content change stays local to the file that
 * changed instead of shifting everything after it.
 */
export function renderPlan(generated: GenerationPlan, templatesRoot: string): string {
  const TARGET_DIR = '<TARGET_DIR>';
  const normaliseSource = (absolute: string): string =>
    `<TEMPLATES>/${path.relative(templatesRoot, absolute).split(path.sep).join('/')}`;

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
