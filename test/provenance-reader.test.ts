import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { planManifest } from '../src/adapters/bridge.js';
import type { ProjectManifest } from '../src/domain/index.js';
import {
  interpretProvenance,
  PROVENANCE_DOCUMENT,
  readProvenance,
  type ProvenanceRead,
} from '../src/domain/provenance-reader.js';
import { PROVENANCE_FILE } from '../src/generate/provenance.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * What a provenance document proves, and what it does not.
 *
 * The reader's whole reason for existing is one distinction: a document can be
 * perfectly **readable** and still not be **sufficient**. Every project
 * generated up to 1.0.2 is exactly that - well-formed, understandable, and
 * silent about the stack. Those two states have to stay apart, because the
 * moment they collapse into one boolean the tool starts filling in the gap, and
 * Stage 56 measured what filling it in costs.
 *
 * So most of this file is about the answers that are not "yes".
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const registry = createRegistry(TEMPLATES_ROOT);
const CLI_VERSION = '1.0.2';

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
const realDocument = (over: Partial<ProjectManifest> = {}): string => {
  const operation = planManifest(manifestFor(over), {
    registry,
    cliVersion: CLI_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: (over.starter ?? 'full') as 'coming-soon' | 'full',
  }).plan.operations.find((entry) => entry.path === PROVENANCE_FILE);
  if (operation?.type !== 'write') throw new Error('no provenance was written');
  return operation.content;
};

const read = (text: string, cliVersion = CLI_VERSION): ProvenanceRead =>
  interpretProvenance(text, cliVersion);

/** The same document with one edit, so each test changes exactly one thing. */
const edited = (mutate: (document: Record<string, unknown>) => void): string => {
  const document = JSON.parse(realDocument()) as Record<string, unknown>;
  mutate(document);
  return JSON.stringify(document, null, 2);
};

/** A 1.0.2 document: everything the writer produced, minus the stack. */
const legacyDocument = (): string => edited((document) => delete document.stack);

// ---------------------------------------------------------------------------
// The name
// ---------------------------------------------------------------------------

describe('the reader and the writer agree on the file', () => {
  it('looks for the file the generator writes', () => {
    /*
     * The reader keeps its own copy of the name rather than importing the
     * writer's, because a domain module reaching into the generator would
     * invert the dependency direction. This is what stops the duplication
     * becoming a disagreement.
     */
    expect(PROVENANCE_DOCUMENT).toBe(PROVENANCE_FILE);
  });
});

// ---------------------------------------------------------------------------
// Usable
// ---------------------------------------------------------------------------

describe('a document that records the stack is usable', () => {
  it('reads a freshly generated project', () => {
    const result = read(realDocument());
    expect(result.status).toBe('usable');
  });

  it('returns the stack it read, not one it assembled', () => {
    const result = read(realDocument({ styling: 'bootstrap', uiLibrary: 'mui' }));
    expect(result.status === 'usable' ? result.stack : null).toEqual({
      framework: 'react',
      buildTool: 'vite',
      language: 'ts',
      styling: 'bootstrap',
      uiLibrary: 'mui',
      router: 'none',
      architecture: 'react-standard',
    });
  });

  it('reads all seven dimensions', () => {
    const result = read(realDocument());
    const stack = result.status === 'usable' ? result.stack : {};
    expect(Object.keys(stack).sort()).toEqual([
      'architecture',
      'buildTool',
      'framework',
      'language',
      'router',
      'styling',
      'uiLibrary',
    ]);
  });

  it('hands back the rest of the document too', () => {
    const result = read(realDocument());
    const document = result.status === 'usable' ? result.document : undefined;
    expect(document?.cliVersion).toBe(CLI_VERSION);
    expect(document?.template.framework).toBe('react');
    expect(document?.config.siteName).toBe('Acme Ltd');
  });

  it('reads the same document to the same verdict every time', () => {
    const text = realDocument({ styling: 'bootstrap' });
    expect(JSON.stringify(read(text))).toBe(JSON.stringify(read(text)));
  });

  it('reads an Astro document as Astro', () => {
    const astro = edited((document) => {
      document.stack = {
        framework: 'astro',
        buildTool: 'astro',
        language: 'ts',
        styling: 'tailwind',
        uiLibrary: 'none',
        router: 'file-based',
        architecture: 'astro-standard',
      };
    });
    const result = read(astro);
    expect(result.status === 'usable' ? result.stack.framework : null).toBe('astro');
  });
});

