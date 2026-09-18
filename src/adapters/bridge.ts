import path from 'node:path';

import {
  appRootEntries,
  appRootEntry,
  composesAppRoot,
  composesProviderShell,
  emitProviderShell,
  emitAppRoot,
  importSpecifier,
} from '../domain/app-composition.js';
import { collectBuildPlugins, emitViteConfig } from '../domain/build-config.js';
import { collectRoutes, emitRouter } from '../domain/route-composition.js';
import { composePackage } from '../domain/package-composition.js';
import type { AccessibilityContract } from '../domain/accessibility.js';
import { collectClaims } from '../domain/claims.js';
import type { Claim } from '../domain/claims.js';
import { collectMetadata } from '../domain/seo.js';
import type { MetadataClaim } from '../domain/seo.js';
import type { OrganizationContract } from '../domain/structured-data.js';
import type { ComposedPackage } from '../domain/package-composition.js';
import { deepMergeJson, stringifyJson } from '../generate/compose.js';
import type { ConfigContribution, Contribution } from '../domain/contributions.js';
import { manifestFromProjectContext } from '../domain/manifest.js';
import type { ProjectManifest } from '../domain/manifest.js';
import type { ResolvedProject } from '../domain/resolved.js';
import { definesRole, resolveRole } from '../domain/roles.js';
import type { FileRole } from '../domain/roles.js';
import { CliError } from '../errors.js';
import type { FileOperation, GenerationPlan } from '../generate/files.js';
import { plan, realPlanFs, type PlanFs, type PlanLayer } from '../generate/plan.js';
import type { TemplateManifest } from '../templates/manifest.js';
import type { TemplateRegistry } from '../templates/registry.js';
import type { ProjectContext, TemplateMode } from '../types.js';
import { createAdapterRegistry } from './registry.js';
import type { DocumentContribution } from '../domain/document-contribution.js';
import { assertPlanRealizable, buildDocumentEmission } from '../domain/document-emission.js';
import { selectDocumentRealizer } from './document-realizers.js';
import type { DocumentTarget } from '../domain/document-scope.js';
import { SITE_TARGET, forPage, resolveDocumentForPage } from '../domain/document-scope.js';
import { resolveProject } from './selection.js';

/**
 * The bridge between V1 generation and the V2 adapter model.
 *
 *     ProjectManifest
 *           ↓  selection + compatibility + resolution   (Stage 3)
 *     ResolvedProject
 *           ↓  adapters contribute
 *     Contribution[]
 *           ↓  template layers      ↓  config contributions
 *         plan()                  composed files
 *           └───────────┬───────────┘
 *                       ↓
 *                FileOperation[]
 *
 * The direction still matters: V1 types flow into V2, never the other way.
 * Nothing in `src/context/`, `src/templates/` or `src/generate/` imports this
 * module, so the CLI runs the V1 path exactly as it always has and everything
 * here is reachable only from tests.
 *
 * ## What this bridge still does not do
 *
 * `package.json` is composed from template `_package.json` layers, as in V1 -
 * the dependency and script contributions are declared and asserted against the
 * templates but not yet used to build the file. That is the composition work a
 * later stage covers.
 *
 * The manifest carries no `cliVersion` or `generatedAt`, so planning still
 * needs those alongside it. `plan()` is a V1-shaped function and this shim
 * feeds it a `ProjectContext`; making planning fully manifest-driven is a
 * deliberate later step.
 */

export interface AdapterPlanOptions {
  readonly registry: TemplateRegistry;
  readonly fs?: PlanFs;
  readonly now?: Date;
}

