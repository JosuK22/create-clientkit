import { adapterRef } from '../domain/adapters.js';
import type { Adapter, AdapterDeclaration, AdapterResolution } from '../domain/adapters.js';
import { resolveAccessibilityContract } from '../domain/accessibility.js';
import type { Contribution } from '../domain/contributions.js';
import { emptyContribution } from '../domain/contributions.js';
import { CliError } from '../errors.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';

/**
 * Accessibility, as a feature.
 *
 * The fourth feature adapter, and the third of the shape SEO established: a
 * framework-independent contract owned by the feature, with each framework
 * keeping ownership of how it satisfies it.
 *
 * ## What this feature is for
 *
 * Not auditing. There is no scanner here, no axe, no Lighthouse, no crawler and
 * no report. Those measure a finished site; this states what the generator
 * itself guarantees about the shell it produces, so the boundary between "the
 * generator handled this" and "this is yours" is written down instead of
 * assumed.
 *
 * That boundary is the deliverable. A team that believes a generated project is
 * already accessible stops checking, which is worse than a team that knows
 * exactly which eight properties are guaranteed and which six are theirs.
 *
 * ## Why `document-metadata`
 *
 * Every guarantee in the contract is a property of the document that reaches
 * the client *before any script runs*: the language on `<html>`, one `<main>`,
 * one `<h1>`, a skip link ahead of the content. That is the same property
 * `document-metadata` already names, so the capability is reused rather than
 * duplicated under an accessibility-flavoured name. Minting a second capability
 * for one requirement would force every future framework to declare two things
 * where one is true.
 *
 * A single-page application does not have it. Its shell is assembled after
 * hydration, so nothing in the response carries these structures and the
 * guarantees cannot be made about the generated document. That is a real
 * limitation of the current React stack rather than a defect to paper over, and
 * the combination is refused.
 *
 * ## What it deliberately does not require
 *
 * Not the SEO feature, not structured data, not `not-found` - by capability or
 * by name. Not a styling system: contrast is the developer's colour choice, and
 * requiring Tailwind would make an accessibility guarantee contingent on a
 * design decision. Not a UI library, not a build tool, not TypeScript.
 *
 * It contributes no dependencies, no scripts, no configuration and no files.
 */

const ACCESSIBILITY_DECLARATION: AdapterDeclaration = {
  id: 'accessibility',
  kind: 'feature',
  displayName: 'Accessibility baseline',
  provides: [],
  requires: [
    {
      kind: 'requires',
      capability: 'document-metadata',
      because:
        'the language, landmarks and heading it guarantees have to be in the document before any script runs',
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
      because: 'its guarantees are about the document shell this generator composes',
    },
  ],
};

const OWNER = adapterRef(ACCESSIBILITY_DECLARATION);

export function createAccessibilityAdapter(): Adapter {
  return {
    declaration: ACCESSIBILITY_DECLARATION,

    resolve(_manifest: ProjectManifest): AdapterResolution {
      return {
        /**
         * The guarantee, as a semantic role.
         *
         * `app.layout` is the shared shell - the thing that owns `<html>`,
         * `<head>` and the landmarks around the page. Requested by role, so
         * this adapter never learns where that shell lives.
         */
        requiredRoles: ['app.layout'],
      };
    },

    contribute(project: ResolvedProject): Contribution {
      const contract = resolveAccessibilityContract(project.manifest.site);

      // A malformed language tag is refused rather than replaced. Substituting
      // a plausible default would put a language on the document that nobody
      // chose, and assistive technology would announce the page in it.
      if (!contract.documentLanguageValid) {
        throw new CliError(
          `"${contract.documentLanguage}" is not a language tag the generated document can declare.`,
          {
            hint:
              'The accessibility baseline guarantees the document states its language, and it will not guess one. ' +
              'Set a BCP-47 tag such as "en" or "en-GB".',
          },
        );
      }

      return {
        ...emptyContribution(OWNER),

        config: [
          {
            /**
             * Its own slot on the shared shell role.
             *
             * The same arrangement SEO and structured data use: one role, one
             * slot each, so three features describe different aspects of the
             * same surface without any of them knowing the others exist.
             */
            target: 'app.layout',
            at: 'accessibility',
            value: contract,
            owner: OWNER,
            reason: 'the accessibility properties the generated shell guarantees',
          },
        ],
      };
    },
  };
}

export { ACCESSIBILITY_DECLARATION };
