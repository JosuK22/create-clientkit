/**
 * The single source of truth for this site.
 *
 * Every component reads from here, so updating a client's details is a
 * one-file change. Nothing below is required to be filled in: an empty string
 * or an empty array means "not set", and the UI omits that piece entirely
 * rather than rendering a placeholder.
 */

export type Appearance = 'light' | 'dark' | 'system';
export type SiteMode = 'coming-soon' | 'full';

export interface NavItem {
  label: string;
  /** Internal path ('/about') or in-page anchor ('#services'). */
  href: string;
}

export interface SocialLink {
  /** Shown as the link text, so name the platform: 'Instagram', 'LinkedIn'. */
  label: string;
  href: string;
}

export interface SiteIdentity {
  name: string;
  description: string;
  /**
   * Production URL, as an origin: 'https://example.com'.
   *
   * Empty until the domain is decided - nothing is invented, and every
   * absolute tag (canonical, og:url, sitemap) is simply omitted until it is
   * set. Only the origin is used; to deploy under a subpath such as
   * example.com/client, also set `base` in astro.config.mjs.
   */
  url: string;
  /** BCP-47 language tag, used for <html lang> and date formatting. */
  locale: string;
  author: string;
  /** How this project was scaffolded. Informational; edit the pages, not this. */
  mode: SiteMode;
}

export interface ContactDetails {
  email: string;
  phone: string;
  /** Free text, e.g. 'Manchester, UK'. */
  location: string;
}

export interface LaunchSettings {
  enabled: boolean;
  /** ISO date or date-time, e.g. '2026-11-01' or '2026-11-01T09:00:00Z'. */
  date: string;
  /** Optional line shown beneath the date. */
  note: string;
}

export interface ThemeSettings {
  /** 'system' follows the visitor's OS preference. No JavaScript either way. */
  appearance: Appearance;
  /** Brand colour as a hex value, e.g. '#1d4ed8'. Empty keeps the neutral ink. */
  accent: string;
}

export type TwitterCard = 'summary' | 'summary_large_image';

export interface SeoSettings {
  /**
   * Social preview image, 1200x630 works everywhere. Either a path in
   * `public/` ('/og.png') or an absolute URL.
   *
   * Empty by default and empty is safe: no `og:image` tag is emitted at all,
   * which is better than pointing social platforms at a file that isn't there.
   * Drop a real image in `public/` and name it here when you have one.
   */
  image: string;

  /** 'summary_large_image' shows a wide preview; 'summary' shows a thumbnail. */
  twitterCard: TwitterCard;

  /**
   * Ask search engines to stay away. Also suppresses the sitemap and its
   * reference in robots.txt, so the site never advertises pages it has asked
   * not to have indexed.
   *
   * Left `false` on purpose, including for coming-soon sites: a placeholder
   * page that gets indexed is replaced at the next crawl, whereas a `noindex`
   * left switched on after launch keeps the real site invisible for weeks.
   * If you would rather the holding page stayed out of search, set this to
   * true now and remember to turn it off when the real site goes live.
   */
  noindex: boolean;
}

/** Identity. These values are filled in from your answers at scaffold time. */
export const SITE: SiteIdentity = {
  name: '{{siteName}}',
  description: '{{description}}',
  url: '{{siteUrl}}',
  locale: '{{locale}}',
  author: '{{author}}',
  mode: '{{mode}}',
};

/**
 * Site navigation. Empty by default: the header renders no menu at all rather
 * than inventing links. Add items once real pages or sections exist.
 */
export const NAV: NavItem[] = [];

/** Social profiles. Add only accounts that actually exist. */
export const SOCIAL: SocialLink[] = [];

/** Contact details. Each field is optional and hidden when empty. */
export const CONTACT: ContactDetails = {
  email: '',
  phone: '',
  location: '',
};

/**
 * Launch date. While `enabled` is false, or `date` is empty or unparseable,
 * no launch information and no countdown is rendered.
 */
export const LAUNCH: LaunchSettings = {
  enabled: false,
  date: '',
  note: '',
};

export const THEME: ThemeSettings = {
  appearance: 'system',
  accent: '',
};

export const SEO: SeoSettings = {
  image: '',
  twitterCard: 'summary_large_image',
  noindex: false,
};
