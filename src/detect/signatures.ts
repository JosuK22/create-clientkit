import type {
  BuildToolId,
  FrameworkId,
  RouterId,
  StylingId,
  UiLibraryId,
} from '../domain/dimensions.js';
import type { PackageManager } from '../types.js';

/**
 * What each value looks like from the outside: the packages that prove it and
 * the configuration files that corroborate it.
 *
 * ## Why this is a table and not derived from the adapters
 *
 * The adapters say what ClientKit *writes* for a value, and a detector has to
 * recognise projects ClientKit never wrote. An Angular project, a Vue project
 * and a hand-built React app all need recognising, and no adapter describes
 * any of them. So the table is written here, once, and kept honest two ways:
 *
 *   - Keyed by the domain's own id types (`satisfies Record<FrameworkId, …>`),
 *     so a new id in `domain/dimensions.ts` does not compile until detection
 *     says what it looks like. The vocabulary is not restated; it is required.
 *   - A round-trip test plans every stack ClientKit accepts, detects the
 *     result, and asserts the same stack comes back. A package an adapter
 *     starts writing that this table does not know fails there.
 *
 * Whether a detected id is *implemented* is not recorded here at all. That is
 * the adapter registry's question, and the resolver asks it.
 *
 * ## Tiers
 *
 * `owner: true` marks a value that owns the layer below it: Next.js, Astro and
 * Angular ship their own build tooling and bring React or their own runtime
 * with them. A project listing `next` and `react` is a Next.js project, not an
 * ambiguous one, so an owner outranks a non-owner. Two owners, or two
 * non-owners with no owner, are ambiguous and reported as such.
 */

export interface Signature {
  /** Packages in `dependencies` or `devDependencies` that establish this value. */
  readonly packages: readonly string[];
  /** Root configuration files that corroborate it. Never sufficient alone. */
  readonly configs?: readonly string[];
  /** Outranks non-owners in the same dimension. See "Tiers" above. */
  readonly owner?: boolean;
}

/** A value outside ClientKit's vocabulary, recognised so it is not mistaken for one inside it. */
export interface ForeignSignature extends Signature {
  /** How the value is named in output. Not an id: nothing may select it. */
  readonly name: string;
}

const configNames = (stem: string, extensions: readonly string[]): readonly string[] =>
  extensions.map((extension) => `${stem}.${extension}`);

const ASTRO_CONFIGS = configNames('astro.config', ['mjs', 'js', 'ts', 'mts', 'cjs']);
const NEXT_CONFIGS = configNames('next.config', ['js', 'mjs', 'ts', 'cjs']);
const VITE_CONFIGS = configNames('vite.config', ['ts', 'js', 'mjs', 'mts', 'cjs', 'cts']);

export const FRAMEWORK_SIGNATURES = {
  astro: { packages: ['astro'], configs: ASTRO_CONFIGS, owner: true },
  nextjs: { packages: ['next'], configs: NEXT_CONFIGS, owner: true },
  angular: { packages: ['@angular/core'], configs: ['angular.json'], owner: true },
  react: { packages: ['react'] },
} as const satisfies Record<FrameworkId, Signature>;

export const FOREIGN_FRAMEWORKS: readonly ForeignSignature[] = [
  { name: 'Gatsby', packages: ['gatsby'], owner: true },
  { name: 'Nuxt', packages: ['nuxt'], owner: true },
  { name: 'Remix', packages: ['@remix-run/react'], owner: true },
  { name: 'SvelteKit', packages: ['@sveltejs/kit'], owner: true },
  { name: 'Preact', packages: ['preact'] },
  { name: 'SolidJS', packages: ['solid-js'] },
  { name: 'Svelte', packages: ['svelte'] },
  { name: 'Vue', packages: ['vue'] },
];

export const BUILD_TOOL_SIGNATURES = {
  astro: { packages: ['astro'], configs: ASTRO_CONFIGS, owner: true },
  next: { packages: ['next'], configs: NEXT_CONFIGS, owner: true },
  'angular-cli': {
    packages: ['@angular/cli', '@angular-devkit/build-angular'],
    configs: ['angular.json'],
    owner: true,
  },
  vite: { packages: ['vite'], configs: VITE_CONFIGS },
} as const satisfies Record<BuildToolId, Signature>;

export const FOREIGN_BUILD_TOOLS: readonly ForeignSignature[] = [
  { name: 'Create React App', packages: ['react-scripts'] },
  { name: 'Parcel', packages: ['parcel'] },
  { name: 'Rsbuild', packages: ['@rsbuild/core'] },
  { name: 'webpack', packages: ['webpack'] },
];

/**
 * `css` and `none` have no signature: plain CSS needs no package, so there is
 * nothing to find. A project with none of the packages below reports styling
 * as absent, and the resolver reads absent as `none`.
 */
export const STYLING_SIGNATURES = {
  tailwind: {
    packages: ['tailwindcss'],
    configs: configNames('tailwind.config', ['js', 'cjs', 'mjs', 'ts']),
  },
  bootstrap: { packages: ['bootstrap'] },
  scss: { packages: ['sass', 'sass-embedded'] },
} as const satisfies Record<Exclude<StylingId, 'css' | 'none'>, Signature>;

export const FOREIGN_STYLING: readonly ForeignSignature[] = [
  { name: 'Bulma', packages: ['bulma'] },
  { name: 'Less', packages: ['less'] },
  { name: 'UnoCSS', packages: ['unocss'] },
];

export const UI_LIBRARY_SIGNATURES = {
  mui: { packages: ['@mui/material'] },
  chakra: { packages: ['@chakra-ui/react'] },
  'angular-material': { packages: ['@angular/material'] },
} as const satisfies Record<Exclude<UiLibraryId, 'none'>, Signature>;

export const FOREIGN_UI_LIBRARIES: readonly ForeignSignature[] = [
  { name: 'Ant Design', packages: ['antd'] },
  { name: 'Mantine', packages: ['@mantine/core'] },
  { name: 'PrimeReact', packages: ['primereact'] },
  { name: 'React Bootstrap', packages: ['react-bootstrap'] },
  { name: 'Vuetify', packages: ['vuetify'] },
];

/**
 * `file-based` has no signature because it is not a package: it is what Next
 * and Astro do, and their adapters fix it. `none` is the absence of the rest.
 */
export const ROUTER_SIGNATURES = {
  'react-router': { packages: ['react-router', 'react-router-dom'] },
  'angular-router': { packages: ['@angular/router'] },
} as const satisfies Record<Exclude<RouterId, 'file-based' | 'none'>, Signature>;

export const FOREIGN_ROUTERS: readonly ForeignSignature[] = [
  { name: 'TanStack Router', packages: ['@tanstack/react-router'] },
  { name: 'Vue Router', packages: ['vue-router'] },
  { name: 'wouter', packages: ['wouter'] },
];

/**
 * Lockfiles, by exact name. Presence is the evidence; none is ever opened.
 * `npm-shrinkwrap.json` is npm's publishable lockfile and means the same.
 */
export const LOCKFILES = {
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'npm-shrinkwrap.json': 'npm',
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
} as const satisfies Record<string, PackageManager>;

export const TSCONFIG = 'tsconfig.json';
export const JSCONFIG = 'jsconfig.json';
