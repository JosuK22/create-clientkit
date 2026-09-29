import { CliError, EXIT_USAGE } from '../errors.js';
import type { DimensionInput } from './dimensions.js';

/**
 * Named starting points, as data.
 *
 * ## What a preset is, and the two things it is not
 *
 * It is a **partial `DimensionInput`** with a name. Nothing more. Selecting one
 * is the same as having typed the flags it lists, which is why it needs no
 * resolution of its own: it joins the existing precedence chain one rung below
 * the config file and lets `resolveDimensions` do what it already does.
 *
 *     --preset react-mui   ==   --framework react --styling tailwind --ui-library mui
 *
 * It is **not a template**. A template owns files; a preset owns none, cannot
 * name one, and has no path, no content and no adapter reference anywhere in
 * its shape - a test walks every definition to prove it. `astro-tailwind`
 * happens to be the name of both, and they remain separate things: one selects
 * a stack, the other is the implementation the framework adapter reaches for.
 *
 * It is **not a compatibility statement**. Nothing here knows that MUI needs
 * React. A preset that named an impossible combination would be refused by the
 * compatibility engine exactly as the equivalent flags are, which is the point:
 * if the adapters change under it, a preset becomes invalid on its own, loudly,
 * rather than quietly continuing to promise something that no longer works.
 *
 * ## Why they are deliberately thin
 *
 * A preset lists only the dimensions that are a genuine choice. `react-tailwind`
 * does not say `buildTool: vite` or `language: ts`, because React's adapter
 * already declares both and restating them here would be a second copy that
 * goes stale the day React gains a second bundler. The remaining dimensions
 * resolve through the ordinary defaults, so a preset composes with the prompts
 * and the flags rather than short-circuiting them.
 */

export interface Preset {
  /** Stable, lowercase, kebab-case. Part of the public surface. */
  readonly id: string;
  readonly displayName: string;
  /** One line, shown in `--help` and in the interactive menu. */
  readonly description: string;
  /**
   * The dimensions this preset states, as the raw strings a flag would carry.
   *
   * Partial on purpose. Anything absent is answered by the framework's own
   * declarations, an interactive question, or the shared defaults - the same
   * three places that answer it when no preset is involved at all.
   */
  readonly dimensions: DimensionInput;
  /**
   * Offered in the interactive "Start from" menu.
   *
   * The menu is kept to a few opinionated starting points; every other stack
   * is one "Custom" away. A preset that is not offered there is still a preset
   * in every other respect - `--preset` and a config file accept it, and help
   * lists it - so taking one off the menu never takes it out of the CLI.
   */
  readonly startFrom: boolean;
}

/**
 * The presets that ship. The "Start from" presets come first, in the order the
 * menu shows them.
 *
 * Only combinations the repository actually builds and tests. The domain
 * vocabulary is wider - it knows `angular` - and a preset naming one would be
 * an advertisement for something that does not exist.
 */
const DEFINITIONS: readonly Preset[] = [
  {
    id: 'astro-tailwind',
    displayName: 'Astro + Tailwind',
    description: 'content-first, ships almost no JavaScript',
    dimensions: { framework: 'astro', styling: 'tailwind' },
    startFrom: true,
  },
  {
    id: 'react-tailwind',
    displayName: 'React + Tailwind',
    description: 'a React application with utility-first styling',
    dimensions: { framework: 'react', styling: 'tailwind' },
    startFrom: true,
  },
  {
    id: 'nextjs-tailwind',
    displayName: 'Next.js + Tailwind',
    description: 'a Next.js App Router site with utility-first styling',
    dimensions: { framework: 'nextjs', styling: 'tailwind' },
    startFrom: true,
  },
  {
    id: 'react-bootstrap',
    displayName: 'React + Bootstrap',
    description: 'a React application with Bootstrap components and grid',
    dimensions: { framework: 'react', styling: 'bootstrap' },
    startFrom: false,
  },
  {
    id: 'react-mui',
    displayName: 'React + Material UI',
    description: 'a React application with the MUI component library',
    dimensions: { framework: 'react', styling: 'tailwind', uiLibrary: 'mui' },
    startFrom: false,
  },
];

export interface PresetRegistry {
  /** Every preset, in a fixed order. The only list; help and prompts read it. */
  all(): readonly Preset[];
  /** The presets the "Start from" menu offers, in menu order. A view of `all`, never a copy. */
  startFrom(): readonly Preset[];
  has(id: string): boolean;
  /** Throws a CliError naming what is available. */
  get(id: string): Preset;
}

/**
 * Checks a definition against the rules a preset has to keep.
 *
 * Run at construction rather than in a test, so a malformed preset cannot ship
 * even through a path no test happens to cover. The registry is built once at
 * startup, which makes this effectively free.
 */
function validate(preset: Preset, seen: Set<string>): void {
  const problem = (why: string): never => {
    throw new CliError(`The "${preset.id}" preset is invalid: ${why}`, {
      hint: 'This is a bug in ClientKit rather than in your configuration.',
    });
  };

  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(preset.id))
    problem('the id is not lowercase kebab-case');
  if (seen.has(preset.id)) problem('the id is used twice');
  if (preset.displayName.trim() === '') problem('the display name is empty');
  if (preset.description.trim() === '') problem('the description is empty');
  if (Object.keys(preset.dimensions).length === 0) problem('it states no dimensions');

  const features = preset.dimensions.features;
  if (features !== undefined && new Set(features).size !== features.length) {
    problem('it lists a feature twice');
  }

  seen.add(preset.id);
}

/**
 * The one list.
 *
 * Help output and the interactive menu both read it, so an advertised preset
 * and an existing preset cannot become two different sets - the failure a
 * hand-written list in the UI would eventually produce.
 */
export function createPresetRegistry(definitions: readonly Preset[] = DEFINITIONS): PresetRegistry {
  const seen = new Set<string>();
  for (const preset of definitions) validate(preset, seen);

  const byId = new Map(definitions.map((preset) => [preset.id, preset]));
  const offered = definitions.filter((preset) => preset.startFrom);

  return {
    all: () => definitions,
    startFrom: () => offered,
    has: (id) => byId.has(id),
    get: (id) => {
      const preset = byId.get(id);
      if (preset !== undefined) return preset;
      const width = Math.max(...definitions.map((entry) => entry.id.length));
      throw new CliError(`Unknown preset "${id}".`, {
        exitCode: EXIT_USAGE,
        hint:
          'Available presets:\n' +
          definitions
            .map((entry) => `  ${entry.id.padEnd(width)}  ${entry.description}`)
            .join('\n'),
      });
    },
  };
}

/** The shipped registry. A module-level constant because the data is static. */
export const PRESETS: PresetRegistry = createPresetRegistry();

/**
 * The dimensions a preset contributes, or none.
 *
 * Deliberately the whole of the resolution logic. There is no branch on a
 * preset id anywhere - the registry returns data and the caller merges it,
 * which is what lets a new preset be one entry in a list rather than an edit
 * in three files.
 */
export function presetDimensions(id: string | undefined, registry: PresetRegistry): DimensionInput {
  return id === undefined ? {} : registry.get(id).dimensions;
}
