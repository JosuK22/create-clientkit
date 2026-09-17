import path from 'node:path';

import type { ConfigContribution } from './contributions.js';
import type { ArchitectureDefinition, FileRole } from './roles.js';
import { definesRole } from './roles.js';
import { CliError } from '../errors.js';

/**
 * Composing the application root from contributions.
 *
 * ## The problem this solves
 *
 * Stage 7 added the UI-library dimension, and MUI is the first adapter that
 * needs to affect the *application* rather than only its dependencies and
 * configuration. A theme context, a style engine and a CSS reset all have to
 * sit above the whole component tree.
 *
 * Every way of doing that without this was worse. The root component belonged
 * to the framework's template, so the UI library could either overwrite a file
 * another adapter owns - the collision the architecture exists to prevent - or
 * ship a component nothing renders, which installs a dependency and proves
 * nothing. Stage 5 hit the same shape with the global stylesheet and answered
 * it the same way: the framework template stopped owning the artefact and it
 * became composed.
 *
 * ## How it stays generic
 *
 * Two roles and nothing else. `app.root` is where the composed file goes;
 * `app.providers` is an optional slot above it. The *paths* come from the
 * architecture, so no adapter knows where anything lives, and each adapter
 * names only its own export. MUI never learns that React puts components in
 * `src/components/ui`, and React never learns that MUI exists.
 *
 * An architecture that maps no `app.root` gets nothing composed, with no branch
 * on the framework anywhere - the same mechanism `config.build` already uses to
 * leave Astro alone.
 *
 * ## What this is not
 *
 * Not an AST transformer and not a general code generator. It emits one shape -
 * a module that imports a page, optionally wraps it, and exports a root
 * component - because that is the shape a React-style application root has. A
 * framework whose root looks different gets its own emitter; what generalises
 * is the pair of roles, not this function.
 */

/** A component an adapter contributes to the application root. */
export interface AppRootEntry {
  /** The exported binding, e.g. `HomePage`. The adapter owns this name. */
  readonly importName: string;
  /**
   * Nesting position for a wrapper. Lower is further out; ties break on owner.
   *
   * Added in Stage 12, when a second kind of wrapper appeared. A router and a
   * UI library both legitimately sit above the application, and which of them
   * is outermost is a decision neither can make alone - so each states where it
   * belongs and the composer sorts, rather than the order falling out of which
   * adapter happened to be selected first.
   */
  readonly order?: number;
  /**
   * Replaces the root module's doc comment.
   *
   * For a wrapper that changes what the root *is*. The default text says the
   * scaffold ships without a router, which stops being true the moment one is
   * selected, and a generated file that describes itself incorrectly is worse
   * than one with no comment at all.
   */
  readonly note?: readonly string[];
  /**
   * The role holding this wrapper's own file.
   *
   * A role rather than a path, so the adapter never learns where the
   * architecture keeps such a component - including its own. Defaults to
   * `app.providers`, which is where the only wrapper before Stage 12 lived.
   */
  readonly role?: FileRole;
}

function isAppRootEntry(value: unknown): value is AppRootEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['importName'] === 'string'
  );
}

/** One adapter's claim on an application-root slot. */
export interface AppRootClaim {
  readonly owner: string;
  readonly entry: AppRootEntry;
}

/**
 * Reads every `app.root` contribution aimed at one slot, in nesting order.
 *
 * Through Stage 11 a slot admitted exactly one occupant, because only one
 * adapter had ever wanted to wrap the application. Stage 12 added a second
 * kind: a router and a UI library both legitimately sit above the tree, and
 * refusing that would have made them mutually exclusive for no reason beyond
 * the shape of this function.
 *
 * Sorted by the declared order and then by owner, so nesting never depends on
 * which adapter happened to be selected first.
 *
 * Two adapters claiming the same binding name is still a conflict: two
 * components cannot be imported under one name, and nesting the same one twice
 * is meaningless. Byte-identical claims collapse to one instead.
 */
