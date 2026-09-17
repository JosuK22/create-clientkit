import type { DocumentDerivation } from '../domain/document-value.js';
import { DOCUMENT_DERIVATION_IDS } from '../domain/document-value.js';

/**
 * Which semantic derivations Astro can realise.
 *
 * Separate from `astro-bindings.ts` on purpose. A binding maps to a single
 * expression Astro already writes; a derivation is an *operation*, and how
 * Astro performs it is emitter work this stage does not do. Keeping the two in
 * one file would invite the derivation's spelling to be added alongside the
 * binding's, which is the emitter arriving by the back door.
 *
 * So this declares support and nothing else. It is the counterpart of
 * `BindingSupport`: a list an architecture publishes, so a value reaching
 * beyond it is refused by name rather than approximated.
 *
 * Astro can realise all three today - it already computes each of them in
 * `Seo.astro`, which is where the three derivations came from. Declared as data
 * rather than assumed, so the moment a derivation is added that Astro cannot
 * express, this list stops matching the vocabulary and a test says so.
 */
export interface DerivationSupport {
  /** Identifies the architecture in a diagnostic. Never branched on. */
  readonly architecture: string;
  readonly supports: readonly DocumentDerivation[];
}

export const ASTRO_DERIVATION_SUPPORT: DerivationSupport = {
  architecture: 'astro-standard',
  supports: [...DOCUMENT_DERIVATION_IDS],
};
