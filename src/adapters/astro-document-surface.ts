import type { DocumentSurfaceOwnership } from '../domain/document-surface.js';
import { assertFieldsAreComposable } from '../domain/document-surface.js';
import type { EmissionField } from '../domain/document-emission.js';
import type { ArchitectureDefinition } from '../domain/roles.js';
import { resolveRole } from '../domain/roles.js';
import type { FileOperation } from '../generate/files.js';
import { CliError } from '../errors.js';

/**
 * Where Astro's composed document head goes, and what it is allowed to own.
 *
 * ## The render site Stage 39 could not find
 *
 * Astro's document lives in `BaseLayout.astro`, whose bytes are captured by the
 * V1 goldens. Stage 39 concluded that realized source had nowhere to render
 * without changing them. The resolution is that it only needs somewhere when
 * there is something to render:
 *
 *     no contributions  ->  no component, no import, no change   (V1 bytes)
 *     contributions     ->  a component, imported and rendered
 *
 * The default path is byte-identical because it does nothing at all - not
 * because it carefully reproduces the original. That is the strongest form of
 * the guarantee available, and it is why this composes rather than replaces.
 *
 * ## Partial ownership, and why Twitter is not here
 *
 * `Seo.astro` is *more capable* than the semantic contract for three things:
 * it emits `og:image` and `twitter:image` when `SEO.image` is configured, and
 * upgrades `twitter:card` to `SEO.twitterCard` once an image exists, while the
 * semantic `TwitterContract` hard-codes `'summary'` and models no image.
 * `StructuredData.astro` likewise emits email, telephone, `sameAs` and a
 * location the `OrganizationContract` does not carry.
 *
 * So the composed surface owns the fields where it loses nothing, and the
 * template keeps the rest. Open Graph splits cleanly - the semantic block's six
 * fields are disjoint from `og:image`. Twitter does not, because `card` is
 * owned by both with the template winning, so it stays template-owned whole.
 *
 * This file is architecture-specific by design. The domain does not know that
 * Astro exists; it knows there is a vocabulary of document fields and that
 * somebody owns each one.
 */
export const ASTRO_DOCUMENT_OWNERSHIP: DocumentSurfaceOwnership = {
  architecture: 'astro-standard',
  composed: ['title', 'description', 'robots', 'canonical', 'open-graph'],
  templateOwnedBecause: {
    twitter:
      'Seo.astro upgrades twitter:card to SEO.twitterCard once a social image is configured, ' +
      'and emits twitter:image; the semantic contract models neither',
    'structured-data':
      'StructuredData.astro emits email, telephone, sameAs and location from the project ' +
      'configuration, which OrganizationContract does not carry',
  },
};

/**
 * The line in Astro's shell after which composed head entries belong.
 *
 * An anchor into a file this adapter ships, matched exactly once. Astro's head
 * is ordered - the descriptive tags come from `<Seo />` and the composed
 * entries follow them - so the position is part of the architecture rather than
 * an arbitrary insertion point.
 *
 * Verified against the shipped template by a test, so a template edit that
 * moved this line fails here rather than silently producing a document with the
 * composed entries in the wrong place.
 */
export const ASTRO_HEAD_ANCHOR =
  '    <Seo title={title} description={description} noindex={noindex} />';

/**
 * Both paths come from the architecture, never from a literal here.
 *
 * The domain names the surfaces - `app.document.head` and `app.layout` - and
 * the architecture says where they live. Hard-coding either would put a second
 * copy of that decision in a file that has no business making it, and the two
 * would drift the first time the folder shape changed.
 */
function headPath(architecture: ArchitectureDefinition): string {
  return resolveRole(architecture, 'app.document.head');
}

function shellPath(architecture: ArchitectureDefinition): string {
  return resolveRole(architecture, 'app.layout');
}

/**
 * A head entry, already realized into Astro source by whoever composed it.
 *
 * Stage 40 does not produce these - realization is a later stage - but the
 * surface has to accept something, and a test-only contributor proves the path.
 * The type is deliberately narrow: a line of Astro source and the field it
 * renders, so ownership can be checked before anything is written.
 */
export interface AstroHeadEntry {
  /** Which document field this renders, for the ownership check. */
  readonly field: EmissionField;
  /** The Astro source line. */
  readonly source: string;
  /** Who contributed it, for diagnostics. */
  readonly owner: string;
}

