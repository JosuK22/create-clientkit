import { CliError } from '../errors.js';
import type { SiteContext } from '../types.js';

/**
 * The SEO contract, as data.
 *
 * ## What this is
 *
 * A framework-independent description of what a page's `<head>` should say:
 * the title, the description, whether the page may be indexed, its canonical
 * address, and the Open Graph and Twitter/X equivalents. It is derived from the
 * site metadata the project already carries, and it is pure - the same site
 * produces the same contract, on any machine, in any locale.
 *
 * ## Why it is data and not a component
 *
 * Every framework renders `<head>` differently: Astro has a component in a
 * layout, an SPA sets it at runtime, a server framework has its own metadata
 * API. Shipping one implementation per framework is the matrix the design
 * exists to prevent, so what the feature owns is the *contract* and what each
 * framework owns is how to satisfy it.
 *
 * That split has a practical benefit beyond tidiness: because the contract is
 * computable, it can be checked against the HTML a real build emits. A test
 * does exactly that, which is what stops the generic model and the framework's
 * implementation drifting apart while both look correct on their own.
 *
 * ## Nothing is invented
 *
 * The rule the whole project runs on applies here with particular force,
 * because SEO is where a generator is most tempted to guess. No domain is
 * fabricated: with no configured site URL there is no canonical tag and no
 * `og:url`, rather than `http://localhost` or `example.com`. No description is
 * invented. No social handle is invented. A value that does not exist produces
 * no tag at all.
 */

/** Whether crawlers may index the page. */
export type RobotsDirective = 'index, follow' | 'noindex, nofollow';

/** The Open Graph subset a client website actually needs. */
export interface OpenGraphContract {
  readonly type: 'website';
  readonly title: string;
  readonly siteName: string;
  /** Empty when the site has no description. */
  readonly description: string;
  /** Empty when no site URL is configured, or the page is not indexable. */
  readonly url: string;
  /** `language_TERRITORY`, or empty when the locale is not in that form. */
  readonly locale: string;
}

/** The Twitter/X subset. No handle is required and none is invented. */
export interface TwitterContract {
  readonly card: 'summary' | 'summary_large_image';
  readonly title: string;
  /** Empty when the site has no description. */
  readonly description: string;
}

/** Everything the feature says a page's metadata surface must express. */
export interface SeoContract {
  readonly title: string;
  /** Empty when the site has no description; the tag is then omitted. */
  readonly description: string;
  readonly robots: RobotsDirective;
  /** Empty when no site URL is configured, or the page is not indexable. */
  readonly canonical: string;
  readonly openGraph: OpenGraphContract;
  readonly twitter: TwitterContract;
}

export interface SeoContractOptions {
  /** Page name. Omitted on the home page, so the title is just the site name. */
  readonly pageTitle?: string;
  /** The site-relative path this contract describes. */
  readonly path?: string;
  /** Force the page out of the index. */
  readonly noindex?: boolean;
}

/**
 * The site's origin, or `''` when no usable production URL is configured.
 *
 * An empty result is the signal to omit absolute metadata entirely. Anything
 * that is not an absolute http(s) URL is treated as absent rather than
 * repaired, because a generator guessing at a domain is worse than a generator
 * emitting no tag.
 */
export function siteOrigin(url: string | null): string {
  const trimmed = (url ?? '').trim();
  if (trimmed === '') return '';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';

  // Origin only, so there is never a trailing slash to double up on.
  return parsed.origin;
}

/** Joins a site-relative path onto an origin, or `''` when there is no origin. */
export function absoluteUrl(origin: string, path: string): string {
  if (origin === '') return '';
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${suffix}`.replace(/([^:]\/)\/+/g, '$1');
}

/**
 * `og:locale` wants `language_TERRITORY`.
 *
 * A bare `en` is not valid there, so it is omitted rather than emitted in a
 * form crawlers discard.
 */
export function openGraphLocale(locale: string): string {
  return /^[a-z]{2,3}-[A-Za-z0-9]{2,8}$/.test(locale) ? locale.replace('-', '_') : '';
}

/**
 * Derives the contract for one page from the site's metadata.
 *
 * Pure, and deliberately total: every branch produces a valid contract rather
 * than throwing, because "this site has no URL yet" is an ordinary state for a
 * client project rather than an error.
 *
 * A canonical tag says "this is the definitive address for this content" while
 * `noindex` says "do not index it". Emitting both is contradictory, so a
 * blocked page gets no canonical and no `og:url`.
 */
export function resolveSeoContract(
  site: SiteContext,
  options: SeoContractOptions = {},
): SeoContract {
  const { pageTitle, path = '/', noindex = false } = options;

  const origin = siteOrigin(site.url);
  const title =
    pageTitle === undefined || pageTitle === '' ? site.name : `${pageTitle} - ${site.name}`;
  const description = site.description.trim();
  const robots: RobotsDirective = noindex ? 'noindex, nofollow' : 'index, follow';
  const canonical = noindex ? '' : absoluteUrl(origin, path);

  return {
    title,
    description,
    robots,
    canonical,
    openGraph: {
      type: 'website',
      title,
      siteName: site.name,
      description,
      url: canonical,
      locale: openGraphLocale(site.locale),
    },
    twitter: {
      // Without a social image a wide card renders worse than a thumbnail, and
      // no image is the default until someone supplies one.
      card: 'summary',
      title,
      description,
    },
  };
}

/** One adapter's claim on the metadata surface, with who made it and why. */
export interface MetadataClaim {
  readonly owner: string;
  readonly reason: string;
  readonly contract: SeoContract;
}

/**
 * Collects the metadata contract from the contributions, or refuses.
 *
 * The same shape of decision the rest of the composition engine makes. Two
 * adapters describing the page head identically is cooperation and
 * de-duplicates, keeping both as provenance; two describing it *differently* is
 * a conflict, because there is one `<title>` and picking a winner silently is
 * how a site ends up with metadata nobody chose.
 *
 * Addressed by role and slot rather than by adapter, so a second feature that
 * legitimately needs to describe the head works with no change here.
 */
export function collectMetadata(
  contributions: readonly {
    readonly target: string;
    readonly at: string;
    readonly value: unknown;
    readonly owner: string;
    readonly reason: string;
  }[],
): MetadataClaim[] {
  const claims = contributions
    .filter((entry) => entry.target === 'app.layout' && entry.at === 'metadata')
    .map((entry) => ({
      owner: entry.owner,
      reason: entry.reason,
      contract: entry.value as SeoContract,
    }))
    .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));

  const distinct = [...new Set(claims.map((claim) => JSON.stringify(claim.contract)))];
  if (distinct.length > 1) {
    throw new CliError('Two adapters describe the page metadata differently.', {
      hint:
        claims
          .map(
            (claim) =>
              `  ${claim.owner}\n    title: ${claim.contract.title}\n    reason: ${claim.reason}`,
          )
          .join('\n') + '\nExactly one description of the head can be correct.',
    });
  }

  return claims;
}
