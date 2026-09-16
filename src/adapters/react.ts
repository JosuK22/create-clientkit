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
 * The React framework adapter.
 *
 * The second framework, and therefore the first real test of whether the V2
 * architecture generalises or merely described Astro. What it had to prove:
 *
 *   - React and Vite are independent dimensions, not a `react-vite` product
 *   - the compatibility engine needed no case for React
 *   - the Tailwind adapter works here untouched
 *   - file roles map to a completely different tree with no shared assumptions
 *   - Astro's output does not move by a byte
 *
 * Everything React-specific lives here or in `templates/react-vite/`. Nothing
 * about React appears in the compatibility engine, the planner, the Tailwind
 * adapter, or the Astro adapter.
 */

const REACT_DECLARATION: AdapterDeclaration = {
  id: 'react',
  kind: 'framework',
  displayName: 'React',
  /**
   * `react-runtime` is what a future MUI or Chakra adapter will require. It is
   * declared now, unused by anything, because the capability is a fact about
   * React rather than a favour to a library that does not exist yet - and a
   * library requiring it should work the day it is written, with no edit here.
   *
   * Note what is absent: `vite-plugins`. React does not provide a plugin
   * pipeline; Vite does. Claiming it here would let React + a bundler that has
   * no plugin system satisfy Tailwind's requirement, which would be a lie the
   * compatibility engine could not catch.
   */
  provides: ['react-runtime', 'jsx', 'typescript', 'spa-routing', 'composed-stylesheet'],
  requires: [],
  minNode: '>=20.19.0',
};

/**
 * A professional React layout.
 *
 * Deeper than Astro's because React projects grow differently: the framework
 * supplies no routing, data or layout conventions, so the scaffold has to. The
 * directories exist to make the shape of a real client site obvious rather than
 * to be impressive - a developer should know where a hook goes without asking.
 *
 * `config.framework` is deliberately unmapped: React has no configuration file
 * of its own. Its build configuration is Vite's, mapped to `config.build`. That
 * asymmetry with Astro - which maps `config.framework` and no `config.build` -
 * is exactly what the role indirection exists to absorb, and it is what lets
 * the Tailwind adapter target a build config without knowing whether one exists.
 */
const REACT_ARCHITECTURE: ArchitectureDefinition = {
  id: 'react-standard',
  displayName: 'React standard',
  /**
   * The directories the generated project actually has.
   *
   * Not an aspirational list. Empty directories are not created - the generator
   * writes files and their parents - so naming `src/services` here while
   * shipping nothing into it would be metadata claiming something untrue. A
   * test asserts this list against what the template really produces.
   */
  directories: [
    'public',
    'src',
    'src/components/common',
    'src/components/layout',
    'src/components/ui',
    'src/config',
    'src/hooks',
    'src/layouts',
    'src/pages',
    'src/styles',
  ],
  roles: {
    'app.entry': 'src/main.tsx',
    'app.root': 'src/App.tsx',
    // Where a UI library's provider wrapper goes, if one is selected. React
    // decides the location; the library that fills it never learns the path.
    'app.providers': 'src/components/ui/AppProviders.tsx',
    // Where a router's composition root goes, if one is selected. Separate from
    // app.providers because a project can have both, and sharing one role would
    // make them collide for no reason but that both happen to wrap the tree.
    'app.router': 'src/routes/AppRouter.tsx',
    'app.layout': 'src/layouts/BaseLayout.tsx',
    'page.home': 'src/pages/HomePage.tsx',
    // Where a view for an unmatched address goes. Mapping the role is not a
    // claim that React has a 404 - it has no such thing, and `not-found` stays
    // refused here because it requires `file-based-routing`. It says only that
    // if something fills the role, this is where the file belongs. Nothing does
    // unless a client-side router and the fallback feature are both selected,
    // which is why the role is optional rather than produced by the framework.
    'page.notFound': 'src/pages/NotFoundPage.tsx',
    'config.site': 'src/config/site.config.ts',
    'config.build': 'vite.config.ts',
    'config.language': 'tsconfig.json',
    'styles.global': 'src/styles/index.css',
    package: 'package.json',
    'assets.public': 'public',
    'docs.readme': 'README.md',
  },
  // src/main.tsx imports the global stylesheet, so a React project without one
  // does not build. Declared rather than assumed: an architecture that composed
  // its entry point could drop this and legitimately support `styling: 'none'`.
  requiredRoles: ['styles.global'],
  rootExportName: 'App',
};

const OWNER = adapterRef(REACT_DECLARATION);

