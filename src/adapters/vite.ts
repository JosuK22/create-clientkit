import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';

/**
 * Vite, as a build tool in its own right.
 *
 * Separate from React on purpose, and the separation is the point of the stage:
 * React does not imply a bundler and Vite does not imply React. Collapsing them
 * into one `react-vite` adapter would have been less code and would have made
 * Vue-on-Vite, or React-on-something-else, a rewrite rather than an addition.
 *
 * Nothing here mentions React. Vite declares what it offers - a plugin pipeline
 * and the scripts to drive it - and anything that needs those asks for the
 * capability. That is why the Tailwind adapter, written before React existed and
 * untouched since, works with this stack without modification.
 */

const VITE_DECLARATION: AdapterDeclaration = {
  id: 'vite',
  kind: 'build-tool',
  displayName: 'Vite',
  /**
   * `vite-plugins` is the capability Tailwind already required in Stage 2, when
   * Astro was the only thing providing it. Reused rather than duplicated: a
   * second `vite-plugin-support` capability meaning the same thing would have
   * forced Tailwind to require both.
   */
  provides: ['vite-plugins'],
  requires: [],
  /**
   * Vite 8 declares `^20.19.0 || >=22.12.0`. The resolution model compares a
   * single floor numerically and has no way to express a gap, so the floor is
   * recorded here and the precise range is what the generated package.json
   * declares to npm. Simplification noted rather than hidden - it is only ever
   * used to report a minimum, never to gate an install.
   */
  minNode: '>=20.19.0',
};

const OWNER = adapterRef(VITE_DECLARATION);

export function createViteAdapter(): Adapter {
  return {
    declaration: VITE_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      // Vite decides no source extensions: what a component file is called is a
      // framework question, and what .ts means is a language question.
      return { minNode: VITE_DECLARATION.minNode ?? '>=20.19.0' };
    },

    contribute(_project: ResolvedProject): Contribution {
      return {
        ...emptyContribution(OWNER),
        dependencies: [
          {
            name: 'vite',
            version: '8.3.0',
            kind: 'dev',
            owner: OWNER,
            reason: 'the build tool',
          },
        ],
        scripts: [
          { name: 'dev', command: 'vite', owner: OWNER, order: 0, reason: 'development server' },
          {
            name: 'build',
            command: 'vite build',
            owner: OWNER,
            order: 1,
            reason: 'production build',
          },
          {
            name: 'preview',
            command: 'vite preview',
            owner: OWNER,
            order: 2,
            reason: 'serve the production build locally',
          },
        ],
      };
    },
  };
}

export { VITE_DECLARATION };