export function appRootEntries(
  contributions: readonly ConfigContribution[],
  slot: 'page' | 'providers',
): readonly AppRootClaim[] {
  const matching = contributions
    .filter((contribution) => contribution.target === 'app.root' && contribution.at === slot)
    .map((contribution) => {
      if (!isAppRootEntry(contribution.value)) {
        throw new CliError(
          `${contribution.owner} contributed an invalid "${slot}" entry for the application root.`,
          { hint: 'An application-root entry needs an importName.' },
        );
      }
      return { owner: contribution.owner, entry: contribution.value };
    })
    .sort(
      (a, b) =>
        (a.entry.order ?? 0) - (b.entry.order ?? 0) ||
        (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0),
    );

  const byName = new Map<string, AppRootClaim>();
  const ordered: AppRootClaim[] = [];
  for (const claim of matching) {
    const seen = byName.get(claim.entry.importName);
    if (seen === undefined) {
      byName.set(claim.entry.importName, claim);
      ordered.push(claim);
      continue;
    }
    if (JSON.stringify(seen) === JSON.stringify(claim)) continue;
    throw new CliError(
      `Two adapters both want "${claim.entry.importName}" in the application root.`,
      {
        hint:
          `  ${seen.owner}\n  ${claim.owner}\n` +
          'Two components cannot share one binding; one of them must use a different name.',
      },
    );
  }

  return ordered;
}

/**
 * Reads the single occupant of a slot that admits only one.
 *
 * The page is still exactly one: a root renders one thing, and two adapters
 * supplying it is a disagreement rather than a nesting.
 */
export function appRootEntry(
  contributions: readonly ConfigContribution[],
  slot: 'page',
): AppRootClaim | undefined {
  const matching = appRootEntries(contributions, slot);

  if (matching.length > 1) {
    throw new CliError(`Two adapters both want to supply the application's ${slot}.`, {
      hint:
        matching
          .map(({ owner, entry }) => `  ${entry.importName}\n    owner: ${owner}`)
          .join('\n') + '\nExactly one adapter can occupy this slot.',
    });
  }

  return matching[0];
}

/**
 * The import specifier for one role, relative to another.
 *
 * Always POSIX-separated and always explicitly relative, because the emitted
 * text is source code rather than a filesystem path - `./pages/HomePage` has to
 * read the same on Windows as it does anywhere else.
 */
