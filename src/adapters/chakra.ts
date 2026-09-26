import path from 'node:path';

import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';

/**
 * Chakra UI, the second UI-library adapter.
 *
 * Deliberately the same shape as MUI's, because it answers the same question -
 * "where do my components come from" - and occupies the same dimension. What
 * differs is only what Chakra itself needs, and every difference below is one
 * of those.
 *
 * ## What it requires
 *
 * `react-runtime`, because its components are React components, and
 * `client-app-root`, because `ChakraProvider` is context mounted above the
 * whole application. Nothing else: not a build tool, not a styling system. The
 * frameworks that provide both are the frameworks that can have it, and this
 * file names none of them.
 *
 * ## What it contributes
 *
 * Its packages, and one file: the provider component, addressed by role. Like
 * MUI, its styling engine is Emotion, which is owned here as an implementation
 * detail and is not the project's styling choice.
 */

const CHAKRA_DECLARATION: AdapterDeclaration = {
  id: 'chakra',
  kind: 'ui-library',
  displayName: 'Chakra UI',
  // Chakra's components are styled through Emotion at runtime, the same real
  // CSS-in-JS runtime MUI declares.
  provides: ['css-in-js'],
  requires: [
    {
      kind: 'requires',
      capability: 'react-runtime',
      because: 'its components are React components',
    },
    {
      kind: 'requires',
      capability: 'client-app-root',
      because: 'it mounts its styling system and theme context above the whole application',
    },
  ],
};

const OWNER = adapterRef(CHAKRA_DECLARATION);

export function createChakraAdapter(templatesRoot: string): Adapter {
  return {
    declaration: CHAKRA_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      // No extensions and no Node floor of its own.
      return {};
    },

    contribute(project: ResolvedProject): Contribution {
      // The capability MUI reads for the same reason: Emotion generates styles
      // while rendering, and a server render has to flush them into the head.
      const serverInserted = project.capabilities.has('server-inserted-head');

      return {
        ...emptyContribution(OWNER),

        files: [
          {
            target: { kind: 'role', role: 'app.providers' },
            intent: 'create',
            payload: {
              kind: 'template',
              source: path.join(
                templatesRoot,
                'ui-library',
                'chakra',
                serverInserted ? 'AppProviders.server-inserted.tsx' : 'AppProviders.tsx',
              ),
            },
            owner: OWNER,
            order: 0,
            reason: 'mounts the Chakra styling system and its theme above the app',
          },
        ],

        config: [
          {
            // Same slot and order as MUI, for the same reason: the provider
            // belongs outside the router, so every route is inside it.
            target: 'app.root',
            at: 'providers',
            value: { importName: 'AppProviders', role: 'app.providers', order: 10 },
            owner: OWNER,
            reason: 'Chakra components need its styling system mounted above them',
          },
        ],

        dependencies: [
          {
            name: '@chakra-ui/react',
            version: '3.37.0',
            kind: 'prod',
            owner: OWNER,
            reason: 'the component library itself; its components ship in the bundle',
          },
          {
            // A required peer of @chakra-ui/react, not a transitive dependency,
            // so the adapter that chose Chakra installs it.
            name: '@emotion/react',
            version: '11.14.0',
            kind: 'prod',
            owner: OWNER,
            reason: "Chakra's styling engine, which its components require at runtime",
          },
          // `@emotion/cache` is already a dependency of `@emotion/react`, but
          // the server-render integration imports it directly, and a project
          // should declare what its own code imports.
          ...(serverInserted
            ? [
                {
                  name: '@emotion/cache',
                  version: '11.14.0',
                  kind: 'prod' as const,
                  owner: OWNER,
                  reason: 'collects styles generated during a server render for the document head',
                },
              ]
            : []),
        ],
      };
    },
  };
}

export { CHAKRA_DECLARATION };
