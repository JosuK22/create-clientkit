import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASTRO_DOCUMENT_REALIZER,
  hasDocumentRealizer,
  selectDocumentRealizer,
} from '../src/adapters/document-realizers.js';
import { planManifest } from '../src/adapters/bridge.js';
import { ARCHITECTURE_IDS } from '../src/domain/dimensions.js';
import type { ArchitectureId, FeatureId, ProjectManifest } from '../src/domain/index.js';
import type { CliError } from '../src/errors.js';
import { createRegistry, findTemplatesRoot } from '../src/templates/registry.js';
import { TEST_CWD } from './helpers.js';

/**
 * Choosing who writes the document, rather than assuming.
 *
 * Until Stage 49 the bridge named Astro directly and it was safe by accident:
 * no non-Astro project can select a document-contributing feature, so the list
 * was always empty and every call returned early. Stage 48 measured what that
 * hid - running the same path against Next produced a role error from the Astro
 * composer, on a project that is not Astro.
 *
 * So the property under test is not "Astro still works". It is that the choice
 * is made from the resolved project, that a wrong choice cannot be made
 * silently, and that an architecture with no realization is refused by name
 * rather than handed to whichever one happens to be there.
 */

const TEMPLATES_ROOT = findTemplatesRoot(path.resolve(import.meta.dirname, '..', 'src'));
const v1Registry = createRegistry(TEMPLATES_ROOT);

const source = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');

const codeOnly = (file: string): string =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    const cli = error as CliError;
    return `${cli.message}\n${cli.hint ?? ''}`;
  }
  return '';
};

const astroManifest = (features: readonly FeatureId[]): ProjectManifest =>
  ({
    targetDir: path.join(TEST_CWD, 'acme-site'),
    projectName: 'acme-site',
    framework: 'astro',
    buildTool: 'astro',
    language: 'ts',
    styling: 'tailwind',
    uiLibrary: 'none',
    router: 'file-based',
    architecture: 'astro-standard',
    starter: 'coming-soon',
    features,
    site: {
      name: 'Acme Ltd',
      url: 'https://acme.example',
      description: 'Bespoke widgets.',
      locale: 'en-GB',
      author: null,
    },
    packageManager: 'npm',
    git: true,
    install: true,
  }) as ProjectManifest;

const planAstro = (features: readonly FeatureId[]) =>
  planManifest(astroManifest(features), {
    registry: v1Registry,
    cliVersion: '9.9.9',
    generatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'coming-soon',
    templateId: 'astro-tailwind',
  });

const planNext = (features: readonly FeatureId[]) =>
  planManifest(
    {
      ...astroManifest(features),
      framework: 'nextjs',
      buildTool: 'next',
      architecture: 'next-app',
      styling: 'tailwind',
    } as ProjectManifest,
    {
      registry: v1Registry,
      cliVersion: '9.9.9',
      generatedAt: '2026-01-01T00:00:00.000Z',
      mode: 'coming-soon',
      templateId: 'nextjs',
    },
  );

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('the realizer is chosen from the resolved architecture', () => {
  it('selects Astro for Astro', () => {
    const realizer = selectDocumentRealizer('astro-standard');
    expect(realizer).toBe(ASTRO_DOCUMENT_REALIZER);
    expect(realizer.architecture).toBe('astro-standard');
    expect(realizer.support.architecture).toBe('astro-standard');
  });

  it('refuses an architecture with no realization, by name', () => {
    for (const architecture of ['react-standard', 'angular-standard'] as const) {
      const message = refusal(() => selectDocumentRealizer(architecture));
      expect(message, architecture).toContain(`"${architecture}" has no document realization`);
      expect(message, architecture).toContain('no fallback on purpose');
    }
  });

  it('never hands one architecture to another', () => {
    /*
     * The defect Stage 48 measured. Astro's realizer is the only one
     * registered, and it is reachable only under its own id - so a Next
     * project cannot arrive at it however the list is ordered.
     */
    for (const architecture of ARCHITECTURE_IDS) {
      if (!hasDocumentRealizer(architecture)) continue;
      expect(selectDocumentRealizer(architecture).architecture).toBe(architecture);
    }
  });

  it('reports which architectures can write a document', () => {
    expect(hasDocumentRealizer('astro-standard')).toBe(true);
    // Next joined in Stage 51, for the canonical and nothing else.
    expect(hasDocumentRealizer('next-app')).toBe(true);
    for (const architecture of ['react-standard', 'angular-standard'] as const) {
      expect(hasDocumentRealizer(architecture), architecture).toBe(false);
    }
  });

  it('does not depend on the order realizers are registered', () => {
    // The match is on the architecture's own id, so the list order is not
    // consulted. Asserted structurally: nothing indexes the list.
    const code = codeOnly('src/adapters/document-realizers.ts');
    expect(code).toContain('REALIZERS.find((entry) => entry.architecture === architecture)');
    expect(code).not.toContain('REALIZERS[0]');
  });

  it('rejects an architecture the vocabulary does not know', () => {
    expect(refusal(() => selectDocumentRealizer('made-up' as ArchitectureId))).toContain(
      'has no document realization',
    );
  });
});

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

