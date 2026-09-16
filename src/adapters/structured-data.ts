import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import { resolveOrganization } from '../domain/structured-data.js';

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
 * JSON-LD block is a `<script>` in the document head that has to be in the
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
 * It contributes no dependencies, no scripts, no configuration files and no
 * source files. A package to serialise one JSON object would be weight in every
 * generated project for something `JSON.stringify` already does.
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
       */
      kind: 'requires',
      capability: 'composed-metadata',
      because: 'it writes a JSON-LD script into the head',
    },
  ],
};

const OWNER = adapterRef(STRUCTURED_DATA_DECLARATION);

export function createStructuredDataAdapter(): Adapter {
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

      return {
        ...emptyContribution(OWNER),

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
