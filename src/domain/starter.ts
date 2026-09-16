import type { TemplateMode } from '../types.js';
import type { AdapterRef, TemplateLayerContribution } from './contributions.js';
import { FILE_ROLES, type FileRole } from './roles.js';
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
 * says which semantic roles each guarantees, and turns a selection into ordered
 * layer contributions. It cannot name a framework, a styling system, a
 * component library or a feature - a test walks the source to prove it -
 * because the moment it could, the combination directories would start growing
 * back one special case at a time.
 *
 * ## Identity, not implementation
 *
 * A starter id says what kind of *starting experience* was asked for. It is
 * never a stack. `portfolio` is a plausible future id; `react-tailwind-portfolio`
 * is the failure this contract exists to make unrepresentable, and it is
 * unrepresentable because nothing here can see a framework to name.
 *
 * Adding one later is a definition plus one line in `STARTER_IDS` - the same
 * central, reviewable edit every other dimension in `dimensions.ts` takes. No
 * adapter changes, no framework learns a new name, and the count of starters
 * stays independent of the count of stacks.
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
 * It also reads nothing. No filesystem, no registry of adapters, no process. It
 * is handed two directory roots and returns data.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The starters that exist, as identities.
 *
 * Separate from `FeatureId` since Stage 21, and the separation is the point. A
 * starter answers "what does this project start out being?"; a feature answers
 * "what else should it be able to do?". Carrying the first inside the second
 * meant seven places had to remember to filter `starter:*` back out, and two
 * independent functions had to agree on how `--mode` became one - which is the
 * shape a bug takes before it happens.
 *
 * These two are V1's modes. The vocabulary is now able to name more; this stage
 * deliberately names none.
 */
export const STARTER_IDS = ['coming-soon', 'full'] as const;
export type StarterId = (typeof STARTER_IDS)[number];

/**
 * One starter, as data.
 *
 * Every field earns its place:
 *
 * - `id` is what the manifest carries and what a framework maps to a directory.
 * - `displayName` and `description` are what a menu, `--help` or a diagnostic
 *   shows. Without them the only way to describe a starter to a user is a
 *   lookup table somewhere else, which is where the vocabulary splits in two.
 * - `guarantees` is what makes the starter checkable rather than merely named.
 *
 * There is deliberately no `layer`, no `root`, no `framework`, no `extends`.
 * The first two are the framework's business, the third would be the
 * combination explosion, and the fourth is starter inheritance - out of scope,
 * and a decision that should be made on its own evidence rather than smuggled
 * in as a field nothing uses yet.
 */
