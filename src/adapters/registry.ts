import path from 'node:path';

import { CliError } from '../errors.js';
import type { Adapter, FrameworkAdapter } from '../domain/adapters.js';
import type {
  BuildToolId,
  FeatureId,
  FrameworkId,
  StylingId,
  UiLibraryId,
} from '../domain/dimensions.js';
import { createAstroAdapter } from './astro.js';
import { createBootstrapAdapter } from './bootstrap.js';
import { createReactAdapter } from './react.js';
import { createTailwindAdapter } from './tailwind.js';
import { createMuiAdapter } from './mui.js';
import { createNotFoundAdapter } from './not-found.js';
import { createViteAdapter } from './vite.js';

/**
 * The adapter registry, holding exactly what exists.
 *
 * Two frameworks, one build tool, two styling systems, one UI library -
 * because those are what is implemented. The id unions in
 * `domain/dimensions.ts` name more (`nextjs`, `angular`, `chakra`, `scss`), and
 * asking for any of them fails here rather than resolving to a stub or, far
 * worse, quietly falling back to something that happens to work.
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
  buildTool(id: BuildToolId): Adapter;
  styling(id: StylingId): Adapter;
  uiLibrary(id: UiLibraryId): Adapter;
  feature(id: FeatureId): Adapter;
  /** Whether an adapter exists, without throwing. */
  hasFramework(id: FrameworkId): boolean;
  hasBuildTool(id: BuildToolId): boolean;
  hasStyling(id: StylingId): boolean;
  hasUiLibrary(id: UiLibraryId): boolean;
  hasFeature(id: FeatureId): boolean;
  implementedFrameworks(): readonly FrameworkId[];
  implementedBuildTools(): readonly BuildToolId[];
  implementedStyling(): readonly StylingId[];
  implementedUiLibraries(): readonly UiLibraryId[];
  implementedFeatures(): readonly FeatureId[];
}

function unsupported(kind: string, id: string, available: readonly string[]): never {
  throw new CliError(`ClientKit does not support ${kind} "${id}" yet.`, {
    hint:
      `Implemented ${kind}s: ${available.join(', ')}. ` +
      `"${id}" is a known identifier but no adapter implements it.`,
  });
}

/**
 * @param templatesRoot the shipped `templates/` directory, which now holds more
 * than one framework's material. Each framework adapter is handed its own
 * subdirectory, so no adapter goes looking for anything.
 */
export function createAdapterRegistry(templatesRoot: string): AdapterRegistry {
  const frameworks = new Map<FrameworkId, FrameworkAdapter>([
    ['astro', createAstroAdapter(path.join(templatesRoot, 'astro-tailwind'))],
    ['react', createReactAdapter(path.join(templatesRoot, 'react-vite'))],
  ]);
  const buildTools = new Map<BuildToolId, Adapter>([['vite', createViteAdapter()]]);
  const styling = new Map<StylingId, Adapter>([
    ['tailwind', createTailwindAdapter(templatesRoot)],
    ['bootstrap', createBootstrapAdapter(templatesRoot)],
  ]);
  const uiLibraries = new Map<UiLibraryId, Adapter>([['mui', createMuiAdapter(templatesRoot)]]);
  // `starter:*` is not here on purpose. It selects a template layer rather than
  // an adapter - the arrangement V1's `mode` became - and asking the registry
  // for it would report a missing adapter for something that was never one.
  const features = new Map<FeatureId, Adapter>([['not-found', createNotFoundAdapter()]]);

  // Sorted so the list in an error message is stable.
  const frameworkIds = [...frameworks.keys()].sort();
  const buildToolIds = [...buildTools.keys()].sort();
  const stylingIds = [...styling.keys()].sort();
  const uiLibraryIds = [...uiLibraries.keys()].sort();
  const featureIds = [...features.keys()].sort();

  return {
    framework(id) {
      return frameworks.get(id) ?? unsupported('framework', id, frameworkIds);
    },
    buildTool(id) {
      return buildTools.get(id) ?? unsupported('build tool', id, buildToolIds);
    },
    styling(id) {
      return styling.get(id) ?? unsupported('styling system', id, stylingIds);
    },
    uiLibrary(id) {
      return uiLibraries.get(id) ?? unsupported('UI library', id, uiLibraryIds);
    },
    feature(id) {
      return features.get(id) ?? unsupported('feature', id, featureIds);
    },
    hasFramework: (id) => frameworks.has(id),
    hasBuildTool: (id) => buildTools.has(id),
    hasStyling: (id) => styling.has(id),
    hasUiLibrary: (id) => uiLibraries.has(id),
    hasFeature: (id) => features.has(id),
    implementedFrameworks: () => frameworkIds,
    implementedBuildTools: () => buildToolIds,
    implementedStyling: () => stylingIds,
    implementedUiLibraries: () => uiLibraryIds,
    implementedFeatures: () => featureIds,
  };
}
