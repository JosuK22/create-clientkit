/**
 * The independent axes a project is configured along.
 *
 * These are kept separate on purpose. V1 collapsed the whole stack into one
 * `template` string plus a `mode`, which worked while there was exactly one
 * template and stopped working the moment there was a choice. A framework is
 * not a build tool, a styling system is not a component library, and a folder
 * layout is not a framework - conflating any of those pairs is what forces a
 * template per combination.
 *
 * Each dimension follows the V1 convention: an `as const` array as the runtime
 * source of truth, with the union derived from it. That keeps validation,
 * prompting and exhaustiveness checks reading from one list.
 *
 * Adding an id here is deliberately a central, reviewable edit. It is one line
 * plus an adapter; it is not a redesign, and nothing in the composition system
 * branches on these values.
 */

export const FRAMEWORK_IDS = ['astro', 'react', 'nextjs', 'angular'] as const;
export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

/**
 * Separate from the framework because React alone does not imply a bundler,
 * while Astro, Next and Angular each fix theirs. `DimensionOptions` in
 * `adapters.ts` is what expresses that difference without a per-framework
 * branch at the call site.
 */
export const BUILD_TOOL_IDS = ['astro', 'vite', 'next', 'angular-cli'] as const;
export type BuildToolId = (typeof BUILD_TOOL_IDS)[number];

export const LANGUAGE_IDS = ['ts', 'js'] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

/** A styling system: how CSS is authored and built. */
export const STYLING_IDS = ['tailwind', 'bootstrap', 'css', 'scss', 'none'] as const;
export type StylingId = (typeof STYLING_IDS)[number];

/**
 * A component library: prebuilt UI with its own conventions, and often its own
 * styling engine.
 *
 * Deliberately not the same dimension as styling. Tailwind and MUI are not
 * alternatives to each other - they occupy different roles and can legitimately
 * be selected together. Modelling them as one dimension would make that
 * combination inexpressible and would imply Bootstrap and Chakra are
 * interchangeable, which they are not.
 */
export const UI_LIBRARY_IDS = ['mui', 'chakra', 'angular-material', 'none'] as const;
export type UiLibraryId = (typeof UI_LIBRARY_IDS)[number];

export const ROUTER_IDS = ['none', 'file-based', 'react-router', 'angular-router'] as const;
export type RouterId = (typeof ROUTER_IDS)[number];

/**
 * A folder and layering convention, owned by the framework adapter.
 *
 * Kept separate from the framework id so that a framework can eventually offer
 * more than one (feature-first, say) without the framework itself becoming two
 * entries.
 */
export const ARCHITECTURE_IDS = [
  'astro-standard',
  'react-standard',
  'nextjs-app',
  'angular-standard',
] as const;
export type ArchitectureId = (typeof ARCHITECTURE_IDS)[number];

/**
 * Framework-independent intent. What a feature *means* is the same everywhere;
 * how it is implemented is not, which is why the implementation belongs to the
 * framework adapter rather than to the feature.
 *
 * `starter:*` is where V1's `mode` lands. It was never a core concept - it was
 * an Astro template detail that reached `src/types.ts` and stayed there.
 */
export const FEATURE_IDS = [
  'accessibility',
  'not-found',
  'seo',
  'robots',
  'sitemap',
  'structured-data',
  'social-metadata',
  'starter:coming-soon',
  'starter:full',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