// ---------------------------------------------------------------------------
// Readable, and not enough
// ---------------------------------------------------------------------------

describe('a 1.0.2 document is readable but insufficient', () => {
  it('is not rejected: it is a valid document', () => {
    const result = read(legacyDocument());
    expect(result.status).toBe('insufficient');
    expect(result.status === 'insufficient' ? result.missing : null).toBe('stack');
  });

  it('still hands back everything the document does establish', () => {
    const result = read(legacyDocument());
    const document = result.status === 'insufficient' ? result.document : undefined;
    expect(document?.cliVersion).toBe(CLI_VERSION);
    expect(document?.mode).toBe('full');
    expect(document?.template.id).toBe('react-vite');
    expect(document?.config.projectName).toBe('acme-site');
  });

  it('invents no stack, of any shape', () => {
    /*
     * The assertion this module exists for. There is no `stack` on the result,
     * no partial one, and nothing anywhere in it naming a framework the
     * document did not.
     */
    const result = read(legacyDocument());
    expect(result).not.toHaveProperty('stack');
    const serialised = JSON.stringify(result);
    for (const guess of ['astro', 'tailwind', 'file-based', 'astro-standard', 'vite']) {
      expect(serialised.toLowerCase(), `the reader volunteered "${guess}"`).not.toContain(
        `"${guess}"`,
      );
    }
  });

  it('says why, in terms of what is missing rather than what is wrong', () => {
    const result = read(legacyDocument());
    const because = result.status === 'insufficient' ? result.because : '';
    expect(because).toContain('records no stack');
    expect(because).toMatch(/will not guess/i);
  });

  it('is a different answer from every failure state', () => {
    // readable ≠ upgrade-capable, and neither is the same as broken.
    expect(read(legacyDocument()).status).not.toBe('invalid');
    expect(read(legacyDocument()).status).not.toBe('malformed');
    expect(read(legacyDocument()).status).not.toBe('missing');
    expect(read(legacyDocument()).status).not.toBe('unsupported');
    expect(read(legacyDocument()).status).not.toBe('usable');
  });
});

// ---------------------------------------------------------------------------
// Missing
// ---------------------------------------------------------------------------