export interface AdapterPlanResult {
  readonly plan: GenerationPlan;
  /**
   * The template manifest the plan was built against.
   *
   * Returned because the caller cannot always look it up: React's lives on its
   * adapter rather than on disk, so `registry.get('react-vite')` throws. The
   * command layer reads `minNode`, `postSteps` and `nextSteps` from it.
   */
  readonly templateManifest: TemplateManifest;
  /**
   * Every dependency and script in the generated manifest, with each adapter
   * that asked for it and the reason it gave. Present whenever the architecture
   * has a `package` role. This is where "why is this package in my project?"
   * is answered.
   */
  readonly composedPackage?: ComposedPackage;
  /**
   * What the selected adapters say the page head must express, with the owner
   * and reason behind each claim. Empty when no adapter describes metadata.
   */
  readonly metadata: readonly MetadataClaim[];
  /**
   * What the selected adapters say machines should be told about the site,
   * with the owner and reason behind each claim. Empty when no adapter
   * describes structured data.
   */
  readonly structuredData: readonly Claim<OrganizationContract>[];
  /**
   * What the selected adapters guarantee about the generated shell's
   * accessibility, with the owner and reason behind each claim. Empty when no
   * adapter makes such a guarantee.
   */
  readonly accessibility: readonly Claim<AccessibilityContract>[];
  readonly manifest: ProjectManifest;
  readonly project: ResolvedProject;
  readonly contributions: readonly Contribution[];
}

/** Resolves the adapters for a manifest and collects their contributions. */
export function resolveWithAdapters(
  manifest: ProjectManifest,
  templatesRoot: string,
): { project: ResolvedProject; contributions: readonly Contribution[] } {
  const registry = createAdapterRegistry(templatesRoot);
  const { project, selection } = resolveProject(manifest, registry);

  return {
    project,
    contributions: selection.adapters.map(({ adapter }) => adapter.contribute(project)),
  };
}

/** Every template layer the contributions ask for, in a deterministic order. */
export function layersFrom(contributions: readonly Contribution[]): readonly PlanLayer[] {
  return (
    contributions
      .flatMap((contribution) => contribution.templateLayers)
      .slice()
      // `order` first, then `owner` so the result never depends on which adapter
      // happened to be iterated first.
      .sort((a, b) => a.order - b.order || a.owner.localeCompare(b.owner))
      .map((layer) => ({ name: layer.name, root: layer.root }))
  );
}

/**
 * Files an adapter contributed directly, resolved through the architecture.
 *
 * The other half of composition, and the first use of `FileContribution` -
 * present since Stage 1 with nothing consuming it until a second styling system
 * needed to own the global stylesheet.
 *
 * Roles are resolved here, so an adapter names `styles.global` and never learns
 * that React puts it in `src/styles/index.css`. A contribution aimed at a role
 * the framework satisfies from its own template is skipped: Astro ships
 * `global.css`, so Tailwind's stylesheet is not composed there and Astro's
 * output is untouched. Two adapters claiming the same path is a collision and
 * is reported, never resolved by running order.
 */
export function contributedFiles(
  project: ResolvedProject,
  contributions: readonly Contribution[],
  readText: (file: string) => string,
): readonly FileOperation[] {
  const templateOwned = new Set(project.templateOwnedRoles);
  const claimed = new Map<string, string>();
  const operations: FileOperation[] = [];

  const files = contributions
    .flatMap((contribution) => contribution.files)
    .slice()
    .sort((a, b) => a.order - b.order || a.owner.localeCompare(b.owner));

  for (const file of files) {
    if (file.target.kind === 'role' && templateOwned.has(file.target.role)) continue;

    const target =
      file.target.kind === 'role'
        ? resolveRole(project.architecture, file.target.role)
        : file.target.path;

    // `merge` is cooperative and handled later, against the planned file it
    // attaches to. Only `create` claims a path outright.
    if (file.intent === 'merge') continue;

    const previous = claimed.get(target);
    if (previous !== undefined) {
      throw new CliError(`Two adapters both claim "${target}".`, {
        hint: `${previous} and ${file.owner} each contributed it. Exactly one should own the file.`,
      });
    }
    claimed.set(target, file.owner);

    const content =
      file.payload.kind === 'text'
        ? file.payload.content
        : file.payload.kind === 'template'
          ? readText(file.payload.source)
          : `${JSON.stringify(file.payload.value, null, 2)}\n`;

    operations.push({
      type: 'write',
      path: target,
      // LF on every platform, matching every other generated file.
      content: content.replace(/\r\n/g, '\n'),
      origin: file.owner,
    });
  }

  return operations;
}

/**
 * Files composed from configuration contributions rather than template layers.
 *
 * Driven entirely by file roles. An architecture that maps `config.build` gets
 * a build configuration composed from whatever the selected adapters
 * contributed; one that does not - Astro - gets nothing, with no branch on the
 * framework anywhere. That is what lets the Tailwind adapter register its
 * plugin for React without knowing React exists, and without disturbing Astro.
 */
