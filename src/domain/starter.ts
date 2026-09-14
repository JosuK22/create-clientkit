import type { AdapterRef, TemplateLayerContribution } from './contributions.js';
import { FEATURE_IDS, type FeatureId } from './dimensions.js';
import type { FileRole } from './roles.js';
import { CliError } from '../errors.js';

/**
 * What a generated project starts out containing, as a contract.
 *
 * ## The problem this exists to prevent
 *
 * A starter is the one concept in the system that touches every other
 * dimension: the initial pages have to be written in *some* framework, styled
 * by *some* system, and may sit under *some* router. The obvious
 * implementation is a directory per combination, and the arithmetic is
 * unforgiving - two frameworks, three styling choices, two component-library
 * options and a router is already two dozen directories, none of which exists
 * yet and all of which would have to be kept in step.
 *
 * The way out is to separate four questions that a combination directory
 * answers all at once:
 *
 *     Starter       what the project starts out containing
 *     Framework     how that is represented
 *     Architecture  where the representation lives
 *     Composition   how everything else attaches to it
 *
 * This file owns the first and nothing else. It names the starters that exist,
 * says which semantic roles each guarantees, and turns a manifest's selection
 * into ordered layer contributions. It cannot name a framework, a styling
 * system, a component library or a feature - a test walks the source to prove
 * it - because the moment it could, the combination directories would start
 * growing back one special case at a time.
 *
 * ## What it deliberately does not do
 *
 * It writes no content. The framework adapter still points at a directory of
 * its own files, because a starter page is genuinely framework-specific markup
 * and pretending otherwise would mean generating `.astro` from a string
 * literal. The contract is about *which* layers exist, in *what* order, owned
 * by *whom*, and what the result must contain - not about the bytes inside
 * them.
 *
 * It also reads nothing. No filesystem, no registry, no adapter. It is handed
 * two paths and returns data.
 */

/**
 * One starter, as data.
 *
 * `id` is a feature id because that is how the pipeline has carried the
 * selection since Stage 1 - `--mode full` becomes `starter:full` in the
 * manifest. Reusing it keeps one vocabulary rather than inventing a parallel
 * one for the same choice.
 */
export interface StarterDefinition {
  readonly id: FeatureId;
  /**
   * The layer directory a framework exposes for this starter.
   *
   * Deliberately not a path. Each framework decides where its layers live; this
   * is the name they agree on, and `planStarterLayers` never joins it to
   * anything.
   */
  readonly layer: string;
  readonly displayName: string;
  readonly description: string;
  /**
   * Semantic roles a project built from this starter must end up with.
   *
   * A guarantee rather than a promise to supply: whoever fills the role
   * satisfies it, checked against the finished plan by resolved path. Without
   * this a framework could ship a starter layer containing no home page and
   * nothing would notice until a user opened the project.
   */
  readonly guarantees: readonly FileRole[];
}

/**
 * The starters that exist.
 *
 * Both were already real - they are V1's two modes - and this stage names them
 * rather than adding any. `page.home` is the only guarantee either makes,
 * because it is the only role both currently shipped architectures map and
 * every starter genuinely produces.
 */
const DEFINITIONS: readonly StarterDefinition[] = [
  {
    id: 'starter:coming-soon',
    layer: 'coming-soon',
    displayName: 'Coming Soon',
    description: 'a single launch page you can put live today',
    guarantees: ['page.home'],
  },
  {
    id: 'starter:full',
    layer: 'full',
    displayName: 'Full Starter',
    description: 'home page and sections, coming-soon route included',
    guarantees: ['page.home'],
  },
];

/** The prefix that marks a feature id as a starter selection. */
export const STARTER_PREFIX = 'starter:';

/** Every starter, in a fixed order. The only list. */
export function starters(): readonly StarterDefinition[] {
  return DEFINITIONS;
}

/** Whether a feature id names a starter rather than a capability. */
export function isStarterId(id: string): boolean {
  return id.startsWith(STARTER_PREFIX);
}

/**
 * The starter a manifest selects.
 *
 * ## Why this refuses rather than guesses
 *
 * The function it replaces was `includes('starter:full') ? 'full' :
 * 'coming-soon'` - a boolean wearing a string's clothes. It answered
 * `coming-soon` for a manifest naming two starters, and `coming-soon` for one
 * naming `starter:nonsense`, which are two different mistakes and neither is a
 * coming-soon project. Both now fail by name.
 *
 * The default is unchanged and load-bearing: no starter feature means
 * coming-soon, which is what V1 does and what every golden asserts.
 */
export function selectStarter(features: readonly string[]): StarterDefinition {
  const named = features.filter(isStarterId);

  if (named.length > 1) {
    throw new CliError(`A project has one starter, but ${named.length} were selected.`, {
      hint: `Selected: ${[...named].sort().join(', ')}.`,
    });
  }

  const id = named[0];
  if (id === undefined) {
    // V1's default, and the reason a bare invocation produces what it always
    // produced. Asserted by the golden snapshots rather than assumed.
    return DEFINITIONS[0] as StarterDefinition;
  }

  const starter = DEFINITIONS.find((definition) => definition.id === id);
  if (starter !== undefined) return starter;

  /*
   * A known feature id with no starter behind it, or an unknown one. Both are
   * the caller asking for something that does not exist, and answering with a
   * different project is the one response that helps nobody.
   */
  const known = FEATURE_IDS.filter(isStarterId);
  throw new CliError(`Unknown starter "${id}".`, {
    hint:
      `Available starters: ${DEFINITIONS.map((entry) => entry.id).join(', ')}.` +
      (known.length === DEFINITIONS.length ? '' : ' Some are named but not implemented.'),
  });
}

/** Where a framework keeps the two directories a starter is made of. */
export interface StarterRoots {
  /** The layer every starter of this framework shares. */
  readonly base: string;
  /** The layer for the selected starter specifically. */
  readonly starter: string;
}

export interface StarterLayerOptions {
  readonly starter: StarterDefinition;
  readonly owner: AdapterRef;
  readonly roots: StarterRoots;
  /**
   * How the framework describes its own shared layer.
   *
   * Supplied rather than generated because it is the one genuinely
   * framework-specific sentence here - "the Astro project every mode shares"
   * says something this file has no way to know. The *starter* layer's reason
   * is generated, because it says the same thing for every framework.
   */
  readonly baseReason: string;
}

/**
 * The layers a starter selection produces, in composition order.
 *
 * Two, always: a shared base and the selected starter on top of it. Order is
 * explicit because later layers override earlier ones, and "it worked because
 * the array happened to be in that order" is not a property to rely on when the
 * result is which file a user opens.
 *
 * The caller supplies both roots. Joining a layer name to a directory needs to
 * know how that framework arranges itself, and this file knows nothing about
 * any framework - which is also why no `path` import appears in it.
 */
export function planStarterLayers(
  options: StarterLayerOptions,
): readonly TemplateLayerContribution[] {
  const { starter, owner, roots, baseReason } = options;

  return [
    {
      name: 'base',
      root: roots.base,
      owner,
      order: 0,
      reason: baseReason,
    },
    {
      name: `modes/${starter.layer}`,
      root: roots.starter,
      owner,
      order: 10,
      reason: `the "${starter.layer}" starter selected by the manifest`,
    },
  ];
}
