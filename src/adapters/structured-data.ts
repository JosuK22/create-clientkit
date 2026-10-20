import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import { EVERY_PAGE, onPage } from '../domain/document-contribution.js';
import type { DocumentContribution } from '../domain/document-contribution.js';
import { resolveOrganization } from '../domain/structured-data.js';
import { siteUrlHelpers, structuredDataComponent } from './search-files.js';

/**
 * schema.org structured data, as a feature.
 *
 * The third feature adapter, and the second of the shape SEO established: what
 * a machine should be told about the site is framework-independent, so the
 * feature owns it as data and each framework keeps owning how it renders it.
 *
 * ## A sibling of SEO, not part of it
 *
 * The two answer different questions. SEO describes *this page* to a crawler.
 * Structured data describes *the organisation* to a knowledge graph. Either is
 * useful without the other, and folding this into the SEO adapter would have
 * made SEO the place every future search-related feature goes - the monolith
 * the feature dimension exists to avoid.
 *
 * They are siblings in the strict sense: the same capability, the same semantic
 * role, different slots, and neither names the other. Selecting one, the other,
 * or both all work, and tests cover each.
 *
 * ## Why `document-metadata`
 *
 * The same requirement SEO has, and deliberately not a new capability. A
 * JSON-LD block is a `<script>` in the document that has to be in the
 * response a crawler reads; that is exactly what `document-metadata` already
 * means. Minting a second capability for the same requirement would fragment
 * the vocabulary and force every future framework to declare two things where
 * one is true.
 *
 * ## What it deliberately does not require
 *
 * Not the SEO feature - by capability or by name. Not a styling system, not a
 * UI library, not a build tool, not TypeScript. Structured data is a JSON
 * document; none of those change what it says.
 *
 * It contributes no dependencies, no scripts and no configuration files. A
 * package to serialise one JSON object would be weight in every generated
 * project for something `JSON.stringify` already does.
 *
 * ## Two ways to reach the document
 *
 * Where the shell already states the organisation (`composed-metadata`,
 * Astro), this feature contributes no source: the template's component is the
 * richer of the two and keeps the field.
 *
 * Where the architecture renders a contributed component instead
 * (`composed-structured-data`, Next), there is nothing to keep, so the feature
 * contributes the component and states the organisation for every page. The
 * architecture's realization decides where that renders. The branch is on the
 * capability, the way MUI branches on `server-inserted-head` - never on which
 * framework it is.
 */

const STRUCTURED_DATA_DECLARATION: AdapterDeclaration = {
  id: 'structured-data',
  kind: 'feature',
  displayName: 'Structured data',
  provides: [],
  requires: [
    {
      kind: 'requires',
      capability: 'document-metadata',
      because:
        'a JSON-LD block has to be in the document the crawler reads, not added after it loads',
    },
    {
      /*
       * Split out from `document-metadata` in Stage 22. Having a head that is
       * rendered before the response is sent is not the same as having one this
       * generator writes into, and the difference only became visible with a
       * third framework: on Next this feature was accepted and then produced a
       * byte-identical project.
       *
       * One of two since SEO Stage 2. `composed-metadata` is a shell that
       * already states the contract (Astro's `StructuredData.astro`);
       * `composed-structured-data` is an architecture that renders a
       * contributed component into its pages (Next). Either puts the JSON-LD
       * in the response, and neither accepts the feature and then ignores it.
       */
      kind: 'requiresOneOf',
      capabilities: ['composed-metadata', 'composed-structured-data'],
      because:
        'the JSON-LD has to reach the document, through a shell that already states it or a component the architecture renders into its pages',
    },
  ],
};

const OWNER = adapterRef(STRUCTURED_DATA_DECLARATION);

export function createStructuredDataAdapter(templatesRoot: string): Adapter {
  return {
    declaration: STRUCTURED_DATA_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      return {
        /**
         * The guarantee, as a semantic role.
         *
         * The same role SEO requires, because it is the same surface: the
         * shared shell that owns the document head. Requesting it by role means
         * this adapter never learns where that shell lives, and the check runs
         * against the finished plan by resolved path.
         */
        requiredRoles: ['app.layout'],
      };
    },

    contribute(project: ResolvedProject): Contribution {
      // Derived from the site metadata the manifest already carries. With no
      // site URL there is simply no `url` property - see the domain module for
      // why omission beats invention here in particular.
      const organization = resolveOrganization(project.manifest.site);
      const rendersComponent = project.capabilities.has('composed-structured-data');

      /*
       * The positive statement, made only where it can be realized truthfully.
       *
       * Next's component reads the same configuration the template's would,
       * so stating the contract here hands it to a component that renders at
       * least what the contract says. On a shell that already states it, the
       * statement would claim to replace something richer than itself - see
       * below - and is not made.
       */
      const everyPage: readonly DocumentContribution[] = rendersComponent
        ? [
            {
              kind: 'structured-data',
              owner: OWNER,
              reason: 'every page describes the organisation behind the site',
              scope: EVERY_PAGE,
              jsonLd: { state: 'stated', value: organization },
            },
          ]
        : [];

      return {
        ...emptyContribution(OWNER),

        /*
         * What the document should *not* say about the organisation.
         *
         * On a shell that already states it, the positive statement stays
         * where it is. Astro's `OrganizationContract` carries five fields and
         * its shipped component emits up to nine - email, telephone, sameAs and
         * a location it does not model - so the template is the more capable of
         * the two and keeps the field. Stating the contract as a document there
         * would be claiming to replace something richer than itself.
         *
         * The refusal is a different matter, and this feature does own it: a
         * not-found page is not a page about the organisation, so it says
         * nothing about one. That is a fact about what a 404 *is*, held by the
         * feature that knows what organisation data means. Astro's shipped 404
         * already agrees (`structuredData={false}`); on Next the realization
         * reads it and leaves the component off the not-found page.
         *
         * Suppression rather than an empty value, because they mean different
         * things and have since Stage 31: this page was decided against, not
         * left unsaid.
         */
        documents: [
          ...everyPage,
          {
            kind: 'structured-data',
            owner: OWNER,
            reason: 'a not-found page describes no organisation',
            scope: onPage('page.notFound'),
            jsonLd: {
              state: 'suppressed',
              because: 'a page that was not found describes no organisation',
            },
          },
        ],

        files: rendersComponent
          ? [structuredDataComponent(OWNER, templatesRoot), siteUrlHelpers(OWNER, templatesRoot)]
          : [],

        config: [
          {
            /**
             * A different slot on the same role SEO uses.
             *
             * That is what makes the two features siblings rather than rivals:
             * they describe different parts of the same surface, so they
             * compose without either knowing the other exists, and a conflict
             * between two claims on *this* slot is still detected.
             */
            target: 'app.layout',
            at: 'structured-data',
            value: organization,
            owner: OWNER,
            reason: 'what machines should be told about the organisation behind this site',
          },
        ],
      };
    },
  };
}

export { STRUCTURED_DATA_DECLARATION };
