import type { DocumentEmissionPlan, RealizationSupport } from '../domain/document-emission.js';
import type { ArchitectureId } from '../domain/dimensions.js';
import type { ArchitectureDefinition } from '../domain/roles.js';
import type { FileOperation } from '../generate/files.js';
import { CliError } from '../errors.js';
import { ASTRO_REALIZATION } from './astro-derivations.js';
import { realizeAstroDocument } from './astro-document-realization.js';
import { composeAstroDocument } from './astro-document-surface.js';
import { NEXT_REALIZATION, applyNextDocument } from './next-document-realization.js';

/**
 * Which architecture writes a resolved document, and how it is chosen.
 *
 * ## The defect this closes
 *
 * Until Stage 49 the bridge called Astro by name: `ASTRO_REALIZATION`,
 * `realizeAstroDocument`, `composeAstroDocument`, with nothing in between and
 * no mention of which architecture the project was. That was safe only by
 * accident - no non-Astro project can select a document-contributing feature
 * today, so the list was always empty and every call returned early.
 *
 * Stage 48 measured what the accident was hiding. Running that path against
 * Next produced:
 *
 *     Architecture "next-app" does not define a path for the file role
 *     "app.document.head"
 *
 * A role error, from the Astro composer, on a project that is not Astro. The
 * failure was correct by luck rather than by design, and the first thing a
 * second realization needs is for the choice to be made rather than assumed.
 *
 * ## What a realizer is
 *
 * Plans in, file operations out. The intermediate shape - whatever an
 * architecture turns a plan into before it writes anything - stays inside that
 * architecture's own modules, so nothing here has an opinion about heads,
 * slots or components.
 *
 * `support` is the same declaration Stage 38 defined: which bindings and
 * derivations this architecture can spell. The bridge checks each plan against
 * the *selected* realizer's support rather than against Astro's, which is the
 * other half of the same defect.
 *
 * ## No fallback, ever
 *
 * An architecture with no realizer is refused by name. There is no default and
 * no nearest match: composing a document with the wrong architecture's spelling
 * produces either a role error, as Stage 48 measured, or - worse - source that
 * happens to parse. Refusing is the only answer that cannot be wrong.
 */
export interface DocumentRealizer {
  readonly architecture: ArchitectureId;
  /** What this architecture can spell, checked before anything is written. */
  readonly support: RealizationSupport;
  /**
   * Turns resolved plans into operations, or refuses.
   *
   * Pure: operations in, operations out, no filesystem. Given no plans it
   * returns the operations it was handed, unchanged.
   */
  readonly apply: (
    architecture: ArchitectureDefinition,
    operations: readonly FileOperation[],
    plans: readonly DocumentEmissionPlan[],
  ) => readonly FileOperation[];
}

/**
 * Astro's realizer: Stage 44's spelling and Stage 43's page-aware surface,
 * behind the boundary rather than in front of it.
 *
 * Identical behaviour to the direct calls it replaces - the same functions in
 * the same order - so generated Astro output is byte-identical and the V1
 * goldens are the proof.
 */
export const ASTRO_DOCUMENT_REALIZER: DocumentRealizer = {
  architecture: 'astro-standard',
  support: ASTRO_REALIZATION,
  apply: (architecture, operations, plans) =>
    composeAstroDocument(architecture, operations, plans.map(realizeAstroDocument)),
};

/**
 * Next's realizer: one field, declared rather than evaluated.
 *
 * Stage 49 left this architecture deliberately unregistered, because Stage 48
 * had measured that its canonical surface was real but unreachable - the SEO
 * feature required a capability Next does not have, so no Next project
 * contributed a document, so a realizer would have been code nothing ran.
 *
 * What changed is the capability, not the measurement. `composed-canonical`
 * names the narrow thing Next genuinely offers, which is why the same refusal
 * still stands for everything else: this realizer spells a canonical and
 * refuses the other six fields by name.
 */
export const NEXT_DOCUMENT_REALIZER: DocumentRealizer = {
  architecture: 'next-app',
  support: NEXT_REALIZATION,
  apply: applyNextDocument,
};

/**
 * Every architecture that can write a document today.
 *
 * A list, not a lookup built from the architecture vocabulary: an architecture
 * absent from here has no realization, which is a fact about what has been
 * built rather than an oversight to be filled in with something plausible.
 * React and Angular are absent because neither has a document realization.
 */
const REALIZERS: readonly DocumentRealizer[] = [ASTRO_DOCUMENT_REALIZER, NEXT_DOCUMENT_REALIZER];

/** Whether this architecture can write a document at all. */
export function hasDocumentRealizer(architecture: ArchitectureId): boolean {
  return REALIZERS.some((realizer) => realizer.architecture === architecture);
}

/**
 * The realizer for one architecture, or a refusal naming it.
 *
 * Ordering of the list is not consulted - the match is on the architecture's
 * own id, so registering realizers in another order selects the same one.
 */
export function selectDocumentRealizer(architecture: ArchitectureId): DocumentRealizer {
  const realizer = REALIZERS.find((entry) => entry.architecture === architecture);
  if (realizer === undefined) {
    throw new CliError(`"${architecture}" has no document realization.`, {
      hint:
        'A resolved document cannot be written by an architecture that has no spelling for ' +
        'it. There is no fallback on purpose: another architecture’s realization either ' +
        'fails on a role it does not map, or produces source that happens to parse and says ' +
        'something nobody decided.',
    });
  }
  return realizer;
}
