import type { ConfigContribution } from './contributions.js';
import type { FileRole } from './roles.js';
import { CliError } from '../errors.js';

/**
 * Composing the router's route table from contributions.
 *
 * ## Why this exists
 *
 * Stage 12 shipped the router's module as a template with one route written
 * into it. Stage 13 needed a second adapter to add a route - a catch-all - and
 * there were only two ways to do that: edit someone else's file with string
 * replacement, or make the file composed. The first is the thing this codebase
 * refuses to do; so the route table joined `vite.config.ts`, `package.json` and
 * `App.tsx` as something assembled from what the selected adapters declared.
 *
 * ## Precedence is declared, never incidental
 *
 * Every route carries an `order`, and the table is sorted by it. That matters
 * more here than anywhere else the pattern is used: a catch-all placed above
 * `/` swallows the home page, and "it worked because objects happened to
 * iterate that way" is not a property anybody can rely on. Ties break on path,
 * so the output never depends on which adapter was selected first.
 *
 * ## What this is not
 *
 * Not a routing framework. It emits one shape - a module that mounts a router
 * and lists routes - because that is the shape a client router's entry has. A
 * router with a different shape gets its own emitter; what generalises is
 * routes being contributed rather than written in.
 */

/** What a route renders. */
export type RouteElement =
  /** The children the wrapper was handed - the application itself. */
  | { readonly kind: 'children' }
  /** A component the contributing adapter owns, addressed by role. */
  | { readonly kind: 'component'; readonly importName: string; readonly role: FileRole };

/** One route an adapter contributes to the table. */
export interface RouteEntry {
  /** The path to match, e.g. `/` or `*`. */
  readonly path: string;
  readonly element: RouteElement;
  /**
   * Position in the emitted table. Lower is matched first; ties break on path.
   *
   * Explicit because route order is semantic: a catch-all belongs last, and
   * nothing about "catch-all" makes that happen on its own.
   */
  readonly order: number;
}

/** One adapter's claim on a route. */
export interface RouteClaim {
  readonly owner: string;
  readonly entry: RouteEntry;
}

function isRouteEntry(value: unknown): value is RouteEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  const element = entry['element'] as Record<string, unknown> | undefined;
  return (
    typeof entry['path'] === 'string' &&
    typeof entry['order'] === 'number' &&
    element !== undefined &&
    (element['kind'] === 'children' ||
      (element['kind'] === 'component' &&
        typeof element['importName'] === 'string' &&
        typeof element['role'] === 'string'))
  );
}

/**
 * Collects the route table, in match order, or refuses.
 *
 * Two adapters contributing the same path identically de-duplicate and both are
 * kept as provenance. Two contributing the same path *differently* is a
 * conflict: one address cannot render two things, and picking a winner silently
 * is how an application ends up serving a page nobody chose.
 */
export function collectRoutes(
  contributions: readonly ConfigContribution[],
  role: FileRole,
  slot: string,
): readonly RouteClaim[] {
  const claims = contributions
    .filter((contribution) => contribution.target === role && contribution.at === slot)
    .map((contribution) => {
      if (!isRouteEntry(contribution.value)) {
        throw new CliError(`${contribution.owner} contributed an invalid route.`, {
          hint: 'A route needs a path, an order, and an element that is children or a component.',
        });
      }
      return { owner: contribution.owner, entry: contribution.value };
    })
    .sort(
      (a, b) =>
        a.entry.order - b.entry.order ||
        (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0),
    );

  const byPath = new Map<string, RouteClaim>();
  const ordered: RouteClaim[] = [];
  for (const claim of claims) {
    const seen = byPath.get(claim.entry.path);
    if (seen === undefined) {
      byPath.set(claim.entry.path, claim);
      ordered.push(claim);
      continue;
    }
    if (JSON.stringify(seen.entry) === JSON.stringify(claim.entry)) continue;
    throw new CliError(`Two adapters both want to render "${claim.entry.path}".`, {
      hint:
        `  ${seen.owner}\n  ${claim.owner}\n` +
        'One address cannot render two different things; one of them must change.',
    });
  }

  return ordered;
}

/**
 * The module's own documentation.
 *
 * Kept beside the emitter for the same reason `DEFAULT_ROOT_NOTE` is: the text
 * describes the generated file, and a generated file that describes itself
 * incorrectly is worse than one with no comment. Which is exactly why the
 * opening paragraph has two versions - "one route, deliberately" stopped being
 * true the moment a second adapter could contribute one.
 */
const ROUTER_DOC_TITLE = [" * The application's routes.", ' *'];

