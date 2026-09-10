import type { PackageManager, TemplateMode } from '../types.js';

/**
 * The single place built-in defaults are defined. Nothing else in the codebase
 * may hard-code a fallback value.
 *
 * TEMPLATE_ID_PLACEHOLDER is a reserved identifier, not a template: no template
 * data exists in M1. It exists so ProjectContext has a well-typed value and so
 * the registry has something to resolve against once M2 lands.
 */
export const TEMPLATE_ID_PLACEHOLDER = 'astro-tailwind';

export const DEFAULTS = {
  locale: 'en',
  /** Never invented. The generator will derive this from the developer's git config. */
  author: null,
  templateId: TEMPLATE_ID_PLACEHOLDER,
  templateVersion: null,
  mode: 'coming-soon',
  features: [],
  packageManager: 'npm',
  install: true,
  git: true,
} as const satisfies {
  locale: string;
  author: null;
  templateId: string;
  templateVersion: null;
  mode: TemplateMode;
  features: readonly string[];
  packageManager: PackageManager;
  install: boolean;
  git: boolean;
};

/**
 * Placeholder meta description. Deliberately generic — the template layer owns
 * real copy from M3 onward. Flagged in the M1 report as review-at-M3.
 */
export function defaultSiteDescription(siteName: string): string {
  return `Official website of ${siteName}.`;
}

/** `acme-website` -> `Acme Website` */
export function titleCase(input: string): string {
  return input
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
