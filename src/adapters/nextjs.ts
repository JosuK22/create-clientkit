import path from 'node:path';

import { adapterRef } from '../domain/adapters.js';
import type {
  AdapterDeclaration,
  AdapterResolution,
  FrameworkAdapter,
} from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import type { ArchitectureDefinition } from '../domain/roles.js';
import type { TemplateManifest } from '../templates/manifest.js';
import { planStarterLayers, selectStarter } from '../domain/starter.js';

/**
 * The Next.js framework adapter: the third framework, and the one that tests
 * whether "third" costs anything.
 *
 * Astro proved the contract could describe an existing product. React proved it
 * generalised to a second framework with a separate build tool. What this had
 * to prove is different again, because Next is the first framework that is
 * *nearly* React and not React:
 *
 *   - it provides `react-runtime`, so every React-only library is a candidate
 *   - it routes its own files, so a client router has nothing to own
 *   - its root is a server component, so nothing can wrap it in context
 *   - it ships its own CSS pipeline, so no styling adapter composes a stylesheet
 *
 * Three of those four are refusals, and every one of them comes out of the
 * capability set rather than out of a branch. The compatibility engine contains
 * no mention of Next, and this file mentions no other adapter.
 *
 * The one thing it did cost: `react-runtime` and `client-app-root` had been the
 * same capability in practice, because React was the only thing providing
 * either. MUI and React Router both said, in prose, that they mount context
 * above the application; both only asked for the runtime. Next provides the
 * runtime and no client root, which is what made the conflation visible.
 */

const NEXTJS_DECLARATION: AdapterDeclaration = {
  id: 'nextjs',
  kind: 'framework',
  displayName: 'Next.js',
  /**
   * What is true of a Next project, and the absences matter as much as the
   * entries.
   *
   * - `file-based-routing`: the App Router turns `app/page.tsx` into a route,
   *   and an unmatched path reaches a real not-found *document* in the
   *   response. That is the capability's actual meaning.
   * - `document-metadata`: the `metadata` export is rendered into the head
   *   server-side, before the response is sent - which is the whole content of
   *   that claim and the reason a client-only title does not qualify.
   * - `react-runtime`: components are React components.
   *
   * Not `spa-routing`: navigation in the App Router is the framework's, not a
   * shape the project can build on. Not `client-side-routing`: nothing here
   * matches routes in the browser. Not `client-app-root`: `app/layout.tsx` is a
   * server component and ClientKit generates no client boundary above it. Not
   * `vite-plugins`: Next does not build with Vite, and claiming it would let
   * Tailwind's requirement be satisfied by a plugin pipeline that is not there.
   * Not `composed-metadata`: the layout declares its own `metadata` export and
   * reads no contributions, so a feature writing into the head would vanish.
   * Not `static-output`: `next build` produces a server application by default,
   * and nothing here generates a static export.
   */
  provides: [
    'react-runtime',
    'jsx',
    'typescript',
    'file-based-routing',
    'document-metadata',
    /*
     * Next reads `postcss.config.mjs` natively and runs the pipeline as part
     * of its own build. A fact about Next that predates any styling system -
     * declared in Stage 23 because it is true, not because Tailwind needed a
     * way in.
     */
    'postcss',
    /*
     * The global stylesheet is composed rather than shipped.
     *
     * This was withheld through Stage 23, on the grounds that "Next ships
     * `styles/globals.css` from its own template, so a styling adapter
     * contributing a second one would collide". Stage 23 made both halves of
     * that false and nobody updated the declaration: `styles.global` left
     * `templateOwnedRoles`, the plain stylesheet became a contribution like
     * any other, and the collision it warned about is exactly what the
     * composer now arbitrates. Stage 24's investigation found the drift.
     *
     * Declared here because it is what the capability *means*: this
     * architecture maps `styles.global`, ships nothing into it from a template
     * layer, and lets composition decide the one owner. The framework never
     * learns which styling adapter that was - it is Tailwind, Bootstrap or
     * Next's own plain CSS, resolved identically.
     *
     * It is distinct from `postcss` above, and Next provides both for separate
     * reasons. `postcss` is about *processing*: there is a pipeline a build
     * plugin can run in. This is about *composition*: there is a stylesheet
     * surface a contribution can be written into. A framework can have either
     * without the other, and conflating them is how a styling system gets
     * accepted and then silently ignored.
     */
    'composed-stylesheet',
  ],
  requires: [],
  /** Next 16's own floor. */
  minNode: '>=20.9.0',
};

