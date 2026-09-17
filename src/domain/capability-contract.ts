import { CliError } from '../errors.js';
import type { Capability } from './capabilities.js';
import { CAPABILITIES } from './capabilities.js';
import type { ArchitectureDefinition, FileRole } from './roles.js';

/**
 * What a capability promises the *generated project*, and what an architecture
 * therefore has to be able to place.
 *
 * ## The gap this closes
 *
 * Compatibility reads declarations and nothing else. The architecture is chosen
 * afterwards, which leaves a hole:
 *
 *     capability declared
 *           ↓
 *     consumer becomes compatible
 *           ↓
 *     architecture cannot materialize the surface
 *           ↓
 *     failure, halfway through planning, naming a role and no reason
 *
 * Stage 25 walked that path with `client-app-root`: MUI asked for it, the
 * refusal was correct, and it arrived as `Architecture "next-app" does not
 * define a path for the file role "app.providers"` - a sentence that names
 * neither the capability, nor who wanted it, nor why. Stage 26 mapped the role
 * and the symptom went away; the hole did not.
 *
 * The invariant here is the general form: **a capability that promises a
 * generated surface may only be declared by a stack whose architecture can
 * place that surface.** Declaring it otherwise is not a compatibility error -
 * the consumer was right to ask - it is a *false declaration*, and this is
 * where it is caught.
 *
 * ## What this is not
 *
 * Not a framework x capability matrix. There is one row per capability and no
 * framework axis at all - nothing here knows that Next, React or Astro exist,
 * and adding a fourth framework adds no row. A framework is held to the
 * contract by *what it declares*, never by its name.
 *
 * Not a requirement that every capability map a file. Most do not.
 * `typescript` is a fact about how source is written and materializes nowhere
 * in particular; inventing `language.typescript` to satisfy a rule would make
 * the vocabulary less true, not more. The categories below exist precisely so
 * that "this capability needs no surface" is a stated answer rather than an
 * omission.
 *
 * Not a replacement for the planner's guards. This says the architecture *can*
 * place a surface; whether anything actually filled it is a question about the
 * finished plan, and `assertRequiredRoles` still answers it.
 */

/**
 * What kind of claim a capability makes.
 *
 * The category is not decoration: it decides whether `surfaces` is meaningful,
 * and a test holds the two to each other so that a surface cannot be bolted
 * onto a pure capability without someone also deciding it is no longer pure.
 */
export const CAPABILITY_CATEGORIES = [
  /**
   * A fact about the project that materializes nowhere in particular.
   *
   * `typescript`, `jsx`, `react-runtime`: true of the whole project, readable
   * from any file, owned by no role.
   */
  'pure',
  /**
   * A fact about the framework, its build pipeline or its runtime.
   *
   * `postcss`, `vite-plugins`, `static-output`, `server-inserted-head`: things
   * that exist in the tooling, that an adapter branches on or plugs into, and
   * that this generator does not have to build a surface for.
   */
  'tooling',
  /**
   * The generated project has a structural place for something to sit.
   *
   * `client-app-root` is the archetype: the claim is not "React is here", it is
   * "there is somewhere above the application where context can be mounted".
   * That somewhere is a role, and an architecture that maps no such role cannot
   * make the claim true however much React it contains.
   */
  'architectural',
  /**
   * A surface whose contents are assembled from contributions rather than
   * shipped whole by the framework's template.
   *
   * The distinction from `architectural` is ownership, not existence. Astro
   * *has* a global stylesheet; its template ships it, so a styling adapter's
   * stylesheet would be refused as a collision rather than composed. The role
   * is mapped and the capability is still false - which is why a composition
   * capability's contract checks template ownership as well as mapping.
   */
  'composition',
] as const;

export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

/**
 * How a capability's promise reaches the surface it names.
 *
 * `file` - some adapter writes a file there, so the architecture must map the
 * role *and* leave it unowned by its own template layers. A template-owned role
 * refuses contributions, which would make the capability a promise the project
 * cannot keep.
 *
 * `data` - contributions are folded into a file the framework already owns.
 * Astro's layout is shipped by its template and still composes contributed
 * metadata, because what is contributed is values rather than a file. Mapping
 * is required; template ownership is irrelevant.
 */
export type SurfaceKind = 'file' | 'data';

export interface CapabilitySurface {
  readonly role: FileRole;
  readonly via: SurfaceKind;
}

/**
 * `because` is mandatory for the same reason `Constraint.because` is: it is the
 * sentence a user is shown when the contract rejects something, so a contract
 * cannot be written without someone having said what the capability promises.
 * For a capability with no surfaces it records the decision *not* to require
 * one, which is the claim most likely to be wrong and least likely to be
 * noticed.
 */
export interface CapabilityContract {
  readonly category: CapabilityCategory;
  readonly because: string;
  /** Empty for `pure` and `tooling`; a test enforces that correspondence. */
  readonly surfaces?: readonly CapabilitySurface[];
}

