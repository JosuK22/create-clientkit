import type { AdapterRegistry } from '../adapters/registry.js';
import { checkCompatibility } from '../adapters/selection.js';
import type { DimensionOptions } from '../domain/adapters.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { TemplateMode } from '../types.js';
import { manifestFrom, resolveDimensions, type DimensionInput } from './dimensions.js';
import type { ChoiceOption, Prompter } from './prompts.js';

/**
 * Asking for the dimensions the user did not state.
 *
 * ## What this is, and what it must never become
 *
 * An input adapter. It produces exactly what `--framework react` produces - a
 * string in a `DimensionInput` - and hands it to the same normaliser. There is
 * no interactive manifest, no interactive default and no interactive
 * validation; a second path to a `ProjectManifest` would be a second place for
 * the two to disagree, and nothing would notice until a user reported that the
 * flags and the questions built different projects.
 *
 *     flags ──┐
 *             ├──→ DimensionInput ──→ resolveDimensions ──→ manifestFrom
 *  answers ──┘
 *
 * ## Which questions are worth asking
 *
 * Two rules, and neither mentions a framework.
 *
 * A dimension is skipped when the framework **fixes** it, or offers exactly one
 * option. Astro is its own build tool and React's only bundler today is Vite;
 * in both cases "Which build tool? > Vite" is a question pretending to be a
 * choice, so the answer is derived instead. The same rule silently covers
 * architecture, which no framework currently offers twice.
 *
 * A choice is dropped when the combination it would produce cannot be built.
 * That judgement is **not made here** - it is `checkCompatibility`, the engine
 * that already answers it for flags, asked about a candidate manifest. So
 * Bootstrap does not appear under Astro because Astro provides no
 * `composed-stylesheet`, and that reason lives in the adapters where it always
 * has. A second set of rules in the UI would be the one thing guaranteed to
 * drift.
 *
 * ## Where it stops filtering
 *
 * When filtering would leave nothing to choose from, everything is offered
 * instead and the engine is allowed to speak. An empty list is a dead end whose
 * explanation this layer would have to invent; the engine's refusal names the
 * missing capability and the adapter that wanted it. Being unhelpful in a way
 * the user can act on beats being helpful in a way that is wrong.
 */

/** Labels for answers that are real but have no adapter to name them. */
const LITERAL_LABELS: Readonly<Record<string, { label: string; hint?: string }>> = {
  none: { label: 'None' },
  'file-based': { label: 'File-based', hint: 'routes come from the framework' },
};

/**
 * The two dimensions with no adapter of their own.
 *
 * A language is a compiler setting and an architecture is a folder layout;
 * neither has a declaration to read a name from. Architectures do carry a
 * `displayName` on the framework, which is preferred where one exists.
 */
const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  js: 'JavaScript',
};

/** Identity has no bearing on compatibility, so a candidate needs none real. */
const CANDIDATE_IDENTITY = {
  targetDir: '',
  projectName: 'candidate',
  site: { name: 'candidate', url: null, description: '', locale: 'en', author: null },
  packageManager: 'npm',
  git: false,
  install: false,
} as const;

export interface InteractiveOptions {
  /** What the flags already settled. Never re-asked. */
  readonly input: DimensionInput;
  readonly adapters: AdapterRegistry;
  readonly prompter: Prompter;
  /** Needed only to build candidate manifests; `--mode` is not a dimension. */
  readonly mode: TemplateMode;
}

export interface InteractiveResult {
  /** The flag input, plus an entry for every question that was answered. */
  readonly input: DimensionInput;
  /** Which dimensions were actually asked about, in order. Read by tests. */
  readonly asked: readonly string[];
}

/**
 * Every implemented adapter's own name for itself, in one lookup.
 *
 * Read from the declarations rather than written here. A label table in the UI
 * would be a second place an adapter is named, and the first thing to go stale
 * when one is renamed - so `Material UI` appears in the menu because the MUI
 * adapter says that is what it is called.
 */
function displayNames(adapters: AdapterRegistry): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const id of adapters.implementedFrameworks()) {
    names.set(id, adapters.framework(id).declaration.displayName);
  }
  for (const id of adapters.implementedBuildTools()) {
    names.set(id, adapters.buildTool(id).declaration.displayName);
  }
  for (const id of adapters.implementedStyling()) {
    names.set(id, adapters.styling(id).declaration.displayName);
  }
  for (const id of adapters.implementedUiLibraries()) {
    names.set(id, adapters.uiLibrary(id).declaration.displayName);
  }
  for (const id of adapters.implementedRouters()) {
    names.set(id, adapters.router(id).declaration.displayName);
  }
  for (const id of adapters.implementedFeatures()) {
    names.set(id, adapters.feature(id).declaration.displayName);
  }
  return names;
}