/**
 * One opinionated App Router layout.
 *
 * No `pages/`, no `src/`, no choice between them. A second arrangement would be
 * a second architecture to test, document and keep working, bought with nothing
 * but the ability to disagree about a directory name.
 *
 * `app.entry` and `app.root` are deliberately unmapped: Next owns the entry
 * point and there is no root component a user composes - `app/layout.tsx` is
 * the top of the tree and it is the layout. `app.providers` and `app.router`
 * are unmapped for the same reason they are refusals: there is no client root
 * to mount providers above, and the router is the framework's.
 *
 * `page.notFound` is unmapped rather than pointed at `app/not-found.tsx`,
 * because this stage generates no not-found page. Mapping a role to a file that
 * is never written would make `assertRequiredRoles` pass on a promise nothing
 * keeps.
 */
const NEXTJS_ARCHITECTURE: ArchitectureDefinition = {
  id: 'next-app',
  displayName: 'Next.js App Router',
  /**
   * What the generated project actually contains. Empty directories are not
   * created - the generator writes files and their parents - so every entry
   * here has a file under it in at least one starter.
   */
  directories: ['app', 'components/ui', 'lib', 'public', 'styles'],
  roles: {
    'app.layout': 'app/layout.tsx',
    'page.home': 'app/page.tsx',
    'config.site': 'lib/site.config.ts',
    'config.framework': 'next.config.ts',
    /*
     * Where a styling system's own configuration file goes, if it needs one.
     * Mapping the role is not a claim that one exists - nothing writes here
     * unless a styling adapter contributes it, exactly like `app.providers` on
     * React.
     */
    'config.styling': 'postcss.config.mjs',
    'config.language': 'tsconfig.json',
    'styles.global': 'styles/globals.css',
    package: 'package.json',
    'assets.public': 'public',
    'docs.readme': 'README.md',
  },
};

const OWNER = adapterRef(NEXTJS_DECLARATION);

