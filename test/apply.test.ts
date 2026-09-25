import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  apply,
  findCollisions,
  renameWithRetry,
  TRANSIENT_RENAME_CODES,
} from '../src/generate/apply.js';
import type { GenerationPlan } from '../src/generate/files.js';
import { tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function scratch(): string {
  const { dir, cleanup } = tempDir('apply');
  cleanups.push(cleanup);
  return dir;
}

function makePlan(targetDir: string, operations: GenerationPlan['operations']): GenerationPlan {
  return {
    templateId: 'fake-template',
    templateVersion: '1.0.0',
    mode: 'coming-soon',
    targetDir,
    operations,
  };
}

const SIMPLE = [
  { type: 'write' as const, path: 'package.json', content: '{"a":1}\n', origin: 'base' },
  { type: 'write' as const, path: 'src/pages/index.astro', content: 'PAGE\n', origin: 'base' },
  { type: 'write' as const, path: '.gitignore', content: 'dist/\n', origin: 'base' },
];

function listFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(path.join(root, entry.name), relative));
    else out.push(relative);
  }
  return out.sort();
}

describe('apply into a fresh directory', () => {
  it('writes every planned file with the right content', () => {
    const target = path.join(scratch(), 'site');
    const result = apply(makePlan(target, SIMPLE));

    expect(result.written).toHaveLength(3);
    expect(listFiles(target)).toEqual(['.gitignore', 'package.json', 'src/pages/index.astro']);
    expect(readFileSync(path.join(target, 'src/pages/index.astro'), 'utf8')).toBe('PAGE\n');
  });

  it('creates nested directories as needed', () => {
    const target = path.join(scratch(), 'site');
    apply(makePlan(target, [{ type: 'write', path: 'a/b/c/d.txt', content: 'x', origin: 'base' }]));
    expect(existsSync(path.join(target, 'a', 'b', 'c', 'd.txt'))).toBe(true);
  });

  it('copies binary sources byte-for-byte', () => {
    const root = scratch();
    const source = path.join(root, 'logo.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    writeFileSync(source, bytes);

    const target = path.join(root, 'site');
    apply(makePlan(target, [{ type: 'copy', path: 'public/logo.png', source, origin: 'base' }]));

    expect(readFileSync(path.join(target, 'public/logo.png')).equals(bytes)).toBe(true);
  });

  it('leaves no temporary directory behind', () => {
    const root = scratch();
    apply(makePlan(path.join(root, 'site'), SIMPLE));
    expect(readdirSync(root).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('accepts an existing but empty directory', () => {
    const target = path.join(scratch(), 'site');
    mkdirSync(target, { recursive: true });
    expect(() => apply(makePlan(target, SIMPLE))).not.toThrow();
    expect(listFiles(target)).toHaveLength(3);
  });

  it('treats a lone .git as empty', () => {
    const target = path.join(scratch(), 'site');
    mkdirSync(path.join(target, '.git'), { recursive: true });
    expect(() => apply(makePlan(target, SIMPLE))).not.toThrow();
    expect(existsSync(path.join(target, '.git'))).toBe(true);
  });
});

describe('atomicity', () => {
  it('leaves the target untouched when an operation fails midway', () => {
    const root = scratch();
    const target = path.join(root, 'site');

    const doomed = makePlan(target, [
      ...SIMPLE,
      // A copy whose source does not exist fails after two successful writes.
      {
        type: 'copy',
        path: 'public/missing.png',
        source: path.join(root, 'nope.png'),
        origin: 'base',
      },
    ]);

    expect(() => apply(doomed)).toThrow(/Generation failed/);
    expect(existsSync(target)).toBe(false);
  });

  it('cleans up the temporary directory after a failure', () => {
    const root = scratch();
    const target = path.join(root, 'site');
    try {
      apply(
        makePlan(target, [
          { type: 'copy', path: 'x.png', source: path.join(root, 'nope.png'), origin: 'base' },
        ]),
      );
    } catch {
      // expected
    }
    expect(readdirSync(root).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('reports that nothing was written', () => {
    const root = scratch();
    try {
      apply(
        makePlan(path.join(root, 'site'), [
          { type: 'copy', path: 'x.png', source: path.join(root, 'nope.png'), origin: 'base' },
        ]),
      );
      expect.unreachable();
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain('Nothing was written');
    }
  });

  it('does not destroy an existing target when a later operation fails', () => {
    const root = scratch();
    const target = path.join(root, 'site');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'IMPORTANT.txt'), 'keep me');

    try {
      apply(
        makePlan(target, [
          ...SIMPLE,
          { type: 'copy', path: 'x.png', source: path.join(root, 'nope.png'), origin: 'base' },
        ]),
        { allowNonEmpty: true },
      );
    } catch {
      // expected
    }

    expect(readFileSync(path.join(target, 'IMPORTANT.txt'), 'utf8')).toBe('keep me');
    // Staging failed before anything moved, so no partial output landed.
    expect(existsSync(path.join(target, 'package.json'))).toBe(false);
  });
});

describe('non-empty targets', () => {
  it('refuses without explicit permission', () => {
    const target = path.join(scratch(), 'site');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'existing.txt'), 'hello');

    expect(() => apply(makePlan(target, SIMPLE))).toThrow(/already exists and is not empty/);
    expect(readdirSync(target)).toEqual(['existing.txt']);
  });

  it('merges when permitted, preserving unrelated files', () => {
    const target = path.join(scratch(), 'site');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'UNRELATED.md'), 'mine');

    const result = apply(makePlan(target, SIMPLE), { allowNonEmpty: true });

    expect(readFileSync(path.join(target, 'UNRELATED.md'), 'utf8')).toBe('mine');
    expect(result.overwritten).toEqual([]);
    expect(listFiles(target)).toContain('package.json');
  });

  it('reports which files it replaced', () => {
    const target = path.join(scratch(), 'site');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'package.json'), 'OLD');

    const result = apply(makePlan(target, SIMPLE), { allowNonEmpty: true });

    expect(result.overwritten).toEqual(['package.json']);
    expect(readFileSync(path.join(target, 'package.json'), 'utf8')).toBe('{"a":1}\n');
  });

  it('never deletes files the plan does not name', () => {
    const target = path.join(scratch(), 'site');
    mkdirSync(path.join(target, 'src', 'custom'), { recursive: true });
    writeFileSync(path.join(target, 'src', 'custom', 'mine.ts'), 'export const x = 1;');

    apply(makePlan(target, SIMPLE), { allowNonEmpty: true });

    expect(existsSync(path.join(target, 'src', 'custom', 'mine.ts'))).toBe(true);
  });
});