/**
 * Adds the composed head to a planned Astro project, or leaves it alone.
 *
 * Modelled on `applyMerges`: it finds the planned shell by path and replaces
 * its content, refusing rather than creating when the file is missing. Pure -
 * operations in, operations out, no filesystem.
 *
 * With no entries it returns the operations unchanged, by reference. That is
 * the byte-identity guarantee: the default path performs no work, so there is
 * nothing for it to get wrong.
 */
export function composeAstroDocumentHead(
  architecture: ArchitectureDefinition,
  operations: readonly FileOperation[],
  entries: readonly AstroHeadEntry[],
): readonly FileOperation[] {
  if (entries.length === 0) return operations;

  const SHELL_PATH = shellPath(architecture);
  const ASTRO_DOCUMENT_HEAD_PATH = headPath(architecture);

  assertFieldsAreComposable(
    ASTRO_DOCUMENT_OWNERSHIP,
    entries.map((entry) => entry.field),
  );

  const shell = operations.find((operation) => operation.path === SHELL_PATH);
  if (shell === undefined || shell.type !== 'write') {
    throw new CliError(`The composed document head has nothing to render into.`, {
      hint: `Nothing planned produces "${SHELL_PATH}".`,
    });
  }

  const occurrences = shell.content.split(ASTRO_HEAD_ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new CliError(`The composed document head could not find its place in "${SHELL_PATH}".`, {
      hint:
        `Expected exactly one anchor line, found ${occurrences}. The shell this ` +
        'architecture ships has changed shape, and inserting blindly would put the ' +
        'composed entries somewhere nobody chose.',
    });
  }

  // Sorted by field, then owner: the order comes from the document vocabulary
  // rather than from how the entries arrived. Nothing reads it as precedence.
  const ordered = [...entries].sort(
    (a, b) => a.field.localeCompare(b.field) || a.owner.localeCompare(b.owner),
  );

  const component = [
    '---',
    '/**',
    ' * Composed document head.',
    ' *',
    ' * Generated because something contributed to it. Every entry below was',
    ' * decided by the document pipeline; this file only renders them.',
    ' */',
    '---',
    '',
    ...ordered.map((entry) => entry.source),
    '',
  ].join('\n');

  const withImport = shell.content.replace(
    ASTRO_HEAD_ANCHOR,
    `${ASTRO_HEAD_ANCHOR}\n    <DocumentHead />`,
  );

  const composed: readonly FileOperation[] = [
    ...operations.filter((operation) => operation.path !== SHELL_PATH),
    {
      type: 'write' as const,
      path: SHELL_PATH,
      content: addImport(
        withImport,
        `import DocumentHead from '${relativeFromShell(SHELL_PATH, ASTRO_DOCUMENT_HEAD_PATH)}';`,
        SHELL_PATH,
      ),
      origin: `${shell.origin} + composed document head`,
    },
    {
      type: 'write' as const,
      path: ASTRO_DOCUMENT_HEAD_PATH,
      content: component,
      origin: 'composed document head',
    },
  ];

  return [...composed].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Adds an import to an Astro frontmatter block, keeping the existing order.
 *
 * Appended after the last existing import rather than sorted in, because the
 * shell's import order is the template author's and reordering it would change
 * bytes for a reason nobody asked for.
 */
function relativeFromShell(shell: string, target: string): string {
  const shellDirectory = shell.split('/').slice(0, -1);
  const targetParts = target.split('/');
  let shared = 0;
  while (
    shared < shellDirectory.length &&
    shared < targetParts.length - 1 &&
    shellDirectory[shared] === targetParts[shared]
  ) {
    shared += 1;
  }
  const up = Array.from({ length: shellDirectory.length - shared }, () => '..');
  const down = targetParts.slice(shared);
  return [...up, ...down].join('/');
}

function addImport(content: string, statement: string, shell: string): string {
  const lines = content.split('\n');
  let lastImport = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && line.startsWith('import ')) lastImport = index;
    if (line === '---' && lastImport !== -1) break;
  }
  if (lastImport === -1) {
    throw new CliError('The composed document head found no imports to join.', {
      hint: `"${shell}" has no frontmatter import block.`,
    });
  }
  return [...lines.slice(0, lastImport + 1), statement, ...lines.slice(lastImport + 1)].join('\n');
}
