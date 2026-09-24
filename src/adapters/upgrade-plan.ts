import type { ProjectManifest } from '../domain/manifest.js';
import type { UpgradePathPlan } from '../domain/upgrade-paths.js';
import { planUpgradePaths } from '../domain/upgrade-paths.js';
import type { RecordedStack } from '../domain/provenance-reader.js';
import type { TemplateMode } from '../types.js';
import { planManifest, type ManifestPlanOptions } from './bridge.js';
import type { AdapterRegistry } from './registry.js';
import {
  checkRecordedTemplate,
  describeTemplate,
  type IdentityCheck,
} from './template-identity.js';

/**
 * Turning a recorded project into two path sets.
 *
 * The layer between Stage 59's reader and the set arithmetic in
 * `domain/upgrade-paths.ts`. Its whole job is to build the two plans honestly:
 * one for the configuration the project recorded, one for the configuration
 * being asked for now, both against the templates this build ships.
 *
 * ## Why the old plan can be built at all
 *
 * Stage 60 found that an old *plan* cannot be reconstructed - the site
 * description and author are not recorded, and `plan()` refuses without them.
 * Stage 61 measured that this does not matter here, because the path set is a
 * function of the stack and the mode alone: across all 104 supported stacks,
 * changing every site field at once leaves the file list byte-identical.
 *
 * So both plans are built from the *same* site configuration - the current one
 * - and differ only in stack and mode. Nothing is invented, and no site value
 * is attributed to the recorded project. A site field cannot create a false
 * difference because it is identical on both sides by construction, which is a
 * stronger guarantee than the invariance measurement alone.
 *
 * ## Why the gate comes first
 *
 * Stage 59's reader validates fields and deliberately not relationships, so a
 * document can be perfectly readable and still claim a template that belongs
 * to another framework. Planning against that would produce a confident,
 * wrong answer. The identity check runs before anything is planned, and a
 * failure stops the work rather than degrading it.
 */

/** Why an upgrade could not be planned. Never a partial result. */
export type UpgradePlanRefusal = {
  readonly status: 'refused';
  readonly reason: Exclude<IdentityCheck['status'], 'ok'>;
  readonly because: string;
};

export type UpgradePlanResult =
  { readonly status: 'planned'; readonly paths: UpgradePathPlan } | UpgradePlanRefusal;

/** What the planner needs from a recorded provenance document. */
export interface RecordedConfiguration {
  readonly stack: RecordedStack;
  readonly mode: string;
  readonly template: { readonly id: string; readonly framework: string };
}

export interface UpgradePlanOptions {
  readonly adapters: AdapterRegistry;
  /** Everything `planManifest` needs that is not the manifest itself. */
  readonly plan: Omit<ManifestPlanOptions, 'mode' | 'templateId'>;
}

/** The generated paths of one plan, as the planner already normalises them. */
export function pathsOfPlan(operations: readonly { readonly path: string }[]): readonly string[] {
  // `toPosix` has already run inside the planner, so separators are settled
  // before this sees them and a Windows run cannot differ from a Linux one.
  return operations.map((operation) => operation.path);
}

/**
 * The manifest the recorded configuration corresponds to.
 *
 * The current manifest with the recorded stack and starter substituted in -
 * every other field, site configuration included, deliberately shared. See the
 * module comment for why that is correct rather than convenient.
 */
function recordedManifestFrom(
  current: ProjectManifest,
  recorded: RecordedConfiguration,
): ProjectManifest {
  return {
    ...current,
    framework: recorded.stack.framework,
    buildTool: recorded.stack.buildTool,
    language: recorded.stack.language,
    styling: recorded.stack.styling,
    uiLibrary: recorded.stack.uiLibrary,
    router: recorded.stack.router,
    architecture: recorded.stack.architecture,
    starter: recorded.mode as ProjectManifest['starter'],
  };
}

/**
 * Plans one manifest and returns the paths it would generate.
 *
 * The template is resolved through the adapter, which Stage 62 made total
 * across every implemented framework. Generic in the framework: there is no
 * branch here naming one, and adding a fourth would need no edit.
 */
function pathsFor(manifest: ProjectManifest, options: UpgradePlanOptions): readonly string[] {
  const { identity } = describeTemplate(manifest.framework, options.adapters);
  const { plan } = planManifest(manifest, {
    ...options.plan,
    /*
     * Taken from the manifest rather than passed in beside it.
     *
     * The two can only agree this way. `planManifest` accepts `mode`
     * separately, but it is `manifest.starter` that `selectStarter` uses to
     * choose the layer - the `mode` option reaches tokens and provenance
     * content instead. So a caller passing one value while the manifest held
     * another would produce a plan whose file list and whose recorded mode
     * disagreed, and this layer, which reads only paths, would never notice.
     * Deriving it makes that unrepresentable rather than merely unlikely.
     */
    mode: manifest.starter as TemplateMode,
    templateId: identity.id,
  });
  return pathsOfPlan(plan.operations);
}

/**
 * Plans the path-level difference between a recorded project and a requested one.
 *
 * Reads no files, writes none, and deletes none. It decides nothing about what
 * should happen next: the result describes paths, and the question of what a
 * developer agrees to is a later stage's, asked with the developer present.
 */
export function planUpgrade(
  recorded: RecordedConfiguration,
  current: ProjectManifest,
  options: UpgradePlanOptions,
): UpgradePlanResult {
  const check = checkRecordedTemplate(
    {
      framework: recorded.stack.framework,
      id: recorded.template.id,
      templateFramework: recorded.template.framework,
    },
    options.adapters,
  );

  if (check.status !== 'ok') {
    // No fallback, and no partial plan. A document ClientKit cannot make sense
    // of is reported as such rather than planned around - reporting an orphan
    // when the real problem is a contradictory template block would send a
    // developer looking for the wrong thing entirely.
    return { status: 'refused', reason: check.status, because: check.because };
  }

  const recordedManifest = recordedManifestFrom(current, recorded);

  return {
    status: 'planned',
    paths: planUpgradePaths(pathsFor(recordedManifest, options), pathsFor(current, options)),
  };
}
