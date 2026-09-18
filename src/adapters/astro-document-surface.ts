import type { DocumentSurfaceOwnership } from '../domain/document-surface.js';
import { assertFieldsAreComposable } from '../domain/document-surface.js';
import type { EmissionField } from '../domain/document-emission.js';
import type { HandoverCapability } from '../domain/document-handover.js';
import { assertHandoverIsCovered, fieldsToHandOver } from '../domain/document-handover.js';
import type { DocumentBinding } from '../domain/document-value.js';
import { collectAstroImports, renderAstroImports } from './astro-bindings.js';
import { ASTRO_SEO_HANDOVER_FIELDS, renderAstroSeoSource } from './astro-seo-source.js';
import type { DocumentTarget } from '../domain/document-scope.js';
import { describeTarget } from '../domain/document-scope.js';
import type { ArchitectureDefinition, FileRole } from '../domain/roles.js';
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
  /**
   * The bindings the source refers to, so its imports can be written.
   *
   * Stage 41's probe generated `{SITE.name}` and the build failed with
   * `ReferenceError: SITE is not defined`, because knowing how a value is
   * spelled says nothing about what makes the spelling resolvable. An entry
   * therefore declares which bindings it used, and the surface asks the
   * binding table what those need in scope.
   *
   * Semantic bindings, not symbols: the entry names `site.name` and never
   * `SITE`, so the one place that knows Astro's spelling stays the one place.
   */
  readonly bindings: readonly DocumentBinding[];
}

/**
 * One target's document, already realized, waiting to be put somewhere.
 *
 * The target is carried rather than inferred. Stage 42's surface took entries
 * alone, so everything it produced rendered in the shell and therefore on every
 * page - a synthetic canonical aimed at nothing in particular turned up on the
 * 404. The target is the whole difference between a document and a document
 * *for a page*, and losing it is how page-scoped semantics become site-wide.
 *
 * It comes from the semantic layer unchanged. Nothing here reads a scope,
 * combines two of them, or decides which is more specific; Stage 33 did all of
 * that, and this only knows that a resolved document belongs to a target.
 */
export interface AstroDocumentComposition {
  readonly target: DocumentTarget;
  readonly entries: readonly AstroHeadEntry[];
}

/**
 * Adds the composed heads to a planned Astro project, or leaves it alone.
 *
 * Modelled on `applyMerges`: it finds planned files by path and replaces their
 * content, refusing rather than creating when one is missing. Pure - operations
 * in, operations out, no filesystem, and no state outside this call.
 *
 * With no compositions it returns the operations unchanged, by reference. That
 * is the byte-identity guarantee: the default path performs no work, so there
 * is nothing for it to get wrong.
 */