/**
 * Every capability, classified.
 *
 * A total `Record`, so a capability added to `CAPABILITIES` without a contract
 * fails to compile. That is the whole reason for the shape: the failure mode
 * this stage exists to prevent is a capability nobody thought about, and a
 * lookup table with a fallback is exactly how one gets in.
 */
export const CAPABILITY_CONTRACTS: Readonly<Record<Capability, CapabilityContract>> = {
  // --- runtimes and authoring ------------------------------------------------
  'react-runtime': {
    category: 'pure',
    because: 'React is on the page; every file may import it, and no single file represents it',
  },
  'angular-runtime': {
    category: 'pure',
    because: 'Angular is on the page; no one generated file represents its presence',
  },
  jsx: {
    category: 'pure',
    because: 'components are written in JSX, which is a property of the source rather than a place',
  },
  typescript: {
    category: 'pure',
    because: 'source is typed, which every file carries and no file owns',
  },
  'spa-routing': {
    category: 'pure',
    because:
      'navigation happens without a full page load - a shape of application, not a file. The router that would own a route table is `client-side-routing`',
  },

  // --- framework and tooling facts ------------------------------------------
  ssr: {
    category: 'tooling',
    because: 'the framework renders on the server; that happens in its runtime, not in a file',
  },
  'static-output': {
    category: 'tooling',
    because: 'the build emits static files, which is a property of the build rather than a surface',
  },
  'file-based-routing': {
    category: 'tooling',
    because:
      'the framework turns its own files into routes. Deliberately no surface: which pages exist is the project\'s business, and requiring one would make "has file routing" mean "has this particular page"',
  },
  'document-metadata': {
    category: 'tooling',
    because:
      "the head reaches the client already filled in - a claim about *when*, answered by the framework's renderer. Where metadata is composed is `composed-metadata`",
  },
  'server-inserted-head': {
    category: 'tooling',
    because:
      'the framework can flush markup collected during a server render into the head; an adapter branches on it and nothing is generated for it',
  },
  postcss: {
    category: 'tooling',
    because: 'there is a PostCSS pipeline a build plugin can run in, which lives in the build',
  },
  sass: {
    category: 'tooling',
    because: 'the build compiles Sass, which is a pipeline fact',
  },
  'css-framework': {
    category: 'tooling',
    because:
      'a CSS framework is present. Declared so a second one can refuse to join it; the stylesheet it writes is `composed-stylesheet`',
  },
  'css-in-js': {
    category: 'tooling',
    because: 'styles are generated at runtime by a library, which no generated role represents',
  },
  'vite-plugins': {
    category: 'tooling',
    because: 'there is a Vite plugin array to add to, which lives in the build configuration',
  },

  // --- architectural --------------------------------------------------------
  'client-app-root': {
    category: 'architectural',
    because:
      'there is a place above the application where React context can be mounted, and a provider is a file that has to go somewhere',
    surfaces: [{ role: 'app.providers', via: 'file' }],
  },
  'client-side-routing': {
    category: 'architectural',
    because:
      'routes are declared and matched in the browser, which needs a route table the project owns rather than the framework',
    surfaces: [{ role: 'app.router', via: 'file' }],
  },

  // --- composition ----------------------------------------------------------
  'composed-stylesheet': {
    category: 'composition',
    because:
      'the global stylesheet is assembled from a contribution rather than shipped by the template, so the role must be mapped and left for a contributor to fill',
    surfaces: [{ role: 'styles.global', via: 'file' }],
  },
  'composed-metadata': {
    category: 'composition',
    because:
      'the document shell is assembled from contributed metadata. The shell may well ship with the template - what is contributed is values, not a file - so mapping it is the whole requirement',
    surfaces: [{ role: 'app.layout', via: 'data' }],
  },
};

/** Every capability in the given category, sorted. Used by tests and docs. */
export function capabilitiesInCategory(category: CapabilityCategory): readonly Capability[] {
  return CAPABILITIES.filter(
    (capability) => CAPABILITY_CONTRACTS[capability].category === category,
  );
}

/** The surfaces a capability promises. Empty for a capability that promises none. */
export function surfacesOf(capability: Capability): readonly CapabilitySurface[] {
  return CAPABILITY_CONTRACTS[capability].surfaces ?? [];
}

/**
 * One way an architecture fails to keep a declared capability's promise.
 *
 * Two reasons rather than one, because they are different mistakes with
 * different fixes: `unmapped` means the architecture has nowhere to put the
 * surface, `templateOwned` means it has somewhere and has already filled it
 * from its own template, so a contribution aimed there would be refused.
 */
export interface ContractBreach {
  readonly capability: Capability;
  readonly category: CapabilityCategory;
  readonly because: string;
  readonly role: FileRole;
  readonly reason: 'unmapped' | 'template-owned';
}

