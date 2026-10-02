import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseCliArgs } from '../src/args.js';
import { runCreate } from '../src/commands/create.js';
import { runUpgrade } from '../src/commands/upgrade.js';
import {
  analyzeChanges,
  analyzeNewProject,
  CHANGE_ORDER,
  outcomeOf,
  type ChangeSet,
} from '../src/generate/changes.js';
import type { CompareFs, PlanComparison } from '../src/generate/compare.js';
import { diffText, MAX_LINES, MAX_SHOWN, renderDiff } from '../src/generate/diff.js';
import type { GenerationPlan } from '../src/generate/files.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { CLI_VERSION } from '../src/version.js';
import { tempDir, testLogger } from './helpers.js';

/**
 * Stage 8: the change analysis and its diff.
 *
 * The analysis is data - every planned file classified against the disk - and
 * the preview and the run both read it. Unit tests drive it with an in-memory
 * filesystem; the end-to-end tests drive `create` and `upgrade` on real
 * temporary projects and check the preview matches what is decided.
 */

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

describe('the line diff', () => {
  const lines = (n: number, prefix = 'line') =>
    Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

  it('finds nothing to show in identical text', () => {
    expect(diffText('a\nb\n', 'a\nb\n')).toEqual({
      status: 'diffed',
      added: 0,
      removed: 0,
      hunks: [],
    });
  });

  it('shows an addition, a deletion and an edit, with context', () => {
    const diff = diffText('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n');
    expect(diff).toMatchObject({ status: 'diffed', added: 2, removed: 1 });
    expect(renderDiff(diff, '')).toEqual(['  one', '- two', '+ TWO', '  three', '+ four']);
  });

  it('handles empty files on either side', () => {
    expect(renderDiff(diffText('', 'a\n'), '')).toEqual(['+ a']);
    expect(renderDiff(diffText('a\n', ''), '')).toEqual(['- a']);
    expect(diffText('', '')).toMatchObject({ added: 0, removed: 0 });
  });

  it('makes a missing final newline, and CRLF line endings, visible', () => {
    expect(renderDiff(diffText('a\n', 'a'), '')).toEqual([
      '- a',
      '+ a  (no newline at end of file)',
    ]);
    const crlf = diffText('a\r\nb\r\n', 'a\nb\n');
    expect(crlf).toMatchObject({ added: 2, removed: 2 });
  });

  it('keeps two lines of context and marks the gap between changes', () => {
    const before = lines(20);
    const after = before.replace('line 2\n', 'LINE 2\n').replace('line 19\n', 'LINE 19\n');
    const rendered = renderDiff(diffText(before, after), '');
    expect(rendered).toContain('…');
    expect(rendered).not.toContain('  line 10');
    expect(rendered[0]).toBe('  line 1');
  });

  it('summarises a file past the line limit instead of diffing it', () => {
    const diff = diffText(lines(MAX_LINES + 1), lines(3));
    expect(diff).toEqual({ status: 'too-large', beforeLines: MAX_LINES + 1, afterLines: 3 });
    expect(renderDiff(diff, '')).toEqual([
      `diff omitted: ${MAX_LINES + 1} lines now, 3 planned - over the ${MAX_LINES}-line preview limit`,
    ]);
  });

  it('stops after a fixed number of shown lines and counts the rest', () => {
    const rendered = renderDiff(diffText(lines(100, 'old'), lines(100, 'new')), '');
    expect(rendered).toHaveLength(MAX_SHOWN + 1);
    expect(rendered[MAX_SHOWN]).toMatch(/^… \d+ more changed line\(s\) not shown$/);
  });

  it('is the same every time', () => {
    const before = lines(50);
    const after = before.replace(/line 1(\d)/g, 'LINE 1$1');
    const first = diffText(before, after);
    for (let run = 0; run < 3; run += 1) expect(diffText(before, after)).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const ROOT = path.resolve('/ck-changes/site');

const plan = (paths: Record<string, string | { copy: string }>): GenerationPlan => ({
  templateId: 'astro-tailwind',
  templateVersion: '0.1.0',
  mode: 'coming-soon',
  targetDir: ROOT,
  operations: Object.entries(paths).map(([file, content]) =>
    typeof content === 'string'
      ? { type: 'write' as const, path: file, content, origin: 'base' }
      : { type: 'copy' as const, path: file, source: content.copy, origin: 'base' },
  ),
});

/** Files on disk, for analyzeChanges' diff reads. */
const disk = (files: Record<string, string>): CompareFs => ({
  exists: (file) => path.relative(ROOT, file).split(path.sep).join('/') in files,
  isFile: () => true,
  read: (file) =>
    Buffer.from(files[path.relative(ROOT, file).split(path.sep).join('/')] ?? '', 'utf8'),
});

const compared = (over: Partial<PlanComparison>): Omit<PlanComparison, 'observed'> => ({
  missing: [],
  unchanged: [],
  differs: [],
  ...over,
});

const kinds = (set: ChangeSet) => set.changes.map((change) => [change.kind, change.path]);

describe('classification', () => {
  const PLAN = plan({
    '.client-site.json': '{}',
    'README.md': 'new readme\n',
    'src/a.ts': 'a\n',
    'src/b.ts': 'b\n',
    'src/c.ts': 'c\n',
    'public/logo.png': { copy: '/templates/logo.png' },
  });

  it('classifies every planned file, in the canonical order', () => {
    const set = analyzeChanges(
      PLAN,
      compared({
        missing: ['src/a.ts', 'src/b.ts'],
        unchanged: ['.client-site.json', 'src/c.ts'],
        differs: ['README.md', 'public/logo.png'],
      }),
      { previousPaths: new Set(['src/b.ts']) },
    );
    expect(kinds(set)).toEqual([
      ['create', 'src/a.ts'],
      ['restore', 'src/b.ts'],
      ['modify', '.client-site.json'],
      ['conflict', 'public/logo.png'],
      ['conflict', 'README.md'],
      ['unchanged', 'src/c.ts'],
    ]);
    expect(set.counts).toEqual({ create: 1, restore: 1, modify: 1, conflict: 2, unchanged: 1 });
    expect(set.upToDate).toBe(false);
  });

  it('calls every missing file a create without a record of what the project had', () => {
    const set = analyzeChanges(PLAN, compared({ missing: ['src/a.ts', 'src/b.ts'] }));
    expect(set.counts.restore).toBe(0);
    expect(set.counts.create).toBe(2);
  });

  it('keeps the record unchanged when nothing else is written, and creates it when missing', () => {
    const nothing = analyzeChanges(
      PLAN,
      compared({ unchanged: PLAN.operations.map((operation) => operation.path) }),
    );
    expect(nothing.upToDate).toBe(true);
    expect(nothing.counts).toEqual({ create: 0, restore: 0, modify: 0, conflict: 0, unchanged: 6 });

    const noRecord = analyzeChanges(
      PLAN,
      compared({
        missing: ['.client-site.json'],
        unchanged: PLAN.operations.map((o) => o.path).filter((p) => p !== '.client-site.json'),
      }),
    );
    expect(kinds(noRecord)[0]).toEqual(['create', '.client-site.json']);
  });

  it('never calls the record a conflict, even when what it records changed', () => {
    const set = analyzeChanges(PLAN, compared({ differs: ['.client-site.json'] }));
    expect(set.changes.find((change) => change.path === '.client-site.json')?.kind).toBe('modify');
    expect(set.counts.conflict).toBe(0);
  });

  it('diffs a differing text file when asked, and never a binary one', () => {
    const set = analyzeChanges(PLAN, compared({ differs: ['README.md', 'public/logo.png'] }), {
      withDiff: true,
      fs: disk({ 'README.md': 'old readme\n', 'public/logo.png': '\u0089PNG' }),
    });
    const readme = set.changes.find((change) => change.path === 'README.md');
    const logo = set.changes.find((change) => change.path === 'public/logo.png');
    expect(readme?.diff && renderDiff(readme.diff, '')).toEqual(['- old readme', '+ new readme']);
    expect(logo).toMatchObject({ kind: 'conflict', binary: true });
    expect(logo?.diff).toBeUndefined();
  });

  it('computes no diff unless asked: a run needs only the decision', () => {
    const set = analyzeChanges(PLAN, compared({ differs: ['README.md'] }), {
      fs: disk({ 'README.md': 'old\n' }),
    });
    expect(set.changes.every((change) => change.diff === undefined)).toBe(true);
  });

  it('never mentions a file the plan does not name', () => {
    const set = analyzeChanges(PLAN, compared({ unchanged: ['src/a.ts'] }));
    expect(set.changes.map((change) => change.path).sort()).toEqual(
      PLAN.operations.map((operation) => operation.path).sort(),
    );
  });

  it('treats a new project as all creates', () => {
    const set = analyzeNewProject(PLAN);
    expect(set.counts.create).toBe(PLAN.operations.length);
  });
});

describe('the outcome', () => {
  const set = analyzeChanges(
    plan({ '.client-site.json': '{}', 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c' }),
    compared({ missing: ['a.ts'], differs: ['b.ts'], unchanged: ['.client-site.json', 'c.ts'] }),
  );

  it('writes everything but the unchanged when conflicts are agreed', () => {
    expect(outcomeOf(set, true)).toEqual({
      write: ['a.ts', '.client-site.json', 'b.ts'],
      skip: [],
      blocked: false,
    });
  });

  it('skips everything when a conflict is not agreed: no half-applied run', () => {
    expect(outcomeOf(set, false)).toEqual({
      write: [],
      skip: ['a.ts', '.client-site.json', 'b.ts'],
      blocked: true,
    });
  });

  it('needs no agreement without conflicts', () => {
    const safe = analyzeChanges(
      plan({ '.client-site.json': '{}', 'a.ts': 'a' }),
      compared({ missing: ['a.ts'], unchanged: ['.client-site.json'] }),
    );
    expect(outcomeOf(safe, false)).toMatchObject({
      blocked: false,
      write: ['a.ts', '.client-site.json'],
    });
  });
});

describe('determinism', () => {
  const PLAN = plan({
    'z.ts': 'z',
    'a.ts': 'a',
    'M.ts': 'm',
    '.client-site.json': '{}',
    'b/c.ts': 'c',
  });
  const comparison = compared({
    missing: ['z.ts', 'a.ts'],
    differs: ['M.ts'],
    unchanged: ['b/c.ts'],
  });

  it('orders by kind, then by the pinned path order, whatever order the plan lists', () => {
    const forward = analyzeChanges(PLAN, comparison);
    const backward = analyzeChanges(
      { ...PLAN, operations: [...PLAN.operations].reverse() },
      comparison,
    );
    expect(backward).toEqual(forward);
    const order = forward.changes.map((change) => CHANGE_ORDER.indexOf(change.kind));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('does not use locale-default comparison', () => {
    const expected = analyzeChanges(PLAN, comparison);
    const spy = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('localeCompare used');
    });
    try {
      // Synchronous: no runner code can run while the stub is in place.
      expect(analyzeChanges(PLAN, comparison)).toEqual(expected);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: create and upgrade read the same analysis
// ---------------------------------------------------------------------------

const registry = createRegistry(findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src')));
const BASE = ['--name', 'Acme Ltd', '--url', 'https://acme.example', '--no-git', '--no-install'];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function create(
  cwd: string,
  argv: readonly string[],
): Promise<{ code: number; text: string }> {
  const { logger, out, err } = testLogger();
  const code = await runCreate({
    flags: parseCliArgs([...argv]),
    logger,
    registry,
    cliVersion: CLI_VERSION,
    cwd,
    env: {},
    isTTY: false,
    nodeVersion: process.versions.node,
  });
  return { code, text: plain(`${out.text}${err.text}`) };
}

async function upgrade(
  cwd: string,
  argv: readonly string[],
): Promise<{ code: number; text: string }> {
  const { logger, out, err } = testLogger();
  const code = await runUpgrade({
    flags: parseCliArgs([...argv]),
    logger,
    registry,
    cliVersion: CLI_VERSION,
    cwd,
    env: {},
    isTTY: false,
  });
  return { code, text: plain(`${out.text}${err.text}`) };
}

function project(): { cwd: string; dir: string } {
  const { dir: cwd, cleanup } = tempDir('changes');
  cleanups.push(cleanup);
  return { cwd, dir: path.join(cwd, 'site') };
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out[path.relative(root, full)] =
          `${statSync(full).mtimeMs}:${readFileSync(full, 'base64')}`;
    }
  };
  walk(root);
  return out;
}

/** Just the per-kind sections of a preview, from the first heading to the summary. */
function changeSections(text: string): string {
  const start = text.search(
    /^(Files to create|Files to restore|Files to modify|Conflicts|Unchanged) \(/m,
  );
  const end = text.indexOf('\nChanges\n');
  return text.slice(start, end);
}

describe('the preview of a generated project', () => {
  it('shows each kind, a conflict’s reason and diff, and the summary - and writes nothing', async () => {
    const { cwd, dir } = project();
    expect((await create(cwd, ['site', ...BASE, '--yes'])).code).toBe(0);
    writeFileSync(
      path.join(dir, 'README.md'),
      `${readFileSync(path.join(dir, 'README.md'), 'utf8')}Our notes.\n`,
    );
    rmSync(path.join(dir, 'src', 'pages', 'index.astro'));
    const before = snapshot(dir);

    const { code, text } = await create(cwd, ['site', ...BASE, '--yes', '--dry-run']);

    expect(code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(text).toMatch(/Files to restore \(1\)\n {2}\+ src\/pages\/index\.astro/);
    expect(text).toMatch(/Files to modify \(1\)\n {2}~ \.client-site\.json/);
    expect(text).toMatch(
      /Conflicts \(1\)\n {2}! README\.md\n {6}differs from what ClientKit would write now - possibly your edit/,
    );
    expect(text).toContain('      - Our notes.');
    expect(text).toMatch(
      /Changes\n {2}0 files to create\n {2}1 file to restore\n {2}1 file to modify\n {2}1 conflict\n {2}\d+ files unchanged/,
    );
    expect(text).toContain('this run would stop and write nothing');
  });

  it('marks a differing binary file without dumping it', async () => {
    const { cwd, dir } = project();
    await create(cwd, ['site', ...BASE, '--yes']);
    // .gitattributes is copied byte for byte: the plan's one binary-kind file here.
    writeFileSync(path.join(dir, '.gitattributes'), Buffer.from([0, 1, 2, 3]));
    const { text } = await create(cwd, ['site', ...BASE, '--yes', '--dry-run']);
    expect(text).toContain('! .gitattributes (binary changed)');
    // Never the bytes themselves.
    expect(text).not.toContain(String.fromCharCode(0));
  });

  it('shows a project that matches as up to date, with an all-zero summary', async () => {
    const { cwd } = project();
    await create(cwd, ['site', ...BASE, '--yes']);
    const { text } = await create(cwd, ['site', ...BASE, '--yes', '--dry-run']);
    expect(text).toMatch(
      /Changes\n {2}0 files to create\n {2}0 files to restore\n {2}0 files to modify\n {2}0 conflicts\n {2}\d+ files unchanged/,
    );
    expect(text).toContain('Already up to date: without --dry-run, nothing would be written.');
  });

  it('gives the reason for every file under --debug', async () => {
    const { cwd } = project();
    await create(cwd, ['site', ...BASE, '--yes']);
    const { text } = await create(cwd, ['site', ...BASE, '--yes', '--dry-run', '--debug']);
    expect(text).toMatch(/= README\.md {2}- already exactly as planned/);
  });

  it('shows no diff for a directory ClientKit did not generate, and says why', async () => {
    const { cwd, dir } = project();
    await create(cwd, ['site', ...BASE, '--yes']);
    rmSync(path.join(dir, '.client-site.json'));
    writeFileSync(path.join(dir, 'README.md'), 'someone else’s\n');
    const { text } = await create(cwd, ['site', ...BASE, '--yes', '--dry-run']);
    expect(text).not.toContain('Conflicts (');
    expect(text).not.toMatch(/^ {6}[-+] /m);
    expect(text).toContain('cannot\n  tell which of these files are yours');
  });

  it('is classified the same way by upgrade', async () => {
    const { cwd, dir } = project();
    await create(cwd, ['site', ...BASE, '--yes']);
    writeFileSync(
      path.join(dir, 'README.md'),
      `${readFileSync(path.join(dir, 'README.md'), 'utf8')}Edit.\n`,
    );
    rmSync(path.join(dir, 'src', 'pages', 'index.astro'));

    const fromCreate = await create(cwd, ['site', ...BASE, '--yes', '--dry-run']);
    const fromUpgrade = await upgrade(cwd, ['upgrade', 'site', '--dry-run']);

    expect(changeSections(fromUpgrade.text)).toBe(changeSections(fromCreate.text));
    expect(fromUpgrade.text).toContain('Add 1 file(s):\n    src/pages/index.astro');
    expect(fromUpgrade.text).toMatch(
      /Replace 2 generated file\(s\):\n {4}\.client-site\.json\n {4}README\.md/,
    );
  });
});