export function composedFiles(
  project: ResolvedProject,
  contributions: readonly Contribution[],
): readonly FileOperation[] {
  const config: ConfigContribution[] = contributions.flatMap((contribution) => contribution.config);
  if (config.length === 0) return [];

  const targeted = config.filter((entry) => entry.target === 'config.build');
  if (targeted.length === 0) return [];

  if (!definesRole(project.architecture, 'config.build')) {
    // An architecture with no separate build-configuration file registers
    // plugins its own way. Astro is the case in hand: its build config is
    // `astro.config.mjs` under `config.framework`, and the Tailwind plugin is
    // already registered there by the template - the legacy coupling Stage 2
    // recorded. Composing a second file would duplicate it.
    //
    // This is a skip rather than an error on purpose. Tailwind's contribution
    // is framework-blind by design, so it will always be offered to
    // architectures that cannot use it, and treating that as a failure would
    // punish the adapter for being decoupled. The risk it carries - a future
    // architecture forgetting to map the role and silently losing its plugins -
    // is covered by generating and building a real project, which is where a
    // missing plugin surfaces immediately.
    return [];
  }

  const plugins = collectBuildPlugins(targeted);
  return [
    {
      type: 'write',
      path: project.architecture.roles['config.build'] ?? 'vite.config.ts',
      content: emitViteConfig(plugins),
      origin: `composed from ${plugins.map(({ owner }) => owner).join(' + ')}`,
    },
  ];
}

/**
 * The router's route table, composed from contributions.
 *
 * Driven by the `app.router` role, so an architecture that maps none gets
 * nothing composed and no branch on the framework appears here - the same
 * mechanism `config.build` and `app.root` already use.
 *
 * Emitted only when something actually contributed a route. A project with no
 * router selected contributes none, so no file appears, and the generated tree
 * is exactly what it was before a router existed.
 */
export function composedRouter(
  project: ResolvedProject,
  contributions: readonly Contribution[],
): readonly FileOperation[] {
  if (!definesRole(project.architecture, 'app.router')) return [];

  const config = contributions.flatMap((contribution) => contribution.config);
  const routes = collectRoutes(config, 'app.router', 'routes');
  if (routes.length === 0) return [];

  const routerPath = resolveRole(project.architecture, 'app.router');

  /*
   * Each route that renders a component names the role holding it, so the
   * contributing adapter never learns where the architecture puts such a file
   * - and the import specifier is derived here, from the mapping.
   */
  const imports = routes
    .filter((claim) => claim.entry.element.kind === 'component')
    .map((claim) => {
      const element = claim.entry.element as { importName: string; role: FileRole };

      if (!definesRole(project.architecture, element.role)) {
        throw new CliError(
          `${claim.owner} contributes a route, but "${project.architecture.id}" maps no "${element.role}" role for its component.`,
          { hint: 'The architecture decides where such a component lives; this one has nowhere.' },
        );
      }

      return {
        importName: element.importName,
        from: importSpecifier(routerPath, resolveRole(project.architecture, element.role)),
      };
    });

  return [
    {
      type: 'write',
      path: routerPath,
      content: emitRouter(
        'AppRouter',
        routes.map((claim) => ({ path: claim.entry.path, element: claim.entry.element })),
        imports,
      ),
      // Router alone reads exactly as it did when the file was a template, so
      // adding the mechanism moved no bytes for anyone who has not selected a
      // second contributor.
      origin: [...new Set(routes.map((claim) => claim.owner))].join(' + '),
    },
  ];
}

/**
 * The application root, composed from role mappings and contributions.
 *
 * Emitted for any architecture that maps both `app.root` and `page.home`, and
 * for none that does not - Astro maps neither, so nothing is composed for it
 * and no branch on the framework appears here.
 *
 * The provider slot is filled only when the architecture maps `app.providers`
 * *and* some adapter actually produced a file there. That is what lets the UI
 * library dimension be genuinely optional: React alone emits the plain root it
 * always had, byte for byte, and React with MUI emits the same root wrapped.
 */
