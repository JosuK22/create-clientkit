import type { AdapterResolution } from './adapters.js';
import type { Capability } from './capabilities.js';
import type { FileRole } from './roles.js';
import { CliError } from '../errors.js';
import type { SourceExtensions } from './resolved.js';

/**
 * Combining what each adapter resolved into one set of facts.
 *
 * The interesting part is not the merging, it is the refusal to merge silently.
 * If two adapters disagree about the component extension, taking whichever ran
 * last would produce a project that builds but is subtly wrong, and the bug
 * would surface as a mysterious missing file rather than as a disagreement. So
 * a conflict is an error that names both adapters and both values.
 *
 * Pure: resolutions in, facts out.
 */

export interface ResolutionInput {
  /** `<kind>:<id>`, used to name the adapter in a conflict. */
  readonly owner: string;
  readonly resolution: AdapterResolution;
}

export interface MergedResolution {
  readonly capabilities: ReadonlySet<Capability>;
  /** Union of every selected adapter's required roles. Order-independent. */
  readonly requiredRoles: ReadonlySet<FileRole>;
  /**
   * Who asked for each required role.
   *
   * The union above is what the plan is checked against; this is what a refusal
   * is *explained* with. Stage 28 needed it because "the architecture cannot
   * place page.notFound" is only half a sentence - the useful half names the
   * feature that asked and lets a reader drop it.
   *
   * Owners are sorted, so a diagnostic does not depend on adapter order.
   */
  readonly requiredRoleOwners: ReadonlyMap<FileRole, readonly string[]>;
  readonly extensions: Partial<SourceExtensions>;
  readonly minNode: string | undefined;
}

/**
 * Compares Node floors like `>=22.12.0` numerically.
 *
 * String comparison happens to order the two values in play today correctly,
 * which is exactly the kind of luck that stops being lucky: `>=9.0.0` would
 * sort above `>=22.12.0`. Parsing the numbers costs a few lines and removes the
 * trap.
 */
export function compareNodeFloor(a: string, b: string): number {
  const parse = (value: string): number[] =>
    (value.match(/\d+/g) ?? []).map((part) => Number.parseInt(part, 10));

  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The highest floor any adapter asks for. */
export function highestNodeFloor(floors: readonly string[]): string | undefined {
  return floors.length === 0
    ? undefined
    : floors.reduce((highest, floor) => (compareNodeFloor(floor, highest) > 0 ? floor : highest));
}

const EXTENSION_KEYS = ['source', 'component', 'config'] as const;

/** The accumulator only: `SourceExtensions` is readonly, and merging fills it in. */
type MutableExtensions = { -readonly [K in keyof SourceExtensions]?: SourceExtensions[K] };

export function mergeResolutions(inputs: readonly ResolutionInput[]): MergedResolution {
  const capabilities = new Set<Capability>();
  const requiredRoles = new Set<FileRole>();
  const requiredRoleOwners = new Map<FileRole, string[]>();
  const extensions: MutableExtensions = {};
  /** Which adapter set each extension key, so a conflict can name it. */
  const extensionOwners = new Map<string, string>();
  const floors: string[] = [];

  for (const { owner, resolution } of inputs) {
    for (const capability of resolution.capabilities ?? []) capabilities.add(capability);
    for (const role of resolution.requiredRoles ?? []) {
      requiredRoles.add(role);
      const owners = requiredRoleOwners.get(role);
      // An adapter listing the same role twice asked once.
      if (owners === undefined) requiredRoleOwners.set(role, [owner]);
      else if (!owners.includes(owner)) owners.push(owner);
    }
    if (resolution.minNode !== undefined) floors.push(resolution.minNode);

    for (const key of EXTENSION_KEYS) {
      const value = resolution.extensions?.[key];
      if (value === undefined) continue;

      const existing = extensions[key];
      if (existing !== undefined && existing !== value) {
        const previousOwner = extensionOwners.get(key) ?? '(unknown)';
        throw new CliError(`Adapters disagree about the ${key} file extension.`, {
          hint:
            `${previousOwner} resolved "${existing}" and ${owner} resolved "${value}". ` +
            'Exactly one adapter should own each extension.',
        });
      }
      extensions[key] = value;
      extensionOwners.set(key, owner);
    }
  }

  for (const owners of requiredRoleOwners.values()) owners.sort();

  return {
    capabilities,
    requiredRoles,
    requiredRoleOwners,
    extensions,
    minNode: highestNodeFloor(floors),
  };
}