export function createReactAdapter(templateRoot: string): FrameworkAdapter {
  return {
    declaration: REACT_DECLARATION,

    /** React needs a bundler; it does not bring one. */
    ownsBuildTool: false,
    buildTools: { kind: 'choice', options: ['vite'], default: 'vite' },
    languages: { kind: 'fixed', value: 'ts' },
    /**
     * A choice, and `none` is the default.
     *
     * This said `fixed: 'none'` until Stage 14, which was true when written and
     * stopped being true in Stage 12 - nothing read the field, so nothing
     * noticed. It is read now: the CLI takes its unstated defaults from here
     * rather than from a table of per-framework special cases, which is what
     * lets the normaliser contain no branch on the framework at all.
     *
     * `none` stays the default because the router is opt-in: `react + vite +
     * tailwind` generates the same files it did before Stage 12, and a test
     * counts them.
     */
    routers: { kind: 'choice', options: ['none', 'react-router'], default: 'none' },
    architectures: { kind: 'fixed', value: 'react-standard' },
    architectureDefinitions: [REACT_ARCHITECTURE],
    /** Nothing: the styling adapter supplies the global stylesheet. */
    templateOwnedRoles: [],
    templateManifest: REACT_TEMPLATE_MANIFEST,

    resolve(manifest: ProjectManifest): AdapterResolution {
      return {
        /*
         * What the selected starter guarantees the finished project contains.
         *
         * Declared rather than assumed: a template layer that shipped no home
         * page would otherwise generate a project whose entry point is missing,
         * and nothing would say so until someone opened it. Checked against the
         * plan by resolved path, so the framework's own template satisfies it.
         */
        requiredRoles: selectStarter(manifest.starter).guarantees,
        minNode: REACT_DECLARATION.minNode ?? '>=20.19.0',
        extensions: {
          source: manifest.language === 'js' ? '.js' : '.ts',
          // .tsx, where Astro resolved .astro - the assertion that would have
          // failed had anything downstream assumed a component extension.
          component: manifest.language === 'js' ? '.jsx' : '.tsx',
          config: '.ts',
        },
      };
    },

    contribute(project: ResolvedProject): Contribution {
      const starter = selectStarter(project.manifest.starter);

      return {
        ...emptyContribution(OWNER),

        // Same two halves as Astro's, and the same contract joining them. Two
        // frameworks arranging their layers identically is a coincidence; the
        // contract is what stops the third from arranging them differently.
        templateLayers: planStarterLayers({
          starter,
          owner: OWNER,
          roots: {
            base: path.join(templateRoot, 'base'),
            starter: path.join(templateRoot, 'modes', starter.id),
          },
          baseReason: 'the React application every starter shares',
        }),

        /**
         * The React plugin is contributed as a build-config entry rather than
         * written into a template file. That is what keeps `vite.config.ts`
         * composable: Tailwind adds its own entry the same way, and neither
         * adapter has to know the other exists.
         */
        config: [
          {
            // The page the application root renders. React names its own
            // export and nothing else: the composer resolves the path from the
            // architecture, so this says nothing about where pages live.
            target: 'app.root',
            at: 'page',
            value: { importName: 'HomePage' },
            owner: OWNER,
            reason: 'the page the application root renders',
          },
          {
            target: 'config.build',
            at: 'plugins',
            value: {
              importName: 'react',
              importFrom: '@vitejs/plugin-react',
              call: 'react()',
            },
            owner: OWNER,
            reason: 'compiles JSX and enables fast refresh',
          },
        ],

        // Exactly the versions in templates/react-vite/base/_package.json,
        // asserted equal by a test so the two cannot drift.
        dependencies: [
          {
            name: 'react',
            version: '19.3.0',
            kind: 'prod',
            owner: OWNER,
            reason: 'the framework itself',
          },
          {
            name: 'react-dom',
            version: '19.3.0',
            kind: 'prod',
            owner: OWNER,
            reason: 'renders React into the DOM',
          },
          {
            // Owned by React, not Vite: it exists because React was selected.
            // Swap React for Vue under the same bundler and this package leaves
            // while @vitejs/plugin-vue arrives, so it tracks the framework.
            name: '@vitejs/plugin-react',
            version: '6.1.1',
            kind: 'dev',
            owner: OWNER,
            reason: 'the Vite plugin that compiles React',
          },
          {
            name: '@types/react',
            version: '19.3.0',
            kind: 'dev',
            owner: OWNER,
            reason: 'React types',
          },
          {
            name: '@types/react-dom',
            version: '19.3.0',
            kind: 'dev',
            owner: OWNER,
            reason: 'React DOM types',
          },
          {
            // Held at 5.x to match the rest of this repository and the Astro
            // template rather than for a peer constraint - React has none. One
            // TypeScript major across generated stacks keeps the drift probe
            // coherent; revisit when it says to.
            name: 'typescript',
            version: '5.9.3',
            kind: 'dev',
            owner: OWNER,
            reason: 'type-checks the application',
          },
        ],

        scripts: [
          {
            name: 'typecheck',
            command: 'tsc --noEmit',
            owner: OWNER,
            // After the build tool's dev/build/preview: this is a check you run,
            // not part of the everyday loop. Ten rather than three so a build
            // tool can add a script without renumbering anything here.
            order: 10,
            reason: 'type-checks without emitting; the build is Vite’s',
          },
        ],

        directories: [...REACT_ARCHITECTURE.directories],
      };
    },
  };
}

export { REACT_ARCHITECTURE, REACT_DECLARATION };

/**
 * Template identity for the React material.
 *
 * Declared here rather than as a `templates/react-vite/template.json`, because
 * a manifest on disk is exactly what the V1 registry discovers - and that would
 * put React into `--list-templates` and `--template react-vite`, announcing a
 * public selection path this stage deliberately does not open.
 *
 * `tokens` is the V1 substitution vocabulary; React uses the same one, which is
 * itself a small piece of evidence that the token layer was never Astro-shaped.
 */
export const REACT_TEMPLATE_MANIFEST: TemplateManifest = {
  id: 'react-vite',
  displayName: 'React + Vite + TypeScript',
  description: 'Professional React client website foundation',
  version: '0.1.0',
  framework: 'react',
  frameworkVersion: '19.3.0',
  minNode: '>=20.19.0',
  supportedModes: ['coming-soon', 'full'],
  defaults: { mode: 'coming-soon', locale: 'en' },
  availableFeatures: [],
  tokens: ['siteName', 'siteUrl', 'description', 'projectName', 'author', 'locale', 'mode'],
  postSteps: ['install', 'git-init'],
  nextSteps: [
    'Edit src/config/site.config.ts - name, description, navigation and contact all live there.',
    'Set SITE.url once the domain is known.',
    'Replace public/favicon.svg with the client mark.',
  ],
};