describe('the bridge names no architecture', () => {
  it('calls no Astro function directly', () => {
    const bridge = codeOnly('src/adapters/bridge.ts');
    for (const astroism of ['composeAstroDocument', 'realizeAstroDocument', 'ASTRO_REALIZATION']) {
      expect(bridge, `bridge.ts calls ${astroism}`).not.toContain(astroism);
    }
  });

  it('checks each plan against the selected realizer, not against Astro', () => {
    expect(codeOnly('src/adapters/bridge.ts')).toContain(
      'assertPlanRealizable(plan, realizer.support)',
    );
  });

  it('selects nothing when nothing was contributed', () => {
    /*
     * The reason a React or Next project still generates. Selecting a realizer
     * for an architecture that has none would refuse every project on it, so
     * the empty case returns before the choice is made.
     */
    expect(codeOnly('src/adapters/bridge.ts')).toContain(
      'if (documents.length === 0) return operations;',
    );
  });
});

// ---------------------------------------------------------------------------
// Behaviour is unchanged
// ---------------------------------------------------------------------------

describe('routing the call changed no output', () => {
  it('produces the same Astro project as before the boundary existed', () => {
    // The V1 goldens are the real proof; this asserts the composed path too.
    const paths = planAstro(['seo']).plan.operations.map((entry) => entry.path);
    expect(paths).toContain('src/components/DocumentHead.astro');
    expect(paths).toContain('src/components/DocumentHeadPageNotFound.astro');
  });

  it('leaves a project with no document contribution untouched', () => {
    const withoutFeature = planAstro([]).plan.operations.map((entry) => entry.path);
    expect(withoutFeature).not.toContain('src/components/DocumentHead.astro');
  });

  it('still generates every architecture that contributes nothing', () => {
    // Next has no realizer. It must still plan, because it contributes no
    // document and therefore never reaches the selector.
    expect(() => planNext([])).not.toThrow();
    expect(planNext([]).plan.operations.length).toBeGreaterThan(0);
  });

  it('is deterministic across repeated planning', () => {
    expect(JSON.stringify(planAstro(['seo']).plan.operations)).toBe(
      JSON.stringify(planAstro(['seo']).plan.operations),
    );
  });
});

// ---------------------------------------------------------------------------
// Refusal happens before anything is written
// ---------------------------------------------------------------------------

describe('a missing realization refuses before any write', () => {
  it('throws while planning, so no operation exists to apply', () => {
    let operations: unknown;
    expect(() => {
      operations = selectDocumentRealizer('react-standard');
    }).toThrow();
    expect(operations).toBeUndefined();
  });

  it('touches no filesystem while selecting', () => {
    const code = codeOnly('src/adapters/document-realizers.ts');
    for (const token of ['readFileSync', 'writeFileSync', 'node:fs', 'process.', 'globalThis']) {
      expect(code, `document-realizers.ts uses ${token}`).not.toContain(token);
    }
  });

  it('holds no mutable state', () => {
    const code = codeOnly('src/adapters/document-realizers.ts');
    expect(code).not.toMatch(/^let /m);
    expect(code).not.toMatch(/^var /m);
  });

  it('keeps the domain unaware that realizers exist', () => {
    // The boundary is an adapter concern. The domain names architectures, not
    // the things that write for them.
    for (const file of ['src/domain/document-emission.ts', 'src/domain/document-scope.ts']) {
      expect(codeOnly(file), `${file} imports a realizer`).not.toContain('document-realizers');
    }
  });
});