export function importSpecifier(fromFile: string, toFile: string): string {
  const relative = path
    .relative(path.posix.dirname(fromFile), toFile.replace(/\.[^./]+$/, ''))
    .split(path.sep)
    .join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Emits the application root module.
 *
 * Imports are sorted by specifier so the output never depends on the order
 * adapters were selected in. LF-terminated, like every other generated file.
 */
/** What the root says about itself when no wrapper has anything to add. */
const DEFAULT_ROOT_NOTE = [
  ' * One page, because this scaffold ships without a router - see the README. Add',
  ' * one when the site needs a second page, and this is where it goes.',
];

export interface AppRootWrapper {
  readonly importName: string;
  readonly from: string;
  readonly note?: readonly string[];
}

export function emitAppRoot(
  rootExportName: string,
  page: { readonly importName: string; readonly from: string },
  providers: readonly AppRootWrapper[] = [],
): string {
  const imports = [
    `import { ${page.importName} } from '${page.from}';`,
    ...providers.map((entry) => `import { ${entry.importName} } from '${entry.from}';`),
  ].sort();

  // Wrappers nest outermost-first, so the element tree reads in the order the
  // composer resolved them.
  const body: string[] = [];
  if (providers.length === 0) {
    body.push(`  return <${page.importName} />;`);
  } else {
    body.push('  return (');
    providers.forEach((entry, depth) => {
      body.push(`${'  '.repeat(depth + 2)}<${entry.importName}>`);
    });
    body.push(`${'  '.repeat(providers.length + 2)}<${page.importName} />`);
    [...providers].reverse().forEach((entry, index) => {
      body.push(`${'  '.repeat(providers.length - index + 1)}</${entry.importName}>`);
    });
    body.push('  );');
  }

  /*
   * The outermost wrapper with something to say replaces the default
   * paragraph.
   *
   * The default text states the scaffold ships without a router, which stops
   * being true the moment one is selected. A generated file that describes
   * itself incorrectly is worse than one with no comment, and the wrapper that
   * changed what the root *is* is the one qualified to say so.
   */
  const note = providers.find((entry) => entry.note !== undefined)?.note ?? DEFAULT_ROOT_NOTE;

  return [
    ...imports,
    '',
    '/**',
    ' * The application root.',
    ' *',
    ...note,
    ' */',
    `export function ${rootExportName}() {`,
    ...body,
    '}',
    '',
  ].join('\n');
}

/** Whether this architecture has an application root to compose at all. */
export function composesAppRoot(architecture: ArchitectureDefinition): boolean {
  return definesRole(architecture, 'app.root') && definesRole(architecture, 'page.home');
}

/**
 * Emits the provider shell: every contributed wrapper, nested around children.
 *
 * ## Why a second emitter rather than a general one
 *
 * `emitAppRoot` composes a module that renders *the page*. That is what a
 * React-style application root is, and it is the wrong shape for a framework
 * that routes its own files - there, the application content arrives as
 * `children` and the framework decides what it is. The two differ in exactly
 * one respect, and pretending otherwise would mean an emitter with a flag.
 *
 * What generalises is everything around them: the semantic roles, the wrapper
 * claims, and the ordering rule. Both emitters consume the identical list from
 * `appRootEntries`, sorted the identical way, and neither knows which adapter
 * produced it.
 *
 * ## The ordering rule, stated once
 *
 * Each wrapper declares an integer `order`; lower is further out. Ties break on
 * the owner's adapter ref, which is a stable string, so nesting never depends
 * on which adapter happened to be selected first, which order flags were passed
 * in, or how a registry iterated.
 *
 * That is the whole model, and deliberately so. It cannot express a cycle -
 * integers are totally ordered and the tiebreak is total - so there is no graph
 * to detect one in. A `before`/`after` model could express contradictions, and
 * would need detection, resolution and an error vocabulary to earn behaviour
 * this already has.
 *
 * With no wrappers the shell is a pass-through: the same component, rendering
 * its children and nothing else, so the framework's own entry imports one name
 * whether or not anything fills it.
 */
export function emitProviderShell(
  exportName: string,
  wrappers: readonly AppRootWrapper[] = [],
): string {
  const imports = [
    "import type { ReactNode } from 'react';",
    ...wrappers.map((entry) => `import { ${entry.importName} } from '${entry.from}';`),
  ].sort();

  const body: string[] = [];
  if (wrappers.length === 0) {
    body.push('  return <>{children}</>;');
  } else {
    body.push('  return (');
    wrappers.forEach((entry, depth) => {
      body.push(`${'  '.repeat(depth + 2)}<${entry.importName}>`);
    });
    body.push(`${'  '.repeat(wrappers.length + 2)}{children}`);
    [...wrappers].reverse().forEach((entry, index) => {
      body.push(`${'  '.repeat(wrappers.length - index + 1)}</${entry.importName}>`);
    });
    body.push('  );');
  }

  const note =
    wrappers.length === 0
      ? [
          ' * Nothing wraps the application yet. Selecting a UI library fills this',
          ' * in; until then it renders its children and adds no client bundle.',
        ]
      : [
          ' * Composed from what the selected adapters contribute, outermost first.',
          ' * Each wrapper declares where it belongs, so the nesting is the same',
          ' * however the stack was configured.',
        ];

  return [
    ...imports,
    '',
    '/**',
    ' * Everything that wraps the whole application.',
    ' *',
    ...note,
    ' */',
    `export function ${exportName}({ children }: { children: ReactNode }) {`,
    ...body,
    '}',
    '',
  ].join('\n');
}

/** Whether this architecture composes a provider shell around its content. */
export function composesProviderShell(architecture: ArchitectureDefinition): boolean {
  return definesRole(architecture, 'app.shell');
}
