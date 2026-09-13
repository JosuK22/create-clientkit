import type { SiteContext } from '../types.js';
import { siteOrigin } from './seo.js';

/**
 * The structured-data contract, as data.
 *
 * ## What this is
 *
 * A framework-independent schema.org `Organization` description of the site,
 * derived from the metadata the project already carries. Pure: the same site
 * produces the same object, on any machine, in any locale.
 *
 * ## Why it is separate from SEO
 *
 * They answer different questions. SEO describes *this page* to a crawler -
 * title, canonical, social preview. Structured data describes *the
 * organisation* to a knowledge graph. A site can want either without the other,
 * and folding one into the other would make the larger of them the place every
 * future search-related feature goes.
 *
 * They are siblings: same capability, same role, different slots, neither
 * naming the other.
 *
 * ## Nothing is invented
 *
 * Structured data is consumed automatically by machines, so a fabricated field
 * here is worse than a missing one - it is a claim about a real organisation
 * that nobody made. Every optional property is omitted unless it has a real
 * value:
 *
 *   - no site URL means no `url`, not `localhost` and not a guessed domain
 *   - no description means no `description`, not a generated sentence
 *   - no configured social profiles means no `sameAs`, not a guess at handles
 *   - no `logo`, ever, from this contract: the project configures a social
 *     image as a path, and turning a path into the absolute URL a crawler
 *     requires would mean inventing the domain it sits on
 *
 * ## What this contract does not cover
 *
 * The generated project's own configuration carries fields this cannot: an
 * email, a phone number, a location, social profiles. Those are things a
 * developer fills in after generation, so the manifest has no truthful value
 * for them and the contract does not model them. The framework's template
 * emits them when they are configured, which is the right place for values the
 * generator never sees.
 */

/** The Organization description, in the order it is serialised. */
export interface OrganizationContract {
  readonly '@context': 'https://schema.org';
  readonly '@type': 'Organization';
  readonly name: string;
  /** Present only when a usable production URL is configured. */
  readonly url?: string;
  /** Present only when the site has a description. */
  readonly description?: string;
}

/**
 * Field order for serialisation.
 *
 * Fixed rather than derived from `Object.keys`, because insertion order is a
 * property of how an object happened to be built and golden snapshots compare
 * bytes. JSON-LD attaches no meaning to key order; determinism does.
 */
export const ORGANIZATION_FIELDS = ['@context', '@type', 'name', 'url', 'description'] as const;

/**
 * Derives the Organization contract from the site's metadata.
 *
 * Total: every input produces a valid object, because "this site has no URL
 * yet" is an ordinary state for a client project rather than an error. The
 * result always has `@context`, `@type` and `name`; everything else appears
 * only when it is true.
 */
export function resolveOrganization(site: SiteContext): OrganizationContract {
  const origin = siteOrigin(site.url);
  const description = site.description.trim();

  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: site.name,
    ...(origin === '' ? {} : { url: origin }),
    ...(description === '' ? {} : { description }),
  };
}

/**
 * Serialises the contract in a fixed field order.
 *
 * Emits compact JSON, matching what a `<script type="application/ld+json">`
 * block should carry. Absent fields are absent rather than `null`: a null in
 * structured data is a claim that the value is empty, which is not the same as
 * making no claim.
 */
export function serialiseOrganization(organization: OrganizationContract): string {
  const ordered: Record<string, unknown> = {};
  for (const field of ORGANIZATION_FIELDS) {
    const value = (organization as unknown as Record<string, unknown>)[field];
    if (value !== undefined) ordered[field] = value;
  }
  return JSON.stringify(ordered);
}
