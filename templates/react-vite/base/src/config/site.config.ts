/**
 * Everything client-specific, in one file.
 *
 * An empty string means "not set", and the UI omits that piece rather than
 * rendering a placeholder. Nothing here is ever invented for you.
 */

export interface NavItem {
  label: string;
  /** In-page anchor ('#services') or path once a router is added. */
  href: string;
}

export interface SiteIdentity {
  name: string;
  description: string;
  /**
   * Production URL. Empty is a supported state, not a broken one - nothing
   * absolute is emitted until you fill it in, so no page ever points at a
   * domain nobody owns.
   */
  url: string;
  locale: string;
  author: string;
}

export interface ContactDetails {
  email: string;
  phone: string;
}

export const SITE: SiteIdentity = {
  name: '{{siteName}}',
  description: '{{description}}',
  url: '{{siteUrl}}',
  locale: '{{locale}}',
  author: '{{author}}',
};

/** Header links. Empty means no menu is rendered at all. */
export const NAV: NavItem[] = [];

/** Each field is optional and hidden when empty. */
export const CONTACT: ContactDetails = {
  email: '',
  phone: '',
};
