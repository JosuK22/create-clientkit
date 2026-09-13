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
 * Its package, a wrapper that mounts the router above the application, and the
 * home route. Since Stage 13 the route table is composed rather than templated,
 * because a second adapter needed to add a catch-all and the alternative was
 * editing someone else's file with string replacement.
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

export function createReactRouterAdapter(): Adapter {
  return {
    declaration: REACT_ROUTER_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      // No extensions and no Node floor: the router constrains neither.
      return {};
    },

    contribute(_project: ResolvedProject): Contribution {
      return {
        ...emptyContribution(OWNER),

        config: [
          {
            /**
             * The home route.
             *
             * Contributed rather than written into a template, because Stage 13
             * needed a second adapter to add one. `children` is the application
             * the wrapper was handed, so the framework's page renders at `/`
             * without this adapter learning which page that is.
             */
            target: 'app.router',
            at: 'routes',
            value: { path: '/', element: { kind: 'children' }, order: 0 },
            owner: OWNER,
            reason: 'the application renders at the site root',
          },
          {
            /**
             * Wraps the application root, innermost.
             *
             * Stage 12 put the router outermost, reasoning that route context
             * should be available to every wrapper inside it - a theme might
             * want to read the current location. Stage 13 showed what that
             * costs, the moment a second route existed.
             *
             * The page this wrapper is handed becomes the element of one route.
             * So a wrapper *inside* the router is inside that one route too,
             * and every other route renders outside it. With MUI selected, a
             * client-side fallback rendered with no theme, no baseline and no
             * styling engine, while the home page had all three. Nothing failed
             * loudly; the second route was simply outside the application.
             *
             * A hypothetical benefit against a demonstrated defect, so: the
             * router goes innermost, and everything that wraps "the
             * application" genuinely wraps all of it. A wrapper that does need
             * route context can still ask for a higher order than this one.
             */
            target: 'app.root',
            at: 'providers',
            value: {
              importName: 'AppRouter',
              role: 'app.router',
              order: 100,
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
