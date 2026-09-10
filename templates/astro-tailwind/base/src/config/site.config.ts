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
  /** Production URL. Empty until the domain is decided - nothing is invented. */
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
