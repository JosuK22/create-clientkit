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
      /*
       * A build integration, either flavour.
       *
       * This said `requires: 'vite-plugins'` until Stage 23, which was
       * over-specified in the same way `react-runtime` was before Stage 22:
       * true of every stack that existed, and not actually what Tailwind
       * depends on. Tailwind v4 dropped the PostCSS-*config* path in favour of
       * a build plugin, and it ships two - `@tailwindcss/vite` and
       * `@tailwindcss/postcss`. What it needs is one of them to have somewhere
       * to run, which is what this now says.
       *
       * Stated as capabilities, so a framework with a PostCSS pipeline works
       * the day it declares one and nothing here is edited.
       */
      kind: 'requiresOneOf',
      capabilities: ['vite-plugins', 'postcss'],
      because: 'Tailwind v4 compiles through a build plugin, either Vite’s or PostCSS’s',
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

    contribute(project: ResolvedProject): Contribution {
      /*
       * Which of Tailwind's two build plugins this project can run.
       *
       * A capability, never a framework. `vite-plugins` means there is a Vite
       * plugin array to register in; otherwise the project reached this point
       * by providing `postcss`, and Tailwind ships a PostCSS plugin for
       * exactly that case. The compatibility engine has already guaranteed one
       * of the two is present - that is what `requiresOneOf` above is for - so
       * there is no third branch and no fallback to guess at.
       *
       * The alternative was `manifest.framework === 'nextjs'`, which would be
       * shorter, wrong, and the first crack in the styling dimension.
       */
      const vite = project.capabilities.has('vite-plugins');

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
          /*
           * The PostCSS configuration, for a project whose pipeline is PostCSS
           * rather than Vite.
           *
           * Addressed by role, like everything else here: Tailwind knows it
           * needs a PostCSS config, and the architecture knows that file is
           * called `postcss.config.mjs` and lives at the root. An architecture
           * that maps no `config.styling` composes nothing, which is the same
           * arrangement that keeps the Vite entry below out of Astro.
           */
          ...(vite
            ? []
            : [
                {
                  target: { kind: 'role', role: 'config.styling' } as const,
                  intent: 'create' as const,
                  payload: {
                    kind: 'template' as const,
                    source: path.join(templatesRoot, 'styling', 'tailwind', 'postcss.config.mjs'),
                  },
                  owner: OWNER,
                  order: 0,
                  reason: 'registers Tailwind with the PostCSS pipeline',
                },
              ]),
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
        config: vite
          ? [
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
            ]
          : [],

        // Exactly the versions in templates/astro-tailwind/base/_package.json.
        dependencies: [
          {
            name: 'tailwindcss',
            version: '4.3.3',
            kind: 'dev',
            owner: OWNER,
            reason: 'the styling system',
          },
          /*
           * One plugin package, chosen by the pipeline that exists.
           *
           * Both are Tailwind's own, both are held at the same version as
           * `tailwindcss` itself, and exactly one is ever installed - a project
           * with both would carry a package nothing loads.
           */
          vite
            ? {
                name: '@tailwindcss/vite',
                version: '4.3.3',
                kind: 'dev' as const,
                owner: OWNER,
                reason: 'the v4 build plugin, registered in the build configuration',
              }
            : {
                name: '@tailwindcss/postcss',
                version: '4.3.3',
                kind: 'dev' as const,
                owner: OWNER,
                reason: 'the v4 build plugin, registered in the PostCSS configuration',
              },
        ],
      };
    },
  };
}

export { TAILWIND_DECLARATION };