/**
 * Which declared capabilities the architecture cannot materialize.
 *
 * Pure, and deterministic by construction: it walks `CAPABILITIES` - a fixed
 * literal order - rather than the caller's set, so the same stack produces the
 * same breaches in the same order however the capabilities arrived.
 */
export function capabilityBreaches(
  capabilities: ReadonlySet<Capability>,
  architecture: ArchitectureDefinition,
  templateOwnedRoles: readonly FileRole[],
): readonly ContractBreach[] {
  const owned = new Set(templateOwnedRoles);
  const breaches: ContractBreach[] = [];

  for (const capability of CAPABILITIES) {
    if (!capabilities.has(capability)) continue;
    const contract = CAPABILITY_CONTRACTS[capability];

    for (const surface of contract.surfaces ?? []) {
      const base = {
        capability,
        category: contract.category,
        because: contract.because,
        role: surface.role,
      };
      if (architecture.roles[surface.role] === undefined) {
        breaches.push({ ...base, reason: 'unmapped' });
        continue;
      }
      // Only a `file` surface cares: a `data` surface is folded into a file the
      // template is entitled to own.
      if (surface.via === 'file' && owned.has(surface.role)) {
        breaches.push({ ...base, reason: 'template-owned' });
      }
    }
  }

  return breaches;
}

/**
 * Refuses a stack whose architecture cannot keep a capability it declares.
 *
 * `providers` is the compatibility engine's own index, so the message names the
 * adapter that made the claim rather than blaming the architecture for
 * something it never said. Thrown at resolution, before a single
 * `FileOperation` exists.
 */
export function assertCapabilityContracts(
  capabilities: ReadonlySet<Capability>,
  architecture: ArchitectureDefinition,
  templateOwnedRoles: readonly FileRole[],
  providers: ReadonlyMap<Capability, readonly string[]>,
): void {
  const breaches = capabilityBreaches(capabilities, architecture, templateOwnedRoles);
  if (breaches.length === 0) return;

  const lines = breaches.map((breach) => {
    const claimed = providers.get(breach.capability) ?? [];
    const who = claimed.length === 0 ? 'Something in this stack' : claimed.join(' and ');
    const problem =
      breach.reason === 'unmapped'
        ? `"${architecture.displayName}" maps no path for the "${breach.role}" surface`
        : `"${architecture.displayName}" maps "${breach.role}" but its own template owns that file, so nothing can be contributed there`;
    return `  - ${who} provides ${breach.capability} - ${breach.because} - but ${problem}.`;
  });

  // The capabilities themselves go in the message, not just the hint: the
  // message is what a caller catching a CliError logs, and "a capability" would
  // tell them nothing they could act on.
  const named = [...new Set(breaches.map((breach) => breach.capability))].join(', ');

  throw new CliError(
    `The "${architecture.id}" architecture cannot keep ${named}, which this stack declares.`,
    {
      hint: [
        ...lines,
        '',
        '  A capability is a promise about the generated project. An architecture that ' +
          'cannot place the surface cannot keep it, so the declaration is wrong rather ' +
          'than the selection.',
      ].join('\n'),
    },
  );
}

/**
 * Refuses a stack that needs a role its architecture cannot place.
 *
 * The other direction, and a separate function on purpose: this is not about
 * capabilities at all. A feature says "the finished project contains a
 * not-found page"; whether one was *written* is a question about the plan and
 * stays with `assertRequiredRoles`, but whether the architecture could place
 * one at all is knowable here, from the architecture alone.
 *
 * Stage 28 found this as the one genuine late failure in the system: `nextjs +
 * not-found` passed compatibility - Next really does route by file - and died
 * during planning with `Architecture "next-app" does not define a path for the
 * file role "page.notFound"`, naming no feature and offering no reason. The
 * refusal was right; only its timing and its wording were wrong.
 */
export function assertRolesArePlaceable(
  architecture: ArchitectureDefinition,
  required: ReadonlyMap<FileRole, readonly string[]>,
): void {
  const unplaceable = [...required.keys()]
    .filter((role) => architecture.roles[role] === undefined)
    .sort();
  if (unplaceable.length === 0) return;

  const lines = unplaceable.map((role) => {
    const askers = [...(required.get(role) ?? [])].sort();
    const who = askers.length === 0 ? 'This stack' : askers.join(' and ');
    return `  - ${who} needs "${role}", and "${architecture.displayName}" maps no path for it.`;
  });

  // Same reasoning as above: the roles belong in the message. Two of the three
  // tests guarding this boundary read `message` alone, and they are right to -
  // a refusal that needs its hint read to be understood is not explained.
  const named = unplaceable.map((role) => `"${role}"`).join(', ');

  throw new CliError(
    `"${architecture.displayName}" maps no path for ${named}, which this stack needs.`,
    {
      hint: [
        ...lines,
        '',
        `  Roles it does map: ${Object.keys(architecture.roles).sort().join(', ')}.`,
      ].join('\n'),
    },
  );
}