export interface StarterDefinition {
  readonly id: StarterId;
  readonly displayName: string;
  readonly description: string;
  /**
   * Semantic roles a project built from this starter must end up with.
   *
   * A guarantee rather than a promise to supply: whoever fills the role
   * satisfies it, checked against the finished plan by resolved path. Without
   * this a framework could ship a starter layer containing no home page and
   * nothing would notice until a user opened the project.
   *
   * Roles, never paths. `page.home` here; `src/pages/index.astro` is the
   * architecture's answer to it, and this file must not be able to guess that.
   */
  readonly guarantees: readonly FileRole[];
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * A validated, immutable set of starter definitions.
 *
 * Formalised in Stage 21 for one concrete reason: proving that a future starter
 * needs no framework-specific code requires *constructing* one, and a bare
 * module-level array cannot be constructed twice. Tests build a registry
 * containing a definition that does not ship, and every generic operation -
 * validation, lookup, metadata, layer planning - works on it unchanged.
 *
 * It is not a plugin system. There is no discovery, no filesystem, no
 * registration at runtime. The shipped registry is a constant.
 */
export interface StarterRegistry {
  /** Every definition, in declaration order. Frozen. */
  all(): readonly StarterDefinition[];
  /** Whether an id names a definition in this registry. */
  has(id: string): boolean;
  /** The definition for an id, or a refusal naming what does exist. */
  get(id: string): StarterDefinition;
}

/**
 * Builds a registry, rejecting anything malformed at construction.
 *
 * Validation happens here rather than at each call site because a definition is
 * data and data is worth checking once. A starter with no guarantee is the
 * defect this stage is most exposed to: it would select, plan and generate
 * perfectly, and produce a project with nothing in it.
 */
export function createStarterRegistry(definitions: readonly StarterDefinition[]): StarterRegistry {
  if (definitions.length === 0) {
    throw new CliError('A starter registry needs at least one starter.');
  }

  const byId = new Map<string, StarterDefinition>();

  for (const definition of definitions) {
    if (definition.id.trim() === '') {
      throw new CliError('A starter definition has an empty id.');
    }
    if (byId.has(definition.id)) {
      throw new CliError(`Two starters share the id "${definition.id}".`, {
        hint: 'A starter id names one starting experience. Rename one of them.',
      });
    }
    if (definition.displayName.trim() === '' || definition.description.trim() === '') {
      throw new CliError(`Starter "${definition.id}" is missing a display name or description.`, {
        hint: 'Both are shown to users choosing a starter.',
      });
    }
    if (definition.guarantees.length === 0) {
      // The quiet failure: a starter that promises nothing generates nothing
      // and reports success.
      throw new CliError(`Starter "${definition.id}" guarantees nothing.`, {
        hint: 'A starter must say which semantic roles a project built from it ends up with.',
      });
    }
    const seen = new Set<string>();
    for (const role of definition.guarantees) {
      if (!(FILE_ROLES as readonly string[]).includes(role)) {
        throw new CliError(`Starter "${definition.id}" guarantees unknown role "${role}".`, {
          hint: 'Guarantees are semantic roles, not paths. See FILE_ROLES.',
        });
      }
      if (seen.has(role)) {
        throw new CliError(`Starter "${definition.id}" guarantees "${role}" twice.`);
      }
      seen.add(role);
    }

    byId.set(definition.id, definition);
  }

  // Copied and frozen: a registry a caller can push into is not a contract.
  const frozen = Object.freeze([...definitions]);

  return {
    all: () => frozen,
    has: (id) => byId.has(id),
    get(id) {
      const definition = byId.get(id);
      if (definition !== undefined) return definition;

      /*
       * A starter that does not exist is the caller asking for something this
       * build cannot produce. Answering with a different project is the one
       * response that helps nobody - and is exactly what the predecessor did,
       * silently, for both an unknown id and an ambiguous selection.
       */
      throw new CliError(`Unknown starter "${id}".`, {
        hint: `Available starters: ${[...byId.keys()].join(', ')}.`,
      });
    },
  };
}

/**
 * The starters this build ships.
 *
 * Both were already real - they are V1's two modes - and this stage names them
 * rather than adding any. `page.home` is the only guarantee either makes,
 * because it is the only role both currently shipped architectures map and
 * every starter genuinely produces.
 */
export const STARTERS: StarterRegistry = createStarterRegistry([
  {
    id: 'coming-soon',
    displayName: 'Coming Soon',
    description: 'a single launch page you can put live today',
    guarantees: ['page.home'],
  },
  {
    id: 'full',
    displayName: 'Full Starter',
    description: 'home page and sections, coming-soon route included',
    guarantees: ['page.home'],
  },
]);

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * The one place `--mode` becomes a starter identity.
 *
 * `--mode` is V1's public surface and stays exactly as it is. It is not the
 * internal vocabulary, and the difference matters the moment a starter exists
 * that no mode names: the mapping stays total in this direction and simply has
 * nothing to say in the other.
 *
 * Two functions used to make this mapping independently - one for the V1
 * bridge, one for the V2 resolver - which is two chances to disagree about what
 * `full` means. This is now the only one, and both call it.
 */
export function starterFromMode(mode: TemplateMode): StarterId {
  return mode;
}

/**
 * The starter a manifest selects.
 *
 * A single id in, a definition out. Ambiguity is not handled here because it is
 * no longer expressible: the manifest carries one starter, so "two starters
 * were selected" stopped being a runtime case and became a type error. What
 * remains is the unknown id, which refuses by name.
 */
export function selectStarter(
  id: StarterId,
  registry: StarterRegistry = STARTERS,
): StarterDefinition {
  return registry.get(id);
}

// ---------------------------------------------------------------------------
// Layer planning
// ---------------------------------------------------------------------------

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
      name: `modes/${starter.id}`,
      root: roots.starter,
      owner,
      order: 10,
      reason: `the "${starter.id}" starter selected by the manifest`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Legacy vocabulary
// ---------------------------------------------------------------------------

/**
 * The prefix V1's starter ids carried inside the feature list.
 *
 * Kept for exactly one purpose: `--features starter:full` must still be refused
 * with a message that says where starters are chosen, rather than the generic
 * "unknown feature" it would otherwise get. Nothing else reads it, and nothing
 * produces it.
 */
export const LEGACY_STARTER_PREFIX = 'starter:';
