import type { ProjectManifest } from '../domain/manifest.js';
import type { ValueSource } from '../types.js';

/**
 * The resolved stack, with the source that supplied each value.
 *
 * ## What this is for
 *
 * Answering "why is the build tool Vite?" without reading the resolver. Six
 * layers can now contribute a dimension - a flag, a config file, a preset, an
 * answer, the framework's own declaration, a built-in default - and a value
 * printed with no attribution is a value the user has to guess the origin of.
 *
 * ## What it is emphatically not
 *
 * A second resolution. Every field here is read from a finished manifest and a
 * finished source map; nothing is recomputed, no precedence is applied, and no
 * adapter is consulted. If this file could decide anything, it could decide it
 * differently from the resolver, and the explanation would eventually describe
 * a configuration nobody built. So it decides nothing - it is a projection, and
 * a test asserts it names no layer it would have to rank.
 *
 * Returning data rather than text is the other half of that: the ordering and
 * the attribution are testable without parsing a rendered line, and a future
 * `--explain` would render the same structure the debug output already does.
 */

export interface ExplainedDimension {
  /** The manifest key, for machine consumers. */
  readonly dimension: string;
  /** Human label, in the CLI's existing style. */
  readonly label: string;
  /** The resolved value, already stringified for display. */
  readonly value: string;
  /**
   * Who supplied it, or `undefined` when nothing recorded a source.
   *
   * Undefined should not happen for a dimension - the resolver marks all eight
   * - and is representable rather than thrown on, because a missing label is a
   * worse failure mode in a diagnostic than a blank one.
   */
  readonly source: ValueSource | undefined;
}

/** Attribution keyed by dimension, as the resolver records it. */
export interface StackAttribution {
  readonly [dimension: string]: ValueSource | undefined;
}

/**
 * The canonical order, stated once.
 *
 * Fixed rather than derived from `Object.keys`, because the order of a
 * diagnostic is part of its contract: a reader comparing two runs should be
 * able to diff them line by line. It follows the dependency order the prompts
 * use - framework first, then what it implies, then what it does not.
 */
const DIMENSIONS: readonly { key: keyof ProjectManifest; label: string }[] = [
  { key: 'framework', label: 'Framework' },
  { key: 'buildTool', label: 'Build tool' },
  { key: 'language', label: 'Language' },
  { key: 'styling', label: 'Styling' },
  { key: 'uiLibrary', label: 'Component library' },
  { key: 'router', label: 'Routing' },
  { key: 'architecture', label: 'Architecture' },
  { key: 'features', label: 'Features' },
];

/** What a feature list shows when it is empty. */
export const NO_FEATURES = 'none';

/**
 * Projects a resolved manifest and its source map into an ordered explanation.
 *
 * Pure, total and deterministic: the same two inputs produce the same array,
 * and every dimension appears exactly once whether or not anything recorded a
 * source for it.
 */
export function explainStack(
  manifest: ProjectManifest,
  sources: StackAttribution,
): readonly ExplainedDimension[] {
  return DIMENSIONS.map(({ key, label }) => {
    const raw = manifest[key];
    /*
     * The starter is filtered out of the feature list, not hidden.
     *
     * `starter:coming-soon` is in `manifest.features` because that is how the
     * pipeline carries `--mode`, and the summary already prints the mode on its
     * own line. Showing it twice under two names would describe one choice as
     * two - the same reasoning that keeps it out of the provenance file.
     */
    const value = Array.isArray(raw)
      ? raw.filter((entry) => !String(entry).startsWith('starter:')).join(', ') || NO_FEATURES
      : String(raw);

    return { dimension: key, label, value, source: sources[key] };
  });
}