export function composedAppRoot(
  project: ResolvedProject,
  contributions: readonly Contribution[],
  operations: readonly FileOperation[],
): readonly FileOperation[] {
  if (!composesAppRoot(project.architecture)) return [];

  const rootPath = resolveRole(project.architecture, 'app.root');
  const rootExportName = project.architecture.rootExportName;
  if (rootExportName === undefined) {
    throw new CliError(
      `Architecture "${project.architecture.id}" maps app.root but does not say what it exports.`,
      { hint: 'Set rootExportName; the entry point imports that binding by name.' },
    );
  }

  const config = contributions.flatMap((contribution) => contribution.config);
  const page = appRootEntry(config, 'page');
  if (page === undefined) {
    throw new CliError('Nothing told the application root which page to render.', {
      hint: `The framework adapter is expected to contribute an "app.root" page entry.`,
    });
  }

  /*
   * Every wrapper that sits above the application, outermost first.
   *
   * Each names the role that holds its own file rather than a path, so a UI
   * library and a router can both wrap the tree without either learning where
   * the other's component lives - or where its own does.
   */
  const wrappers = appRootEntries(config, 'providers').map((claim) => {
    const role = claim.entry.role ?? 'app.providers';

    if (!definesRole(project.architecture, role)) {
      throw new CliError(
        `${claim.owner} wraps the application root, but "${project.architecture.id}" maps no "${role}" role for it.`,
        { hint: 'The architecture decides where such a component lives; this one has nowhere.' },
      );
    }

    const filePath = resolveRole(project.architecture, role);
    if (!operations.some((entry) => entry.path === filePath)) {
      // A wrapper nothing produced would emit an import of a file that does
      // not exist - a project that installs and then fails to build, which is
      // the failure mode this codebase treats most seriously.
      throw new CliError(
        `${claim.owner} wraps the application root but contributes no file for it.`,
        { hint: `Nothing produces "${filePath}".` },
      );
    }

    return {
      owner: claim.owner,
      importName: claim.entry.importName,
      from: importSpecifier(rootPath, filePath),
      ...(claim.entry.note === undefined ? {} : { note: claim.entry.note }),
    };
  });

  const owners = [page.owner, ...wrappers.map((wrapper) => wrapper.owner)];

  return [
    {
      type: 'write',
      path: rootPath,
      content: emitAppRoot(
        rootExportName,
        {
          importName: page.entry.importName,
          from: importSpecifier(rootPath, resolveRole(project.architecture, 'page.home')),
        },
        wrappers,
      ),
      origin: `composed from ${owners.join(' + ')}`,
    },
  ];
}

/**
 * Composes the provider shell, for an architecture whose entry it does not own.
 *
 * The sibling of `composedAppRoot`, and everything above the two emitters is
 * shared: the same wrapper claims, read from the same slot, sorted by the same
 * rule, resolved through the same role indirection. What differs is the one
 * thing that genuinely differs - a root renders the page, a shell renders the
 * children it is handed.
 *
 * An architecture mapping no `app.shell` composes nothing and takes no branch,
 * which is how React is left alone: it composes at `app.root` instead.
 */
export function composedProviderShell(
  project: ResolvedProject,
  contributions: readonly Contribution[],
  operations: readonly FileOperation[],
): readonly FileOperation[] {
  if (!composesProviderShell(project.architecture)) return [];

  const shellPath = resolveRole(project.architecture, 'app.shell');
  const config = contributions.flatMap((contribution) => contribution.config);

  const wrappers = appRootEntries(config, 'providers').map((claim) => {
    const role = claim.entry.role ?? 'app.providers';

    if (!definesRole(project.architecture, role)) {
      throw new CliError(
        `${claim.owner} wraps the application, but "${project.architecture.id}" maps no "${role}" role for it.`,
        { hint: 'The architecture decides where such a component lives; this one has nowhere.' },
      );
    }

    const filePath = resolveRole(project.architecture, role);
    if (!operations.some((entry) => entry.path === filePath)) {
      throw new CliError(`${claim.owner} wraps the application but contributes no file for it.`, {
        hint: `Nothing produces "${filePath}".`,
      });
    }

    return {
      owner: claim.owner,
      importName: claim.entry.importName,
      from: importSpecifier(shellPath, filePath),
    };
  });

  const exportName = project.architecture.shellExportName ?? 'AppProviders';

  /*
   * A wrapper cannot share the shell's own binding.
   *
   * The shell imports each wrapper by name and exports itself by name, into one
   * module scope. A collision emits a module that redeclares its own export -
   * which is not a subtle failure, but it is one a generator should refuse
   * rather than write. `appRootEntries` already refuses two wrappers sharing a
   * name; this is the same rule, extended to the one name it could not see.
   */
  const clash = wrappers.find((wrapper) => wrapper.importName === exportName);
  if (clash !== undefined) {
    throw new CliError(
      `${clash.owner} contributes a wrapper called "${exportName}", which is what the provider shell exports.`,
      {
        hint: `"${project.architecture.id}" names its shell "${exportName}"; two bindings cannot share it. One of them must be renamed.`,
      },
    );
  }

  const owners = wrappers.map((wrapper) => wrapper.owner);

  return [
    {
      type: 'write',
      path: shellPath,
      content: emitProviderShell(exportName, wrappers),
      origin: owners.length === 0 ? 'composed from nothing' : `composed from ${owners.join(' + ')}`,
    },
  ];
}