describe('a project with no provenance', () => {
  it('reports the document as missing', () => {
    const result = readProvenance(
      path.join(TEST_CWD, 'somewhere'),
      () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      CLI_VERSION,
    );
    expect(result.status).toBe('missing');
  });

  it('does not look at anything else in the directory', () => {
    // A reader that fell back to package.json would ask for a second file.
    const asked: string[] = [];
    readProvenance(
      path.join(TEST_CWD, 'somewhere'),
      (file) => {
        asked.push(path.basename(file));
        throw new Error('ENOENT');
      },
      CLI_VERSION,
    );
    expect(asked).toEqual([PROVENANCE_DOCUMENT]);
  });

  it('reads exactly one file when the document is there', () => {
    const asked: string[] = [];
    readProvenance(
      path.join(TEST_CWD, 'site'),
      (file) => {
        asked.push(path.basename(file));
        return realDocument();
      },
      CLI_VERSION,
    );
    expect(asked).toEqual([PROVENANCE_DOCUMENT]);
  });

  it('says ClientKit will not work it out from the project', () => {
    const result = readProvenance(
      TEST_CWD,
      () => {
        throw new Error('ENOENT');
      },
      CLI_VERSION,
    );
    expect(result.status === 'missing' ? result.because : '').toMatch(
      /does not inspect a project/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed and invalid
// ---------------------------------------------------------------------------

describe('a document that is not a provenance document', () => {
  it('reports invalid JSON as malformed', () => {
    expect(read('{ not json').status).toBe('malformed');
    expect(read('').status).toBe('malformed');
  });

  it('reports a JSON primitive as invalid', () => {
    for (const text of ['"a string"', '42', 'true', 'null', '[]']) {
      expect(read(text).status, text).toBe('invalid');
    }
  });

  it('rejects a document with no cliVersion', () => {
    expect(read(edited((d) => delete d.cliVersion)).status).toBe('invalid');
    expect(read(edited((d) => (d.cliVersion = 7))).status).toBe('invalid');
  });

  it('rejects missing or mistyped top-level fields', () => {
    for (const field of ['template', 'mode', 'generatedAt', 'config']) {
      expect(read(edited((d) => delete d[field])).status, field).toBe('invalid');
    }
  });

  it('rejects an incomplete template block', () => {
    for (const field of ['id', 'version', 'framework', 'frameworkVersion']) {
      const text = edited((d) => delete (d.template as Record<string, unknown>)[field]);
      expect(read(text).status, field).toBe('invalid');
    }
  });

  it('rejects an incomplete config block', () => {
    for (const field of [
      'projectName',
      'siteName',
      'siteUrl',
      'locale',
      'packageManager',
      'features',
    ]) {
      const text = edited((d) => delete (d.config as Record<string, unknown>)[field]);
      expect(read(text).status, field).toBe('invalid');
    }
  });

  it('accepts a null siteUrl, which is a real answer', () => {
    const text = edited((d) => ((d.config as Record<string, unknown>).siteUrl = null));
    expect(read(text).status).toBe('usable');
  });

  it('rejects a features list that is not a list of strings', () => {
    expect(
      read(edited((d) => ((d.config as Record<string, unknown>).features = 'seo'))).status,
    ).toBe('invalid');
    expect(read(edited((d) => ((d.config as Record<string, unknown>).features = [1]))).status).toBe(
      'invalid',
    );
  });

  it('rejects an unknown top-level field', () => {
    expect(read(edited((d) => (d.somethingElse = true))).status).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// A stack that is present but wrong
// ---------------------------------------------------------------------------

describe('a stack that does not hold up', () => {
  const withStack = (mutate: (stack: Record<string, unknown>) => void): string =>
    edited((document) => mutate(document.stack as Record<string, unknown>));

  it('rejects a stack that is not an object', () => {
    for (const value of ['"astro"', '[]', '5']) {
      expect(read(edited((d) => (d.stack = JSON.parse(value)))).status, value).toBe('invalid');
    }
  });

  it('rejects a stack missing any one dimension', () => {
    for (const dimension of [
      'framework',
      'buildTool',
      'language',
      'styling',
      'uiLibrary',
      'router',
      'architecture',
    ]) {
      const result = read(withStack((stack) => delete stack[dimension]));
      expect(result.status, dimension).toBe('invalid');
      expect(result.status === 'invalid' ? result.because : '', dimension).toContain(dimension);
    }
  });

  it('rejects a dimension whose value ClientKit does not know', () => {
    const result = read(withStack((stack) => (stack.framework = 'svelte')));
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' ? result.because : '').toContain('svelte');
  });

  it('rejects a dimension of the wrong type rather than coercing it', () => {
    expect(read(withStack((stack) => (stack.styling = 42))).status).toBe('invalid');
    expect(read(withStack((stack) => (stack.router = null))).status).toBe('invalid');
  });

  it('rejects a non-string even when it would stringify into a real value', () => {
    /*
     * The case that matters, and the one the other test cannot reach: `42` and
     * `null` stringify to nonsense, so the vocabulary check would refuse them
     * whether or not the type check existed. `["none"]` stringifies to exactly
     * `"none"` - a value ClientKit does know - so only refusing the wrong
     * *type* stops a document saying one thing and being read as another.
     *
     * A mutation that replaced the type check with `String(recorded)` survived
     * until this existed.
     */
    expect(String(['none'])).toBe('none');
    expect(read(withStack((stack) => (stack.uiLibrary = ['none']))).status).toBe('invalid');
    expect(read(withStack((stack) => (stack.router = ['file-based']))).status).toBe('invalid');
    expect(read(withStack((stack) => (stack.framework = { toString: () => 'astro' }))).status).toBe(
      'invalid',
    );
  });

  it('rejects a stack carrying a dimension that is not one', () => {
    expect(read(withStack((stack) => (stack.starter = 'full'))).status).toBe('invalid');
  });

  it('never reports a wrong stack as insufficient', () => {
    // Insufficient means "the document does not say"; a stack that says
    // something unreadable is a different problem and must not be softened
    // into the state that a 1.0.2 project is in.
    expect(read(withStack((stack) => (stack.framework = 'svelte'))).status).not.toBe(
      'insufficient',
    );
    expect(read(withStack((stack) => delete stack.router)).status).not.toBe('insufficient');
  });
});

// ---------------------------------------------------------------------------
// Documents from the future
// ---------------------------------------------------------------------------

describe('a document written by a newer ClientKit', () => {
  it('is unsupported rather than read optimistically', () => {
    const result = read(
      edited((d) => (d.cliVersion = '2.0.0')),
      '1.0.2',
    );
    expect(result.status).toBe('unsupported');
    expect(result.status === 'unsupported' ? result.recordedVersion : '').toBe('2.0.0');
  });

  it('is judged on the version, not on whether the JSON happened to parse', () => {
    // The document below is structurally perfect. Being from the future is the
    // whole objection: fields this build does not know about may be present,
    // and parsing succeeding says nothing about understanding them.
    const result = read(
      edited((d) => (d.cliVersion = '1.0.3')),
      '1.0.2',
    );
    expect(result.status).toBe('unsupported');
  });

  it('accepts a document from an older ClientKit', () => {
    expect(
      read(
        edited((d) => (d.cliVersion = '1.0.0')),
        '1.0.2',
      ).status,
    ).toBe('usable');
  });

  it('accepts a document from this exact ClientKit', () => {
    expect(read(realDocument(), CLI_VERSION).status).toBe('usable');
  });

  it('checks the version before complaining about shape', () => {
    // A future document may legitimately look wrong to this build; saying
    // "invalid" would blame the document for this CLI's age.
    const futureShape = JSON.stringify({ cliVersion: '9.9.9', somethingNew: true });
    expect(read(futureShape, '1.0.2').status).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

describe('the reader only reads', () => {
  it('touches no filesystem API of its own', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'provenance-reader.ts'),
      'utf8',
    );
    for (const forbidden of [
      'node:fs',
      'node:child_process',
      'node:process',
      'node:os',
      'writeFile',
      'mkdir',
      'rmSync',
      'execSync',
    ]) {
      expect(source, `the reader references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('does not reach for the generator, a template or an adapter', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'domain', 'provenance-reader.ts'),
      'utf8',
    );
    for (const forbidden of ["from '../generate/", "from '../adapters/", "from '../templates/"]) {
      expect(source, `the reader imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('returns the same verdict however often it is asked', () => {
    const text = legacyDocument();
    const once = JSON.stringify(read(text));
    expect(JSON.stringify(read(text))).toBe(once);
    expect(JSON.stringify(read(text))).toBe(once);
  });

  it('does not modify the text it was given', () => {
    const text = realDocument();
    const copy = `${text}`;
    read(text);
    expect(text).toBe(copy);
  });
});