describe('findCollisions', () => {
  it('returns nothing for a missing target', () => {
    expect(findCollisions(makePlan(path.join(scratch(), 'nope'), SIMPLE))).toEqual([]);
  });

  it('lists only the planned paths that already exist', () => {
    const target = path.join(scratch(), 'site');
    mkdirSync(path.join(target, 'src', 'pages'), { recursive: true });
    writeFileSync(path.join(target, 'package.json'), 'old');
    writeFileSync(path.join(target, 'src', 'pages', 'index.astro'), 'old');
    writeFileSync(path.join(target, 'unrelated.txt'), 'old');

    expect(findCollisions(makePlan(target, SIMPLE))).toEqual([
      'package.json',
      'src/pages/index.astro',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Publishing a tree while Windows is still holding it (1.1.1)
// ---------------------------------------------------------------------------

/**
 * The failure a user hit on 1.1.0, generating into a OneDrive folder:
 *
 *     x Generation failed: EPERM: operation not permitted, rename
 *       '…\.my-client-site.tmp-5r2eoa' -> '…\my-client-site'
 *       Nothing was written to the target directory.
 *
 * The atomicity contract held - nothing was written - but the generation
 * failed for no reason the user could act on. A rename of a freshly written
 * tree can fail transiently on Windows while OneDrive's sync filter,
 * Defender's scanner or the search indexer still holds a handle on files that
 * appeared a moment ago. The operation is legal; the path is briefly busy.
 *
 * Measured before the fix: 2 failures in 8 runs into a OneDrive directory.
 * After: 0 in 40.
 *
 * Only contention is retried. A rename that is genuinely wrong must still fail
 * at once rather than after a second of hopeful waiting, which is what the
 * last two tests are for.
 */
describe('publishing survives a path that is briefly busy', () => {
  const failing = (code: string, times: number) => {
    let calls = 0;
    const rename = (): void => {
      calls += 1;
      if (calls <= times) {
        const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
    };
    return {
      rename,
      get calls() {
        return calls;
      },
    };
  };

  it('retries a transient failure and then succeeds', () => {
    for (const code of [...TRANSIENT_RENAME_CODES]) {
      const attempt = failing(code, 3);
      expect(() =>
        renameWithRetry('from', 'to', { rename: attempt.rename, delayMs: 0 }),
      ).not.toThrow();
      expect(attempt.calls, `${code} should have been retried`).toBe(4);
    }
  });

  it('does not retry a failure that is not contention', () => {
    // ENOENT means the source is not there. Waiting cannot help, and a user
    // staring at a hung command is worse than a prompt error.
    const attempt = failing('ENOENT', 1);
    expect(() => renameWithRetry('from', 'to', { rename: attempt.rename, delayMs: 0 })).toThrow(
      /ENOENT/,
    );
    expect(attempt.calls).toBe(1);
  });

  it('gives up eventually rather than retrying for ever', () => {
    const attempt = failing('EPERM', Number.MAX_SAFE_INTEGER);
    expect(() =>
      renameWithRetry('from', 'to', { rename: attempt.rename, attempts: 4, delayMs: 0 }),
    ).toThrow(/EPERM/);
    expect(attempt.calls).toBe(4);
  });

  it('reports the original error when it gives up, not a rewritten one', () => {
    // The user needs the real code and path to work out what is holding it.
    const attempt = failing('EBUSY', Number.MAX_SAFE_INTEGER);
    try {
      renameWithRetry('from', 'to', { rename: attempt.rename, attempts: 2, delayMs: 0 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('EBUSY');
    }
  });

  it('does not sleep when the rename works first time', () => {
    const started = Date.now();
    renameWithRetry('from', 'to', { rename: () => undefined, delayMs: 5000 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('publishes a project through the retry, not around it', () => {
    /*
     * The mutation that matters, and the one the tests above missed: if the
     * publishing rename goes back to a bare `renameSync`, every test of the
     * retry still passes while the original OneDrive failure returns.
     *
     * So this drives `apply` itself and makes the underlying rename fail the
     * way Windows fails it. The generation must still succeed, and the
     * injected rename must have been called more than once - which can only
     * happen if publishing went through the retry.
     */
    const { dir, cleanup } = tempDir('apply-retry');
    try {
      let calls = 0;
      const rename = (from: string, to: string): void => {
        calls += 1;
        if (calls === 1) {
          const error = new Error(
            'EPERM: operation not permitted, rename',
          ) as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        renameSync(from, to);
      };

      const target = path.join(dir, 'acme-site');
      const result = apply(
        {
          templateId: 'astro-tailwind',
          templateVersion: '0.1.0',
          mode: 'coming-soon',
          targetDir: target,
          operations: [{ type: 'write', path: 'README.md', content: '# Acme\n', origin: 'base' }],
        },
        { rename },
      );

      expect(calls).toBeGreaterThan(1);
      expect(result.written).toEqual(['README.md']);
      expect(readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('# Acme\n');
    } finally {
      cleanup();
    }
  });

  it('still fails, writing nothing, when the rename is genuinely refused', () => {
    // The retry must not turn a real error into a hang or a silent success.
    const { dir, cleanup } = tempDir('apply-refused');
    try {
      const rename = (): void => {
        const error = new Error('EROFS: read-only file system') as NodeJS.ErrnoException;
        error.code = 'EROFS';
        throw error;
      };

      const target = path.join(dir, 'acme-site');
      expect(() =>
        apply(
          {
            templateId: 'astro-tailwind',
            templateVersion: '0.1.0',
            mode: 'coming-soon',
            targetDir: target,
            operations: [{ type: 'write', path: 'README.md', content: '# Acme\n', origin: 'base' }],
          },
          { rename },
        ),
      ).toThrow(/EROFS/);
      expect(existsSync(target)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
