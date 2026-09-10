import { describe, expect, it } from 'vitest';

import { loadConfigFile } from '../src/context/fromFile.js';
import { CliError } from '../src/errors.js';
import { TEST_CWD } from './helpers.js';

function load(content: string) {
  return loadConfigFile('preset.json', { cwd: TEST_CWD, readFile: () => content });
}

describe('loadConfigFile', () => {
  it('reads a complete, valid preset', () => {
    const input = load(
      JSON.stringify({
        dir: 'acme-website',
        site: {
          name: 'Acme Ltd',
          url: 'https://acme.example/',
          description: 'Bespoke widgets.',
          locale: 'en-GB',
          author: 'Studio',
        },
        template: { id: 'astro-tailwind', version: '1.0.0', mode: 'full' },
        packageManager: 'pnpm',
        git: false,
        install: false,
      }),
    );

    expect(input).toEqual({
      dir: 'acme-website',
      siteName: 'Acme Ltd',
      siteUrl: 'https://acme.example',
      siteDescription: 'Bespoke widgets.',
      locale: 'en-GB',
      author: 'Studio',
      templateId: 'astro-tailwind',
      templateVersion: '1.0.0',
      mode: 'full',
      packageManager: 'pnpm',
      git: false,
      install: false,
    });
  });

  it('accepts a partial preset', () => {
    expect(load(JSON.stringify({ git: false }))).toEqual({ git: false });
    expect(load('{}')).toEqual({});
  });

  it('preserves an explicit null URL as absent', () => {
    expect(load(JSON.stringify({ site: { url: null } }))).toEqual({ siteUrl: null });
  });

  it('rejects malformed JSON', () => {
    expect(() => load('{ "git": true,')).toThrow(/not valid JSON/);
  });

  it('rejects a non-object top level', () => {
    expect(() => load('[]')).toThrow(/JSON object/);
    expect(() => load('"hello"')).toThrow(/JSON object/);
  });

  it.each([
    [{ nope: 1 }, /Unknown key "nope"/],
    [{ site: { nope: 1 } }, /Unknown key "nope"/],
    [{ template: { nope: 1 } }, /Unknown key "nope"/],
  ])('rejects unknown keys: %j', (config, pattern) => {
    expect(() => load(JSON.stringify(config))).toThrow(pattern);
  });

  it.each([
    [{ git: 'yes' }, /must be true or false/],
    [{ install: 1 }, /must be true or false/],
    [{ site: { name: 42 } }, /must be a string/],
    [{ site: 'acme' }, /must be an object/],
  ])('rejects wrong types: %j', (config, pattern) => {
    expect(() => load(JSON.stringify(config))).toThrow(pattern);
  });

  it('does not bypass validation', () => {
    expect(() => load(JSON.stringify({ site: { url: 'ftp://acme.example' } }))).toThrow(/site.url/);
    expect(() => load(JSON.stringify({ packageManager: 'deno' }))).toThrow(/packageManager/);
    expect(() => load(JSON.stringify({ template: { mode: 'landing' } }))).toThrow(/template.mode/);
    expect(() => load(JSON.stringify({ dir: 'Acme Website' }))).toThrow(/"dir" is invalid/);
    expect(() => load(JSON.stringify({ site: { locale: 'english' } }))).toThrow(/site.locale/);
  });

  it('reports a missing file as a CliError with a hint', () => {
    try {
      loadConfigFile('missing.json', {
        cwd: TEST_CWD,
        readFile: () => {
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain('Config file not found');
      expect((error as CliError).hint).toContain('--from');
    }
  });

  it('only accepts JSON, never executable config', () => {
    expect(() => load('module.exports = { git: false }')).toThrow(/not valid JSON/);
  });
});