export function composeAstroDocument(
  architecture: ArchitectureDefinition,
  operations: readonly FileOperation[],
  compositions: readonly AstroDocumentComposition[],
): readonly FileOperation[] {
  if (compositions.length === 0) return operations;

  const SHELL_PATH = shellPath(architecture);
  const ASTRO_DOCUMENT_HEAD_PATH = headPath(architecture);
  const METADATA_PATH = resolveRole(architecture, 'app.document.metadata');

  assertTargetsAreDistinct(compositions);

  const entries = compositions.flatMap((composition) => composition.entries);
  if (entries.length === 0) return operations;

  assertFieldsAreComposable(
    ASTRO_DOCUMENT_OWNERSHIP,
    entries.map((entry) => entry.field),
  );

  /*
   * The handover. Every field about to be composed is taken off the template in
   * the same step that adds it to the composed head, so the two can never
   * disagree - which is the disagreement Stage 41 measured as two titles and
   * two canonicals in one document.
   *
   * The union across every target, because `Seo.astro` is one shared component:
   * which fields the composition owns is a decision about the project, and
   * which values each page states is what the target decides. Handing a field
   * over for one page only is not something a shared component can express.
   */
  const handedOver = fieldsToHandOver(
    ASTRO_DOCUMENT_OWNERSHIP,
    ASTRO_SEO_HANDOVER,
    entries.map((entry) => entry.field),
  );

  const metadata = operations.find((operation) => operation.path === METADATA_PATH);
  if (metadata === undefined || metadata.type !== 'write') {
    throw new CliError('The document fields have no component to be handed over from.', {
      hint: `Nothing planned produces "${METADATA_PATH}".`,
    });
  }
  if (metadata.content !== renderAstroSeoSource([])) {
    throw new CliError(`"${METADATA_PATH}" is not the component the handover model describes.`, {
      hint:
        'The segment model reproduces the shipped component exactly, and this planned file ' +
        'differs from it. Handing fields over from source the model does not describe would ' +
        'remove whichever lines it happened to match.',
    });
  }

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

  /*
   * The template gives a field up once, for the whole project, so every target
   * has to state every field that left. Checked before anything is written: a
   * target missing one renders a document quietly without it, which is the
   * mirror of the duplicate and just as invisible to a build.
   */
  assertHandoverIsCovered(
    handedOver,
    compositions.map((composition) => ({
      target: composition.target,
      fields: composition.entries.map((entry) => entry.field),
    })),
  );

  /*
   * The site-wide document is always present by this point: the coverage check
   * refuses a set without one, because it is what every page that states
   * nothing of its own falls back to. So there is no second branch here for a
   * missing fallback - a branch nothing can reach is a branch nobody can prove.
   */
  const siteEntries =
    compositions.find((composition) => composition.target.kind === 'site')?.entries ?? [];

  /*
   * The slot is what makes a page-specific composition replace the site-wide one
   * rather than join it.
   *
   * Astro renders a named slot's fallback only when nothing fills it, which is
   * exactly the specificity Stage 33 defined: a page that states its own
   * document uses it, and a page that says nothing - including one the developer
   * adds later, which ClientKit never sees - inherits the site's. No condition,
   * no page list, and no way for both to render.
   */
  const slot = `${ASTRO_HEAD_ANCHOR}\n    <slot name="head"><DocumentHead /></slot>`;

  const rewritten = new Map<string, FileOperation>();

  rewritten.set(METADATA_PATH, {
    // The other half of the handover: the template component, rebuilt without
    // the fields that have just moved. Rendered from the segment model rather
    // than edited, so nothing is removed that the model does not describe.
    type: 'write',
    path: METADATA_PATH,
    content: renderAstroSeoSource(handedOver),
    origin: `${metadata.origin} - ${handedOver.join(', ')} handed over`,
  });

  const shellWithSlot = shell.content.replace(ASTRO_HEAD_ANCHOR, slot);
  rewritten.set(SHELL_PATH, {
    type: 'write',
    path: SHELL_PATH,
    content: addImport(
      shellWithSlot,
      `import DocumentHead from '${relativeFromShell(SHELL_PATH, ASTRO_DOCUMENT_HEAD_PATH)}';`,
      SHELL_PATH,
    ),
    origin: `${shell.origin} + composed document head`,
  });

  rewritten.set(ASTRO_DOCUMENT_HEAD_PATH, {
    type: 'write',
    path: ASTRO_DOCUMENT_HEAD_PATH,
    content: renderHeadComponent(architecture, ASTRO_DOCUMENT_HEAD_PATH, siteEntries, 'the site'),
    origin: 'composed document head',
  });

  for (const composition of compositions) {
    // The site's document was handled above; everything else names a page, and
    // this is also what narrows the target so its role can be read.
    if (composition.target.kind !== 'page') continue;
    const role = composition.target.role;
    const componentPath = pageHeadPath(architecture, role);
    const componentName = pageHeadName(role);
    const pagePath = pageFilePath(architecture, role);

    const planned = rewritten.get(pagePath) ?? operations.find((entry) => entry.path === pagePath);
    if (planned === undefined || planned.type !== 'write') {
      throw new CliError(
        `The composed head for ${describeTarget(composition.target)} has no page to render in.`,
        {
          hint:
            `Nothing planned produces "${pagePath}". A composition aimed at a page this ` +
            'project does not have cannot be rendered anywhere, and rendering it site-wide ' +
            'would put one page’s document on every page.',
        },
      );
    }

    rewritten.set(componentPath, {
      type: 'write',
      path: componentPath,
      content: renderHeadComponent(
        architecture,
        componentPath,
        composition.entries,
        describeTarget(composition.target),
      ),
      origin: `composed document head for ${role}`,
    });
    rewritten.set(pagePath, {
      type: 'write',
      path: pagePath,
      content: fillHeadSlot(
        planned.content,
        pagePath,
        SHELL_PATH,
        componentName,
        relativeFromShell(pagePath, componentPath),
      ),
      origin: `${planned.origin} + composed document head`,
    });
  }

  const composed: readonly FileOperation[] = [
    ...operations.filter((operation) => !rewritten.has(operation.path)),
    ...rewritten.values(),
  ];

  return [...composed].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * One composed component, for whichever target asked for it.
 *
 * Identical work for the site and for a page: the target decides *where* the
 * component is rendered, never how it is built. Entries are ordered by field
 * then owner - the document's vocabulary, not the order they arrived in - and
 * nothing downstream reads that order as precedence.
 */
function renderHeadComponent(
  architecture: ArchitectureDefinition,
  componentPath: string,
  entries: readonly AstroHeadEntry[],
  description: string,
): string {
  const ordered = [...entries].sort(
    (a, b) => a.field.localeCompare(b.field) || a.owner.localeCompare(b.owner),
  );

  /*
   * What the entries need in scope, asked of the binding table rather than
   * guessed from their source. Collected across every entry so two that both
   * read the site configuration produce one import.
   */
  const imports = renderAstroImports(
    collectAstroImports(ordered.flatMap((entry) => entry.bindings)),
    (role) => relativeFromShell(componentPath, resolveRole(architecture, role)),
  );

  return [
    '---',
    '/**',
    ` * Composed document head for ${description}.`,
    ' *',
    ' * Generated because something contributed to it. Every entry below was',
    ' * decided by the document pipeline; this file only renders them.',
    ' */',
    ...imports,
    '---',
    '',
    ...ordered.map((entry) => entry.source),
    '',
  ].join('\n');
}

/**
 * Renders a page's own head component into the shell's head slot.
 *
 * The fragment goes in as the page's **last** child, which is what lets the
 * anchor be the layout's closing tag - one exact string, found once. The
 * alternative was to insert after the opening tag, and the four page shapes
 * this template ships spell that four different ways: bare, with attributes on
 * one line, and with attributes across five. Slot order does not matter to
 * Astro, so the anchor that needs no parsing is the one to use.
 *
 * The layout's local name is read from the page's own import rather than
 * assumed, so a page that imported it under another name still works.
 */
function fillHeadSlot(
  content: string,
  pagePath: string,
  shellPath: string,
  componentName: string,
  specifier: string,
): string {
  const layoutSpecifier = relativeFromShell(pagePath, shellPath);
  const importLine = content
    .split('\n')
    .find((line) => line.startsWith('import ') && line.endsWith(`from '${layoutSpecifier}';`));
  const localName = importLine?.slice('import '.length).split(/\s+/)[0];

  if (localName === undefined || localName === '') {
    throw new CliError(`"${pagePath}" does not import the layout the composed head renders into.`, {
      hint: `Expected an import from "${layoutSpecifier}".`,
    });
  }

  const anchor = `</${localName}>`;
  const occurrences = content.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new CliError(`The composed head could not find its place in "${pagePath}".`, {
      hint:
        `Expected exactly one "${anchor}", found ${occurrences}. Inserting blindly would ` +
        'put the page’s document somewhere nobody chose.',
    });
  }

  const withSlot = content.replace(
    anchor,
    `  <Fragment slot="head"><${componentName} /></Fragment>\n${anchor}`,
  );
  return addImport(withSlot, `import ${componentName} from '${specifier}';`, pagePath);
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

/**
 * Which document fields Astro's own template can stop emitting.
 *
 * Read off the segment model rather than restated, so the capability and the
 * mechanism cannot disagree: a field is surrenderable exactly when some segment
 * serves it, which is exactly when rendering can leave it out.
 */
export const ASTRO_SEO_HANDOVER: HandoverCapability = {
  architecture: 'astro-standard',
  surrenderable: ASTRO_SEO_HANDOVER_FIELDS,
};

/**
 * Where a page's composed head component lives.
 *
 * A sibling of the site-wide one, named from the role so two pages never
 * collide and nothing has to keep a list. Derived from the architecture's own
 * mapping rather than a literal, so the directory stays the architecture's
 * decision.
 */
function pageHeadPath(architecture: ArchitectureDefinition, role: FileRole): string {
  const siteHead = resolveRole(architecture, 'app.document.head');
  const directory = siteHead.slice(0, siteHead.lastIndexOf('/'));
  return `${directory}/${pageHeadName(role)}.astro`;
}

/**
 * The component's identifier, derived from the semantic role.
 *
 * `page.notFound` becomes `DocumentHeadPageNotFound`. A function of the role
 * alone, so the same role always produces the same name and no registry of
 * pages exists anywhere.
 */
function pageHeadName(role: FileRole): string {
  const parts = role
    .split('.')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
  return `DocumentHead${parts}`;
}

/**
 * The file a page role names, refusing a role this architecture does not map.
 *
 * The refusal matters more than the lookup. A target naming a page the
 * architecture has never heard of cannot be rendered anywhere, and the
 * tempting fallback - render it in the shell - is exactly how one page's
 * document ends up on every page.
 */
function pageFilePath(architecture: ArchitectureDefinition, role: FileRole): string {
  const mapped = architecture.roles[role];
  if (mapped === undefined) {
    throw new CliError(
      `"${architecture.id}" has no page for the role "${role}", which a composed head targets.`,
      {
        hint:
          'A page-scoped document has to be rendered by that page. There is no site-wide ' +
          'fallback on purpose: it would broaden the scope the target was chosen to narrow.',
      },
    );
  }
  return mapped;
}

/**
 * Refuses two compositions aimed at the same target.
 *
 * Stage 33 resolves one document per target, so a second one for the same page
 * means a caller built something the semantic layer would never produce.
 * Merging them here would be inventing precedence in the Astro layer, which is
 * the one thing this layer must not do - so it refuses instead.
 */
function assertTargetsAreDistinct(compositions: readonly AstroDocumentComposition[]): void {
  const seen = new Set<string>();
  for (const composition of compositions) {
    const key = describeTarget(composition.target);
    if (seen.has(key)) {
      throw new CliError(`Two composed heads both target ${key}.`, {
        hint:
          'The document pipeline resolves one document per target. Combining two here would ' +
          'be arbitration, and arbitration finished before the architecture was involved.',
      });
    }
    seen.add(key);
  }
}
