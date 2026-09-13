import path from 'node:path';

import type { ConfigContribution } from './contributions.js';
import type { ArchitectureDefinition } from './roles.js';
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
}

function isAppRootEntry(value: unknown): value is AppRootEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['importName'] === 'string'
  );
}

/**
 * Reads a single `app.root` contribution aimed at one slot.
 *
 * More than one adapter claiming a slot is a conflict rather than a merge:
 * there is one page and one provider wrapper, and picking a winner silently is
 * how a generated project ends up rendering something nobody chose.
 */
export function appRootEntry(
  contributions: readonly ConfigContribution[],
  slot: 'page' | 'providers',
): { readonly owner: string; readonly entry: AppRootEntry } | undefined {
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
    .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));

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
export function emitAppRoot(
  rootExportName: string,
  page: { readonly importName: string; readonly from: string },
  providers?: { readonly importName: string; readonly from: string },
): string {
  const imports = [
    `import { ${page.importName} } from '${page.from}';`,
    ...(providers === undefined
      ? []
      : [`import { ${providers.importName} } from '${providers.from}';`]),
  ].sort();

  const body =
    providers === undefined
      ? [`  return <${page.importName} />;`]
      : [
          `  return (`,
          `    <${providers.importName}>`,
          `      <${page.importName} />`,
          `    </${providers.importName}>`,
          `  );`,
        ];

  return [
    ...imports,
    '',
    '/**',
    ' * The application root.',
    ' *',
    ' * One page, because this scaffold ships without a router - see the README. Add',
    ' * one when the site needs a second page, and this is where it goes.',
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