export function createNextjsAdapter(templateRoot: string): FrameworkAdapter {
  return {
    declaration: NEXTJS_DECLARATION,

    /** Next is its own build tool; there is no separate adapter to select. */
    ownsBuildTool: true,
    buildTools: { kind: 'fixed', value: 'next' },
    languages: { kind: 'fixed', value: 'ts' },
    /**
     * `file-based`, fixed. Not a router adapter: it is what a framework that
     * routes by file already does, recorded so the choice is visible. The same
     * arrangement Astro uses, and the reason the routing question is skipped.
     */
    routers: { kind: 'fixed', value: 'file-based' },
    architectures: { kind: 'fixed', value: 'next-app' },
    architectureDefinitions: [NEXTJS_ARCHITECTURE],
    templateManifest: NEXTJS_TEMPLATE_MANIFEST,
    /**
     * Plain CSS, shipped by the template.
     *
     * Not ownership of the dimension - `--styling tailwind` still resolves to
     * Tailwind and is still refused by the compatibility engine, which is where
     * that refusal belongs. This only settles what an unstated styling means,
     * which for Next is "the globals.css the template already contains".
     */
    defaultStyling: 'none',
    defaultUiLibrary: 'none',
    /**
     * The unconditional three. `styles.global` is deliberately absent here and
     * decided in `resolve` instead - see below.
     */
    templateOwnedRoles: ['config.framework', 'package', 'config.site'],

    resolve(manifest: ProjectManifest): AdapterResolution {
      return {
        requiredRoles: selectStarter(manifest.starter).guarantees,
        minNode: NEXTJS_DECLARATION.minNode ?? '>=20.9.0',
        extensions: {
          source: '.ts',
          component: '.tsx',
          // next.config.ts - Next reads a TypeScript config natively, so this
          // is `.ts` where Astro resolved `.mjs`.
          config: '.ts',
        },
      };
    },

    contribute(project: ResolvedProject): Contribution {
      const starter = selectStarter(project.manifest.starter);

      return {
        ...emptyContribution(OWNER),

        // The third framework, and the same two halves as the other two: which
        // layers and in what order from the shared contract, where they live
        // from here. Nothing in `domain/starter.ts` learned that Next exists.
        templateLayers: planStarterLayers({
          starter,
          owner: OWNER,
          roots: {
            base: path.join(templateRoot, 'base'),
            starter: path.join(templateRoot, 'modes', starter.id),
          },
          baseReason: 'the Next.js application every starter shares',
        }),

        /*
         * The plain-CSS stylesheet, contributed only when nothing else will.
         *
         * It is a contribution rather than a file in the base layer, and the
         * difference is the whole design. A layer file is written
         * unconditionally, so shipping it there and selecting Tailwind put two
         * owners on `styles/globals.css` - which the composer correctly
         * refused. As a contribution it competes on equal terms: exactly one
         * stylesheet is ever claimed, and which one is a resolution rather
         * than a precedence rule.
         *
         * The condition is "is there a styling adapter at all", never which
         * one. The class names in this file and in every styling adapter's are
         * the same shared contract, which is what makes that sufficient - and
         * what keeps a framework-specific styling branch out of the codebase.
         */
        files:
          project.manifest.styling === 'none'
            ? [
                {
                  target: { kind: 'role', role: 'styles.global' },
                  intent: 'create',
                  payload: {
                    kind: 'template',
                    source: path.join(templateRoot, 'styling', 'globals.css'),
                  },
                  owner: OWNER,
                  order: 0,
                  reason: 'the design system a project with no styling adapter still needs',
                },
              ]
            : [],

        // Exactly the versions in templates/nextjs/base/_package.json, asserted
        // equal by a test so the two cannot drift.
        dependencies: [
          {
            name: 'next',
            version: '16.3.5',
            kind: 'prod',
            owner: OWNER,
            reason: 'the framework itself',
          },
          {
            name: 'react',
            version: '19.3.0',
            kind: 'prod',
            owner: OWNER,
            reason: 'the runtime Next renders with',
          },
          {
            name: 'react-dom',
            version: '19.3.0',
            kind: 'prod',
            owner: OWNER,
            reason: 'renders React on the server and hydrates it in the browser',
          },
          {
            name: '@types/node',
            version: '22.20.3',
            kind: 'dev',
            owner: OWNER,
            reason: 'types for next.config.ts and the server runtime',
          },
          {
            name: '@types/react',
            version: '19.3.0',
            kind: 'dev',
            owner: OWNER,
            reason: 'React types',
          },
          {
            // 5.x for the same reason the other two frameworks hold it there:
            // one TypeScript major across generated stacks keeps the drift
            // probe coherent.
            name: 'typescript',
            version: '5.9.3',
            kind: 'dev',
            owner: OWNER,
            reason: 'type-checks the application',
          },
        ],

        /**
         * Three native Next commands and one type check.
         *
         * `lint` is deliberately absent, and the reason is worth recording:
         * Next 16 removed the `next lint` command, so there is no native
         * command to bind it to. Providing one would mean adding `eslint` and
         * `eslint-config-next`, which are outside the dependency baseline this
         * stage sets - and a `lint` script that errors on its first run is
         * worse than no script at all.
         */
        scripts: [
          {
            name: 'dev',
            command: 'next dev',
            owner: OWNER,
            order: 0,
            reason: 'development server',
          },
          {
            name: 'build',
            command: 'next build',
            owner: OWNER,
            order: 1,
            reason: 'production build',
          },
          {
            name: 'start',
            command: 'next start',
            owner: OWNER,
            order: 2,
            reason: 'serves the production build',
          },
          {
            name: 'typecheck',
            command: 'tsc --noEmit',
            owner: OWNER,
            // Ten rather than three, matching React's: a check you run, not
            // part of the everyday loop, and it leaves room below.
            order: 10,
            reason: 'type-checks without emitting; the build is Next’s',
          },
        ],

        directories: [...NEXTJS_ARCHITECTURE.directories],
      };
    },
  };
}

export { NEXTJS_ARCHITECTURE, NEXTJS_DECLARATION };

/**
 * Template identity for the Next material.
 *
 * Declared here rather than as a `templates/nextjs/template.json`, because a
 * manifest on disk is what the V1 registry discovers - and that would put Next
 * into `--list-templates` and `--template nextjs`, announcing a public
 * selection path this stage does not open. The same arrangement React uses.
 *
 * Omitting it is not neutral, which is how this came to be written: without a
 * manifest the bridge falls back to the V1 registry's default, and a generated
 * Next project's `.client-site.json` recorded `"template": "astro-tailwind"`
 * and `"framework": "astro"`. A provenance file that describes the wrong
 * framework is worse than no provenance file.
 */
export const NEXTJS_TEMPLATE_MANIFEST: TemplateManifest = {
  id: 'nextjs',
  displayName: 'Next.js + TypeScript',
  description: 'Professional Next.js client website foundation',
  version: '0.1.0',
  framework: 'nextjs',
  frameworkVersion: '16.3.5',
  minNode: '>=20.9.0',
  supportedModes: ['coming-soon', 'full'],
  defaults: { mode: 'coming-soon', locale: 'en' },
  availableFeatures: [],
  tokens: ['siteName', 'siteUrl', 'description', 'projectName', 'author', 'locale', 'mode'],
  postSteps: ['install', 'git-init'],
  nextSteps: [
    'Edit lib/site.config.ts - name, description, locale and contact all live there.',
    'Set SITE.url once the domain is known.',
    'Replace public/favicon.svg with the client mark.',
  ],
};
