import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';

/**
 * A real not-found page, as a feature.
 *
 * The first adapter in the `feature` dimension, and the one that had to settle
 * what a feature actually owns. The answer this adapter arrived at is narrower
 * than it first looks, and the reasoning matters more than the code.
 *
 * ## What a feature owns
 *
 * A not-found *page* is framework-specific by nature. Astro's is `.astro`
 * markup that imports an Astro layout; a React one would be a component behind
 * a router; a Next one would be a file with a reserved name. Putting any of
 * those inside this adapter would mean shipping one implementation per
 * framework - `Astro404`, `React404`, `Next404` - which is precisely the matrix
 * the whole design exists to prevent.
 *
 * So the feature does not own the markup. It owns two things that genuinely are
 * framework-independent:
 *
 *   - **the requirement**: a not-found page has to be *routable*, which is a
 *     capability, not a file. A framework that cannot serve an unmatched path
 *     cannot have this feature however many files are generated.
 *   - **the guarantee**: selecting it means the finished project has one. The
 *     plan is checked against that before anything is written, so the feature
 *     cannot be silently satisfied by nothing.
 *
 * The framework supplies the implementation, the architecture decides where it
 * lives, and this decides whether the project may claim to have one at all.
 * That split is the whole point: `not-found` names no framework, and no
 * framework names `not-found`.
 *
 * ## Why `file-based-routing`
 *
 * It is the smallest correct requirement. A framework that routes by file
 * serves `/anything-at-all` from its not-found page with no configuration and
 * no router package - that is what makes the page real rather than a component
 * nothing renders.
 *
 * `spa-routing` deliberately does not satisfy it. React with Vite provides
 * `spa-routing` and no router, so an unmatched path returns the server's own
 * 404 and never reaches the application. Generating a `404.tsx` there would
 * produce a file that looks like a feature and is dead code. The combination is
 * refused instead, and a test holds that line.
 *
 * ## What it deliberately does not require
 *
 * Not a styling system: the page is markup, and the framework's own template
 * styles it however that framework styles anything. Not a UI library. Not
 * TypeScript. Not a build tool. Requiring any of them would turn a composition
 * choice into a technical constraint.
 *
 * It contributes no dependencies, no scripts and no configuration, because a
 * not-found page needs none of those. A feature that quietly added a package
 * would be the worst version of this abstraction.
 */

const NOT_FOUND_DECLARATION: AdapterDeclaration = {
  id: 'not-found',
  kind: 'feature',
  displayName: 'Not-found page',
  provides: [],
  requires: [
    {
      kind: 'requires',
      capability: 'file-based-routing',
      because:
        'an unmatched path has to reach the page for it to be a 404 rather than an unreachable file',
    },
  ],
};

const OWNER = adapterRef(NOT_FOUND_DECLARATION);

export function createNotFoundAdapter(): Adapter {
  return {
    declaration: NOT_FOUND_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      return {
        /**
         * The guarantee, in the only form the planner acts on.
         *
         * Addressed as a semantic role, so this adapter never learns that Astro
         * puts the page at `src/pages/404.astro`. Whoever fills the role
         * satisfies it - the framework's template here, a contribution
         * elsewhere - because the check runs against the finished plan by
         * resolved path rather than against who promised what.
         */
        requiredRoles: ['page.notFound'],
      };
    },

    contribute(_project: ResolvedProject): Contribution {
      // Nothing. Not an oversight: see the header. The page is framework
      // -specific markup and belongs to whoever knows the framework, while the
      // requirement and the guarantee - which are not - belong here.
      return emptyContribution(OWNER);
    },
  };
}

export { NOT_FOUND_DECLARATION };
