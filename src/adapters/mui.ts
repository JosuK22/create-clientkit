import path from 'node:path';

import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';

/**
 * Material UI, the first UI-library adapter.
 *
 * The point of this adapter is not MUI. It is that the UI library is a
 * dimension of its own, independent of the framework, the build tool and - the
 * part that is easy to get wrong - the styling system.
 *
 * ## Why a UI library is not a styling system
 *
 * Tailwind and Bootstrap answer "what do the classes on my markup mean". MUI
 * answers "where do my components come from". A project can want both, and this
 * one does: the generated starter keeps its styling system's global stylesheet
 * and its semantic classes exactly as they were, and adds MUI above them.
 * Collapsing the two would mean `styling: mui` and then having to explain why
 * `tailwind + mui` is unrepresentable.
 *
 * Emotion is the confusing case and is worth stating plainly. `@emotion/react`
 * and `@emotion/styled` are MUI's styling *engine* and are owned here, as MUI's
 * implementation detail. They are not the project's styling *choice*, which
 * remains whatever the styling adapter contributed. A dependency and a
 * dimension are different things.
 *
 * ## What it requires, and what it deliberately does not
 *
 * `react-runtime`, and nothing else. Not the build tool: MUI ships compiled
 * JavaScript and needs no bundler plugin, so requiring `vite-plugins` would
 * exclude bundlers that could serve it perfectly well. Not a styling system:
 * MUI works with any of them, or none, and requiring one would encode a product
 * combination as a technical constraint.
 *
 * That single requirement is what makes this framework-agnostic in the only way
 * that matters - a test builds a hypothetical non-React framework that provides
 * `react-runtime`, and MUI works with it unmodified and unaware.
 *
 * ## What it contributes
 *
 * Its packages, and one file: the provider component that mounts the theme, the
 * baseline and the styling engine above the application. It addresses that file
 * by role, so it never learns where the architecture keeps components, and it
 * names only its own export. It contributes no scripts, because it needs none.
 */

const MUI_DECLARATION: AdapterDeclaration = {
  id: 'mui',
  kind: 'ui-library',
  displayName: 'Material UI',
  // Emotion, which MUI mounts, is a real CSS-in-JS runtime available to
  // anything else in the project. Declared because it is true, not because
  // anything requires it yet - and it is an existing capability rather than a
  // new name invented for this adapter.
  provides: ['css-in-js'],
  requires: [
    {
      kind: 'requires',
      capability: 'react-runtime',
      because: 'its components are React components',
    },
    {
      // Split out from `react-runtime` in Stage 22. The prose above always
      // said MUI mounts context above the tree; the constraint only asked for
      // the runtime, which was the same thing while React was the only
      // framework providing one. Next provides the runtime and no client root,
      // and that is exactly the case this has to refuse.
      kind: 'requires',
      capability: 'client-app-root',
      because: 'it mounts a theme and style context above the whole application',
    },
  ],
};

const OWNER = adapterRef(MUI_DECLARATION);

export function createMuiAdapter(templatesRoot: string): Adapter {
  return {
    declaration: MUI_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      // No extensions and no Node floor of its own: MUI's requirements are
      // satisfied by any Node the framework already accepts.
      return {};
    },

    contribute(project: ResolvedProject): Contribution {
      /*
       * Whether this project's framework can flush server-rendered markup into
       * the document head.
       *
       * A capability, never a framework. Emotion generates styles while
       * rendering; on a client-only framework they are inserted in the browser
       * and there is nothing to collect, while on a server-rendering one they
       * must be flushed into the head or hydration disagrees with itself.
       *
       * The same shape Tailwind uses to choose between its two build plugins:
       * one adapter, two integrations, selected by what the project can do.
       */
      const serverInserted = project.capabilities.has('server-inserted-head');

      return {
        ...emptyContribution(OWNER),

        files: [
          {
            /**
             * The provider wrapper, addressed by role.
             *
             * The architecture decides where this lives - `src/components/ui/
             * AppProviders.tsx` under React, somewhere else under a future
             * framework - and this adapter never learns which. A template file
             * rather than an inline string so the component stays reviewable,
             * formatted and diffable as TSX.
             */
            target: { kind: 'role', role: 'app.providers' },
            intent: 'create',
            payload: {
              kind: 'template',
              source: path.join(
                templatesRoot,
                'ui-library',
                'mui',
                serverInserted ? 'AppProviders.server-inserted.tsx' : 'AppProviders.tsx',
              ),
            },
            owner: OWNER,
            order: 0,
            reason: 'mounts the theme, the CSS baseline and the styling engine above the app',
          },
        ],

        config: [
          {
            // Asks to wrap the application root. Names its own export and
            // nothing else: the composer resolves the import path from the
            // architecture's role mapping.
            target: 'app.root',
            at: 'providers',
            // Order 10 leaves room on both sides. What matters is that the
            // theme ends up *outside* the router rather than inside it: a
            // wrapper inside the router only wraps the route it was handed to,
            // and a theme that covers one route out of two is worse than none.
            // See the router adapter, which explains what that cost looked
            // like.
            value: { importName: 'AppProviders', role: 'app.providers', order: 10 },
            owner: OWNER,
            reason: 'MUI components need the theme and styling engine mounted above them',
          },
        ],

        dependencies: [
          {
            name: '@mui/material',
            version: '9.4.0',
            kind: 'prod',
            owner: OWNER,
            reason: 'the component library itself; its components ship in the bundle',
          },
          {
            // MUI's default styling engine. Declared as optional peers by MUI
            // because it also supports Pigment CSS, which means npm installs
            // neither unless someone asks - so the adapter that chose the
            // engine asks for it.
            name: '@emotion/react',
            version: '11.14.0',
            kind: 'prod',
            owner: OWNER,
            reason: "MUI's styling engine, which its components require at runtime",
          },
          {
            name: '@emotion/styled',
            version: '11.14.1',
            kind: 'prod',
            owner: OWNER,
            reason: "the styled() API MUI's components are built on",
          },
          /*
           * The server-render integration, installed only where there is a
           * server render to integrate with.
           *
           * Owned by MUI rather than by the framework, and the direction
           * matters: MUI is what needs its styles flushed, so MUI asks. A
           * framework depending on a UI library would invert the composition
           * and make every project carry it.
           *
           * The package is MUI's own and its vendor named it after the
           * framework it targets. That name is a fact about the registry, not
           * a branch - the decision above is made on a capability, and this
           * adapter still contains no framework id it tests against.
           */
          ...(serverInserted
            ? [
                {
                  name: '@mui/material-nextjs',
                  version: '9.4.0',
                  kind: 'prod' as const,
                  owner: OWNER,
                  reason: 'flushes styles generated during a server render into the document head',
                },
              ]
            : []),
        ],
      };
    },
  };
}

export { MUI_DECLARATION };
