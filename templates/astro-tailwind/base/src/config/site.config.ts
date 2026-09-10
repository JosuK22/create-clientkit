/**
 * The single source of truth for this site.
 *
 * Everything else - layout, metadata, footer - reads from here, so updating a
 * client's details is a one-file change.
 */
export const SITE = {
  /** Display name, used in the browser title and the footer. */
  name: '{{siteName}}',

  /** One-sentence description used for the meta description. */
  description: '{{description}}',

  /**
   * Production URL, e.g. 'https://example.com'.
   * An empty string means it has not been decided yet; nothing is invented for
   * you. Set it once the domain is known.
   */
  url: '{{siteUrl}}',

  /** BCP-47 language tag for the <html lang> attribute. */
  locale: '{{locale}}',

  /** Who the site belongs to. Empty until you fill it in. */
  author: '{{author}}',

  /**
   * How this project was scaffolded: 'coming-soon' or 'full'.
   * Kept for reference - change the pages directly, not this value.
   */
  mode: '{{mode}}',
} as const;

export type Site = typeof SITE;
