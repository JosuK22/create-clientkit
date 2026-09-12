import path from 'node:path';

import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';

/**
 * Bootstrap, as a second styling system.
 *
 * The point of this adapter is not Bootstrap. It is that a styling system can
 * be added without the React adapter or the Vite adapter learning it exists -
 * neither was modified, and neither mentions Bootstrap anywhere.
 *
 * What makes that possible is the split between what the markup *names* and
 * what a stylesheet *decides*. The generated components ask for `site-header`,
 * `page-title`, `button-primary`; this adapter's stylesheet implements those in
 * Bootstrap's terms, mapping them onto Bootstrap's own custom properties so the
 * values stay Bootstrap's. Tailwind implements the same contract in its terms.
 * Neither knows about the other, and the framework knows about neither.
 *
 * ## What Bootstrap does and does not require
 *
 * It requires `composed-stylesheet` and nothing else. Not `react-runtime` -
 * Bootstrap is CSS and has no opinion about the runtime. Not `vite-plugins` -
 * unlike Tailwind v4, Bootstrap ships plain CSS and needs no build plugin, so
 * requiring one would exclude bundlers that could serve it perfectly well.
 *
 * Requiring only what is technically true is what keeps the compatibility
 * engine honest: a hypothetical framework that composes its stylesheet works
 * with this adapter unmodified, and a test proves it.
 */

const BOOTSTRAP_DECLARATION: AdapterDeclaration = {
  id: 'bootstrap',
  kind: 'styling',
  displayName: 'Bootstrap',
  provides: ['css-framework'],
  requires: [
    {
      kind: 'requires',
      capability: 'composed-stylesheet',
      // Bootstrap has no legacy template arrangement anywhere, so it must be
      // able to contribute the global stylesheet. An architecture that ships
      // its own would silently ignore this one, and the project would build
      // with no Bootstrap in it at all.
      because: 'it supplies the global stylesheet, which the architecture must compose',
    },
  ],
};

const OWNER = adapterRef(BOOTSTRAP_DECLARATION);

export function createBootstrapAdapter(templatesRoot: string): Adapter {
  return {
    declaration: BOOTSTRAP_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      // No extensions, no Node floor: plain CSS constrains neither.
      return {};
    },

    contribute(_project: ResolvedProject): Contribution {
      return {
        ...emptyContribution(OWNER),

        /**
         * The global stylesheet, addressed by role rather than by path.
         *
         * The architecture decides where `styles.global` lives - `src/styles/
         * index.css` under React, somewhere else under a future framework - and
         * this adapter never learns which. Referenced as a template file rather
         * than an inline string so the CSS stays reviewable, formatted and
         * diffable as CSS.
         */
        files: [
          {
            target: { kind: 'role', role: 'package' },
            intent: 'merge',
            payload: { kind: 'json', value: { dependencies: { bootstrap: '5.3.8' } } },
            owner: OWNER,
            order: 0,
            reason: 'the packages this styling system needs',
          },
          {
            target: { kind: 'role', role: 'styles.global' },
            intent: 'create',
            payload: {
              kind: 'template',
              source: path.join(templatesRoot, 'styling', 'bootstrap', 'styles.global.css'),
            },
            owner: OWNER,
            order: 0,
            reason: 'imports Bootstrap and implements the shared style contract',
          },
        ],

        dependencies: [
          {
            name: 'bootstrap',
            version: '5.3.8',
            // A production dependency: its CSS is imported by application
            // source and ends up in the shipped bundle.
            kind: 'prod',
            owner: OWNER,
            reason: 'the styling system; its CSS is imported by the global stylesheet',
          },
        ],
      };
    },
  };
}

export { BOOTSTRAP_DECLARATION };
