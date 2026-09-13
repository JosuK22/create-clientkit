/**
 * The contract between the resolution layer and everything downstream.
 *
 * Nothing below the resolver ever reads flags, prompts, env vars or config
 * files: it reads a ProjectContext. That is what makes interactive and
 * non-interactive runs a single code path.
 */

export const TEMPLATE_MODES = ['coming-soon', 'full'] as const;
export type TemplateMode = (typeof TEMPLATE_MODES)[number];

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface SiteContext {
  readonly name: string;
  /** `null` means "explicitly absent"; never a fabricated URL. */
  readonly url: string | null;
  readonly description: string;
  readonly locale: string;
  /** `null` until the generator can derive it from the developer's git config. */
  readonly author: string | null;
}

export interface TemplateContext {
  readonly id: string;
  /** `null` until a real template registry supplies versions. */
  readonly version: string | null;
  readonly mode: TemplateMode;
}

export interface ProjectContext {
  /** Absolute, normalised path. */
  readonly targetDir: string;
  /** npm-safe name; also the generated package.json `name`. */
  readonly projectName: string;
  readonly site: SiteContext;
  readonly template: TemplateContext;
  /** Always empty in V1 — the feature overlay system is deferred. */
  readonly features: readonly string[];
  readonly packageManager: PackageManager;
  readonly git: boolean;
  readonly install: boolean;
  readonly cliVersion: string;
  /** ISO-8601 timestamp. */
  readonly generatedAt: string;
}

/** Where each resolved value came from. Powers `--dry-run` diagnostics. */
export type ValueSource =
  | 'flag'
  | 'file'
  /** A named starting point supplied the value; the user did not state it. */
  | 'preset'
  | 'prompt'
  | 'template'
  | 'default'
  | 'derived';

export type SourceMap = Readonly<Record<string, ValueSource>>;

export interface ResolutionResult {
  readonly context: ProjectContext;
  readonly sources: SourceMap;
}

/**
 * A partial set of answers contributed by one precedence layer (flags, config
 * file, prompts, template defaults). The resolver merges these in order.
 *
 * Every field is `| undefined` so a layer can be built incrementally under
 * exactOptionalPropertyTypes.
 */
export interface ContextInput {
  dir?: string | undefined;
  siteName?: string | undefined;
  siteUrl?: string | null | undefined;
  siteDescription?: string | undefined;
  locale?: string | undefined;
  author?: string | null | undefined;
  templateId?: string | undefined;
  templateVersion?: string | null | undefined;
  mode?: TemplateMode | undefined;
  packageManager?: PackageManager | undefined;
  git?: boolean | undefined;
  install?: boolean | undefined;
}