/** Said when the table is the home route alone. */
const NO_FALLBACK_INTRO = [
  ' * One route, deliberately. A scaffold that shipped `/about`, `/contact` and',
  ' * `/dashboard` would be handing you three pages to delete before you could',
  ' * start, and every one of them would be a guess about a site nobody has',
  ' * designed yet. What is here is the wiring: a router mounted above the',
  ' * application, with the home page as its first route.',
  ' *',
  ' * ## Adding a route',
  ' *',
  ' * Import a page and add a `<Route>` beside the one below:',
  ' *',
  ' *     <Route path="/about" element={<AboutPage />} />',
];

/** Said when something has contributed a catch-all as well. */
const FALLBACK_INTRO = [
  ' * The home page and a catch-all, deliberately. A scaffold that shipped',
  ' * `/about`, `/contact` and `/dashboard` would be handing you three pages to',
  ' * delete before you could start, and every one of them would be a guess about',
  ' * a site nobody has designed yet. What is here is the wiring: a router mounted',
  ' * above the application, the home page at the root, and a fallback for',
  ' * everything that matches neither.',
  ' *',
  ' * ## Adding a route',
  ' *',
  ' * Import a page and add a `<Route>` above the catch-all:',
  ' *',
  ' *     <Route path="/about" element={<AboutPage />} />',
  ' *',
  ' * Above it by convention rather than necessity - React Router ranks routes by',
  ' * specificity instead of taking the first match, so `*` loses to anything real',
  ' * wherever it sits. Keep it last anyway: a table that reads in match order is',
  ' * one you can reason about without knowing that.',
];

/** Said when nothing has contributed a catch-all. */
const NO_FALLBACK_NOTE = [
  ' *',
  ' * ## About the not-found case',
  ' *',
  ' * You can add a catch-all with `path="*"`, and it will render for any address',
  ' * the routes above do not match. Worth knowing what that is and is not: it',
  ' * renders a component in the browser *after* the server has already answered,',
  ' * so the response itself is still whatever your host sent - usually a 200 for',
  ' * `index.html`. Crawlers and monitoring see that status, not a 404.',
  ' *',
  ' * A real not-found response needs the host to serve one, or a framework that',
  ' * renders on the server. This file cannot produce it, so it does not pretend',
  ' * to. See the README before relying on client-side fallbacks for SEO.',
];

/** Said when one has. The caveat is the same; only the first sentence changes. */
const FALLBACK_NOTE = [
  ' *',
  ' * ## About the not-found case',
  ' *',
  ' * The catch-all below renders for any address the routes above do not match.',
  ' * Worth knowing what that is and is not: it renders a component in the browser',
  ' * *after* the server has already answered, so the response itself is still',
  ' * whatever your host sent - usually a 200 for `index.html`. Crawlers and',
  ' * monitoring see that status, not a 404.',
  ' *',
  ' * A real not-found response needs the host to serve one, or a framework that',
  ' * renders on the server. This file cannot produce it, so it does not pretend',
  ' * to. See the README before relying on client-side fallbacks for SEO.',
];

const ROUTER_DOC_TAIL = [
  ' *',
  ' * This file is yours now - the generator will not touch it again.',
];

export interface RouterImport {
  readonly importName: string;
  readonly from: string;
}

/**
 * Emits the router module.
 *
 * Routes appear in the order the collector resolved them, which is the order
 * the router matches them in. Deterministic and LF-terminated, like every other
 * generated file.
 */
export function emitRouter(
  exportName: string,
  routes: readonly { readonly path: string; readonly element: RouteElement }[],
  imports: readonly RouterImport[],
): string {
  const componentImports = [...imports]
    .map((entry) => `import { ${entry.importName} } from '${entry.from}';`)
    .sort();

  const hasCatchAll = routes.some((route) => route.path === '*');

  return [
    "import { BrowserRouter, Route, Routes } from 'react-router-dom';",
    "import type { ReactNode } from 'react';",
    ...componentImports,
    '',
    '/**',
    ...ROUTER_DOC_TITLE,
    ...(hasCatchAll ? FALLBACK_INTRO : NO_FALLBACK_INTRO),
    ...(hasCatchAll ? FALLBACK_NOTE : NO_FALLBACK_NOTE),
    ...ROUTER_DOC_TAIL,
    ' */',
    `export function ${exportName}({ children }: { children: ReactNode }) {`,
    '  return (',
    '    <BrowserRouter>',
    '      <Routes>',
    ...routes.map((route) => {
      const element =
        route.element.kind === 'children' ? '{children}' : `{<${route.element.importName} />}`;
      return `        <Route path="${route.path}" element=${element} />`;
    }),
    '      </Routes>',
    '    </BrowserRouter>',
    '  );',
    '}',
    '',
  ].join('\n');
}
