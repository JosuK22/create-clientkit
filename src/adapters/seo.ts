import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import { EVERY_PAGE, onPage } from '../domain/document-contribution.js';
import { absolutePageUrl, literal } from '../domain/document-value.js';
import { resolveSeoContract } from '../domain/seo.js';

/**
 * Search-engine metadata, as a feature.
 *
 * The second feature adapter, and a materially different shape from the first.
 * `not-found` expresses a requirement and a guarantee and contributes no data,
 * because a 404 page is markup and markup is framework-specific. SEO is the
 * other case: what a page's `<head>` should *say* is entirely
 * framework-independent, so this feature owns that as data and leaves each
 * framework to render it however that framework renders anything.
 *
 * ## The split
 *
 *   - **the feature owns the contract**: title, description, robots,
 *     canonical, Open Graph and Twitter/X, derived from the site metadata the
 *     project already carries. Computable, pure, and checkable against real
 *     emitted HTML.
 *   - **the framework owns the surface**: where `<head>` is and how tags reach
 *     it. That is what the required capability is about.
 *   - **the architecture owns the location**: which file is the layout.
 *
 * Nothing here knows what Astro is, and Astro's template does not know this
 * feature exists.
 *
 * ## Why `document-metadata`
 *
 * It is the smallest correct requirement: the application must have a document
 * head that per-page metadata can be rendered into *before the response is
 * sent*. That is what makes a canonical tag or an `og:url` mean anything.
 *
 * A single-page application that sets `document.title` after hydration does
 * not have this, and deliberately does not claim it. A crawler reading the
 * initial response sees the entry HTML and nothing the feature contributed, so
 * generating metadata there would produce tags that look right in a browser
 * and are invisible to the machines the feature exists for. That combination is
 * refused, and a test holds the line. Server rendering is the fix, not a
 * runtime metadata package.
 *
 * ## What it deliberately does not require
 *
 * Not a build tool - metadata is a document concern, not a bundler one. Not a
 * styling system, not a UI library, not TypeScript. Requiring any of them would
 * turn a composition choice into a technical constraint.
 *
 * It contributes no dependencies, no scripts, no configuration files and no
 * source files. An SEO library would be weight added to every generated project
 * for tags a framework can already emit.
 */

const SEO_DECLARATION: AdapterDeclaration = {
  id: 'seo',
  kind: 'feature',
  displayName: 'Search-engine metadata',
  provides: [],
  requires: [
    {
      kind: 'requires',
      capability: 'document-metadata',
      because:
        'the contract has to reach the document head before the response is sent, or crawlers never see it',
    },
    {
      /*
       * Split out from `document-metadata` in Stage 22. Having a head that is
       * rendered before the response is sent is not the same as having one this
       * generator writes into, and the difference only became visible with a
       * third framework: on Next this feature was accepted and then produced a
       * byte-identical project.
       */
      kind: 'requires',
      capability: 'composed-metadata',
      because: 'it writes the title, description and canonical link into the head',
    },
  ],
};

const OWNER = adapterRef(SEO_DECLARATION);

export function createSeoAdapter(): Adapter {
  return {
    declaration: SEO_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      return {
        /**
         * The guarantee, as a semantic role.
         *
         * `app.layout` is the shared page shell - the thing that owns `<head>`.
         * Requesting it by role means this adapter never learns that Astro's is
         * `src/layouts/BaseLayout.astro`, and the check runs against the
         * finished plan by resolved path, so a framework template and a
         * contribution satisfy it equally.
         */
        requiredRoles: ['app.layout'],
      };
    },

    contribute(project: ResolvedProject): Contribution {
      // Derived from the site metadata the manifest already carries, so no
      // value is invented here and none is duplicated from configuration. With
      // no site URL the contract simply has no canonical and no og:url.
      const contract = resolveSeoContract(project.manifest.site);

      return {
        ...emptyContribution(OWNER),

        /*
         * What the document should say about its own address.
         *
         * Deliberately not `metadataFromContract(contract)`. That helper is the
         * faithful translation of a contract with no bindings in it, and its own
         * documentation says a contributor that knows better states a binding
         * instead. This one knows better: a canonical address follows the URL
         * the project configures and the page Astro is rendering, and freezing
         * either into a literal is exactly the failure Stage 34 stopped for.
         *
         * Two statements, and the second is the reason scope composition exists.
         * Every page claims its own absolute address; the not-found page claims
         * none, because a page asking not to be indexed while naming itself the
         * definitive copy of something contradicts itself. That is stated at the
         * page's own scope and specificity settles it - no condition in the
         * generated source, and no list of pages anywhere.
         */
        documents: [
          {
            kind: 'metadata',
            owner: OWNER,
            reason: 'every page states its own absolute address',
            scope: EVERY_PAGE,
            metadata: { state: 'stated', value: { canonical: absolutePageUrl() } },
          },
          {
            kind: 'metadata',
            owner: OWNER,
            reason: 'a page that refuses indexing does not claim to be canonical',
            scope: onPage('page.notFound'),
            metadata: { state: 'stated', value: { canonical: literal('url', '') } },
          },
        ],

        config: [
          {
            /**
             * The contract, addressed at the metadata surface.
             *
             * A `ConfigContribution` rather than a new type: it already carries
             * a target role, a slot, a value, an owner and a reason, which is
             * exactly what this needs. Inventing a `SeoContribution` would add
             * a parallel mechanism for a shape the model already expresses.
             */
            target: 'app.layout',
            at: 'metadata',
            value: contract,
            owner: OWNER,
            reason: 'what the page head must say about this site',
          },
        ],
      };
    },
  };
}

export { SEO_DECLARATION };