/**
 * Applies `merge` file contributions onto files the plan already produces.
 *
 * Bootstrap forced this. React's `_package.json` listed Tailwind's packages, so
 * every React project installed Tailwind whatever styling was selected - the
 * same coupling the stylesheet had, one file over. The framework template can
 * only own the dependencies the *framework* needs; the rest has to come from
 * whoever needs them.
 *
 * Deliberately narrow. It merges JSON payloads into an existing planned file
 * using the planner's own `deepMergeJson`, so `package.json` composes exactly
 * as template layers already do. It is not a general merge engine: a merge with
 * nothing to attach to is an error rather than a silent create, and a non-JSON
 * merge is refused outright.
 */
export function applyMerges(
  project: ResolvedProject,
  contributions: readonly Contribution[],
  operations: readonly FileOperation[],
): readonly FileOperation[] {
  const templateOwned = new Set(project.templateOwnedRoles);
  const merges = contributions
    .flatMap((contribution) => contribution.files)
    .filter((file) => file.intent === 'merge')
    .filter((file) => !(file.target.kind === 'role' && templateOwned.has(file.target.role)))
    .slice()
    .sort((a, b) => a.order - b.order || a.owner.localeCompare(b.owner));

  if (merges.length === 0) return operations;

  const byPath = new Map(operations.map((operation) => [operation.path, operation]));

  for (const file of merges) {
    const target =
      file.target.kind === 'role'
        ? resolveRole(project.architecture, file.target.role)
        : file.target.path;

    const existing = byPath.get(target);
    if (existing === undefined || existing.type !== 'write') {
      throw new CliError(`${file.owner} tried to merge into "${target}", which nothing creates.`, {
        hint: 'A merge contribution needs a file to attach to; nothing planned produces this one.',
      });
    }
    if (file.payload.kind !== 'json') {
      throw new CliError(`${file.owner} can only merge JSON into "${target}".`, {
        hint: `It contributed a "${file.payload.kind}" payload.`,
      });
    }

    const merged = deepMergeJson(JSON.parse(existing.content), file.payload.value);
    byPath.set(target, {
      type: 'write',
      path: target,
      content: stringifyJson(merged),
      origin: `${existing.origin} + ${file.owner}`,
    });
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Merges composed files into a planned set, refusing to overwrite silently.
 *
 * A template layer and a config contribution both claiming the same path is a
 * genuine ownership collision between different authors, and V1's last-layer-
 * wins rule is the wrong answer for it. Reported rather than resolved.
 */
export function mergeComposed(
  operations: readonly FileOperation[],
  composed: readonly FileOperation[],
): readonly FileOperation[] {
  const existing = new Map(operations.map((operation) => [operation.path, operation]));

  for (const file of composed) {
    const clash = existing.get(file.path);
    if (clash !== undefined) {
      throw new CliError(`Two owners both claim "${file.path}".`, {
        hint:
          `It is produced by ${clash.origin} and by ${file.origin}. ` +
          'Exactly one of them should own the file.',
      });
    }
    existing.set(file.path, file);
  }

  // Same ordering rule as plan(): sorted by path, so composed files land where
  // they would have had they come from a template.
  return [...existing.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A registry view that also answers for a framework whose template is not on
 * disk in a form the V1 registry discovers.
 *
 * `plan()` asks for a `TemplateManifest` and a template root. Astro's come from
 * the V1 disk registry unchanged; React's come from its adapter, because giving
 * its directory a `template.json` would list it in the V1 CLI.
 *
 * Exported since Stage 14: the resolver needs the same view, because a manifest
 * naming React resolves a template id the disk registry has never heard of, and
 * two functions building that view would be two chances to build it differently.
 */
export function registryFor(
  base: TemplateRegistry,
  templatesRoot: string,
  manifest: TemplateManifest | undefined,
): TemplateRegistry {
  if (manifest === undefined) return base;
  return {
    ...base,
    has: (id) => id === manifest.id || base.has(id),
    get: (id) => (id === manifest.id ? manifest : base.get(id)),
    rootFor: (id) =>
      id === manifest.id ? path.join(templatesRoot, manifest.id) : base.rootFor(id),
    supportsMode: (id, mode) =>
      id === manifest.id ? manifest.supportedModes.includes(mode) : base.supportsMode(id, mode),
    defaultsFor: (id) => (id === manifest.id ? manifest.defaults : base.defaultsFor(id)),
  };
}

/**
 * Generates through the V2 adapter path, for the V1 Astro configuration.
 *
 * The Stage 0 golden snapshots are asserted against this, so its output must
 * stay byte-identical to `plan()`'s own.
 */
export function planWithAdapters(
  context: ProjectContext,
  options: AdapterPlanOptions,
): AdapterPlanResult {
  return planManifest(manifestFromProjectContext(context), {
    ...options,
    cliVersion: context.cliVersion,
    generatedAt: context.generatedAt,
    mode: context.template.mode,
    templateId: context.template.id,
  });
}

export interface ManifestPlanOptions extends AdapterPlanOptions {
  readonly cliVersion: string;
  readonly generatedAt: string;
  /** V1 mode, still required by `plan()` for tokens and provenance. */
  readonly mode: TemplateMode;
  /** Overrides the template id; defaults to the framework adapter's own. */
  readonly templateId?: string;
}

/**
 * Generates from a V2 manifest, for any implemented framework.
 *
 * The entry point React uses. Astro reaches it through `planWithAdapters`, so
 * both frameworks travel the same path and the golden snapshots cover it.
 */
/**
 * Replaces the planned `package.json` with one composed from contributions.
 *
 * Driven by the `package` file role, so it applies to any architecture that has
 * a package manifest and to none that does not - no branch on the framework.
 *
 * The distinction this rests on is the one Stage 6 had to make explicit: the
 * *file* is owned by the framework's template, which supplies the project's
 * identity, while the *data* in three of its blocks is owned by whichever
 * adapters need those packages and scripts. Both statements are true at once,
 * and conflating them is what made the template a second source of truth for
 * five stages.
 *
 * Runs last, after merges, so the base it reads is the finished template
 * result. Anything a template still lists under `scripts`, `dependencies` or
 * `devDependencies` is dropped rather than merged - that is what "authoritative"
 * means - and a drift test asserts no template is relying on it.
 *
 * ## Why `origin` does not gain a "+ composed" suffix
 *
 * `applyMerges` appends the merging adapter to `origin` because a genuinely
 * different owner is injecting data into someone else's file, and a reader of
 * `--dry-run --debug` needs to know that. Composition is not that: the package
 * manifest has always been produced this way, and every stage until now simply
 * hid where the data came from. Adding a suffix would announce a new author
 * that does not exist, and would change the bytes of a diagnostic line in the
 * V1 golden files for a file whose content is identical.
 *
 * Provenance is not lost by that choice - it is improved. The returned
 * `ComposedPackage` carries every contributor of every dependency and script,
 * with the reason each gave, which is strictly more than a string could say.
 */
export function composePackageOperation(
  project: ResolvedProject,
  contributions: readonly Contribution[],
  operations: readonly FileOperation[],
): { readonly operations: readonly FileOperation[]; readonly composed?: ComposedPackage } {
  if (!definesRole(project.architecture, 'package')) return { operations };
  const target = resolveRole(project.architecture, 'package');

  const index = operations.findIndex((operation) => operation.path === target);
  const existing = index === -1 ? undefined : operations[index];
  if (existing === undefined || existing.type !== 'write') {
    throw new CliError(
      `Nothing produces "${target}", so there is no package manifest to compose.`,
      {
        hint: 'The framework template is expected to supply the project identity that the composed blocks are added to.',
      },
    );
  }

  const base: unknown = JSON.parse(existing.content);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    throw new CliError(`"${target}" is not a JSON object.`);
  }

  const composed = composePackage(base as Record<string, unknown>, contributions);
  const replacement: FileOperation = {
    type: 'write',
    path: target,
    content: stringifyJson(composed.json),
    origin: existing.origin,
  };

  return {
    operations: operations.map((operation, at) => (at === index ? replacement : operation)),
    composed,
  };
}

/**
 * Refuses a plan that is missing a file the architecture cannot do without.
 *
 * Composition can legitimately leave a mapped role empty - React maps
 * `config.build` and gets a `vite.config.ts` only because some adapter
 * contributed a plugin. `requiredRoles` marks the ones where empty is not a
 * valid outcome but a broken project: React's entry point imports the global
 * stylesheet unconditionally, so `styling: 'none'` would generate a tree that
 * installs cleanly and then fails on the first build with a missing import.
 *
 * Since Stage 8 the set is the architecture's plus every selected adapter's, so
 * a feature can make the same kind of statement. Selecting `not-found` means
 * the finished project has a not-found page; if nothing produces one the plan
 * fails here rather than shipping a site whose 404s are the framework's
 * default.
 *
 * Checked by resolved path rather than by contribution, so a template-owned
 * file counts. Astro satisfies `styles.global` from its own template and would
 * pass this check unchanged if it declared the requirement.
 *
 * Failing here rather than at `apply()` means nothing is written: the user gets
 * a sentence about what to pick, not a directory that cannot build.
 */
export function assertRequiredRoles(
  project: ResolvedProject,
  operations: readonly FileOperation[],
): void {
  const required = project.requiredRoles;
  if (required.length === 0) return;

  const present = new Set(operations.map((operation) => operation.path));
  const missing = required
    .filter((role) => !present.has(resolveRole(project.architecture, role)))
    .map((role) => `${role} (${resolveRole(project.architecture, role)})`);

  if (missing.length === 0) return;

  throw new CliError(
    `Nothing provides ${missing.join(', ')}, which the ${project.architecture.displayName} architecture needs.`,
    {
      hint:
        project.manifest.styling === 'none'
          ? 'This architecture composes its global stylesheet, so it needs a styling system. Choose one instead of "none".'
          : `Selected styling: ${project.manifest.styling}.`,
    },
  );
}

export function planManifest(
  manifest: ProjectManifest,
  options: ManifestPlanOptions,
): AdapterPlanResult {
  const templatesRoot = path.dirname(options.registry.rootFor('astro-tailwind'));
  const adapters = createAdapterRegistry(templatesRoot);
  const framework = adapters.framework(manifest.framework);
  const templateManifest = framework.templateManifest;

  const templateId = options.templateId ?? templateManifest?.id ?? manifest.framework;
  const registry = registryFor(options.registry, templatesRoot, templateManifest);

  const { project, contributions } = resolveWithAdapters(manifest, templatesRoot);

  // plan() is V1-shaped and reads tokens and provenance from a ProjectContext.
  const context: ProjectContext = {
    targetDir: manifest.targetDir,
    projectName: manifest.projectName,
    site: manifest.site,
    template: {
      id: templateId,
      version: registry.get(templateId).version,
      mode: options.mode,
    },
    /*
     * What was selected, so the provenance file records it.
     *
     * Hard-coded `[]` until Stage 14, which was harmless while nothing could
     * ask for a feature and became a lie the moment `--features` was public: a
     * project generated with three features shipped a `.client-site.json`
     * saying it had none.
     *
     * The starter is not merged in. It is already recorded as `mode` two lines
     * above, and naming one decision twice under two keys would make the
     * provenance file describe it as two. Until Stage 21 that took a filter
     * here, because the starter travelled inside this very list; it now has a
     * field of its own and simply is not in it.
     *
     * De-duplicated and sorted, exactly as `selectAdapters` does. Not cosmetic:
     * without it, asking for one feature twice, or in the other order, produced
     * a different generated file - and two tests that had held since Stage 8
     * caught precisely that.
     */
    features: [...new Set(manifest.features)].sort(),
    packageManager: manifest.packageManager,
    git: manifest.git,
    install: manifest.install,
    cliVersion: options.cliVersion,
    generatedAt: options.generatedAt,
  };

  const generated = plan(context, {
    registry,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    layers: layersFrom(contributions),
  });

  const readText = (options.fs ?? realPlanFs).readText;
  const withContributions = mergeComposed(generated.operations, [
    ...contributedFiles(project, contributions, readText),
    ...composedFiles(project, contributions),
    ...composedRouter(project, contributions),
  ]);

  const merged = applyMerges(
    project,
    contributions,
    mergeComposed(
      mergeComposed(withContributions, composedAppRoot(project, contributions, withContributions)),
      composedProviderShell(project, contributions, withContributions),
    ),
  );

  /*
   * The document, from what the adapters said to what Astro writes.
   *
   * The whole pipeline in five lines, and every step already existed: the
   * contributions are resolved and composed by scope for one target at a time
   * (Stages 32-33), projected into an emission plan (Stage 38), checked against
   * what this architecture can supply (Stage 38 again), realized into Astro
   * expressions (Stage 44) and handed to the surface that knows where each
   * target renders (Stage 43).
   *
   * With no document contributions the list is empty and the call is the
   * identity it has been since Stage 40 - which is why the V1 goldens running
   * through it prove the default path changes nothing.
   */
  const documents = contributions.flatMap((entry) => entry.documents ?? []);
  const operations = realizeDocuments(project.architecture, merged, documents);

  const packageResult = composePackageOperation(project, contributions, operations);
  // Refuses two adapters describing the head differently, before anything is
  // written. Runs even when nothing consumes the claims, because a conflict
  // nobody notices is the failure this exists to prevent.
  const config = contributions.flatMap((entry) => entry.config);
  const metadata = collectMetadata(config);
  const structuredData = collectClaims<OrganizationContract>(
    config,
    'app.layout',
    'structured-data',
  );
  const accessibility = collectClaims<AccessibilityContract>(config, 'app.layout', 'accessibility');
  assertRequiredRoles(project, packageResult.operations);

  return {
    plan: { ...generated, operations: packageResult.operations },
    templateManifest: registry.get(templateId),
    ...(packageResult.composed === undefined ? {} : { composedPackage: packageResult.composed }),
    metadata,
    structuredData,
    accessibility,
    manifest,
    project,
    contributions,
  };
}

/**
 * Which targets a set of document contributions actually speaks about.
 *
 * The site, plus every page some contribution scopes itself to - and nothing
 * else. Not a list of the project's pages: a page nobody says anything specific
 * about needs no target, because it resolves to the site's document and renders
 * the shell's fallback. That is what keeps a page the developer adds later
 * working without ClientKit ever having heard of it.
 *
 * Sorted by role so the compositions are ordered by what was said rather than
 * by the order adapters happened to run. Deterministic ordering, not
 * precedence: scope composition settled that already.
 */
export function documentTargets(
  documents: readonly DocumentContribution[],
): readonly DocumentTarget[] {
  if (documents.length === 0) return [];

  const roles = [
    ...new Set(
      documents.flatMap((contribution) =>
        contribution.scope.kind === 'page' ? [contribution.scope.role] : [],
      ),
    ),
  ].sort();

  return [SITE_TARGET, ...roles.map((role) => forPage(role))];
}

/**
 * Resolves every target's document and hands the plans to its architecture.
 *
 * The one place the pipeline meets an architecture, and it meets it by name:
 * the realizer is selected from the resolved project rather than assumed, and
 * each plan is checked against *that* realizer's support before anything is
 * written.
 *
 * With nothing contributed it returns the operations it was given, unchanged
 * and without selecting anything - which is why a project on an architecture
 * that has no realization at all still generates, as every React and Next
 * project does today.
 */
function realizeDocuments(
  architecture: ResolvedProject['architecture'],
  operations: readonly FileOperation[],
  documents: readonly DocumentContribution[],
): readonly FileOperation[] {
  if (documents.length === 0) return operations;

  const realizer = selectDocumentRealizer(architecture.id);
  const plans = documentTargets(documents).map((target) => {
    const plan = buildDocumentEmission(resolveDocumentForPage(documents, target));
    assertPlanRealizable(plan, realizer.support);
    return plan;
  });

  return realizer.apply(architecture, operations, plans);
}
