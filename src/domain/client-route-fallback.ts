/**
 * The client-side route fallback contract, as data.
 *
 * ## What this guarantees, and the one thing it refuses to
 *
 * When the client-side router receives an address that matches none of the
 * application's routes, the generated fallback view renders. That is the whole
 * claim, and it is worth being precise about what it is not.
 *
 * It is **not** an HTTP 404. The router matches in the browser, after the
 * server has already answered - so the response a crawler, an uptime monitor or
 * a CDN log records is whatever the host sent, usually `200` for `index.html`.
 * A rendered component cannot retroactively change a status line.
 *
 * That distinction is the reason this feature exists separately from
 * `not-found` rather than being folded into it. `not-found` requires
 * `file-based-routing`, which is the capability that produces a real
 * not-found *document*; this requires `client-side-routing`, which produces a
 * rendered view. Selecting this one does not make the other available, and a
 * test holds that line.
 *
 * ## Nothing is invented
 *
 * The fallback view carries no page metadata, no canonical URL, no structured
 * data and no accessible names beyond the ones its own markup earns. The
 * generator has no truthful source for what a missing page should say about
 * itself, so it says nothing about it.
 */

/** What the feature guarantees about a generated project. */
export const CLIENT_ROUTE_FALLBACK_GUARANTEES = [
  /** A catch-all route exists in the composed route table. */
  'catch-all-route',
  /** It is matched last, so it cannot shadow a real route. */
  'catch-all-is-last',
  /** An unmatched client-side address renders the generated view. */
  'renders-fallback-view',
  /** The view offers a keyboard-reachable link back to the site root. */
  'link-home',
  /** One primary heading, inside the application's main landmark. */
  'semantic-markup',
] as const;

export type ClientRouteFallbackGuarantee = (typeof CLIENT_ROUTE_FALLBACK_GUARANTEES)[number];

/**
 * What the feature explicitly does not guarantee.
 *
 * The honest half. Every entry is something a reader might otherwise assume a
 * "404 feature" had handled.
 */
export const CLIENT_ROUTE_FALLBACK_OUT_OF_SCOPE = [
  /** The response status is the host's; a rendered component cannot change it. */
  'http-404-status',
  /** No server renders this; the view exists only after JavaScript runs. */
  'server-rendered-not-found',
  /** A crawler that does not execute JavaScript sees the entry HTML. */
  'crawler-visible-not-found',
  /** Rewrites, redirects and error pages are host configuration. */
  'host-configuration',
  /** No canonical, robots or social metadata is emitted for the fallback. */
  'fallback-page-metadata',
] as const;

export type ClientRouteFallbackOutOfScope = (typeof CLIENT_ROUTE_FALLBACK_OUT_OF_SCOPE)[number];

export interface ClientRouteFallbackContract {
  /** The path the router matches when nothing else does. */
  readonly catchAllPath: string;
  /**
   * Where the catch-all sits in the route table.
   *
   * Deliberately large, and deliberately part of the contract rather than an
   * implementation detail: a catch-all that sorts above `/` swallows the home
   * page, and the ordering has to be something a test can assert.
   */
  readonly routeOrder: number;
  readonly guarantees: readonly ClientRouteFallbackGuarantee[];
  readonly outOfScope: readonly ClientRouteFallbackOutOfScope[];
}

/** The catch-all always sorts last; nothing else in the table comes close. */
export const CATCH_ALL_ORDER = 10_000;

/** Derives the contract. Pure, and independent of every other selection. */
export function resolveClientRouteFallbackContract(): ClientRouteFallbackContract {
  return {
    catchAllPath: '*',
    routeOrder: CATCH_ALL_ORDER,
    guarantees: [...CLIENT_ROUTE_FALLBACK_GUARANTEES],
    outOfScope: [...CLIENT_ROUTE_FALLBACK_OUT_OF_SCOPE],
  };
}

/** Serialises the contract in a fixed field order, for deterministic snapshots. */
export function serialiseClientRouteFallbackContract(
  contract: ClientRouteFallbackContract,
): string {
  return JSON.stringify({
    catchAllPath: contract.catchAllPath,
    routeOrder: contract.routeOrder,
    guarantees: contract.guarantees,
    outOfScope: contract.outOfScope,
  });
}
