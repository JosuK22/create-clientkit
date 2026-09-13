import path from 'node:path';

import { adapterRef } from '../domain/adapters.js';
import type {
  AdapterDeclaration,
  AdapterResolution,
  FrameworkAdapter,
} from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import type { ArchitectureDefinition } from '../domain/roles.js';
import { starterLayerFor } from './starters.js';

/**
 * The Astro framework adapter: the first concrete adapter, and the one whose
 * job is to prove the architecture rather than to add capability.
 *
 * ClientKit already generates Astro projects. What this establishes is that the
 * V2 contract can describe that generation without changing a byte of it - the
 * four Stage 0 golden snapshots are the oracle, and they are asserted against
 * output produced through this adapter.
 *
 * It deliberately does not generate content. The template directory remains the
 * source of truth for what an Astro project contains, and this adapter says
 * which layers make it up, what it depends on, and where its file roles live.
 * Moving template content into code would trade a reviewable directory for a
 * string literal, and would have made byte-identical output far harder to prove.
 */

const ASTRO_DECLARATION: AdapterDeclaration = {
  id: 'astro',
  kind: 'framework',
  displayName: 'Astro',
  /**
   * `vite-plugins` is not incidental: Astro builds on Vite, and it is the
   * capability the Tailwind contribution requires, because Tailwind v4
   * integrates through `@tailwindcss/vite` rather than a PostCSS config. That
   * dependency is expressed as a capability rather than "Tailwind works with
   * Astro", which is why the same Tailwind declaration will hold for React +
   * Vite without being edited.
   */
  provides: [
    'static-output',
    'file-based-routing',
    'document-metadata',
    'typescript',
    'vite-plugins',
  ],
  requires: [],
  /** Astro 7's own floor, matching templates/astro-tailwind/template.json. */
  minNode: '>=22.12.0',
};

/**
 * Where Astro puts things.
 *
 * `app.entry` is deliberately absent. Astro has no explicit entry module - the
 * framework owns that - and `roles` being partial means "this architecture has
 * nowhere to put that" is a real answer rather than an omission. An adapter
 * asking for it gets a clear error instead of a file in an invented location.
 */
const ASTRO_ARCHITECTURE: ArchitectureDefinition = {
  id: 'astro-standard',
  displayName: 'Astro standard',
  directories: [
    'public',
    'src/components',
    'src/config',
    'src/layouts',
    'src/lib',
    'src/pages',
    'src/styles',
  ],
  roles: {
    'app.layout': 'src/layouts/BaseLayout.astro',
    'page.home': 'src/pages/index.astro',
    'page.notFound': 'src/pages/404.astro',
    'config.site': 'src/config/site.config.ts',
    'config.framework': 'astro.config.mjs',
    'config.language': 'tsconfig.json',
    'styles.global': 'src/styles/global.css',
    package: 'package.json',
    'assets.public': 'public',
    'docs.readme': 'README.md',
  },
};

const OWNER = adapterRef(ASTRO_DECLARATION);

/**
 * Builds the adapter for one installed copy of the template.
 *
 * A factory rather than a constant because the template's location is
 * discovered at runtime (it differs between a published install and this
 * repository), and an adapter must not go looking for it: `contribute` stays a
 * pure function of the resolved project it is handed.
 */
