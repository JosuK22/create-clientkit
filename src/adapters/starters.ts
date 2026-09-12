import type { FeatureId } from '../domain/dimensions.js';

/**
 * Which starter template layer a set of features selects.
 *
 * Shared because both framework adapters answer the same question, and the
 * answer is about the feature vocabulary rather than about any framework. Left
 * in one adapter it would have been copied into the next one, and the two would
 * have drifted the first time a starter was added.
 *
 * The default matches V1: no starter feature means coming-soon.
 */
export function starterLayerFor(features: readonly FeatureId[] | readonly string[]): string {
  return (features as readonly string[]).includes('starter:full') ? 'full' : 'coming-soon';
}
