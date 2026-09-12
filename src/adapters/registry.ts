import { CliError } from '../errors.js';
import type { Adapter, FrameworkAdapter } from '../domain/adapters.js';
import type { FrameworkId, StylingId } from '../domain/dimensions.js';
import { createAstroAdapter } from './astro.js';
import { createTailwindAdapter } from './tailwind.js';

/**
 * The adapter registry, holding exactly what exists.
 *
 * One framework and one styling system, because those are the two that are
 * implemented. The id unions in `domain/dimensions.ts` name more - `react`,
 * `mui`, `bootstrap` - and asking for any of them fails here rather than
 * resolving to a stub. A registry that answered for an adapter nobody wrote
 * would turn "not built yet" into a confusing runtime failure much further
 * downstream.
 *
 * That distinction is the registry's job and nobody else's: a **domain id** is
 * a name the vocabulary knows, an **implemented adapter** is code that exists.
 * `implemented*` exposes the second so callers can report the difference rather
 * than discover it by catching.
 *
 * Deliberately not a discovery mechanism. Adapters are imported by name and
 * ship in the package; there is no scanning, no dynamic import and no plugin
 * protocol, which keeps the set of things that can run inside ClientKit equal
 * to the set of things that were reviewed.
 */
export interface AdapterRegistry {
  /** Throws a CliError when the id has no implemented adapter. */
  framework(id: FrameworkId): FrameworkAdapter;
  styling(id: StylingId): Adapter;
  /** Whether an adapter exists, without throwing. */
  hasFramework(id: FrameworkId): boolean;
  hasStyling(id: StylingId): boolean;
  implementedFrameworks(): readonly FrameworkId[];
  implementedStyling(): readonly StylingId[];
}

function unsupported(kind: string, id: string, available: readonly string[]): never {
  throw new CliError(`ClientKit does not support ${kind} "${id}" yet.`, {
    hint:
      `Implemented ${kind}s: ${available.join(', ')}. ` +
      `"${id}" is a known identifier but no adapter implements it.`,
  });
}

export function createAdapterRegistry(templateRoot: string): AdapterRegistry {
  const frameworks = new Map<FrameworkId, FrameworkAdapter>([
    ['astro', createAstroAdapter(templateRoot)],
  ]);
  const styling = new Map<StylingId, Adapter>([['tailwind', createTailwindAdapter()]]);

  // Sorted so the list in an error message is stable.
  const frameworkIds = [...frameworks.keys()].sort();
  const stylingIds = [...styling.keys()].sort();

  return {
    framework(id) {
      return frameworks.get(id) ?? unsupported('framework', id, frameworkIds);
    },
    styling(id) {
      return styling.get(id) ?? unsupported('styling system', id, stylingIds);
    },
    hasFramework: (id) => frameworks.has(id),
    hasStyling: (id) => styling.has(id),
    implementedFrameworks: () => frameworkIds,
    implementedStyling: () => stylingIds,
  };
}
