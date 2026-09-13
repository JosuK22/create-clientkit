import { CliError } from '../errors.js';
import type { ArchitectureId } from './dimensions.js';

/**
 * Semantic file roles, and the architecture that maps them to real paths.
 *
 * This is what stops every non-framework adapter from needing to know which
 * framework it is running under. A styling adapter says "I have a global
 * stylesheet" and never learns where it went:
 *
 *     styles.global  ->  src/styles/global.css   (Astro)
 *                    ->  src/styles/index.css    (React + Vite)
 *                    ->  src/app/globals.css     (Next.js)
 *                    ->  src/styles.scss         (Angular)
 *
 * One Tailwind adapter therefore serves four frameworks with no branch in it.
 * Without this, the alternative is `if (framework === 'nextjs')` inside every
 * adapter that writes a file, which is the conditional-logic explosion the
 * architecture exists to avoid.
 *
 * The vocabulary below is a core artifact. If it is wrong or too thin, adapters
 * start reaching for literal paths instead and the decoupling quietly rots -
 * which is why `FileTarget` in `contributions.ts` records which of the two an
 * adapter used, so that drift is measurable rather than invisible.
 */
export const FILE_ROLES = [
  /** Process entry point: `main.tsx`, `main.ts`. */
  'app.entry',
  /** Root component or shell the entry renders. */
  'app.root',
  /**
   * The component that wraps the application in context providers.
   *
   * Added in Stage 7 for the UI-library dimension. A UI library that needs a
   * theme context, a style engine or a CSS reset has to sit above the whole
   * tree, and there was no way to express that: the root component belonged to
   * the framework's template, so the only options were for the library to
   * overwrite someone else's file or to be installed and never rendered.
   *
   * Mapping it is optional. An architecture that maps it says "there is a place
   * above the application where a provider can live, and it is here"; the root
   * composer wires it in when some adapter actually fills it, and emits the
   * plain root when nobody does.
   */
  'app.providers',
  /**
   * The component that declares the application's routes.
   *
   * Separate from `app.providers` because a project can legitimately have both
   * - a router and a UI library each wrap the application, and each needs a
   * file of its own. Sharing one role would make them collide for no reason
   * other than that both happen to be wrappers.
   *
   * Mapping it is optional, exactly like `app.providers`: an architecture that
   * maps it says "a router's composition root belongs here", and the root
   * composer wires it in when some adapter fills it.
   */
  'app.router',
  /** The shared page shell: `<head>`, header, footer. */
  'app.layout',
  /** Home page. */
  'page.home',
  /** Not-found page. */
  'page.notFound',
  /** The single file a developer edits to configure the site. */
  'config.site',
  /** Framework configuration: `astro.config.mjs`, `next.config.ts`. */
  'config.framework',
  /** Build-tool configuration where it is a separate file: `vite.config.ts`. */
  'config.build',
  /** Language configuration: `tsconfig.json`. */
  'config.language',
  /** Styling-system configuration, where the system needs a file of its own. */
  'config.styling',
  /** The global stylesheet every page loads. */
  'styles.global',
  /** Package manifest. */
  'package',
  /** Static assets directory marker. */
  'assets.public',
  /** Project README. */
  'docs.readme',
] as const;

export type FileRole = (typeof FILE_ROLES)[number];

/**
 * A framework's folder and layering convention.
 *
 * Owned by the framework adapter, because "professional structure" means
 * something different per ecosystem and pretending otherwise is how a
 * generator ends up making Angular look like React.
 *
 * `roles` is partial: not every architecture has somewhere to put every role,
 * and an unmapped role is a real answer rather than an oversight. Asking for
 * one that is unmapped fails loudly (see `resolveRole`) instead of silently
 * writing to a path nobody chose.
 */
export interface ArchitectureDefinition {
  readonly id: ArchitectureId;
  readonly displayName: string;
  /** Created even when empty, so the shape of the project is visible up front. */
  readonly directories: readonly string[];
  readonly roles: Readonly<Partial<Record<FileRole, string>>>;
  /**
   * Roles this architecture cannot be built without.
   *
   * Mapping a role says where a file goes *if* one exists; this says the
   * project is broken when one does not. React needs it because `src/main.tsx`
   * imports the global stylesheet unconditionally - with no styling adapter
   * selected, nothing contributes that file and the generated project fails to
   * build on a missing import.
   *
   * Checked against the finished plan by path, so a template-owned file
   * satisfies the requirement exactly as a contributed one does. Omitted means
   * nothing is required, which is the right answer for an architecture whose
   * every file comes from its own template.
   */
  readonly requiredRoles?: readonly FileRole[];
  /**
   * What the composed `app.root` module exports.
   *
   * Required when `app.root` is mapped, because the entry point imports this
   * binding by name and the composer must not guess it. Architecture data
   * rather than adapter data: it is a convention of the ecosystem's folder
   * shape, which is exactly what an architecture is for.
   */
  readonly rootExportName?: string;
}

/**
 * Maps a role to its concrete path for one architecture.
 *
 * Throws rather than returning undefined: an adapter contributing to a role the
 * architecture does not define is a bug in one of the two, and the useful
 * moment to say so is immediately, naming both. Silently dropping the
 * contribution would produce a project missing a file with no indication why.
 */
export function resolveRole(architecture: ArchitectureDefinition, role: FileRole): string {
  const target = architecture.roles[role];
  if (target === undefined) {
    const known = Object.keys(architecture.roles).sort().join(', ');
    throw new CliError(
      `Architecture "${architecture.id}" does not define a path for the file role "${role}".`,
      {
        hint:
          known === ''
            ? `"${architecture.id}" maps no roles at all.`
            : `Roles it does define: ${known}.`,
      },
    );
  }
  return target;
}

/** Whether an architecture can place a given role, without throwing. */
export function definesRole(architecture: ArchitectureDefinition, role: FileRole): boolean {
  return architecture.roles[role] !== undefined;
}
