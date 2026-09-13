import path from 'node:path';

import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import { resolveClientRouteFallbackContract } from '../domain/client-route-fallback.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';

/**
 * A client-side route fallback, as a feature.
 *
 * ## Why this is not `not-found`
 *
 * The two look like the same feature written twice. They are not, and keeping
 * them apart is the entire reason this adapter exists rather than a relaxation
 * of Stage 8's requirement.
 *
 *   - `not-found` requires `file-based-routing`. That capability means the
 *     framework turns an unmatched address into a real not-found *document*:
 *     the response itself says the page is missing, before any JavaScript runs.
 *   - this requires `client-side-routing`. That capability means routes are
 *     declared and matched *in the browser*, after the response was sent. What
 *     it produces is a rendered view. The status line is whatever the host
 *     already returned.
 *
 * One is a property of the response; the other is a property of the render. So:
 *
 *     React + Vite + React Router + client-route-fallback  -> supported
 *     React + Vite + React Router + not-found              -> refused
 *
 * The second stays refused even though React now maps `page.notFound`, because
 * the compatibility engine asks for a capability and React Router provides the
 * wrong one. Loosening that would let a project advertise a 404 page that
 * returns 200 to every crawler that asked, which is worse than not offering it.
 *
 * ## What it requires, and what it deliberately does not
 *
 * `client-side-routing`, and nothing else. Not React Router - the requirement
 * is the capability, so a second client-side router works the day it is
 * written, and a test builds a hypothetical one to prove it. Not a styling
 * system: the view uses the semantic classes every styling adapter already
 * defines, so it looks right under Tailwind and under Bootstrap without naming
 * either. Not a UI library, not TypeScript, not a build tool.
 *
 * Note what `spa-routing` does not buy. React provides it with no router at
 * all, and a fallback with nothing to match against is a component that never
 * renders. That combination is refused.
 *
 * ## What it contributes
 *
 * One view, and one route pointing at it. No packages, no scripts and no build
 * configuration - a feature that quietly installed something would be the worst
 * version of this abstraction. The route is contributed through the same
 * generic mechanism the router itself uses; nothing here knows the router's
 * name, and nothing in the router knows this exists.
 */

const CLIENT_ROUTE_FALLBACK_DECLARATION: AdapterDeclaration = {
  id: 'client-route-fallback',
  kind: 'feature',
  displayName: 'Client-side route fallback',
  provides: [],
  requires: [
    {
      kind: 'requires',
      capability: 'client-side-routing',
      because:
        'an unmatched address has to be matched by a router in the browser for the view to render at all',
    },
  ],
};

const OWNER = adapterRef(CLIENT_ROUTE_FALLBACK_DECLARATION);

export function createClientRouteFallbackAdapter(templatesRoot: string): Adapter {
  return {
    declaration: CLIENT_ROUTE_FALLBACK_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      return {
        /**
         * The guarantee, checked against the finished plan rather than against
         * anyone's promise. This adapter contributes the view itself, so the
         * role is satisfied by its own file - but the check is by resolved
         * path, so an architecture that maps the role somewhere else, or a
         * framework that supplies its own view, satisfies it just as well.
         */
        requiredRoles: ['page.notFound'],
      };
    },

    contribute(_project: ResolvedProject): Contribution {
      const contract = resolveClientRouteFallbackContract();

      return {
        ...emptyContribution(OWNER),

        files: [
          {
            /**
             * The view, addressed by role.
             *
             * A template rather than an inline string, for the same reason
             * every other contributed component is one: it stays reviewable,
             * formatted and diffable as the source it becomes. The architecture
             * decides where it lands.
             */
            target: { kind: 'role', role: 'page.notFound' },
            intent: 'create',
            payload: {
              kind: 'template',
              source: path.join(
                templatesRoot,
                'feature',
                'client-route-fallback',
                'NotFoundPage.tsx',
              ),
            },
            owner: OWNER,
            order: 0,
            reason: 'the view a visitor sees when the router matches nothing',
          },
        ],

        config: [
          {
            /**
             * The catch-all.
             *
             * The order comes from the contract rather than a number typed
             * here, because it is a correctness property and not a preference:
             * a catch-all that sorts above `/` matches first and swallows the
             * home page. Ten thousand is not a guess at "large enough" so much
             * as a statement that nothing else belongs after it.
             *
             * Addressed by role, like the file - so this never learns that the
             * view is at `src/pages/NotFoundPage.tsx`, only that whatever fills
             * `page.notFound` is what an unmatched address should render.
             */
            target: 'app.router',
            at: 'routes',
            value: {
              path: contract.catchAllPath,
              element: { kind: 'component', importName: 'NotFoundPage', role: 'page.notFound' },
              order: contract.routeOrder,
            },
            owner: OWNER,
            reason: 'an address that matches no route renders the fallback view',
          },
        ],
      };
    },
  };
}

export { CLIENT_ROUTE_FALLBACK_DECLARATION };