/**
 * What a framework says is available for a dimension it owns.
 *
 * A fixed value is a list of one, which is the point: whether to ask is decided
 * in exactly one place - `ask` skips any menu with fewer than two survivors -
 * rather than here and there. An earlier version also returned `null` for
 * `fixed`, which read as intent but was unreachable, since a fixed value cannot
 * produce two options. A mutation testing run found it: inverting the branch
 * changed nothing, because the length check downstream had already covered it.
 */
function candidates<T extends string>(options: DimensionOptions<T>): readonly T[] {
  return options.kind === 'fixed' ? [options.value] : options.options;
}

export async function promptDimensions(options: InteractiveOptions): Promise<InteractiveResult> {
  const { adapters, prompter, mode } = options;
  const answers: Record<string, string | readonly string[] | undefined> = { ...options.input };
  const asked: string[] = [];
  const names = displayNames(adapters);

  /** The dimensions as currently decided; re-read, since an answer changes them. */
  const decided = () => resolveDimensions(answers as DimensionInput, adapters);

  const label = (id: string): ChoiceOption => {
    const literal = LITERAL_LABELS[id];
    if (literal !== undefined) {
      return {
        value: id,
        label: literal.label,
        ...(literal.hint === undefined ? {} : { hint: literal.hint }),
      };
    }
    const architecture = adapters
      .framework(decided().framework)
      .architectureDefinitions.find((definition) => definition.id === id);
    return {
      value: id,
      label: names.get(id) ?? LANGUAGE_LABELS[id] ?? architecture?.displayName ?? id,
    };
  };

  /** A complete manifest for whatever has been decided so far. */
  const candidate = (over: DimensionInput): ProjectManifest =>
    manifestFrom(
      CANDIDATE_IDENTITY,
      resolveDimensions({ ...(answers as DimensionInput), ...over }, adapters),
      mode,
    );

  /**
   * The engine's answer, never this layer's.
   *
   * A throw counts as "cannot be built" for the same reason `false` does: the
   * registry refusing an id and the engine refusing a combination are both the
   * authority saying no.
   */
  const buildable = (over: DimensionInput): boolean => {
    try {
      return checkCompatibility(candidate(over), adapters).compatible;
    } catch {
      return false;
    }
  };

  /** Asks one dimension, unless a flag settled it or there is nothing to ask. */
  const ask = async (
    dimension:
      'framework' | 'buildTool' | 'language' | 'styling' | 'uiLibrary' | 'router' | 'architecture',
    message: string,
    ids: readonly string[],
  ): Promise<void> => {
    if (answers[dimension] !== undefined) return;
    if (!prompter.interactive) return;

    const viable = ids.filter((id) => buildable({ [dimension]: id }));
    // Nothing viable means the flags already given have no completion. Offer
    // everything and let the engine explain, rather than inventing a message.
    const offered = viable.length > 0 ? viable : ids;

    // One survivor is a derivation, not a decision: `resolveDimensions` reaches
    // the same value from the framework's own declaration and the defaults.
    if (offered.length < 2) return;

    const current = decided()[dimension];
    answers[dimension] = await prompter.selectDimension({
      dimension,
      message,
      options: offered.map(label),
      // The default has to be on the list, or "press Enter" would silently pick
      // the first entry instead of the documented default.
      initialValue: offered.includes(current) ? current : (offered[0] as string),
    });
    asked.push(dimension);
  };

  await ask('framework', 'Framework', adapters.implementedFrameworks());

  const framework = () => adapters.framework(decided().framework);

  await ask('buildTool', 'Build tool', candidates(framework().buildTools));
  await ask('language', 'Language', candidates(framework().languages));

  await ask('styling', 'Styling', [...adapters.implementedStyling(), 'none']);
  await ask('uiLibrary', 'Component library', [...adapters.implementedUiLibraries(), 'none']);

  await ask('router', 'Routing', candidates(framework().routers));
  await ask('architecture', 'Architecture', candidates(framework().architectures));

  // ---- features -----------------------------------------------------------
  /*
   * Multi-select, each candidate checked on its own against the stack chosen
   * above. Two features that are individually fine but conflict with each other
   * would still both be offered: checking every subset is exponential, and the
   * finished manifest goes through the engine regardless, so such a pair is
   * refused there rather than never appearing. Recorded as a limitation instead
   * of solved with a rule this layer would then own.
   */
  const featuresGiven = options.input.features !== undefined && options.input.features.length > 0;
  if (!featuresGiven && prompter.interactive) {
    const offerable = adapters.implementedFeatures().filter((id) => buildable({ features: [id] }));

    if (offerable.length > 0) {
      const chosen = await prompter.selectMany({
        dimension: 'features',
        message: 'Features',
        options: offerable.map(label),
        initialValues: [],
      });
      /*
       * Handed back as one comma-joined string - exactly the shape
       * `--features a,b` arrives in - so the same parser splits, trims,
       * rejects and sorts it. Nothing about a feature list is decided twice.
       */
      if (chosen.length > 0) answers['features'] = [chosen.join(',')];
      asked.push('features');
    }
  }

  return { input: answers as DimensionInput, asked };
}
