import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';

/**
 * Tailwind, as a styling adapter distinct from the framework.
 *
 * Kept separate even though V1 ships a single `astro-tailwind` template,
 * because the separation is the point: styling is its own dimension, and the
 * declaration written here is the one a React + Vite project will reuse
 * unchanged. Collapsing it into the Astro adapter would have been less code
 * today and a rewrite later.
 *
 * ## Deliberate temporary coupling
 *
 * Tailwind's *files* are not contributed here. `src/styles/global.css`,
 * the `@tailwindcss/vite` registration in `astro.config.mjs`, and the entries
 * in `_package.json` all live inside `templates/astro-tailwind/`, delivered by
 * the Astro adapter's template layers.
 *
 * That is a real limitation, not a design preference. Separating them means
 * splitting the template directory and having the planner compose CSS and Astro
 * config from two owners - which is the configuration-merging work the
 * architecture schedules for a later stage. Doing it now would have put
 * byte-identical output at risk for no gain, and byte-identical output is the
 * only thing this stage is trying to prove.
 *
 * What is contributed now is the part that can be correct immediately: the
 * declaration, the capability it needs, and its dependencies with their real
 * versions. When the styling layer is generalised, the files move here and this
 * comment goes away; nothing about the declaration should have to change.
 */

const TAILWIND_DECLARATION: AdapterDeclaration = {
  id: 'tailwind',
  kind: 'styling',
  displayName: 'Tailwind CSS',
  provides: ['css-framework'],
  requires: [
    {
      kind: 'requires',
      capability: 'vite-plugins',
      // Tailwind v4 dropped the PostCSS-config path in favour of a build
      // plugin, so this is a genuine technical requirement rather than a
      // stand-in for "works with Astro". Stated as a capability, it holds for
      // any Vite-based stack without naming one.
      because: 'Tailwind v4 integrates through the @tailwindcss/vite build plugin',
    },
  ],
};

const OWNER = adapterRef(TAILWIND_DECLARATION);

export function createTailwindAdapter(): Adapter {
  return {
    declaration: TAILWIND_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      return {};
    },

    contribute(_project: ResolvedProject): Contribution {
      return {
        ...emptyContribution(OWNER),
        // Exactly the versions in templates/astro-tailwind/base/_package.json.
        dependencies: [
          {
            name: 'tailwindcss',
            version: '4.3.3',
            kind: 'dev',
            owner: OWNER,
            reason: 'the styling system',
          },
          {
            name: '@tailwindcss/vite',
            version: '4.3.3',
            kind: 'dev',
            owner: OWNER,
            reason: 'the v4 build plugin; configured in astro.config.mjs',
          },
        ],
      };
    },
  };
}

export { TAILWIND_DECLARATION };
