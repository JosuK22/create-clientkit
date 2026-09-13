import path from 'node:path';

import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';

/**
 * React Router, the first router adapter.
 *
 * The point of this adapter is not React Router. It is that routing is a
 * dimension of its own - selected explicitly, composable with any styling
 * system and any UI library, and owned by neither the framework nor the build
 * tool.
 *
 * ## The distinction this adapter exists to preserve
 *
 * A router is not file-based routing, and conflating the two would let the
 * generator claim something untrue. Three capabilities, three different
 * statements:
 *
 *   - `file-based-routing` - the framework turns files into routes, and an
 *     address nothing matches reaches a real not-found *document* in the
 *     response. Astro has this.
 *   - `spa-routing` - navigation happens without a full page load. React has
 *     this with or without any router.
 *   - `client-side-routing` - this adapter. Routes are declared and matched, in
 *     the browser, after the response has already been sent.
 *
 * A catch-all route renders a component; it does not produce an HTTP 404. So
 * this must never satisfy a requirement for `file-based-routing`, and
 * `React + Vite + react-router + not-found` stays refused. Making that
 * combination pass would produce a project whose "404 page" returns 200 to
 * every crawler that asked - a worse outcome than not offering it.
 *
 * ## What it requires
 *
 * `react-runtime`, and nothing else. React Router is React components and React
 * context; that requirement is simply true. Not the build tool - it ships
 * compiled JavaScript and needs no bundler plugin. Not a styling system, not a
 * UI library, not a feature.
 *
 * ## What it contributes
 *
 * Its package, and one file: the component that mounts the router above the
 * application and declares the home route. Addressed by role, so it never
 * learns where the architecture keeps such a component, and it names only its
 * own export.
 */

const REACT_ROUTER_DECLARATION: AdapterDeclaration = {
  id: 'react-router',
  kind: 'router',
  displayName: 'React Router',
  // True and non-redundant: the framework already declares `spa-routing`
  // without a router, so this says the different thing - routes exist and are
  // matched. A future client-side fallback feature is what would require it.
  provides: ['client-side-routing'],
  requires: [
    {
      kind: 'requires',
      capability: 'react-runtime',
      because: 'its routes are React components and it mounts React context above them',
    },
  ],
};

const OWNER = adapterRef(REACT_ROUTER_DECLARATION);

export function createReactRouterAdapter(templatesRoot: string): Adapter {
  return {
    declaration: REACT_ROUTER_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      // No extensions and no Node floor: the router constrains neither.
      return {};
    },

    contribute(_project: ResolvedProject): Contribution {
      return {
        ...emptyContribution(OWNER),

        files: [
          {
            /**
             * The routing composition root, addressed by role.
             *
             * A role of its own rather than the provider slot's, because a
             * project can have both a router and a UI library and each needs a
             * file. The architecture decides where it goes.
             */
            target: { kind: 'role', role: 'app.router' },
            intent: 'create',
            payload: {
              kind: 'template',
              source: path.join(templatesRoot, 'router', 'react-router', 'AppRouter.tsx'),
            },
            owner: OWNER,
            order: 0,
            reason: 'mounts the router above the application and declares the home route',
          },
        ],

        config: [
          {
            /**
             * Wraps the application root, outermost.
             *
             * Order 0 puts the router above anything else that wraps the tree,
             * so route context is available to every wrapper inside it -
             * including a UI library's theme, which may want to read the
             * current location.
             */
            target: 'app.root',
            at: 'providers',
            value: {
              importName: 'AppRouter',
              role: 'app.router',
              order: 0,
              note: [
                ' * Routing lives in the component below - add routes there, not here.',
                ' *',
                ' * Note that a client-side catch-all renders a component without changing',
                " * the response status, so it is not a substitute for a host's 404.",
              ],
            },
            owner: OWNER,
            reason: 'the application has to be inside the router for routes to match',
          },
        ],

        dependencies: [
          {
            name: 'react-router-dom',
            version: '7.18.3',
            // A production dependency: its components are in the shipped bundle.
            kind: 'prod',
            owner: OWNER,
            reason: 'the router itself; its components render the application',
          },
        ],
      };
    },
  };
}

export { REACT_ROUTER_DECLARATION };
