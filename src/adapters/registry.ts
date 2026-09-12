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
 * Deliberately not a discovery mechanism. Adapters are imported by name and
 * ship in the package; there is no scanning, no dynamic import and no plugin
 * protocol, which keeps the set of things that can run inside ClientKit equal
 * to the set of things that were reviewed.
 */
export interface AdapterRegistry {
  framework(id: FrameworkId): FrameworkAdapter;
  styling(id: StylingId): Adapter;
}

function unsupported(kind: string, id: string, available: readonly string[]): never {
  throw new CliError(`No ${kind} adapter for "${id}".`, {
    hint: `Implemented ${kind} adapters: ${available.join(', ')}.`,
  });
}

export function createAdapterRegistry(templateRoot: string): AdapterRegistry {
  const astro = createAstroAdapter(templateRoot);
  const tailwind = createTailwindAdapter();

  return {
    framework(id) {
      if (id === 'astro') return astro;
      return unsupported('framework', id, ['astro']);
    },
    styling(id) {
      if (id === 'tailwind') return tailwind;
      return unsupported('styling', id, ['tailwind']);
    },
  };
}
