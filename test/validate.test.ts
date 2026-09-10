import { describe, expect, it } from 'vitest';

import {
  deriveProjectName,
  inspectTargetDir,
  sanitizeProjectName,
  validateLocale,
  validateMode,
  validatePackageManager,
  validateProjectName,
  validateSiteName,
  validateTargetDir,
  validateUrl,
} from '../src/context/validate.js';
import { TEST_CWD, TEST_HOME, emptyFs, occupiedFs } from './helpers.js';

describe('validateProjectName', () => {
  it.each(['acme-website', 'a', 'acme.site', 'client_2026', 'a1'])('accepts %s', (name) => {
    expect(validateProjectName(name)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['Acme-Website', 'uppercase'],
    ['.hidden', 'leading dot'],
    ['_private', 'leading underscore'],
    ['my site', 'space'],
    ['my/site', 'path separator'],
    ['my\\site', 'windows separator'],
    ['..', 'dot dot'],
    ['../escape', 'traversal'],
    ['con', 'windows reserved'],
    ['COM1', 'windows reserved device'],
    ['node_modules', 'reserved'],
    ['site.', 'trailing dot'],
    ['site ', 'trailing space'],
    ['what?', 'illegal character'],
    ['a'.repeat(215), 'too long'],
  ])('rejects "%s" (%s)', (name) => {
    expect(validateProjectName(name)).toBeTypeOf('string');
  });

  it('rejects control characters', () => {
    expect(validateProjectName(`bad${String.fromCharCode(7)}name`)).toBeTypeOf('string');
  });

  it('suggests a sanitised alternative', () => {
    expect(validateProjectName('Acme Website')).toContain('acme-website');
    expect(sanitizeProjectName('  ***  ')).toBe('my-client-site');
  });
});

describe('deriveProjectName', () => {
  it('takes the basename of a nested path', () => {
    expect(deriveProjectName('sites/acme-website', TEST_CWD)).toBe('acme-website');
  });

  it('strips trailing separators', () => {
    expect(deriveProjectName('acme-website/', TEST_CWD)).toBe('acme-website');
  });

  it('falls back to the cwd basename for "."', () => {
    expect(deriveProjectName('.', TEST_CWD)).toBe('ck-test');
  });
});

describe('validateUrl', () => {
  it('treats undefined, null and empty as explicitly absent', () => {
    expect(validateUrl(undefined)).toEqual({ value: null, error: null });
    expect(validateUrl(null)).toEqual({ value: null, error: null });
    expect(validateUrl('   ')).toEqual({ value: null, error: null });
  });

  it('accepts and normalises http(s) URLs', () => {
    expect(validateUrl('https://example.com/').value).toBe('https://example.com');
    expect(validateUrl('http://example.com').value).toBe('http://example.com');
    expect(validateUrl('https://sub.example.co.uk/path').value).toBe(
      'https://sub.example.co.uk/path',
    );
  });

  it.each(['example.com', 'ftp://example.com', 'javascript:alert(1)', 'https://', 'not a url'])(
    'rejects %s',
    (input) => {
      expect(validateUrl(input).error).toBeTypeOf('string');
    },
  );

  it('never invents a value when rejecting', () => {
    expect(validateUrl('nope').value).toBeNull();
  });
});

describe('validatePackageManager', () => {
  it.each(['npm', 'pnpm', 'yarn', 'bun'])('accepts %s', (pm) => {
    expect(validatePackageManager(pm)).toBeNull();
  });

  it.each(['NPM', 'deno', '', 'npm '])('rejects "%s"', (pm) => {
    expect(validatePackageManager(pm)).toBeTypeOf('string');
  });
});

describe('validateMode, validateLocale, validateSiteName', () => {
  it('accepts the two V1 modes only', () => {
    expect(validateMode('coming-soon')).toBeNull();
    expect(validateMode('full')).toBeNull();
    expect(validateMode('landing')).toBeTypeOf('string');
  });

  it('validates locales', () => {
    expect(validateLocale('en')).toBeNull();
    expect(validateLocale('en-GB')).toBeNull();
    expect(validateLocale('english')).toBeTypeOf('string');
  });

  it('validates site names', () => {
    expect(validateSiteName('Acme Ltd')).toBeNull();
    expect(validateSiteName('   ')).toBeTypeOf('string');
  });
});

describe('target directory', () => {
  it('classifies missing, empty and non-empty directories', () => {
    expect(inspectTargetDir('/anywhere', emptyFs)).toBe('missing');
    expect(inspectTargetDir('/anywhere', occupiedFs([]))).toBe('empty');
    expect(inspectTargetDir('/anywhere', occupiedFs(['.git']))).toBe('empty');
    expect(inspectTargetDir('/anywhere', occupiedFs(['index.html']))).toBe('non-empty');
  });

  it('accepts a missing directory', () => {
    const result = validateTargetDir('acme', { cwd: TEST_CWD, home: TEST_HOME, fs: emptyFs });
    expect(result.error).toBeNull();
    expect(result.state).toBe('missing');
  });

  it('refuses a non-empty directory rather than overwriting', () => {
    const result = validateTargetDir('acme', {
      cwd: TEST_CWD,
      home: TEST_HOME,
      fs: occupiedFs(['index.html']),
    });
    expect(result.error).toContain('not empty');
  });

  it('refuses the filesystem root and the home directory', () => {
    const root = validateTargetDir('/', { cwd: TEST_CWD, home: TEST_HOME, fs: emptyFs });
    expect(root.error).toBeTypeOf('string');

    const home = validateTargetDir(TEST_HOME, { cwd: TEST_CWD, home: TEST_HOME, fs: emptyFs });
    expect(home.error).toContain('home directory');
  });

  it('refuses an over-long path', () => {
    const result = validateTargetDir('a'.repeat(220), {
      cwd: TEST_CWD,
      home: TEST_HOME,
      fs: emptyFs,
    });
    expect(result.error).toContain('characters long');
  });
});
