import path from 'node:path';

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

export function createTailwindAdapter(templatesRoot: string): Adapter {
  return {
    declaration: TAILWIND_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      return {};
    },

    contribute(_project: ResolvedProject): Contribution {
      return {
        ...emptyContribution(OWNER),

        /**
         * The global stylesheet, addressed by role.
         *
         * Moved out of the React template in Stage 5. While it lived there, the
         * framework template hardcoded `@import 'tailwindcss'` - so selecting
         * any other styling system would still have shipped Tailwind. Owning it
         * here is what makes the styling dimension real.
         *
         * Astro is unaffected: its template ships its own global.css and its
         * adapter declares that role template-owned, so this contribution is
         * not composed there and its output does not move.
         */
        files: [
          {
            // Its own packages, merged into package.json rather than listed in the
            // framework template - which would make every React project install
            // Tailwind whatever styling was selected.
            target: { kind: 'role', role: 'package' },
            intent: 'merge',
            payload: {
              kind: 'json',
              value: {
                devDependencies: { '@tailwindcss/vite': '4.3.3', tailwindcss: '4.3.3' },
              },
            },
            owner: OWNER,
            order: 0,
            reason: 'the packages this styling system needs',
          },
          {
            target: { kind: 'role', role: 'styles.global' },
            intent: 'create',
            payload: {
              kind: 'template',
              source: path.join(templatesRoot, 'styling', 'tailwind', 'styles.global.css'),
            },
            owner: OWNER,
            order: 0,
            reason: 'imports Tailwind and implements the shared style contract',
          },
        ],

        /**
         * Registers the Tailwind plugin in whatever build configuration the
         * selected architecture defines.
         *
         * Added when React arrived, and deliberately framework-blind: it names
         * a role, not a file and not a framework. Architectures that map
         * `config.build` (React) get the plugin composed in; architectures that
         * do not (Astro, whose build config is `astro.config.mjs` under
         * `config.framework`) compose nothing and keep registering it in their
         * own template, exactly as before.
         *
         * This is the whole of what Tailwind gained from React existing. There
         * is no branch on the framework here and there should never be one.
         */
        config: [
          {
            target: 'config.build',
            at: 'plugins',
            value: {
              importName: 'tailwindcss',
              importFrom: '@tailwindcss/vite',
              call: 'tailwindcss()',
            },
            owner: OWNER,
            reason: 'Tailwind v4 compiles through a build plugin',
          },
        ],

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