export function createAstroAdapter(templateRoot: string): FrameworkAdapter {
  return {
    declaration: ASTRO_DECLARATION,

    /** Astro is its own build tool; there is no separate adapter to select. */
    ownsBuildTool: true,
    buildTools: { kind: 'fixed', value: 'astro' },
    languages: { kind: 'fixed', value: 'ts' },
    routers: { kind: 'fixed', value: 'file-based' },
    architectures: { kind: 'fixed', value: 'astro-standard' },
    architectureDefinitions: [ASTRO_ARCHITECTURE],
    /**
     * Astro ships both from its own template, so a styling adapter must not
     * compose a second copy. Astro therefore does not provide
     * composed-stylesheet, which is what makes Bootstrap - a styling system
     * with no template arrangement here - incompatible rather than silently
     * ignored.
     */
    // `page.notFound` is here because Astro's template ships a complete 404 of
    // its own. A feature contributing one would collide with it, and the
    // framework-specific `.astro` markup could not live in a framework-agnostic
    // feature anyway without recreating the per-framework matrix the design
    // exists to avoid. Same legacy arrangement Stage 2 recorded for the
    // stylesheet: when the Astro template is generalised, this shortens.
    templateOwnedRoles: ['styles.global', 'config.framework', 'package', 'page.notFound'],

    /**
     * Astro fixes every dimension it owns, so little here varies with the
     * manifest - but the extensions are resolved rather than assumed, and
     * `source` follows the selected language rather than being pinned to `.ts`.
     *
     * All three extensions are owned here for now. `source` properly belongs to
     * a language adapter, which does not exist yet; when it does, `source`
     * moves there and the orchestrator's conflict detection catches any overlap
     * rather than letting one silently win.
     */
    resolve(manifest: ProjectManifest): AdapterResolution {
      return {
        minNode: ASTRO_DECLARATION.minNode ?? '>=22.12.0',
        extensions: {
          source: manifest.language === 'js' ? '.js' : '.ts',
          // Not .tsx: an Astro component is a .astro file whatever the language.
          component: '.astro',
          config: '.mjs',
        },
      };
    },

    contribute(project: ResolvedProject): Contribution {
      const starter = starterLayerFor(project.manifest.features);

      return {
        ...emptyContribution(OWNER),

        templateLayers: [
          {
            name: 'base',
            root: path.join(templateRoot, 'base'),
            owner: OWNER,
            order: 0,
            reason: 'the Astro project every mode shares',
          },
          {
            name: `modes/${starter}`,
            root: path.join(templateRoot, 'modes', starter),
            owner: OWNER,
            order: 10,
            reason: `the "${starter}" starter selected by the manifest`,
          },
        ],

        // Exactly the versions in templates/astro-tailwind/base/_package.json.
        // A test asserts that equality, so a template bump that forgets this
        // list fails rather than drifting quietly.
        dependencies: [
          {
            name: 'astro',
            version: '7.3.2',
            kind: 'prod',
            owner: OWNER,
            reason: 'the framework itself',
          },
          {
            name: '@astrojs/sitemap',
            version: '3.7.4',
            kind: 'prod',
            owner: OWNER,
            reason: 'generates the sitemap when a production URL is configured',
          },
          {
            name: '@astrojs/check',
            version: '0.9.10',
            kind: 'dev',
            owner: OWNER,
            reason: 'type-checks .astro files for `npm run check`',
          },
          {
            name: 'typescript',
            version: '5.9.3',
            kind: 'dev',
            owner: OWNER,
            // Not 7.x on purpose: @astrojs/check peers typescript ^5 || ^6, so
            // the newest release would break the generated project's check
            // script. Recorded here because the reason is not obvious later.
            reason: 'required by @astrojs/check; held at 5.x by its peer range',
          },
        ],

        scripts: [
          {
            name: 'dev',
            command: 'astro dev',
            owner: OWNER,
            order: 0,
            reason: 'development server',
          },
          {
            name: 'build',
            command: 'astro build',
            owner: OWNER,
            order: 1,
            reason: 'production build',
          },
          {
            name: 'preview',
            command: 'astro preview',
            owner: OWNER,
            order: 2,
            reason: 'preview the build',
          },
          {
            name: 'check',
            command: 'astro check',
            owner: OWNER,
            order: 3,
            reason: 'type-check the site',
          },
          {
            name: 'astro',
            command: 'astro',
            owner: OWNER,
            order: 4,
            reason: 'passthrough to the Astro CLI',
          },
        ],

        directories: [...ASTRO_ARCHITECTURE.directories],
      };
    },
  };
}

export { ASTRO_ARCHITECTURE, ASTRO_DECLARATION };
