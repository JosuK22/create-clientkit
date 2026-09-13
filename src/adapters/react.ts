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
import { starterLayerFor } from './starters.js';

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
    'app.layout': 'src/layouts/BaseLayout.tsx',
    'page.home': 'src/pages/HomePage.tsx',
    // No `page.notFound`. A client-side 404 needs a router to detect an
    // unmatched path, and this stage ships none - so rather than map the role
    // to a component nothing can ever render, the architecture says it has
    // nowhere to put one. Astro, which routes by file, maps it.
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
};

const OWNER = adapterRef(REACT_DECLARATION);

export function createReactAdapter(templateRoot: string): FrameworkAdapter {
  return {
    declaration: REACT_DECLARATION,

    /** React needs a bundler; it does not bring one. */
    ownsBuildTool: false,
    buildTools: { kind: 'choice', options: ['vite'], default: 'vite' },
    languages: { kind: 'fixed', value: 'ts' },
    routers: { kind: 'fixed', value: 'none' },
    architectures: { kind: 'fixed', value: 'react-standard' },
    architectureDefinitions: [REACT_ARCHITECTURE],
    /** Nothing: the styling adapter supplies the global stylesheet. */
    templateOwnedRoles: [],
    templateManifest: REACT_TEMPLATE_MANIFEST,

    resolve(manifest: ProjectManifest): AdapterResolution {
      return {
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
      const starter = starterLayerFor(project.manifest.features);

      return {
        ...emptyContribution(OWNER),

        templateLayers: [
          {
            name: 'base',
            root: path.join(templateRoot, 'base'),
            owner: OWNER,
            order: 0,
            reason: 'the React application every starter shares',
          },
          {
            name: `modes/${starter}`,
            root: path.join(templateRoot, 'modes', starter),
            owner: OWNER,
            order: 10,
            reason: `the "${starter}" starter selected by the manifest`,
          },
        ],

        /**
         * The React plugin is contributed as a build-config entry rather than
         * written into a template file. That is what keeps `vite.config.ts`
         * composable: Tailwind adds its own entry the same way, and neither
         * adapter has to know the other exists.
         */
        config: [
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
