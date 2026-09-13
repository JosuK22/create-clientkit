import type { FileRole } from './roles.js';

/**
 * What an adapter hands back, and the only way it can affect the output.
 *
 * Adapters never write files, never touch `package.json`, and never run
 * anything. They return data describing what they want, and the composition
 * planner decides what that means together with everyone else's data. That is
 * what makes a conflict between two adapters detectable rather than a matter of
 * whichever one ran last.
 *
 * V1's planner resolves a collision by letting the later layer win, which is
 * correct when the layers are `base` and `modes/<mode>` and the same person
 * wrote both. It stops being correct once contributions come from independently
 * authored adapters, so ownership is recorded here and the planner (a later
 * stage) is expected to treat a genuine collision as an error.
 */

/** Which adapter a contribution came from. Formatted `<kind>:<id>`, e.g. `styling:tailwind`. */
export type AdapterRef = string;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export const DEPENDENCY_KINDS = ['prod', 'dev', 'peer', 'optional'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/**
 * One package an adapter needs.
 *
 * `version` is an exact pin, matching V1's policy of pinning the template's
 * dependencies exactly - reproducible generation is worth more here than
 * automatic minor upgrades.
 *
 * `reason` is surfaced by `--dry-run --debug`. With seven adapters
 * contributing, "why is @emotion/react in my project?" is a question someone
 * will actually ask, and "because @mui/material needs it" should not require
 * reading the source to answer.
 */
export interface DependencyContribution {
  readonly name: string;
  readonly version: string;
  readonly kind: DependencyKind;
  readonly owner: AdapterRef;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Where a file goes.
 *
 * A role is the preferred form and keeps the adapter framework-agnostic. A
 * literal path is the escape hatch for something genuinely framework-specific,
 * which is legitimate for a framework adapter and a warning sign anywhere else.
 * Modelling it as a discriminated union rather than two optional fields means
 * the distinction is visible to a lint, so the escape hatch can be measured
 * instead of quietly becoming the norm.
 */
export type FileTarget =
  | { readonly kind: 'role'; readonly role: FileRole }
  | { readonly kind: 'path'; readonly path: string };

/**
 * How a file contribution combines with others aimed at the same place.
 *
 * `create` claims the file. Two `create`s from different owners is a collision
 * the planner must report - that is the case V1 cannot currently express.
 * `merge` and `append` are explicitly cooperative and expect a `create` to
 * exist; one with nothing to attach to is an error rather than a silent no-op,
 * because a contribution that quietly does nothing is the hardest kind of bug
 * to find in generated output.
 */
export const FILE_INTENTS = ['create', 'merge', 'append'] as const;
export type FileIntent = (typeof FILE_INTENTS)[number];

/** Inline text, a template file to read, or structured data to be serialised. */
export type FilePayload =
  | { readonly kind: 'text'; readonly content: string }
  | { readonly kind: 'template'; readonly source: string }
  | { readonly kind: 'json'; readonly value: unknown };

export interface FileContribution {
  readonly target: FileTarget;
  readonly intent: FileIntent;
  readonly payload: FilePayload;
  readonly owner: AdapterRef;
  /**
   * Orders cooperative contributions to the same file. Lower runs first.
   * Ties break on `owner` so the result does not depend on adapter iteration
   * order - determinism is a contract, not an accident.
   */
  readonly order: number;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Scripts and configuration
// ---------------------------------------------------------------------------

/**
 * A directory of template files an adapter wants composed, in order.
 *
 * Added in Stage 2, because the Astro migration surfaced a gap: V1 delivers
 * files by walking a template directory, and expressing that as a list of
 * `FileContribution`s would mean enumerating 22 files in code and giving up the
 * "templates are inert data" property that makes them reviewable.
 *
 * Both forms are expected to coexist. An adapter that ships a template
 * directory contributes layers; an adapter that generates content from the
 * resolved project contributes files. What they share is that neither writes
 * anything - a layer is a request to compose a directory, and the planner still
 * decides what that means alongside everyone else's contributions.
 *
 * `order` is what makes layering explicit rather than implied by array
 * position, which matters once more than one adapter contributes layers.
 */
export interface TemplateLayerContribution {
  /** Diagnostic label, surfaced as `origin` on the resulting operations. */
  readonly name: string;
  /** Absolute path to the directory to compose. */
  readonly root: string;
  readonly owner: AdapterRef;
  /** Lower composes first; later layers override earlier ones. */
  readonly order: number;
  readonly reason: string;
}

/** A `package.json` script. Two adapters claiming one name with different bodies is a conflict. */
export interface ScriptContribution {
  readonly name: string;
  readonly command: string;
  readonly owner: AdapterRef;
  /**
   * Position in the emitted `scripts` block. Lower comes first; ties break on
   * owner then name, so the result never depends on adapter iteration order.
   *
   * The same idiom as `FileContribution.order` and
   * `TemplateLayerContribution.order`, and it exists for the same reason: the
   * alternative is for the composition engine to hold a table of script names
   * and rank them, which would put framework knowledge inside the one component
   * that must not have any. An adapter knows that `dev` comes before
   * `typecheck` in its own ecosystem's convention; the engine only sorts.
   */
  readonly order: number;
  readonly reason: string;
}

/**
 * An entry in a configuration file owned by someone else.
 *
 * The mechanism that avoids parsing code: the framework or build adapter owns
 * a config *model* and serialises it, while other adapters contribute entries
 * to that model. A styling adapter registers a build plugin without ever
 * editing, or even seeing, `vite.config.ts`.
 */
export interface ConfigContribution {
  /** Which config model this belongs to, addressed by role. */
  readonly target: FileRole;
  /** Dotted path within the model, e.g. `plugins` or `compilerOptions.jsx`. */
  readonly at: string;
  readonly value: unknown;
  readonly owner: AdapterRef;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/**
 * Everything one adapter wants, returned in a single object.
 *
 * One object rather than five separate methods because an adapter computes
 * these together - the files it writes and the dependencies they import come
 * from the same decision - and splitting them invites recomputing it.
 */
export interface Contribution {
  readonly owner: AdapterRef;
  readonly dependencies: readonly DependencyContribution[];
  readonly files: readonly FileContribution[];
  readonly scripts: readonly ScriptContribution[];
  readonly config: readonly ConfigContribution[];
  /** Template directories to compose, in order. See TemplateLayerContribution. */
  readonly templateLayers: readonly TemplateLayerContribution[];
  /** Directories to create even if nothing writes into them. */
  readonly directories: readonly string[];
}

/** An empty contribution, for adapters that legitimately add nothing (`styling: none`). */
export function emptyContribution(owner: AdapterRef): Contribution {
  return {
    owner,
    dependencies: [],
    files: [],
    scripts: [],
    config: [],
    templateLayers: [],
    directories: [],
  };
}
