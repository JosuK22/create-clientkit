# ClientKit V2 — Multi-Framework Architecture

**Status:** design proposal, no implementation.
**Written against:** `create-clientkit@1.0.2` (the brief said 1.0.1; 1.0.2 shipped
on 2026-09-12 and is a documentation-only patch, so nothing here is affected).

Every heading below is marked **DECIDED**, **PROPOSED** or **OPEN QUESTION**.
Nothing is presented as settled unless the reasoning for it is written down and
a reviewer could disagree with it on the merits.

---

## 1. Goals

1. Let a developer choose framework, build tool, language, styling system, UI
   library, router, architecture and features — and get a project that is
   idiomatic for that stack rather than a lowest-common-denominator one.
2. Support the combinations without a template per combination.
3. Keep generation deterministic: the same resolved configuration produces the
   same files, byte for byte.
4. Let a new framework be added without editing any existing adapter.
5. Keep the V1 guarantees that are load-bearing — atomic generation, a pure
   planner, no fabricated values, no shell execution from template data.

## 2. Non-goals

- **Not** a website builder, still. The developer owns the output.
- **Not** an "add ClientKit to an existing project" tool. Everything below
  assumes greenfield generation into an empty directory. This assumption is
  what lets us avoid parsing user code (§12).
- **Not** a plugin marketplace. Adapters ship in the package and are reviewed
  like any other code.
- **Not** a runtime. Nothing ClientKit generates depends on ClientKit.

---

## 3. Current V1 architecture (audited, not assumed)

Read in full: `src/types.ts`, `src/args.ts`, `src/cli.ts`, `src/context/*`,
`src/templates/*`, `src/generate/*`, and the 11 test files.

```
bin/cli.js          Node >= 20.19 gate
      ↓
src/cli.ts          argv, error boundary, exit codes
      ↓
src/commands/       create | list
      ↓
src/context/        resolve ← prompts, fromFile, defaults, validate
      ↓
ProjectContext      frozen (deepFreeze)
      ↓
src/templates/      registry → manifest (strict schema)
      ↓
src/generate/       plan() → FileOperation[] → apply() → postSteps()
      ↓
templates/          inert data, shipped in the tarball
```

### 3.1 What must remain — DECIDED

These are load-bearing and V2 keeps them unchanged in spirit:

| Concept               | Where                   | Why it survives                                                                                                                                                                                |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolver boundary     | `types.ts`              | Nothing below the resolver reads flags, env, prompts or files. This is what makes interactive and flag-driven runs one code path, and it is the single most valuable property in the codebase. |
| Frozen context        | `resolve.ts:deepFreeze` | Generation cannot mutate its own inputs.                                                                                                                                                       |
| Pure `plan()`         | `generate/plan.ts`      | Reads templates, writes nothing. Given the same inputs returns identical operations, so output is snapshottable and diffable.                                                                  |
| `FileOperation[]`     | `generate/files.ts`     | The plan is a list of operations and nothing else. Dry-run is free.                                                                                                                            |
| Atomic `apply()`      | `generate/apply.ts`     | Stages into a **sibling** temp dir then renames — sibling because a cross-device rename fails on Windows. A failure leaves the target untouched.                                               |
| `SourceMap`           | `types.ts`              | Records whether each value came from a flag, file, prompt, template default or built-in default. V2 needs far more of this, not less (§20).                                                    |
| Declarative manifests | `templates/manifest.ts` | Unknown keys rejected; post-steps are an allow-list of CLI-owned identifiers, never shell strings. A template is data.                                                                         |
| Underscore rename     | `files.ts`              | `_package.json` → `package.json`. Required or npm resolves template package.json files during install.                                                                                         |
| Text allow-list       | `files.ts:isTextFile`   | Substitution targets are decided by extension allow-list, never by sniffing content.                                                                                                           |
| LF normalisation      | `files.ts`              | Identical bytes on every platform.                                                                                                                                                             |
| Injectable `PlanFs`   | `plan.ts`               | Planning is testable in memory. V2 depends on this heavily.                                                                                                                                    |
| Injectable `Prompter` | `context/prompts.ts`    | The interactive branch is testable without a TTY.                                                                                                                                              |

### 3.2 The observation the whole design rests on — DECIDED

`plan()` **is already a composition engine.** It:

- walks an ordered list of layers (`base`, then `modes/<mode>`),
- keys contributions by destination path,
- resolves collisions with a rule (last layer wins; `package.json` and
  `tsconfig.json` deep-merge instead),
- records `origin` for diagnostics.

V2 does not need a new engine. It needs three changes to this one:

1. The layer list stops being two hardcoded directories and becomes **an
   ordered list of contributions produced by adapters**.
2. Contributions carry **ownership and intent**, so a collision between two
   independent adapters can be reported instead of silently resolved.
3. A **compatibility gate** runs before planning, so impossible configurations
   never reach the planner.

That framing is why this is an evolution rather than a rewrite.

### 3.3 What must be generalised

| V1 detail                                               | Problem for V2                                    |
| ------------------------------------------------------- | ------------------------------------------------- |
| `TEMPLATE_MODES = ['coming-soon','full']` in `types.ts` | A template-level concept hardcoded in core types. |
| `TemplateContext { id, version, mode }`                 | Assumes one template identity; V2 has a stack.    |
| Layer list hardcoded in `plan()`                        | Exactly two layers, fixed names.                  |
| `MERGEABLE_JSON = {package.json, tsconfig.json}`        | Angular needs `angular.json`; others differ.      |
| `KNOWN_TOKENS` as one global union                      | Adapters need to contribute tokens.               |
| `availableFeatures` must be empty                       | A deliberate V1 guard that V2 removes.            |
| `manifest.framework` is a display string                | V2 needs it to name an adapter.                   |
| Registry id = directory name                            | V2 composes; there is no single directory.        |

### 3.4 What must **not** be abstracted — DECIDED

Worth stating, because the temptation in a design like this is to abstract
everything:

- **`apply()`.** Atomic staging is finished work. It takes a
  `FileOperation[]` and does not care where the list came from. Leave it alone.
- **The post-step allow-list.** `install`, `git-init`, `format` stay a fixed
  CLI-owned set. Adapters must never gain the ability to run commands — that is
  the difference between a scaffolder and an arbitrary code execution vector.
- **The error model.** `CliError` with message + hint is adequate.
- **Package-manager detection.** Orthogonal to everything here.
- **The no-fabrication rule.** URL-less behaviour is a product principle, not a
  template detail. It applies to every framework V2 ever supports.

---

## 4. V2 target architecture — PROPOSED

```
                     CLI (argv)
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        flags / --from          interactive prompts
              └───────────┬───────────┘
                          ▼
                 Configuration Resolver        ← V1 precedence, extended
                          │
                          ▼
                  ProjectManifest              ← user intent only
                          │
                          ▼
                 Compatibility Engine          ← capabilities + constraints
                          │                       (rejects before any I/O)
                          ▼
                   Adapter Selection
        framework │ build │ language │ styling │ ui │ router │ features
                          │
                          ▼
                   Resolution Pass             ← adapters answer questions
                          │                       (versions, extensions, roles)
                          ▼
                   ResolvedProject             ← intent + resolved facts
                          │
                          ▼
                  Contribution Pass            ← adapters emit contributions
          dependencies │ files │ scripts │ config │ directories
                          │
                          ▼
                 Composition Planner           ← merge, detect conflicts
                          │
                          ▼
                   FileOperation[]             ← unchanged from V1
                          │
                ┌─────────┴─────────┐
                ▼                   ▼
             dry-run           atomic apply     ← unchanged from V1
```

Two passes (resolution, then contribution) rather than one, because an adapter
often needs to know a _resolved_ fact owned by a different adapter — the
styling adapter needs to know the file extension the language adapter chose,
and the path the framework's architecture assigns to the global stylesheet —
before it can say what files it wants to create.

---

## 5. Domain model — PROPOSED

### 5.1 Three tiers, and the boundary between them

This is Phase 3 of the brief and the part most likely to rot if it is fudged.

```
ProjectManifest     what the user asked for        no versions, no paths
      ↓
ResolvedProject     what that means concretely     versions, extensions, roles
      ↓
GenerationPlan      what will be written           FileOperation[]
```

**The rule:** if a field would change when a dependency releases a new version,
it does not belong in the manifest.

```ts
// Tier 1 — user intent. Serialisable, diffable, stable across releases.
interface ProjectManifest {
  readonly projectName: string;
  readonly targetDir: string;

  readonly framework: FrameworkId; // 'astro' | 'react' | 'nextjs' | 'angular'
  readonly buildTool: BuildToolId; // 'astro' | 'vite' | 'next' | 'angular-cli'
  readonly language: LanguageId; // 'ts' | 'js'
  readonly styling: StylingId; // 'tailwind' | 'bootstrap' | 'css' | 'scss' | 'none'
  readonly uiLibrary: UiLibraryId; // 'mui' | 'chakra' | 'angular-material' | 'none'
  readonly router: RouterId; // 'none' | 'file-based' | 'react-router' | 'angular-router'
  readonly architecture: ArchitectureId; // 'standard' | 'feature-first' | ...
  readonly features: readonly FeatureId[];

  readonly site: SiteConfig; // unchanged from V1 SiteContext
  readonly packageManager: PackageManager;
  readonly git: boolean;
  readonly install: boolean;
}
```

Note what is **absent**: no `viteConfigFile`, no `tailwindPluginVersion`, no
`muiEmotionDependency`. Those are tier 2.

```ts
// Tier 2 — resolved facts. Rebuilt on every run; never persisted as user config.
interface ResolvedProject {
  readonly manifest: ProjectManifest;

  readonly adapters: {
    readonly framework: FrameworkAdapter;
    readonly buildTool: BuildToolAdapter;
    readonly language: LanguageAdapter;
    readonly styling: StylingAdapter;
    readonly uiLibrary: UiLibraryAdapter;
    readonly router: RouterAdapter;
    readonly features: readonly FeatureAdapter[];
  };

  readonly architecture: ArchitectureDefinition; // §11
  readonly extensions: {
    // from the language adapter
    readonly source: string; // '.ts' | '.js'
    readonly component: string; // '.tsx' | '.jsx' | '.ts'
    readonly config: string;
  };
  readonly minNode: string; // max() across adapters
  readonly capabilities: ReadonlySet<Capability>; // §9
}
```

Tier 3 is V1's `GenerationPlan`, extended only with a dependency set and richer
`origin` (§14, §20).

### 5.2 What happens to `ProjectContext` — DECIDED

`ProjectContext` becomes `ProjectManifest`. It keeps `deepFreeze`, keeps the
"nothing below the resolver reads input" rule, and keeps `SiteConfig` verbatim
including `url: string | null` meaning _explicitly absent_.

`TemplateContext { id, version, mode }` is dissolved: `id` becomes the adapter
set, `mode` becomes a feature (§13).

---

## 6. Framework adapters — PROPOSED

### 6.1 Minimum useful interface

The brief's sketch is close but does too much in one pass. Split by tier:

```ts
interface FrameworkAdapter {
  readonly id: FrameworkId;
  readonly displayName: string;

  // --- declaration (static, no I/O, used by the compatibility engine) ---
  readonly provides: readonly Capability[];
  readonly requires: readonly Constraint[];
  readonly buildTools: DimensionOptions<BuildToolId>; // §7
  readonly languages: DimensionOptions<LanguageId>;
  readonly routers: DimensionOptions<RouterId>;
  readonly architectures: readonly ArchitectureDefinition[];
  readonly minNode: string;

  // --- resolution pass ---
  resolve(manifest: ProjectManifest): FrameworkResolution;

  // --- contribution pass ---
  contribute(project: ResolvedProject): Contribution;
}
```

`Contribution` is one object rather than five methods, because the five kinds
are always produced together and splitting them invites an adapter to compute
the same thing repeatedly:

```ts
interface Contribution {
  readonly owner: AdapterId;
  readonly dependencies: readonly DependencyContribution[];
  readonly files: readonly FileContribution[];
  readonly scripts: readonly ScriptContribution[];
  readonly config: readonly ConfigContribution[];
  readonly directories: readonly string[];
}
```

### 6.2 Adapters never see each other — DECIDED

An adapter receives `ResolvedProject` and returns a `Contribution`. It cannot
call another adapter, cannot read the filesystem, and cannot mutate anything.
That makes every adapter a pure function of resolved state, which is what makes
them independently unit-testable with no CLI and no disk (§18).

---

## 7. Build tool as a dimension — PROPOSED

The brief is right that `React` and `React + Vite` must not become two
frameworks. The build tool is a separate axis whose **cardinality** varies:

```ts
type DimensionOptions<T> =
  | { readonly kind: 'fixed'; readonly value: T } // no question asked
  | { readonly kind: 'choice'; readonly options: readonly T[]; readonly default: T };
```

| Framework | Build tool                            |
| --------- | ------------------------------------- |
| Astro     | `fixed: 'astro'`                      |
| Next.js   | `fixed: 'next'`                       |
| Angular   | `fixed: 'angular-cli'`                |
| React     | `choice: ['vite', …]`, default `vite` |

The prompt engine's rule is then general, with no framework knowledge in it:

> Ask a question if and only if the dimension is `choice` **and** more than one
> option survives compatibility filtering.

This single rule delivers Phase 10's "do not ask irrelevant questions" for
every dimension — build tool, language, router, UI library — without a special
case anywhere.

---

## 8. Language, styling and UI library adapters — PROPOSED

All three implement the same shape as the framework adapter (declare → resolve
→ contribute). What differs is what they own.

**Language** owns file extensions, `tsconfig.json` (or its absence), type
declaration files, and the `check` script. It declares which frameworks it is
valid for via capabilities, not a list of framework ids.

**Styling** owns its dependencies, its config files, the global stylesheet
content, and any build-tool plugin registration. Critically it does **not** own
the _path_ of the global stylesheet — it asks for the role `styles.global` and
the architecture answers (§11). That is what lets one Tailwind adapter serve
Astro, React, Next and Angular.

**UI library** is a different architectural role from styling and the
compatibility model must know it (Phase 8). Tailwind is a styling system;
MUI is a component library that brings its own styling engine (Emotion). They
are not interchangeable and they are not always mutually exclusive — MUI and
Tailwind together is a real, if opinionated, combination. The model expresses
this with capabilities rather than by categorising:

- MUI `requires: requiresCapability('react-runtime')`
- MUI `provides: 'css-in-js'`
- Bootstrap `provides: 'css-framework'`, and `conflictsWith('css-framework')`
  prevents Bootstrap + another CSS framework without forbidding MUI.

---

## 9. Compatibility engine — DECIDED (the central decision)

### 9.1 Not a matrix

A matrix over 4 frameworks × 2 build tools × 2 languages × 5 styling × 4 UI is
320 cells today and grows multiplicatively. Worse, adding Vue means editing
every existing UI library's row. That fails Phase 25's "add a framework without
modifying unrelated adapters".

### 9.2 Capabilities and constraints

Each adapter declares what it **provides** and what it **requires**. The engine
never compares two adapters directly.

```ts
type Capability =
  | 'react-runtime'
  | 'vue-runtime'
  | 'angular-runtime'
  | 'jsx'
  | 'ssr'
  | 'file-based-routing'
  | 'spa-routing'
  | 'postcss'
  | 'css-framework'
  | 'css-in-js'
  | 'vite-plugins'
  | 'typescript';

type Constraint =
  | { kind: 'requires'; capability: Capability; because: string }
  | { kind: 'conflicts'; capability: Capability; because: string }
  | { kind: 'requiresOneOf'; capabilities: readonly Capability[]; because: string };
```

Worked example — the brief's `Angular + Chakra UI`:

```
Angular adapter   provides: ['angular-runtime', 'spa-routing', 'typescript']
Chakra adapter    requires: 'react-runtime'  because "Chakra UI is built on React"

Selected capabilities = { angular-runtime, spa-routing, typescript, … }
'react-runtime' ∉ selected  →  Chakra is invalid.
```

No rule mentions both Angular and Chakra. Adding Vue tomorrow requires editing
nothing: Vue declares `vue-runtime`, and every React-only library remains
correctly excluded because it asked for `react-runtime`.

**`because` is mandatory on every constraint.** It is not documentation — it is
the user-facing error text (§17), which guarantees no constraint can be added
without a human-readable reason.

### 9.3 Two operating modes

The same model serves both entry points, which is Phase 11's requirement that
prompts and flags share one implementation:

- **Filter** (interactive): given partial selections, return the options for the
  next dimension whose constraints are still satisfiable. Drives the prompts.
- **Validate** (flags/preset): given a complete manifest, return
  `{ ok } | { violations }`. Drives the error message.

### 9.4 Order independence — OPEN QUESTION

Filtering against _partial_ state can mislead. If the user picks Chakra before
picking a framework, do we narrow the framework list to React, or reject later?

Two candidate answers, both defensible:

- **Fixed dimension order** (framework first, always) — simple, predictable,
  matches every comparable CLI. Cost: no "I want Chakra, what works?" flow.
- **Constraint propagation** — genuinely solving in any order. More powerful,
  meaningfully more code, and hard to explain in prompt UI.

**Recommendation: fixed order for V2.0**, revisit if anyone asks. Recorded as
open because it is a real product decision, not a technical inevitability.

---

## 10. Composition model — PROPOSED

### 10.1 Dependencies

Adapters never touch `package.json`. They contribute:

```ts
interface DependencyContribution {
  readonly name: string;
  readonly version: string; // exact pin, matching V1 policy
  readonly kind: 'prod' | 'dev' | 'peer' | 'optional';
  readonly owner: AdapterId;
  readonly reason: string; // surfaced by --dry-run --debug
}
```

The resolver folds them and reports, rather than silently picking:

| Situation                                       | Outcome                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| Same name, same version, different owners       | Merge. Record both owners.                                       |
| Same name, different versions                   | **Conflict — hard error**, naming both owners and both versions. |
| Same name, `prod` in one and `dev` in another   | Promote to `prod`, record why.                                   |
| Declared `peer` unsatisfied by the resolved set | **Conflict — hard error.**                                       |
| Duplicate script name, different bodies         | **Conflict — hard error.**                                       |

Silent "last wins" is deliberately not an option for dependencies. Two adapters
disagreeing about a version is a bug in ClientKit, and it should fail in CI on
a maintainer's machine rather than produce a subtly broken project.

### 10.2 Files, ownership and conflicts

```ts
interface FileContribution {
  readonly role?: RoleId; // preferred: 'styles.global', 'app.entry'
  readonly path?: string; // escape hatch; role wins when both given
  readonly owner: AdapterId;
  readonly intent: 'create' | 'merge' | 'append' | 'template';
  readonly payload: FilePayload; // inline text | template ref | JSON model
  readonly order: number; // deterministic ordering within an intent
}
```

Resolution rules, in order:

1. Resolve `role` → concrete path via the architecture (§11).
2. Group by resolved path.
3. Exactly one `create` per path. **Two `create`s from different owners is a
   hard error** naming both — this is the brief's Phase 16 scenario, and V1's
   silent last-wins is wrong once adapters are independent authors.
4. `merge` contributions apply onto the `create`, ordered by `order` then
   `owner` for stability. JSON merges structurally (V1's `deepMergeJson`);
   anything else must declare a config model (§12).
5. `append` concatenates in `order` — for stylesheet import blocks and similar.
6. A `merge` or `append` with no `create` to attach to is a hard error, not a
   silent no-op.

### 10.3 Determinism — DECIDED

`(order, owner, path)` is a total ordering, and `Map` iteration is insertion-
ordered, so the planner's output is stable. V1 already sorts operations by path
before returning; V2 keeps that. Golden-file tests (§18) enforce it.

---

## 11. Professional architecture model — PROPOSED (the key decoupling)

Phase 13 asks that ClientKit not force one folder structure on every framework.
The mechanism that achieves this is also what keeps `if (framework === …)` out
of every other adapter, so it is worth stating plainly:

> **Adapters address files by _role_. The framework's architecture maps roles
> to paths.**

```ts
interface ArchitectureDefinition {
  readonly id: ArchitectureId;
  readonly displayName: string;
  readonly directories: readonly string[]; // created even when empty
  readonly roles: Readonly<Record<RoleId, string>>;
}
```

The same Tailwind adapter, contributing `role: 'styles.global'`, lands
correctly in four different stacks:

| Framework    | `styles.global` resolves to |
| ------------ | --------------------------- |
| Astro        | `src/styles/global.css`     |
| React + Vite | `src/styles/index.css`      |
| Next.js      | `src/app/globals.css`       |
| Angular      | `src/styles.scss`           |

Sketches of the structures each framework adapter would own — Astro's is
today's, unchanged:

```
React + Vite                Next.js (app router)        Angular
src/                        src/                        src/
├── assets/                 ├── app/                    ├── app/
├── components/             ├── components/             │   ├── core/
│   ├── common/             ├── config/                 │   ├── shared/
│   ├── layout/             ├── constants/              │   ├── features/
│   └── ui/                 ├── hooks/                  │   └── layouts/
├── config/                 ├── lib/                    ├── assets/
├── constants/              ├── services/               ├── environments/
├── hooks/                  ├── types/                  └── styles.scss
├── layouts/                └── utils/
├── lib/
├── pages/
├── routes/
├── services/
├── styles/
├── types/
├── utils/
├── App.tsx
└── main.tsx
```

**The role vocabulary is a core, versioned artifact.** If it is wrong, adapters
start reaching for `path` instead of `role` and the decoupling silently rots.
Recommended guard: a lint test asserting non-framework adapters contribute
zero literal `path` values (§18).

**OPEN QUESTION:** whether `architecture` is user-selectable in V2.0
(`standard` vs `feature-first`) or fixed per framework. Selectable multiplies
the test surface for unclear early benefit. **Recommendation: fixed per
framework in V2.0**, with the type already able to express alternatives.

---

## 12. Configuration merging — PROPOSED

Phase 17 warns against building a universal AST framework. We can avoid it
entirely, and the reason is worth naming because it is load-bearing:

> **ClientKit generates these files; it never edits a file a human wrote.**
> Greenfield-only (§2) means there is no arbitrary code to parse.

So configuration is composed as **data**, then serialised once:

| Target                                          | Strategy                                                                                                                                                        | Status   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `package.json`, `tsconfig.json`, `angular.json` | Structured JSON deep-merge — V1's `deepMergeJson`, with the mergeable set moved from a hardcoded constant to adapter declaration                                | DECIDED  |
| `vite.config`, `next.config`, `astro.config`    | The framework/build adapter owns a **config model** (plugins, aliases, options). Other adapters contribute entries. The owner serialises to source. No parsing. | DECIDED  |
| Global stylesheet                               | Ordered blocks (`imports`, `directives`, `theme`, `base`) contributed and concatenated                                                                          | DECIDED  |
| Entry file (`main.tsx`, `App.tsx`)              | Framework owns the file; others contribute _provider wrappers_ and _imports_ as structured entries, not text                                                    | PROPOSED |
| Anything requiring true AST editing             | Out of scope for V2                                                                                                                                             | DECIDED  |

The entry-file case is the one genuinely hard spot: MUI wants
`<ThemeProvider>`, a router wants `<BrowserRouter>`, and nesting order matters.
Modelling it as an ordered provider list the framework adapter renders keeps it
data, but the ordering rules are not obvious. **OPEN QUESTION: how provider
nesting order is decided** — candidates are an explicit `order` on each
provider, or a declared inside/outside relationship. Needs a concrete spike
against React + MUI + React Router before committing.

---

## 13. Feature model — PROPOSED

Phase 14's distinction is the right one: features are framework-independent
_intent_ with framework-specific _implementation_.

```ts
interface FeatureAdapter {
  readonly id: FeatureId; // 'seo' | 'sitemap' | 'robots' | …
  readonly requires: readonly Constraint[];
  contribute(project: ResolvedProject, impl: FeatureImplementation): Contribution;
}
```

A framework adapter declares which features it can implement and how. A feature
with no implementation for the selected framework is **not offered** — the same
capability mechanism as everything else, no special case.

Mapping today's concepts:

| V1 concept                                             | V2 home                                                                                                                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coming-soon` / `full` mode                            | **Feature** (`starter:coming-soon` / `starter:full`), selected per framework. Not a core enum.                                                                                   |
| 404 page                                               | Framework-provided baseline, always on                                                                                                                                           |
| SEO, robots, sitemap, social metadata, structured data | Features; implementation differs sharply (Astro build-time vs React SPA runtime)                                                                                                 |
| Favicon, theme                                         | Framework baseline                                                                                                                                                               |
| URL-less behaviour                                     | **Not a feature — a product invariant.** Every SEO implementation must omit absolute tags when `site.url` is null. Enforced by a shared test applied to every framework adapter. |

Removing `TEMPLATE_MODES` from core types is the concrete win here: "mode" was
always an Astro-template concept that had leaked into `src/types.ts`.

---

## 14. Template strategy and migration — PROPOSED

### 14.1 Directory shape

```
templates/
├── frameworks/
│   ├── astro/          ← today's base/ + modes/, moved intact
│   ├── react/
│   ├── nextjs/
│   └── angular/
├── styling/
│   ├── tailwind/
│   ├── bootstrap/
│   └── scss/
├── ui/
│   ├── mui/
│   └── chakra/
└── features/
    ├── seo/
    └── starter/
```

Template **files** stay inert data. Adapters are code in `src/adapters/…` and
reference template files by path. Nothing executable moves into `templates/`.

### 14.2 The migration's safety net — DECIDED

`templates/astro-tailwind/` is not deleted and its content is not edited during
the move. Before any V2 code is written:

1. Capture golden snapshots of the full `FileOperation[]` for every current
   combination (2 modes × URL/URL-less) from 1.0.2.
2. Land them as tests on `main`.
3. Every subsequent V2 commit must keep them **byte-identical**.

Step 2 of the implementation sequence (§21) is then objectively verifiable:
the Astro adapter is correct when it reproduces those snapshots exactly. That
converts "did we break the existing product?" from a judgement call into a test
result.

### 14.3 The starter contribution contract — DECIDED (Stage 20)

§14.1's shape was a proposal; the tree that exists differs from it in one
respect worth recording, because the difference is the decision. There is no
`features/starter/` directory and there is no directory per stack. A starter is
a _contract_ in `src/domain/starter.ts`, and each framework answers it with two
directories of its own.

```
src/domain/starter.ts              which starters exist, what each guarantees,
                                   which layers a selection produces
templates/astro-tailwind/base/     ┐ Astro's answer: two directories
templates/astro-tailwind/modes/*/  ┘
templates/react-vite/base/         ┐ React's answer: the same two, arranged
templates/react-vite/modes/*/      ┘ however React wants them
templates/styling/<id>/            one directory per option, never per combination
templates/ui-library/<id>/
templates/feature/<id>/
```

Four questions a `react-tailwind-starter/` directory would answer all at once,
kept apart:

| Question                                | Owner                    |
| --------------------------------------- | ------------------------ |
| What does the project start containing? | the starter contract     |
| How is that represented?                | the framework adapter    |
| Where does the representation live?     | the architecture's roles |
| How does everything else attach?        | the composition engine   |

A new framework contributes starters by calling `planStarterLayers` with its own
two roots and one sentence explaining its shared layer. It adds no starter
definition, and no existing adapter changes. The arithmetic that motivated this
— frameworks × styling × UI library × router × starter — never runs: the count
on disk is two directories per framework, and adding a styling system adds none.

The contract is enforced negatively, because that is where the failure mode is:

- It may not name a framework, build tool, styling system, component library,
  router, architecture, or any feature other than the starters themselves. A
  test strips the prose and walks the source for every dimension id.
- It reads no filesystem, spawns nothing, and imports no `path` — both layer
  roots are handed to it. A path it could join is a layout it has an opinion
  about.
- Its output is a pure function of its input, ordered explicitly rather than by
  array position, with an owner and a reason on every layer.

Each starter also declares the semantic **roles** a project built from it must
end up with — `page.home` for both of today's starters. The check runs against
the finished plan by resolved path, so whoever produces the file satisfies it,
and a starter layer that shipped no home page fails before anything is written.

### 14.4 Starter identity — DECIDED (Stage 21)

Stage 20 generalised how a starter _contributes_. This generalises what a
starter _is_, and the question it answers is whether `coming-soon` / `full` is
the long-term model or a two-valued flag that happens to look like one.

It is the long-term model, with one correction: a starter had been a **feature**
since Stage 1.

```
before                                   after
────────────────────────────────────     ────────────────────────────────────
FEATURE_IDS: [..., 'starter:full']       STARTER_IDS: ['coming-soon', 'full']
manifest.features: ['starter:full']      manifest.starter: 'full'
                                         manifest.features: []
```

Carrying the starter inside the feature list meant seven places had to filter
`starter:*` back out of lists it did not belong in — adapter selection, the
provenance file, the explanation, compatibility probing, the `--features`
parser — and **two** functions independently mapped `--mode` onto it. Two copies
of one rule is a disagreement waiting for someone to add a starter.
`starterFromMode` is now the only mapping, and both callers use it.

The identity is deliberately thin:

| Field         | Why it exists                                                   |
| ------------- | --------------------------------------------------------------- |
| `id`          | what the manifest carries; what a framework maps to a directory |
| `displayName` | what a menu, `--help` or a diagnostic shows                     |
| `description` | the same, one line down                                         |
| `guarantees`  | what makes a starter checkable rather than merely named         |

There is no `layer` (Stage 20 had one; it was always the id), no `root`, no
`framework`, and no `extends`. The last would be starter inheritance, which is
out of scope and should be decided on its own evidence rather than smuggled in
as a field nothing uses.

`STARTERS` is a registry validated at construction: unique non-empty ids, a name
and description, at least one guarantee, and every guarantee a real `FileRole`.
A starter that guarantees nothing is the defect worth catching there — it would
select, plan and generate perfectly, and produce a project with nothing in it.

**What this buys.** `portfolio`, `marketing`, `saas` and `documentation` are
each a definition plus one line in `STARTER_IDS` — no adapter changes, no
framework learns a new name. A test proves it by registering a `portfolio`
starter that does not ship and driving validation, selection, metadata and layer
planning through the generic machinery, and a structural test asserts no
framework adapter compares against a starter id at all. **None of those starters
is implemented, registered or offered.** The two that ship are still the two
that ship.

**What is unchanged.** `--mode coming-soon | full` is the public surface and
stays exactly as it is; there is no `--starter` flag and the configuration file
gained no starter key. One project still has exactly one starter — now by
construction, since a single field cannot hold two.

---

## 15. Prompt flow — PROPOSED

```
◇ Project directory
◇ Client / site name
◇ Production URL                (optional — empty stays URL-less)
│
◇ Framework            ● Astro  ○ React  ○ Next.js  ○ Angular
│
├─ Astro    → build tool fixed, skipped
├─ React    → ◇ Build tool      ● Vite
├─ Next.js  → build tool fixed, skipped
└─ Angular  → build tool fixed, skipped
│
◇ Language             ● TypeScript  ○ JavaScript      (skipped if fixed)
◇ Styling              ● Tailwind  ○ Bootstrap  ○ CSS  ○ SCSS  ○ None
◇ UI library           (only options passing compatibility; skipped if only "None")
◇ Router               (skipped when the framework fixes it)
◇ Starter              ● Coming Soon  ○ Full
◇ Setup                install deps, initialise git
```

Every skip is the one rule from §7 — not a hardcoded exception. Angular is
never asked about Chakra because Chakra requires `react-runtime`, and the
filter removes it before the question is rendered.

The existing `Prompter` interface generalises to one method:

```ts
selectDimension<T>(dimension: DimensionId, options: readonly Option<T>[], def: T): Promise<T>;
```

which keeps the injectable-prompter testability V1 already has.

---

## 16. CLI flags and presets — PROPOSED

```bash
npm create clientkit@latest acme-website \
  --framework react \
  --build-tool vite \
  --language ts \
  --styling tailwind \
  --ui-library mui \
  --starter coming-soon
```

Vocabulary: one flag per dimension, kebab-case, singular, matching the manifest
field. `--yes` fills every unanswered dimension from defaults, as today.

**Presets are named partial manifests — DECIDED.** Not templates, not persisted
files, not a fourth concept:

```bash
npm create clientkit@latest acme-website --preset react-vite-tailwind
```

A preset is a plain object slotting into the existing precedence chain at
exactly the position `--from` already occupies:

```
CLI flags  >  --from file  >  --preset  >  interactive  >  adapter defaults  >  built-in
```

So `--preset react-vite-tailwind --styling bootstrap` works predictably: the
explicit flag overrides the preset. This reuses V1's resolver wholesale and
adds no new machinery. Presets are validated through the same compatibility
engine, so a broken preset fails a unit test rather than a user's generation.

---

## 17. Error experience — PROPOSED

Because every constraint carries `because`, errors are generated, not written:

```
✖ Chakra UI cannot be used with Angular.

  Chakra UI is built on React, and Angular does not provide a React runtime.

  Available UI libraries for Angular:
    ● Angular Material
    ○ None
```

For flags, report **all** violations at once rather than failing on the first —
a user fixing a five-flag command one error at a time is a bad afternoon:

```
✖ Invalid configuration.

  --ui-library chakra   requires a React runtime, which --framework angular does not provide
  --build-tool vite     is not available for --framework angular (fixed: angular-cli)

  Run with --help, or drop the flags above to be prompted instead.
```

Configuration errors exit non-zero with no stack trace, as V1 already does via
`CliError`. Stack traces stay behind `--debug`.

---

## 18. Testing architecture — PROPOSED

Six layers, cheapest first:

| Layer                | What it proves                                                             | Cost    |
| -------------------- | -------------------------------------------------------------------------- | ------- |
| 1. Adapter unit      | Each adapter's declarations and contributions, pure, no disk               | ms      |
| 2. Compatibility     | Table-driven valid/invalid combinations, including every `because` string  | ms      |
| 3. Composition       | Contributions → plan; conflict detection; determinism                      | ms      |
| 4. Golden plan       | Full `FileOperation[]` snapshots, incl. the frozen 1.0.2 Astro set (§14.2) | ms      |
| 5. Clean-room build  | Real `npm install`, typecheck, build, axe, Lighthouse                      | minutes |
| 6. Cross-platform CI | Existing 17-job matrix                                                     | minutes |

Layers 1–4 need no filesystem and no CLI, because `PlanFs` and `Prompter` are
already injectable. That is the V1 investment paying off.

**The real explosion is in testing, not templates.** 4 frameworks × 2 build ×
2 languages × 5 styling × 4 UI ≈ 320 combinations. Layers 1–4 can cover all of
them in seconds. Layer 5 cannot — it is minutes each. Proposed sampling:

- every framework × its default stack — always
- every styling adapter on at least one framework — always
- every UI library on its own framework — always
- the full cross-product — nightly or on release only, never per-PR

Two invariants get applied to _every_ framework adapter as shared test suites,
so a new framework cannot regress them: **URL-less emits no absolute tags**,
and **generated projects are `private: true` / `UNLICENSED`**.

---

## 19. Backward compatibility — DECIDED

V1's public contract, in priority order:

1. `npm create clientkit@latest` with no flags produces an Astro + Tailwind
   coming-soon site.
2. `--template astro-tailwind` is accepted.
3. `--mode coming-soon | full` is accepted.
4. Generated projects keep their shape, licensing and SEO behaviour.

The strategy:

| V1 input                                          | V2 handling                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| No flags                                          | Defaults resolve to Astro + Tailwind + coming-soon. **Unchanged output.**                            |
| `--template astro-tailwind`                       | Accepted as a preset alias → `framework=astro, styling=tailwind`. Documented as legacy; not removed. |
| `--template <unknown>`                            | Same error as today                                                                                  |
| `--mode`                                          | Maps to the starter feature. Kept indefinitely — it is a reasonable name.                            |
| `--from` presets containing `templateId` / `mode` | Translated by the same alias layer, so existing config files keep working                            |

**No breaking change ships in a minor version.** If V2 ever needs to change the
no-flag default away from Astro, that is 2.0.0 with a migration note — and
§14.2's golden snapshots are what make it possible to prove we haven't done it
by accident.

---

## 20. Debuggability — PROPOSED

Phase 25 asks whether a developer can understand why a file or dependency
exists. V1 already answers a weaker version via `origin` and `SourceMap`; V2
extends both, because with seven adapters "why is this here?" gets genuinely
hard:

```
$ npm create clientkit@latest acme --framework react --styling tailwind --ui-library mui --dry-run --debug

Framework   react      (flag)
Build tool  vite       (derived — react's default)
Language    ts         (default)
Styling     tailwind   (flag)
UI library  mui        (flag)

Files (31)
  + src/main.tsx                  react:framework
  + src/App.tsx                   react:framework
  + src/styles/index.css          tailwind:styling  → role styles.global
  + tailwind.config.ts            tailwind:styling
  + vite.config.ts                vite:build        + tailwind:styling (plugin)
  + package.json                  composed from 4 contributors

Dependencies (9)
  + react@…              react:framework    "framework runtime"
  + tailwindcss@…        tailwind:styling   "styling system"
  + @mui/material@…      mui:ui             "component library"
  + @emotion/react@…     mui:ui             "required by @mui/material"
```

Every line traces to an owner and a reason. The `reason` field on
`DependencyContribution` exists for this and nothing else.

---

## 21. Recommended implementation sequence — PROPOSED

Ordered so each step is independently reviewable and the product stays shippable
throughout. **No step removes the working Astro path.**

| #   | Step                                                                      | Proves                                                                                                                      |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0   | Golden snapshots of 1.0.2 output, landed on `main`                        | Safety net exists before anything moves                                                                                     |
| 1   | Core types: roles, capabilities, constraints, contributions. No adapters. | The vocabulary compiles and is testable in isolation                                                                        |
| 2   | **Astro adapter reproducing today's output byte-identically**             | The abstraction is real. If step 0's snapshots don't pass here, the design is wrong and this is where we find out — cheaply |
| 3   | Compatibility engine + generalised prompt driver                          | Filtering and validation share one model                                                                                    |
| 4   | React + Vite adapter                                                      | The abstraction generalises past one framework                                                                              |
| 5   | Styling adapters (Tailwind first — it already exists)                     | Roles decouple styling from framework                                                                                       |
| 6   | UI library adapters (MUI first)                                           | Capabilities handle a genuinely React-only dependency                                                                       |
| 7   | Feature generalisation (SEO, starters)                                    | Framework-independent intent, framework-specific implementation                                                             |
| 8   | Next.js, then Angular                                                     | Each is now additive                                                                                                        |

**Step 2 is the gate.** If the Astro adapter cannot reproduce the current output
exactly, stop and revise the design rather than adjusting the snapshots.

---

## 22. Risks and tradeoffs

| #   | Risk                                                                                                                                                                                                                                  | Severity | Mitigation                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Maintenance load.** One template already needs a weekly drift probe. Four frameworks is four ecosystems churning independently.                                                                                                     | **High** | Generalise the drift probe per adapter; pin exactly; be willing to mark an adapter unmaintained rather than ship a broken one |
| 2   | **Test-matrix explosion** — real, even though templates don't explode                                                                                                                                                                 | High     | Layers 1–4 cover all combinations cheaply; layer 5 samples (§18)                                                              |
| 3   | **Role vocabulary rots** — adapters fall back to literal paths                                                                                                                                                                        | Medium   | Lint test forbidding literal `path` in non-framework adapters                                                                 |
| 4   | Entry-file provider composition is genuinely hard                                                                                                                                                                                     | Medium   | Spike React + MUI + Router before committing (§12)                                                                            |
| 5   | Dependency version conflicts between adapters                                                                                                                                                                                         | Medium   | Hard error, never silent resolution (§10.1)                                                                                   |
| 6   | Astro regression during migration                                                                                                                                                                                                     | Medium   | Golden snapshots as a merge gate (§14.2)                                                                                      |
| 7   | **Product focus.** V1's value is an opinionated client-website foundation. A generic multi-framework scaffolder competes with `create-vite`, `create-next-app` and `ng new` — which are maintained by the framework teams themselves. | **High** | See below                                                                                                                     |

Risk 7 deserves a straight answer rather than a mitigation cell. The thing
ClientKit does that `create-vite` does not is the _client-website_ layer — SEO
that refuses to invent a domain, a real 404, structured data, an accessibility
baseline, a Coming Soon page you can put live today. If V2 keeps that layer as
the point and treats frameworks as the substrate, it stays differentiated. If
frameworks become the point, ClientKit becomes a worse version of tools written
by the framework authors. **Recommendation: hold the feature layer as the
product and require every new framework adapter to implement it** — a framework
that cannot carry SEO, 404 and the starter features is not ready to ship.

Worth noting plainly: nothing in §22 is a reason not to proceed. It is the list
of things that would make this fail, so they can be watched.

---

## 23. Open questions

Carried from above, unresolved on purpose:

1. **Dimension order** (§9.4) — fixed framework-first, or full constraint
   propagation? _Recommendation: fixed for V2.0._
2. **Provider nesting order** in entry files (§12) — needs a spike.
3. **User-selectable architecture** (§11) — or fixed per framework?
   _Recommendation: fixed for V2.0._
4. **Router as its own dimension** — or a feature? Angular and Next fix it;
   only React makes it a real choice, which is weak evidence for a top-level
   dimension.
5. **JavaScript support breadth** — is `--language js` supported for every
   framework, or TypeScript-only for Angular (where the ecosystem assumes TS)?
6. **Versioning** — does multi-framework ship as 2.0.0, or as 1.x while the
   V1 contract holds? The compatibility strategy (§19) makes 1.x defensible;
   the scope change may make 2.0.0 more honest.
7. **Astro's `modes/` layering** — does it become two starter features, or stay
   a template-internal detail behind the Astro adapter? Affects §14.1 only.

---

## 24. Example: React + Vite + TypeScript + Tailwind + MUI

```
Manifest                          Resolved
────────────────────────          ─────────────────────────────────
framework    react                capabilities  react-runtime, jsx,
buildTool    vite                                vite-plugins, typescript,
language     ts                                  postcss, css-in-js, spa-routing
styling      tailwind             architecture  react-standard
uiLibrary    mui                  extensions    .ts / .tsx
router       react-router         minNode       20.19 (max across adapters)
features     [seo, starter:full]

Contributions
─────────────────────────────────────────────────────────────────
react:framework   files: main.tsx, App.tsx, index.html
                  deps:  react, react-dom
vite:build        files: vite.config.ts (config model owner)
                  deps:  vite, @vitejs/plugin-react
ts:language       files: tsconfig.json
                  deps:  typescript
tailwind:styling  role:  styles.global → src/styles/index.css
                  config: vite plugins += tailwindcss()
                  deps:  tailwindcss, @tailwindcss/vite
mui:ui            entry: provider ThemeProvider
                  deps:  @mui/material, @emotion/react, @emotion/styled
seo:feature       files: src/config/site.config.ts, src/lib/seo.ts
starter:full      files: src/pages/Home.tsx

Conflicts: none. package.json composed from 6 contributors.
```

No template named `react-vite-tailwind-mui` exists, and none ever will. That is
the whole point.

---

## 25. Summary of decisions

| Decision                                                            | Status   |
| ------------------------------------------------------------------- | -------- |
| Evolve `plan()` rather than rewrite it                              | DECIDED  |
| Keep frozen manifest, pure plan, atomic apply, post-step allow-list | DECIDED  |
| Three tiers: manifest → resolved → plan                             | PROPOSED |
| Capabilities + constraints, not a compatibility matrix              | DECIDED  |
| Roles, not paths, as the adapter↔architecture interface             | PROPOSED |
| Build tool as a dimension with fixed/choice cardinality             | PROPOSED |
| Config as data models, no AST                                       | DECIDED  |
| Duplicate `create` and version conflicts are hard errors            | PROPOSED |
| Presets are partial manifests in the existing precedence chain      | DECIDED  |
| Golden snapshots of 1.0.2 before any V2 code                        | DECIDED  |
| Astro byte-identical reproduction is the gate on step 2             | DECIDED  |
| Mode becomes a feature; `TEMPLATE_MODES` leaves core types          | PROPOSED |
| Greenfield-only, so no user code is ever parsed                     | DECIDED  |

---

## 26. Implementation status

### Stage 0 — golden snapshot safety net (landed, `00c3590`)

Four snapshots pin what 1.0.2 generates. See
[golden-snapshots.md](./golden-snapshots.md).

### Stage 1 — core domain types (landed, `bd6e84d`)

The vocabulary described above now exists in `src/domain/`. Types and a few
pure helpers only: no adapters, no compatibility engine, no planner changes.
Nothing in the V1 generation path imports it, and the shipped bundle is
byte-identical — a test asserts both.

```
src/domain/
├── dimensions.ts     the independent axes and their id unions
├── capabilities.ts   Capability, Constraint, describeConstraint
├── roles.ts          FileRole, ArchitectureDefinition, resolveRole
├── contributions.ts  dependency / file / script / config contributions
├── manifest.ts       ProjectManifest + a read-only bridge from V1
├── resolved.ts       ResolvedProject
├── adapters.ts       the declare → resolve → contribute contract
└── index.ts          the internal entry point
```

**The pipeline**

```
ProjectManifest     what the user asked for       no versions, no paths
      ↓
ResolvedProject     what that means technically   capabilities, roles, extensions
      ↓
Contribution[]      what each adapter wants       owned, ordered, reasoned
      ↓
GenerationPlan      what will be written          V1, unchanged
      ↓
FileOperation[]     the safety boundary           V1, unchanged
```

**The adapter contract**

| Phase      | Sees              | Returns             | Why it is separate                                                                                                                       |
| ---------- | ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| declare    | nothing           | static metadata     | The compatibility engine filters on it before anything is selected, and cannot run an adapter to find out whether the adapter is usable. |
| resolve    | `ProjectManifest` | `AdapterResolution` | Resolution produces the resolved project, so it cannot also consume it.                                                                  |
| contribute | `ResolvedProject` | `Contribution`      | What an adapter writes depends on decisions other adapters made — the language's extension, the architecture's paths.                    |

An adapter is handed plain data and returns plain data. The contract gives it
no filesystem, no logger, no registry and no other adapter, so it cannot write
a file, run a command, call `apply()`, or read another adapter's state. A test
additionally asserts no module under `src/domain/` imports `node:fs`,
`node:child_process`, `node:process` or `node:os`.

**The dimensions, and why each is its own axis**

| Dimension    | Answers                        | Kept separate from                                                       |
| ------------ | ------------------------------ | ------------------------------------------------------------------------ |
| Framework    | What renders the site          | The build tool — React implies no bundler, Astro is both                 |
| Build tool   | What compiles it               | The framework — otherwise `react` and `react-vite` become two frameworks |
| Language     | TypeScript or JavaScript       | Everything — it only decides extensions and type config                  |
| Styling      | How CSS is authored            | The UI library — Tailwind and MUI can both be selected                   |
| UI library   | Prebuilt components            | Styling — Bootstrap and Chakra are not interchangeable                   |
| Architecture | Folder and layering convention | The framework — a framework may offer more than one                      |
| Feature      | SEO, sitemap, starter pages    | The framework — intent is shared, implementation is not                  |

V1's `mode` is not a dimension. It was an Astro template detail that reached
`src/types.ts`; in this vocabulary it is `starter:coming-soon` /
`starter:full`, two feature ids.

### Stage 2 — Astro adapter (landed, `3366f62`)

The first concrete adapter. Its purpose is not to add capability — ClientKit
already generates Astro projects — but to prove the contract can describe that
generation without changing it.

```
src/adapters/
├── astro.ts      the framework adapter: declaration, architecture, layers, deps
├── tailwind.ts   the styling adapter: declaration and dependencies
├── registry.ts   astro + tailwind only; anything else fails by name
└── bridge.ts     ProjectContext → manifest → resolve → contribute → plan()
```

**The gate.** The three plan snapshots from Stage 0 are asserted a second time
against output produced through the adapter path, pointing at the same files,
plus direct `V2 === V1` equality assertions. They pass without regeneration.

**What is real.** Capability declarations, the architecture's role map, template
layer selection driven by the adapter, and dependency and script contributions
with their true versions — checked against the template's own `_package.json`,
so the two cannot drift.

**What is deliberately deferred.** Only template layers are consumed by the
bridge; `package.json` is still composed from `_package.json` as in V1, because
building it from contributions is the composition work a later stage covers and
would change the one thing this stage must not change. Tailwind's _files_ also
still live in the shared Astro template — its declaration and dependencies are
separate, its content is not, and separating it needs the config-merging layer.

**What has not changed.** The CLI runs the V1 path exactly as before. Nothing
under `src/context/`, `src/generate/` or `src/templates/` imports the adapters,
and a test fails if that changes. No framework selection exists: there is no
`--framework` flag and no prompt.

`plan()` gained one optional `layers` parameter, defaulting to the `base` +
`modes/<mode>` list it previously computed inline. That is the only production
change, and the golden snapshots cover it.

**Still not supported:** React, Next.js, Angular, Bootstrap, MUI, Chakra. Their
ids exist in the dimension vocabulary; no adapter implements them, and the
registry says so.

### Stage 3 — compatibility engine and selection (landed, `ec0a47b`)

The decision layer. Given a manifest, it determines which adapters are
eligible, which choices survive, why a rejected one was rejected, and folds
what the selected adapters resolved into a `ResolvedProject`.

```
src/domain/compatibility.ts   pure: declarations → verdict + diagnostics
src/domain/resolution.ts      pure: AdapterResolution[] → merged facts
src/adapters/selection.ts     orchestration: registry → check → resolve
```

**Capability-based, not a matrix.** Every judgement comes from `provides` and
`requires`; nothing inspects an adapter id. `evaluateCombination` takes the
union of everything provided and checks each declaration against it, so a chain
(A provides X; B requires X and provides Y; C requires Y) resolves with no
ordering, and the verdict is identical whichever order the declarations arrive
in. Adding a framework needs no edit to any existing declaration — asserted by
a test that introduces a hypothetical Vue-like framework and checks an existing
consumer's declaration is untouched and both verdicts stay correct.

**One subtlety worth knowing.** A `conflicts` constraint ignores the
declaring adapter's own contribution. Bootstrap will both _provide_
`css-framework` and refuse to sit beside another one; without self-exclusion it
would reject every combination, including the one where it is the only CSS
framework present.

**Fixed vs choice.** `filterCandidates` returns the options for a dimension
that survive what is already selected, judging the whole combination rather
than the candidate alone — so an option that would break an earlier choice is
rejected too. This is what a prompt would render; no prompt exists yet.

**Known id ≠ implemented adapter.** `react`, `mui`, `bootstrap` and the rest
exist in the dimension vocabulary. The registry implements `astro` and
`tailwind` and nothing else, exposes `hasFramework`/`implementedFrameworks` so
callers can tell the difference, and refuses anything else by name. There is no
fallback: a manifest asking for React gets an error, never an Astro project.

**Resolution order** is `framework → build-tool → language → styling →
ui-library → architecture → feature`, chosen and recorded here because the
architecture did not prescribe one. It runs most-determining first. Compatibility
does **not** depend on it — that is order-independent by construction — so the
order matters only for stable reporting and for the day a later adapter needs an
earlier one's resolved facts.

**Merging is explicit about disagreement.** Two adapters resolving different
values for the same source extension is a `CliError` naming both adapters and
both values, not last-one-wins. Node floors are compared numerically, so
`>=9.0.0` cannot outrank `>=22.12.0`.

**Unchanged.** The CLI still runs the V1 path; the four golden baselines are
byte-identical; no prompts, no new flags, no template changes. Still no React,
Next.js, Angular, Bootstrap, MUI or Chakra — the engine is proven against
hypothetical declarations in `test/compatibility.test.ts`, which is the only
honest way to show it generalises while one framework is implemented.

### Stage 4 — React + Vite adapter (landed)

The second framework, and the first evidence that the architecture generalises
rather than merely describing Astro.

```
src/adapters/react.ts        framework: capabilities, architecture, layers, deps
src/adapters/vite.ts         build tool: vite-plugins, build scripts
src/adapters/starters.ts     shared feature → starter-layer mapping
src/domain/build-config.ts   composes a build config from several adapters
templates/react-vite/        base + coming-soon + full layers
```

**Supported as of this stage:** `astro + tailwind` and `react + vite +
typescript + tailwind` (UI library `none`, router `none`). Next.js, Angular,
Bootstrap, MUI and Chakra remain names in the vocabulary with no adapter behind
them; the registry refuses them by name. (Stage 5 adds Bootstrap; see the matrix
there for the current answer.)

**React and Vite are separate dimensions.** There is no `react-vite` adapter and
no such framework id. React declares `react-runtime`, `jsx`, `typescript` and
`spa-routing`; Vite declares `vite-plugins`. React deliberately does _not_
declare `vite-plugins` — claiming it would let React plus a bundler with no
plugin system satisfy Tailwind's requirement, and the engine could not catch it.

**Tailwind was not modified to understand React.** Its declaration still names
no framework. The requirement it has had since Stage 2 — `vite-plugins` — is
satisfied by Astro in one stack and by Vite in the other, with the same bytes.

**`vite.config.ts` is composed, not templated.** It is deliberately absent from
the React template. React contributes `@vitejs/plugin-react` and Tailwind
contributes `@tailwindcss/vite` as `ConfigContribution` entries — the type that
had existed unused since Stage 1 — and `build-config.ts` emits the file. A
template carrying both plugins would have hardcoded Tailwind into React and
broken the first time someone picked React without it.

Composition is driven by the `config.build` file role. Astro's architecture maps
no such role, so nothing is composed for it and its template keeps registering
the Tailwind plugin itself — the legacy arrangement Stage 2 recorded, unchanged.

**Two contract additions**, both on `FrameworkAdapter`:

| Field               | Why                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownsBuildTool`     | Astro ships its build tooling and must not be asked for a build-tool adapter; React must. Without it, selection cannot tell "needs none" from "adapter missing", and silently skipping would generate a project with no way to build it. |
| `templateManifest?` | React's template has no `template.json` on disk, because one would list it in the V1 `--list-templates` and announce a framework with no public selection path. Astro omits the field and keeps using the disk registry.                 |

**Role asymmetry is real and load-bearing.** React maps `app.entry` and
`config.build`, which Astro leaves unmapped; Astro maps `config.framework` and
`page.notFound`, which React leaves unmapped. Absorbing that is the whole
purpose of addressing files by role.

**Unchanged.** The V1 golden checksum is identical, the CLI has no new flags or
prompts, and `templates/astro-tailwind/` was not touched.

**Known limitations, stated rather than implied:**

- No router, so no client-side 404 page. Astro has one; React does not.
- Metadata is set at runtime by a hook. A crawler that does not execute
  JavaScript sees only `index.html`. That is an SPA property, not a defect to
  paper over with a library.
- `package.json` is still composed from template layers; dependency and script
  contributions are declared and asserted but not yet used to build the file.
- Plugin order in the composed config is by owner — stable, but an adapter that
  genuinely needed to run before another has no way to say so yet.

### Stage 5 — Bootstrap styling adapter (landed)

The second styling system, and the first evidence that the _styling_ dimension
is a dimension rather than a decoration on the framework.

```
src/adapters/bootstrap.ts              styling: css-framework, deps, stylesheet
templates/styling/tailwind/            the stylesheets the adapters contribute
templates/styling/bootstrap/
src/adapters/bridge.ts                 contributedFiles, applyMerges, assertRequiredRoles
```

**Support matrix — every cell below was executed, not inferred:**

| Framework | Build tool | Styling     | Result                                                      |
| --------- | ---------- | ----------- | ----------------------------------------------------------- |
| `astro`   | own        | `tailwind`  | supported                                                   |
| `astro`   | own        | `bootstrap` | refused, by capability (see below)                          |
| `astro`   | own        | `none`      | supported, but see the limitation on Astro's template below |
| `react`   | `vite`     | `tailwind`  | supported; installs, typechecks and builds                  |
| `react`   | `vite`     | `bootstrap` | supported; installs, typechecks and builds                  |
| `react`   | `vite`     | `none`      | refused, with a sentence saying to pick a styling system    |

`nextjs`, `angular`, `mui`, `chakra`, `scss` and `css` remain names in the
vocabulary with no adapter behind them; the registry refuses them by name.

**The finding this stage was really about.** React's template hardcoded
Tailwind — `@import 'tailwindcss'` in `base/src/styles/index.css`, and Tailwind's
two packages in `base/_package.json`. Adding a Bootstrap adapter next to that
would have produced a project with both. So the fix is not Bootstrap; the fix is
that the framework template stopped owning the stylesheet.

**Three mechanisms, none of which name a styling system:**

| Mechanism             | What it does                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composed-stylesheet` | A capability of the _architecture_: the global stylesheet is composed rather than templated. React provides it; Astro does not.                                     |
| `templateOwnedRoles`  | Roles a framework's template already fills, so a contribution to them is skipped rather than colliding. Astro lists `styles.global`; React lists nothing.           |
| `applyMerges`         | Lets an adapter merge JSON into a file it does not own, so each styling system adds its own packages to `package.json` instead of the template listing one of them. |

**Astro + Bootstrap is refused without any rule naming both.** Bootstrap
requires `composed-stylesheet`; Astro's architecture does not provide it,
because its template ships the stylesheet. Neither adapter mentions the other,
and neither was modified to produce the refusal.

**Bootstrap requires only what is technically true.** Not `react-runtime` — it
is CSS and has no opinion about the runtime. Not `vite-plugins` — unlike
Tailwind v4 it ships plain CSS and needs no build plugin, so requiring one would
exclude bundlers that could serve it perfectly well. A test proves a
hypothetical non-React framework that composes its stylesheet works with this
adapter unmodified.

**The markup names roles; the stylesheet decides what they look like.** The
React template's components ask for `site-header`, `page-title`,
`button-primary` — 28 semantic class names, no utility classes and no mention of
either styling system. Each adapter's stylesheet implements the same 28.
Bootstrap's maps them onto Bootstrap's own custom properties, so the values stay
Bootstrap's rather than being reimplemented in its name.

**Evidence, from real generated projects rather than unit tests.** Both stacks
were generated through the real `apply()` path and then installed and built:

| Stack               | `npm install` | `typecheck` | `build` | emitted CSS |
| ------------------- | ------------- | ----------- | ------- | ----------- |
| `react + bootstrap` | 25 packages   | clean       | clean   | 233.01 kB   |
| `react + tailwind`  | 40 packages   | clean       | clean   | 7.52 kB     |

"Build passes" is not evidence that Bootstrap is _in_ the project, so the
discriminator was measured: with Bootstrap still in `package.json` and still in
`node_modules` but the stylesheet's `@import` removed, the build still succeeds
and emits **2.95 kB**. 233.01 kB against 2.95 kB is the difference between
integrated and merely installed. The emitted bundle carries 2,608 `--bs-`
custom properties against the 2,555 in `bootstrap.min.css`, and all 28 semantic
classes resolve in both stacks.

The two generated trees are **identical in 17 of 21 files**. The four that
differ are `package.json`, `src/styles/index.css`, `vite.config.ts` and the
provenance file. Every `.tsx` file is byte-for-byte the same.

**A hole this stage opened, and closed.** Moving the stylesheet out of the
template is what makes the styling systems interchangeable — and it means that
with `styling: 'none'` nothing contributes `src/styles/index.css` while
`src/main.tsx` still imports it. That plan looked healthy: 20 files, no error,
installs and typechecks cleanly, then fails on first build. `requiredRoles` on
`ArchitectureDefinition` marks roles where "empty" is a broken project rather
than a valid outcome, and the finished plan is checked against them by resolved
path — so a template-owned file satisfies the requirement exactly as a
contributed one does. It fails before anything is written.

**Unchanged.** The three V1 golden files, the V1 generation engine and
`templates/astro-tailwind/` are byte-identical to the previous commit. The CLI
has no new flags or prompts.

Vite's adapter was not touched at all. React's was - but not to accommodate
Bootstrap: it gained `composed-stylesheet`, an empty `templateOwnedRoles` and
`requiredRoles`, which are three ways of saying it stopped owning the global
stylesheet. Neither adapter names a styling system in its code - Tailwind
appears in both only in comments explaining why the capability boundaries fall
where they do - and a test strips the comments and asserts exactly that.
The distinction matters, because "we added Bootstrap support to React" is
exactly the outcome this design exists to avoid.

**Known limitations, stated rather than implied:**

- **The styling dimension is real for React and inert for Astro.** Astro's
  template owns its stylesheet, its Tailwind dependency and its Vite plugin, so
  Tailwind's adapter contributes nothing to it — `astro + tailwind` and
  `astro + none` produce byte-identical output, and asking Astro for `none`
  quietly gives you Tailwind. Making that honest means Astro's template
  surrendering stylesheet ownership, which is a migration, not an adapter.
- Bootstrap ships as a full 233 kB stylesheet with no tree-shaking. That is
  Bootstrap's distribution model, not a defect in the adapter, but it is a real
  difference from Tailwind's 7.5 kB and a developer should know before choosing.
- Bootstrap's JavaScript components (dropdowns, modals, offcanvas) are not
  wired up. Only the CSS is imported, which is all the generated markup needs.
- The 28-class contract is enforced by a test comparing the two stylesheets, not
  by a type. A third styling system would be checked the same way.

### Stage 6 — contribution-driven package and configuration composition (landed)

The stage that made the contributions true. No new framework, no new styling
system, no new CLI surface — the adapters that already existed stopped merely
_describing_ the generated project and started _producing_ it.

```
src/domain/package-composition.ts   dependencies + scripts -> package.json
src/domain/build-config.ts          config contributions -> vite.config.ts
src/adapters/bridge.ts              composePackageOperation, assertRequiredRoles
scripts/lib/generated-package.mjs   operator scripts read the generated output
templates/*/base/_package.json      identity only; no packages, no scripts
```

**The limitation this closes.** Stage 5 recorded it plainly: `package.json` was
still produced from template `_package.json` layers while the dependency and
script contributions were declared, asserted, and otherwise unused. Two sources
of truth kept in step by a test. The failure mode was quiet — an adapter says it
needs `bootstrap@5.3.8`, the template ships `5.3.7`, every check passes, and the
generated project contains neither what was declared nor an error.

**File ownership and data ownership are different things.** This is the
distinction the stage had to make explicit, and conflating it is what kept the
template authoritative for five stages. The framework's template owns the
_file_ and everything in it that describes the project itself — `name`,
`version`, `private`, `license`, `type`, `engines`, `keywords`. The adapters own
the _data_ in three blocks inside it. React contributes `react`, Vite
contributes `vite`, Tailwind contributes `tailwindcss`, Bootstrap contributes
`bootstrap`, and no adapter ever writes the file.

**Composition rules, all generic.** Nothing in the composer knows what any
adapter is:

| Case                                               | Behaviour                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| two adapters ask for `foo@1.0.0`                   | one entry; both contributors retained                                                                      |
| two adapters ask for `foo@1.0.0` and `2.0.0`       | error naming package, both versions, both owners, both reasons                                             |
| same version, one `prod` and one `dev`             | error — one ships in the bundle and one does not, and no rule in the model says which contributor is wrong |
| two adapters contribute an identical script        | one entry; both contributors retained                                                                      |
| one script name, two commands                      | error naming both commands and both owners                                                                 |
| two adapters import one binding, same module       | de-duplicated                                                                                              |
| two adapters import one binding, different modules | error — emitting both would produce a module with clashing imports                                         |

**Ordering is defined, not incidental.** Dependencies sort by name; scripts sort
by a declared `order`, then owner, then name. Both use UTF-16 code-unit
comparison rather than `localeCompare`, which consults collation data that
differs between a full-ICU and a small-ICU Node — generated bytes must not move
between a laptop and CI.

`order` was added to `ScriptContribution` because there was a demonstrated
requirement: React resolves before Vite, so contribution order alone would emit
`typecheck` ahead of `dev`, and the emitted order is part of the compatibility
contract. The alternative — a table of script names ranked inside the composer —
would put ecosystem knowledge in the one component that must not have any.

Configuration deliberately did **not** get the same field. Stage 5 noted that an
adapter with a real ordering requirement cannot express one; no configuration
has that requirement, the two plugins in play are order-independent, and
machinery for a requirement nobody has cannot be validated. When a real case
appears, `order` is the shape to copy.

**Provenance survives the JSON.** `package.json` cannot record why `bootstrap`
is present, so `AdapterPlanResult.composedPackage` carries every dependency and
script with each contributing adapter and the reason it gave. `origin` was
deliberately left alone: `applyMerges` appends an owner because a different
adapter really is injecting data into someone else's file, whereas composition
is simply how the manifest has always been built.

**The CLI now runs the adapter path.** `plan()` composes template layers and
knows nothing about adapters, so it would emit a manifest with no dependencies
at all. `commands/create.ts` calls `planWithAdapters` instead. A test that
previously asserted "the bridge is not imported by the V1 generation path" —
written to fail if that changed _without a decision_ — is kept and narrowed to
allow exactly that one file.

**Verification, on real projects rather than unit tests:**

| Stack                         | install      | typecheck | build | result                   |
| ----------------------------- | ------------ | --------- | ----- | ------------------------ |
| `astro + tailwind` (real CLI) | 291 packages | 0 errors  | clean | 2 pages, sitemap emitted |
| `react + vite + tailwind`     | 40 packages  | clean     | clean | 7.52 kB CSS              |
| `react + vite + bootstrap`    | 25 packages  | clean     | clean | 233.01 kB CSS            |
| `react + vite + none`         | —            | —         | —     | refused before writing   |

Both React builds produced **byte-identical asset hashes to Stage 5**, which is
the clearest statement available that composing the manifest changed nothing
about the application.

**`styling: none` cannot produce a broken project.** React's architecture
declares `requiredRoles: ['styles.global']` because `src/main.tsx` imports the
global stylesheet, and the finished plan is checked against that by resolved
path — so a template-owned file satisfies it exactly as a contributed one does.
The guard was verified by removing it: the plan then succeeds with 20
operations, the project installs cleanly, `tsc --noEmit` passes, and
`vite build` fails on the missing import. Planning refuses instead, and writes
nothing.

**Every new abstraction, against the seven questions:**

| Question                              | `composePackage`                                                          | `ScriptContribution.order`                                            |
| ------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| What Stage 5 problem required it?     | package.json was template-authoritative; contributions were unused        | contribution order emitted React's `typecheck` before `dev`           |
| Why not the existing model?           | `applyMerges` merges into a file; it cannot own three blocks of it        | no field expressed position, and sorting by name changes the contract |
| Why generic?                          | groups, de-duplicates, sorts, rejects; names no adapter                   | the engine sorts numbers and never reads a script name                |
| Works for Astro?                      | yes — byte-identical output, from a framework that owns its build tooling | yes — reproduces its five scripts exactly                             |
| Works for React?                      | yes — across two styling systems                                          | yes                                                                   |
| Helps future frameworks?              | a new framework contributes packages and gets a manifest for free         | a new framework declares its own convention                           |
| Removable without losing correctness? | no — the template no longer carries the data                              | no — removing it changes the emitted script order                     |

**Unchanged.** The four V1 golden files are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), the CLI
has no new flags or prompts, `--template astro-tailwind` and `--mode` behave
exactly as before, and the CLI still has zero runtime dependencies. Six V2 React
and Bootstrap goldens changed by 21 lines total: dependency keys moved into
sorted position, and `package.json` lost the `+ styling:tailwind` origin suffix
now that Tailwind contributes a dependency rather than merging into someone's
file. The package sets, versions and top-level keys are identical, which a test
asserts.

**Known limitations, stated rather than implied:**

- **Astro's styling dimension is still inert.** Unchanged from Stage 5: Astro's
  template owns its stylesheet and registers the Tailwind plugin itself, so
  `astro + none` and `astro + tailwind` produce identical output. Package
  composition did not fix this, because it is the _file_ layer that is still
  template-owned there.
- `peerDependencies` and `optionalDependencies` are supported by the composer
  and emitted in a fixed position, but no adapter contributes either yet, so
  only the unit tests exercise them.
- Configuration composition covers one shape — a Vite config module that imports
  plugins and calls `defineConfig`. That is deliberate: it is not an AST engine,
  and a second build tool with a different shape gets its own emitter. What
  generalises is the mechanism of contributing entries, not the emitter.
- The operator scripts read pins from the Astro golden snapshot rather than from
  the adapters directly, because they are plain `.mjs` and cannot import
  TypeScript. The golden is the generated output and the suite keeps it current,
  but it is one level of indirection.
- `styling: none` is refused for React rather than producing an unstyled
  project. Making it genuinely optional needs the entry point to be composed
  rather than templated, which is a larger change than this stage warranted.

### Stage 7 — Material UI and the UI-library dimension (landed)

The first UI-library adapter, and the stage that proves a component library is
independent of the styling system rather than a variety of one.

```
src/adapters/mui.ts                        ui-library: deps + provider + wrapper
src/domain/app-composition.ts              app.root composed from contributions
templates/ui-library/mui/AppProviders.tsx  the component MUI contributes
src/adapters/registry.ts                   the ui-library dimension is selectable
```

**Support matrix — every row marked supported was generated, installed and
built; the rest say only what was actually checked:**

| Framework | Build tool | Styling     | UI library | Result                                                               |
| --------- | ---------- | ----------- | ---------- | -------------------------------------------------------------------- |
| `astro`   | own        | `tailwind`  | `none`     | supported                                                            |
| `react`   | `vite`     | `tailwind`  | `none`     | supported                                                            |
| `react`   | `vite`     | `bootstrap` | `none`     | supported                                                            |
| `react`   | `vite`     | `tailwind`  | `mui`      | **supported** — new in this stage                                    |
| `react`   | `vite`     | `bootstrap` | `mui`      | capability-compatible, **not** generated or built, **not** supported |
| `react`   | `vite`     | `none`      | `mui`      | refused before writing — the architecture still needs a stylesheet   |
| `astro`   | own        | `tailwind`  | `mui`      | refused — Astro provides no `react-runtime`                          |

`chakra`, `angular-material`, `nextjs`, `angular` and `scss` remain names in the
vocabulary with no adapter behind them; the registry refuses them by name.
Compatibility is not support: a combination is documented as supported only
once it has been generated and built.

**A UI library is not a styling system.** Tailwind and Bootstrap answer "what do
the classes on my markup mean". MUI answers "where do my components come from".
A project can want both, and this one does — the generated starter keeps its
styling system's global stylesheet and its semantic classes untouched, and adds
MUI above them. Collapsing the two would make `tailwind + mui` unrepresentable.

Emotion is the case that is easiest to get wrong, so it is worth stating
plainly: `@emotion/react` and `@emotion/styled` are MUI's styling **engine** and
are owned by MUI as an implementation detail. They are not the project's styling
**choice**, which remains whatever the styling adapter contributed. A dependency
and a dimension are different things, and a test asserts the distinction.

**MUI requires one capability and names nothing.** `react-runtime`, and that is
the whole of it:

- Not the build tool. MUI ships compiled JavaScript and needs no bundler plugin,
  so requiring `vite-plugins` would have quietly excluded every other bundler.
- Not a styling system. MUI works with any of them or none, and requiring one
  would encode a product combination as a technical constraint.

The proof is hypothetical rather than circumstantial. A test builds a framework
that does not exist, gives it `react-runtime`, and MUI works with it unmodified
and unaware; a second framework without that capability is refused, naming the
capability. A hypothetical build tool that is not Vite is accepted, and a second
hypothetical component library works against React with no change to React. The
compatibility engine was not modified in this stage.

**The application root became composed.** This is the one new mechanism, and it
existed because every alternative was worse. MUI has to mount a theme, a style
engine and a CSS reset above the whole tree, and the root component belonged to
React's template — so MUI could either overwrite a file another adapter owns, or
ship a component nothing renders, which installs a dependency and proves
nothing.

Two roles carry it. `app.root` is where the composed module goes; `app.providers`
is an optional slot above it. The architecture supplies both **paths**, so MUI
never learns that React keeps components in `src/components/ui`, and each
adapter names only its own export. React contributes `{ importName: 'HomePage' }`
and MUI contributes `{ importName: 'AppProviders' }`; the composer resolves the
import specifiers and emits the file.

With no UI library selected the emitted root is byte-for-byte the file React's
template used to ship. That is why adding a whole dimension moved six existing
golden lines and no generated bytes.

**What MUI contributes, and what it does not:**

| Contribution       | MUI                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| dependencies       | `@mui/material@9.4.0`, `@emotion/react@11.14.0`, `@emotion/styled@11.14.1`, all `prod`                                        |
| files              | one, the provider component, addressed by role                                                                                |
| config             | one entry, asking to wrap the application root                                                                                |
| scripts            | none — Vite owns `dev`, `build` and `preview`, and MUI needs no others                                                        |
| configuration file | none — MUI is configured by editing the provider it contributes; a `mui.config.ts` would be an abstraction with nothing in it |
| template layer     | none, so it cannot override anyone's files                                                                                    |

**Evidence, from a real generated project rather than unit tests.** Generated
through `planManifest` → `apply()`, then installed and built:

| Stack                           | install      | typecheck | build | JS        | CSS       |
| ------------------------------- | ------------ | --------- | ----- | --------- | --------- |
| `react + vite + tailwind + mui` | 115 packages | clean     | clean | 313.53 kB | 7.52 kB   |
| `react + vite + tailwind`       | 40 packages  | clean     | clean | 222.85 kB | 7.52 kB   |
| `react + vite + bootstrap`      | 25 packages  | clean     | clean | 222.85 kB | 233.01 kB |
| `astro + tailwind` (real CLI)   | 291 packages | 0 errors  | clean | —         | —         |

"Installed" is not "used", so the discriminators were measured rather than
assumed. The emitted JS bundle contains `MuiBox` and `MuiCssBaseline` — the two
MUI components the provider renders — plus the Emotion runtime, and grows by
90.7 kB against the same project without MUI. The emitted CSS is byte-identical
to the non-MUI Tailwind build, same content hash: MUI did not displace Tailwind
or add a stylesheet of its own.

The built project was then loaded in a headless browser. The live DOM carries
`MuiBox-root` on a real element, Emotion injected two `<style data-emotion>`
tags, and the Tailwind classes `app-shell`, `site-header` and `page-title` are
present on the same page with the heading rendering at 40px. No console errors.
That is both systems demonstrably active in one document, which is the claim the
stage rests on.

**Unchanged.** The four V1 golden files are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), the CLI has
no new flags or prompts, and both existing React stacks build to the same asset
hashes as before this stage. Six V2 React and Bootstrap goldens changed by one
line each: `src/App.tsx` now reads `origin composed from framework:react` instead
of `origin base`. Its content did not change.

**Known limitations, stated rather than implied:**

- **`react + vite + bootstrap + mui` is compatible but unsupported.** Nothing in
  the capability model objects to it and a test records that, but it has not
  been generated or built, so it is not documented as supported. Bootstrap's CSS
  and MUI's baseline would both style the same elements, and that interaction is
  unexamined.
- **The demonstration is a provider, not a showcase.** MUI's visible surface in
  the generated project is `ThemeProvider`, `CssBaseline` and one `Box`. A demo
  button would have been more obvious, but injecting decorative UI into a client
  starter is the wrong default, and a component nothing renders would prove
  nothing. The browser check above is what establishes that MUI really renders.
- **The MUI theme is not wired to the site config.** Reading the accent colour
  out of `src/config/site.config.ts` would couple MUI to React's config shape,
  which is exactly the coupling this stage exists to avoid. The theme is a
  starting point to edit.
- **`app.providers` has one filler.** The slot is generic and a second UI library
  would need no change to React, but only MUI exercises it today, so the claim
  rests on the hypothetical-adapter tests rather than on a second real one.
- **No public CLI selection.** `uiLibrary` is reachable through the V2 planning
  API and its tests, not through `npm create clientkit@latest`. The prompt and
  flag surface belongs to a later stage.
- Astro's styling dimension remains inert, unchanged from Stage 5.

### Stage 8 — the feature dimension, through `not-found` (landed)

The first feature adapter, and the stage that had to settle what a feature
actually owns.

```
src/adapters/not-found.ts     feature: the capability requirement + the guarantee
src/domain/adapters.ts        AdapterResolution.requiredRoles
src/domain/resolution.ts      the union every selected adapter contributes to
src/adapters/registry.ts      the feature dimension is selectable
```

**Support matrix — supported means generated, installed and built:**

| Stack                                 | Result                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `astro + tailwind`                    | supported                                                                  |
| `astro + tailwind + not-found`        | **supported** — new in this stage                                          |
| `react + vite + tailwind`             | supported                                                                  |
| `react + vite + bootstrap`            | supported                                                                  |
| `react + vite + tailwind + mui`       | supported                                                                  |
| `react + vite + tailwind + not-found` | **refused** — React provides `spa-routing`, not `file-based-routing`       |
| hypothetical framework + `not-found`  | compatible when it provides `file-based-routing`; refused when it does not |

`seo`, `sitemap`, `structured-data`, `social-metadata` and `robots` remain names
in the feature vocabulary with no adapter behind them; the registry refuses them
by name and never falls back to `not-found`.

**What a feature owns.** The question this stage existed to answer, and the
answer is narrower than it first looks.

A not-found _page_ is framework-specific by nature. Astro's is `.astro` markup
importing an Astro layout; a React one would be a component behind a router; a
Next one would be a file with a reserved name. Putting any of those inside the
feature would mean shipping one implementation per framework — `Astro404`,
`React404`, `Next404` — which is exactly the matrix the design exists to
prevent. So the feature does not own the markup.

It owns the two things that genuinely are framework-independent:

| Owns                | Meaning                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- |
| the **requirement** | a not-found page must be _routable_, which is a capability, not a file              |
| the **guarantee**   | selecting it means the finished project has one, checked before anything is written |

The framework supplies the implementation, the architecture decides where it
lives, and the feature decides whether the project may claim to have one at all.
`not-found` names no framework and no framework names `not-found`.

**Why `file-based-routing`.** It is the smallest correct requirement. A framework
that routes by file serves `/anything-at-all` from its not-found page with no
router package and no configuration — which is what makes the page real rather
than a component nothing renders.

`spa-routing` deliberately does not satisfy it. React with Vite provides
`spa-routing` and ships no router, so an unmatched path returns the host's own
404 and never reaches the application. Generating a `404.tsx` there would produce
a file that looks like a feature and is dead code, so the combination is refused
and the error names the missing capability:

```
That combination will not work.
  - Not-found page requires file-based-routing
    (an unmatched path has to reach the page for it to be a 404
     rather than an unreachable file)
```

Adding a router to make that pass is a later stage's work, not a way around the
boundary.

**One new generic mechanism.** `AdapterResolution.requiredRoles`. Since Stage 6
an _architecture_ could say the project cannot ship without a role — React needs
a global stylesheet — but only an architecture could. A feature needs the same
sentence, so the field moved onto the resolution every adapter already returns,
and `ResolvedProject.requiredRoles` is now the union of the architecture's and
every selected adapter's. One check enforces both.

It is deliberately not a promise to _supply_ the role. Whoever fills it satisfies
it, because the check runs against the finished plan by resolved path — which is
what lets the same feature work for Astro, whose template ships the page, and
for a framework that would contribute one instead.

**What it contributes:**

| Contribution   | `not-found`                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| dependencies   | none — a feature that quietly installed a package to render a 404 would be the worst version of this abstraction |
| scripts        | none                                                                                                             |
| configuration  | none                                                                                                             |
| files          | none — see ownership above                                                                                       |
| template layer | none, so it cannot override anyone's files                                                                       |
| required roles | `page.notFound`, requested as a semantic role                                                                    |

**Evidence, from a real generated project.** Generated through the production
path — manifest → selection → compatibility → resolution → contributions →
composition → plan → apply:

| Step                            | Result                                              |
| ------------------------------- | --------------------------------------------------- |
| `npm install`                   | 291 packages                                        |
| `astro check`                   | 15 files, 0 errors, 0 warnings, 0 hints             |
| `npm run build`                 | 2 pages, `dist/404.html` emitted, sitemap generated |
| `GET /`                         | 200                                                 |
| `GET /nonexistent-stage8-route` | **404**, 3,993 bytes                                |

The served body is byte-identical to `dist/404.html` and carries the real
heading, the 404 element, the return-home action and the `noindex` robots meta.
That is a genuine 404 status on an unmatched route, not a file that happens to
exist. No unresolved `{{tokens}}` and no machine paths anywhere in the output.

Astro, React + Tailwind, React + Bootstrap and React + Tailwind + MUI were all
regenerated and rebuilt, every one to the same asset hashes as before this stage.

**Unchanged.** The four V1 golden files are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`),
`templates/astro-tailwind/` was not touched, no existing V2 golden moved, and the
CLI has no new flags or prompts.

**Known limitations, stated rather than implied:**

- **For Astro the feature is a gate and a guarantee, not the file's author.**
  Astro's template ships `src/pages/404.astro` and keeps ownership of it, so
  selecting `not-found` changes the adapter set and the required-role set
  without changing a byte. Two reasons, both real: framework-specific `.astro`
  markup cannot live in a framework-agnostic feature without recreating the
  per-framework matrix, and moving it would change the V1 golden that is a
  standing compatibility contract. `page.notFound` is listed in Astro's
  `templateOwnedRoles`, the same legacy arrangement Stage 2 recorded for the
  stylesheet. When the Astro template is generalised, this shortens.
  The pair of composition goldens records the difference the selection makes.
- **A feature that contributes files is untested by a real adapter.** The
  mechanism exists and the guarantee is enforced, but every current path has the
  framework supplying the page. The first feature that genuinely contributes
  source will exercise the other half.
- **No public CLI selection.** `features` is reachable through the V2 planning
  API and its tests, not through `npm create clientkit@latest`. The prompt and
  flag surface belongs to a later stage.
- **`starter:*` is not an adapter.** It selects a template layer — the
  arrangement V1's `mode` became — and selection skips it rather than asking the
  registry for an adapter that was never one.
- Astro's styling dimension remains inert, unchanged from Stage 5.

### Stage 9 — SEO, and metadata as composable data (landed)

The second feature adapter, and a deliberately different shape from the first.

```
src/domain/seo.ts        the contract: what a head must say, as data
src/adapters/seo.ts      feature: the capability requirement + the contract
src/domain/capabilities  document-metadata
scripts/smoke.mjs        the contract asserted against a freshly built project
test/fixtures/           the head a real astro build emitted, for both URL states
```

**Support matrix — supported means generated, installed, checked and built:**

| Stack                                      | Result                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `astro + tailwind`                         | supported (metadata is baseline framework behaviour)                      |
| `astro + tailwind + seo` (with a site URL) | **supported** — new in this stage                                         |
| `astro + tailwind + seo` (no site URL)     | **supported** — canonical and `og:url` omitted, nothing fabricated        |
| `astro + tailwind + seo + not-found`       | supported; the two features compose                                       |
| `react + vite + tailwind + seo`            | **refused** — React provides no `document-metadata`                       |
| hypothetical framework + `seo`             | compatible when it provides `document-metadata`; refused when it does not |

`sitemap`, `structured-data`, `social-metadata` and `robots` remain names in the
feature vocabulary with no adapter behind them, and never fall back to `seo`.

**A feature is not one shape.** Stage 8's `not-found` owns a requirement and a
guarantee and contributes no data, because a 404 page is markup and markup is
framework-specific. SEO is the other case: what a head must _say_ is entirely
framework-independent, so this feature owns that as data and leaves each
framework to render it. Both are features; neither pattern is the rule, and a
test asserts the two differ.

| Layer            | Owns                                                              |
| ---------------- | ----------------------------------------------------------------- |
| the feature      | the contract — title, description, robots, canonical, OG, Twitter |
| the framework    | the head, and how tags reach it before the response is sent       |
| the architecture | which file is the layout                                          |

**Why `document-metadata`.** The smallest correct requirement, and the timing is
the whole content of the claim: metadata must reach the document head _before
the response is sent_. An SPA that sets `document.title` after hydration has a
head and does not have this — a crawler reading the initial response sees the
entry HTML and nothing the feature contributed. React's own template says as
much in a comment, so it does not claim the capability and the combination is
refused:

```
That combination will not work.
  - Search-engine metadata requires document-metadata
    (the contract has to reach the document head before the response is
     sent, or crawlers never see it)
```

Server rendering is the fix. A runtime metadata package would produce tags that
look right in a browser and are invisible to the machines the feature exists
for, so none was added.

**Nothing is invented.** The rule the project runs on applies here with
particular force, because SEO is where a generator is most tempted to guess.
With no configured site URL there is no canonical and no `og:url` — not
`localhost`, not `example.com`, not an empty attribute, which would resolve to
the current page and be worse than no tag. Anything that is not an absolute
http(s) URL is treated as absent rather than repaired. A golden snapshots the
URL-less contract so the omission is a recorded contract rather than a
coincidence.

**The contract is checked against reality.** This is what stops a generic model
and a framework implementation drifting apart while both look correct alone:

| Check                                    | Where                                        |
| ---------------------------------------- | -------------------------------------------- |
| contract ↔ emitted HTML, both URL states | `test/fixtures/`, captured from a real build |
| contract ↔ freshly built project         | `scripts/smoke.mjs`, every CI run            |

All thirteen fields agree in both states: title, description, robots, canonical,
`og:type`, `og:title`, `og:site_name`, `og:description`, `og:url`, `og:locale`,
`twitter:card`, `twitter:title`, `twitter:description`.

**Evidence, from real generated projects.** Both scenarios generated through the
production path, then installed, checked and built:

| Scenario           | install      | astro check | build   | canonical               |
| ------------------ | ------------ | ----------- | ------- | ----------------------- |
| with a site URL    | 291 packages | 0 errors    | 2 pages | `https://acme.example/` |
| without a site URL | 291 packages | 0 errors    | 2 pages | absent, as is `og:url`  |

**What it contributes:**

| Contribution        | `seo`                                                               |
| ------------------- | ------------------------------------------------------------------- |
| dependencies        | none — an SEO package would be weight for tags a framework can emit |
| scripts             | none                                                                |
| configuration files | none — no `seo.config.ts`; the values come from site metadata       |
| files               | none                                                                |
| config entries      | one, the contract, addressed at `app.layout` / `metadata`           |
| required roles      | `app.layout`, requested as a semantic role                          |

The contract travels as an ordinary `ConfigContribution` — it already carries a
target role, a slot, a value, an owner and a reason, which is exactly what this
needs, so no `SeoContribution` type was invented.

**Conflicts are refused, not resolved.** Two adapters describing the head
identically de-duplicate and both are kept as provenance; two describing it
_differently_ is an error naming both owners and both titles, because there is
one `<title>` and picking a winner silently is how a site ends up with metadata
nobody chose. The check runs during planning even though nothing consumes the
claims yet — a conflict nobody notices is the failure it exists to prevent.

**Unchanged.** The four V1 golden files are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`),
`templates/astro-tailwind/` was not touched, no existing V2 golden moved, and
the three React stacks rebuild to the same asset hashes as before. Astro's
existing structured data and sitemap behaviour are untouched and were verified
still present in a real build.

**Known limitations, stated rather than implied:**

- **For Astro, metadata is baseline behaviour and the feature is a contract over
  it.** The template's `Seo.astro` already emits every tag, reading the same
  site metadata, and it keeps ownership — selecting `seo` changes the adapter
  set, the required-role set and the recorded contract without changing a byte
  of output. Converting baseline behaviour into optional behaviour would mean
  rewriting the template and changing V1 output, which is a standing
  compatibility contract. The value the feature adds today is the framework
  -independent contract and the drift check against it.
- **No adapter consumes the metadata claim yet.** The slot, the conflict rule
  and the provenance are real and tested, but Astro satisfies the contract from
  its own template rather than by reading the claim. The first framework whose
  head is composed rather than templated will exercise the other half.
- **The contract covers one page.** `resolveSeoContract` takes a page title, a
  path and a noindex flag, but only the site-level contract is contributed;
  per-page metadata composition is not part of this stage.
- **`og:image` and the Twitter card type are not modelled.** They are choices a
  developer makes after generation, in `site.config.ts`, and modelling them
  would duplicate configuration the project already owns.
- **Structured data and sitemap are untouched and out of scope**, as is
  per-framework SEO for React. A correct rejection was preferred to fake
  support.
- **No public CLI selection.** `features` remains V2 manifest territory.

### Stage 10 — structured data, as a sibling of SEO (landed)

The third feature adapter, and the one that had to stay out of the second.

```
src/domain/structured-data.ts   the Organization contract, as data
src/adapters/structured-data.ts feature: the capability requirement + the contract
src/domain/claims.ts            the slot collector both metadata features share
test/fixtures/jsonld-*.html     the JSON-LD a real astro build emitted
```

**Support matrix — supported means generated, installed, checked and built:**

| Stack                                              | Result                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `astro + tailwind + structured-data`               | **supported** — new in this stage                                         |
| `astro + tailwind + seo + structured-data`         | **supported** — one JSON-LD block, one metadata set, no duplication       |
| `astro + tailwind + structured-data` (no site URL) | **supported** — `url` omitted entirely                                    |
| `astro + tailwind + seo`                           | supported, unchanged                                                      |
| `astro + tailwind + not-found`                     | supported, unchanged                                                      |
| `react + vite + tailwind + structured-data`        | **refused** — React provides no `document-metadata`                       |
| hypothetical framework + `structured-data`         | compatible when it provides `document-metadata`; refused when it does not |

`sitemap`, `social-metadata` and `robots` remain names in the feature vocabulary
with no adapter behind them, and never fall back to `structured-data`.

**Why this is not part of SEO.** They answer different questions. SEO describes
_this page_ to a crawler — title, canonical, social preview. Structured data
describes _the organisation_ to a knowledge graph. Either is useful without the
other, and folding this into the SEO adapter would have made SEO the place every
future search-related feature goes: the monolith the feature dimension exists to
prevent.

They are siblings in the strict sense — same capability, same semantic role,
**different slots**, and neither names the other:

| Feature           | Role         | Slot              |
| ----------------- | ------------ | ----------------- |
| `seo`             | `app.layout` | `metadata`        |
| `structured-data` | `app.layout` | `structured-data` |

That is what lets either be selected alone and both together. Tests cover all
three selections.

**Why `document-metadata` and not a new capability.** A JSON-LD block is a
`<script>` in the document head that has to be in the response a crawler reads
— which is exactly what `document-metadata` already means. Minting a second
capability for the same requirement would fragment the vocabulary and force
every future framework to declare two things where one is true. So the
capability set did not grow this stage.

**One shared mechanism, because there were now two callers.** Stage 9's
`collectMetadata` refused two adapters describing the head differently. Stage 10
needed the identical rule at a different slot, so the rule moved into
`collectClaims` rather than being written twice — and gained a better
diagnostic on the way. A conflict now names the **field** that differs and both
values, since "two adapters disagree" without saying about what is a diagnostic
nobody can act on:

```
Two adapters describe "structured-data" differently.
  They disagree about "name":
    feature:alpha
      name: "Other Co"
    feature:structured-data
      name: "Acme Ltd"
```

An absent field prints `(absent)` rather than `undefined`, which is a real
distinction in structured data.

**Nothing is invented.** Structured data is consumed automatically by machines,
so a fabricated field here is worse than a missing one — it is a claim about a
real organisation that nobody made:

| Value           | Behaviour                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| no site URL     | no `url` property at all — not `localhost`, not a guess, not `null`                                                                        |
| no description  | no `description` property                                                                                                                  |
| logo            | never claimed: the project configures an image as a _path_, and making it the absolute URL a crawler needs would mean inventing the domain |
| social profiles | never claimed: the manifest carries none                                                                                                   |

The contract models `@context`, `@type`, `name`, `url?` and `description?` —
exactly what the manifest can truthfully supply. Email, telephone, location and
`sameAs` are things a developer fills in after generation, so the generated
project's own template emits them when configured, which is the right place for
values the generator never sees.

**Serialisation is deterministic.** A fixed field order rather than insertion
order, because insertion order is a property of how an object happened to be
built and golden snapshots compare bytes. JSON-LD attaches no meaning to key
order; determinism does. Absent fields are absent rather than `null` — a null is
a claim that the value is empty, which is not the same as making no claim.

**The contract is checked against reality, parsed rather than matched.**

| Check                                            | Where                               |
| ------------------------------------------------ | ----------------------------------- |
| `JSON.parse` of the emitted block succeeds       | fixtures captured from a real build |
| parsed object equals the contract                | both URL states                     |
| emitted bytes equal the contract's serialisation | both URL states                     |
| same agreement on a freshly built project        | `scripts/smoke.mjs`, every CI run   |

Structured data that looks right in a plan and does not parse in a browser is
worse than none — a consumer discards the whole block — so the test parses.

**Evidence, from real generated projects.** All three scenarios generated
through the production path, then installed, checked and built:

| Scenario                       | install | astro check | build   | JSON-LD                              |
| ------------------------------ | ------- | ----------- | ------- | ------------------------------------ |
| `structured-data`              | 291 pkg | 0 errors    | 2 pages | 1 block, parses, equals the contract |
| `seo + structured-data`        | 291 pkg | 0 errors    | 2 pages | 1 block — no duplication             |
| `structured-data`, no site URL | 291 pkg | 0 errors    | 2 pages | 1 block, `url` absent                |

**What it contributes:** no dependencies, no scripts, no configuration file, no
source files, no template layer. One `ConfigContribution` carrying the
Organization object, and one required role.

**Unchanged.** The four V1 golden files are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`),
`templates/` was not touched, no existing V2 golden moved, and the three React
stacks rebuild to the same asset hashes. Astro's existing JSON-LD, SEO metadata,
404 page and sitemap were all verified still present in a real build through the
shipped CLI.

**Known limitations, stated rather than implied:**

- **For Astro, structured data is baseline behaviour and the feature is a
  contract over it.** The template's `StructuredData.astro` already emits the
  block, reading the same site metadata plus fields a developer configures
  later, and it keeps ownership. Selecting the feature changes the adapter set,
  the required-role set and the recorded claim without changing a byte of
  output. Making it removable would mean rewriting the template and changing V1
  output, which is a standing compatibility contract.
- **No adapter consumes the claim yet.** The slot, the conflict rule and the
  provenance are real and tested, but Astro satisfies the contract from its own
  template rather than by reading the claim.
- **`Organization` is the only schema type.** No `Article`, `Product`,
  `BreadcrumbList`, `WebSite` or anything else, and no generic schema builder.
  A second type is a later stage's decision, not an abstraction to prepare for.
- **The contract covers the site, not the page.** A per-page structured-data
  claim would need the same page-level plumbing SEO also lacks.
- **`logo` and `sameAs` are outside the contract** for the reasons above; the
  framework template still emits `sameAs`, `email`, `telephone` and `location`
  when the developer configures them.
- **No public CLI selection.** `features` remains V2 manifest territory, and no
  release accompanies this stage.

### Stage 11 — accessibility, as a contract rather than a claim (landed)

The fourth feature adapter, and the one where saying less is the point.

```
src/domain/accessibility.ts      the contract: what the shell guarantees, and what it does not
src/adapters/accessibility.ts    feature: the capability requirement + the contract
test/fixtures/a11y-skeleton-*    the structure a real astro build emitted, with and without nav
```

**Support matrix — supported means generated, installed, checked, built and
validated in a browser:**

| Stack                                                                  | Result                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------- |
| `astro + tailwind + accessibility`                                     | **supported** — new in this stage                   |
| `astro + tailwind + seo + accessibility`                               | **supported**                                       |
| `astro + tailwind + structured-data + accessibility`                   | **supported**                                       |
| `astro + tailwind + seo + structured-data + not-found + accessibility` | **supported** — all four features compose           |
| `astro + tailwind` (no accessibility)                                  | supported, unchanged                                |
| `react + vite + tailwind + accessibility`                              | **refused** — React provides no `document-metadata` |
| hypothetical framework + `accessibility`                               | compatible when it provides `document-metadata`     |

**This is not an auditor.** No axe, no Lighthouse, no crawler, no report, no
score. Those measure a finished site. This states what the generator guarantees
about the shell it produces, so the line between "handled" and "yours" is
written down rather than assumed — and a team that knows which eight properties
are covered keeps checking the rest, where a team that believes the project is
"accessible" stops.

**The contract has two halves, and the second is the important one.**

| Guaranteed on every generated page | Meaning                                        |
| ---------------------------------- | ---------------------------------------------- |
| `document-language`                | `<html lang>` carries the configured tag       |
| `document-title`                   | exactly one non-empty `<title>`                |
| `main-landmark`                    | exactly one `<main>`, with an id               |
| `skip-link`                        | first focusable element, targeting that id     |
| `contentinfo-landmark`             | a `<footer>`                                   |
| `primary-heading`                  | exactly one `<h1>`                             |
| `navigation-landmark-when-present` | navigation, where rendered, is a named `<nav>` |
| `scalable-viewport`                | the viewport meta does not block zoom          |

| Explicitly **not** guaranteed | Why                                                               |
| ----------------------------- | ----------------------------------------------------------------- |
| `wcag-conformance`            | conformance is a property of a finished site, not a shell         |
| `colour-contrast`             | the accent colour is the developer's, and so is every pairing     |
| `authored-content`            | headings, labels and copy written after generation                |
| `image-alternative-text`      | the generator ships no content images and invents no descriptions |
| `third-party-components`      | anything added later                                              |
| `authored-interaction`        | keyboard behaviour of elements the generator did not create       |

The navigation guarantee is phrased conditionally because it has to be: the
coming-soon page renders no navigation at all, so "every page has a nav
landmark" would be false. What is unconditionally true is that navigation, when
present, is a `<nav>` with an accessible name — and both cases are captured as
fixtures so the conditional half stays exercised.

**Why `document-metadata`.** Every guarantee is a property of the document
_before any script runs_: the language on `<html>`, one `<main>`, one `<h1>`, a
skip link ahead of the content. That is the property the capability already
names, so it is reused rather than duplicated under an accessibility-flavoured
name — the vocabulary did not grow. A single-page application assembles its
shell after hydration, so none of these are in the response, and the current
React stack is refused with the capability and the reason named.

**Nothing is invented — and here that is a refusal, not an omission.** A
malformed or missing language tag makes generation _fail_ rather than fall back
to a plausible `en`. Substituting one would put a language on the document that
nobody chose, and assistive technology would announce the page in it as fact:

```
"Nope" is not a language tag the generated document can declare.
  The accessibility baseline guarantees the document states its language,
  and it will not guess one. Set a BCP-47 tag such as "en" or "en-GB".
```

No accessible name, label, alt text or ARIA description is ever generated. The
contract describes landmarks by the elements that provide them — `main`, `nav`,
`footer` — rather than by `role`, because native semantics need no help and a
redundant role can only go wrong.

**Verified against real HTML, in a real browser.** The eight guarantees were
asserted on three built projects, loaded with the puppeteer the repository
already uses for its audits — the live DOM, not a regular expression over
source:

| Scenario                   | install | check    | build   | contract assertions |
| -------------------------- | ------- | -------- | ------- | ------------------- |
| accessibility, coming-soon | 291 pkg | 0 errors | 2 pages | 16/16, 0 nav        |
| accessibility, full        | 291 pkg | 0 errors | 2 pages | 16/16, 1 named nav  |
| all four features, full    | 291 pkg | 0 errors | 2 pages | 16/16, 1 named nav  |

No console errors, no unresolved tokens, no empty ARIA attribute, no fabricated
accessible name. `scripts/smoke.mjs` re-checks the same guarantees on three
freshly built projects every CI run.

**What it contributes:** no dependencies, no scripts, no configuration, no
files, no template layer. One `ConfigContribution` on the `app.layout` role at
its own `accessibility` slot — the fourth feature to describe that surface, and
the third to do so without any of them knowing the others exist:

| Feature           | Slot on `app.layout` |
| ----------------- | -------------------- |
| `seo`             | `metadata`           |
| `structured-data` | `structured-data`    |
| `accessibility`   | `accessibility`      |

**Unchanged.** The four V1 golden files are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`),
`templates/` was not touched, no existing golden moved, the three React stacks
rebuild to the same asset hashes, and the default `npm create clientkit@latest`
behaviour is exactly what it was.

**Known limitations, stated rather than implied:**

- **The Astro template already satisfied the baseline, so the feature adds a
  contract rather than markup.** That is the intended outcome: the shell had a
  skip link, one `main`, one `h1` and a language before this stage; what it did
  not have was a written, testable statement of which of those are promises.
  Selecting the feature changes the adapter set, the required-role set and the
  recorded claim without changing a byte of output.
- **No adapter consumes the claim yet.** The slot, the conflict rule and the
  provenance are real and tested; Astro satisfies the contract from its own
  template rather than by reading the claim.
- **The guarantees are structural, not perceptual.** Contrast, focus visibility
  against a custom accent, motion preferences and reading order of authored
  content are all outside the contract, and no amount of generator work would
  let it claim them honestly.
- **The language rule is duplicated, deliberately.** The configuration resolver
  validates locales in a module that reads the filesystem; the domain contract
  must stay pure, so it carries its own copy of the same rule with a test
  asserting the two agree on a shared set of inputs.
- **One framework.** The contract is framework-independent and proven so against
  a hypothetical adapter, but Astro is the only implemented framework that
  provides the capability today.
- **No public CLI selection**, and no release: the version stays 1.0.2.

### Stage 12 — routing as a dimension, and the first router (landed)

The seventh dimension to become real, and the stage whose most important
outcome is a combination that stays **unsupported**.

```
src/adapters/react-router.ts             router: the dependency + the composition root
templates/router/react-router/AppRouter  the component it contributes
                                         (composed instead, from Stage 13)
src/domain/app-composition.ts            wrappers now nest, deterministically
src/domain/capabilities.ts               client-side-routing
src/domain/roles.ts                      app.router
```

**Support matrix — supported means generated, installed, typechecked, built and
loaded in a browser:**

| Stack                                                                     | Result                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `react + vite + tailwind`                                                 | supported, **unchanged** — the router is opt-in             |
| `react + vite + tailwind + react-router`                                  | **supported** — new in this stage                           |
| `react + vite + tailwind + mui + react-router`                            | **supported** — both wrap the app (order corrected in 13)   |
| `react + vite + bootstrap + react-router`                                 | compatible; golden-covered, not build-tested                |
| `react + vite + react-router + not-found`                                 | **refused, deliberately** — see below                       |
| `react + vite + react-router + seo` / `structured-data` / `accessibility` | refused, unchanged — React still has no `document-metadata` |
| `astro + react-router`                                                    | refused — Astro provides no `react-runtime`                 |
| `angular-router`                                                          | refused by name; no fallback to `react-router`              |

**A router is not file-based routing.** This is the whole point of the stage,
and the reason one combination is deliberately left unsupported. Three
capabilities, three different statements:

| Capability            | Means                                                                                                                 | Provided by                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `file-based-routing`  | the framework turns files into routes, and an unmatched address reaches a real not-found **document** in the response | Astro                           |
| `spa-routing`         | navigation happens without a full page load — a shape of application                                                  | React, with or without a router |
| `client-side-routing` | routes are declared and matched, in the browser, **after** the response was sent                                      | React Router                    |

A catch-all route renders a component; it does not produce an HTTP 404. So
`react + vite + react-router + not-found` stays refused, and the refusal still
names `file-based-routing` rather than the router:

```
That combination will not work.
  - Not-found page requires file-based-routing
    (an unmatched path has to reach the page for it to be a 404
     rather than an unreachable file)
```

Making that pass would have produced a project whose "404 page" answers **200**
to every crawler and uptime check that asked. A more impressive feature matrix
is not worth a generated project that lies about its status codes. The generated
`AppRouter.tsx` carries the same caveat, so the developer reading the file gets
it too.

**The router is opt-in, and that is enforced.** React declares no routing
capability of its own and does not select the adapter; `react + vite + tailwind`
generates exactly the 21 files and the same asset hashes it did before this
stage. `file-based` selects no adapter either — it is what a framework that
routes by file already does, recorded on the manifest so the choice is visible
rather than implied.

**One generic change: wrappers now nest.** Through Stage 11 the application-root
provider slot admitted exactly one occupant, because only one adapter had ever
wanted to wrap the tree. A router and a UI library both legitimately do, and
refusing that would have made them mutually exclusive for no reason beyond the
shape of a function. So the slot became a list, ordered by a declared position
and then by owner:

```tsx
export function App() {
  return (
    <AppRouter>
      <AppProviders>
        <HomePage />
      </AppProviders>
    </AppRouter>
  );
}
```

The router took order 0 and sat outermost, so route context was available to
everything inside it. **Stage 13 reversed that**, and the reason is in that
stage's section: the page a router wrapper is handed becomes one route's
element, so a wrapper inside the router wraps that route and no other. Two
adapters claiming the same **binding name** is still a
conflict — two components cannot share one import — and the page slot still
admits exactly one, because a root renders one thing.

Each wrapper names the **role** holding its own file rather than a path, so
neither learns where the architecture keeps components, including its own. The
router's file lives at a role of its own, `app.router`, rather than sharing the
provider role: sharing it would have made them collide for no reason but that
both happen to be wrappers.

**The generated root stops lying.** The default doc comment says the scaffold
ships without a router, which becomes false the moment one is selected, so a
wrapper that changes what the root _is_ can replace that paragraph. Only the
router does, which is why every existing React golden is byte-identical.

**What it contributes:** `react-router-dom@7.18.3` as an exact prod pin through
the Stage 6 package composer, one file by role, one root-wrapper entry. No
scripts, no configuration, no Vite plugin, no template edit. A test asserts no
template mentions a router and that no other adapter smuggles one in.

**Evidence, from real generated projects.** Both generated through the
production path, then installed, typechecked, built and loaded in the puppeteer
the repository already uses:

| Scenario             | install      | typecheck | build     | browser          |
| -------------------- | ------------ | --------- | --------- | ---------------- |
| `react-router`       | 44 packages  | clean     | 262.16 kB | 9/9 assertions   |
| `react-router + mui` | 119 packages | clean     | 352.32 kB | 10/10 assertions |

`GET /` returns 200 and renders the home route. A `pushState` to an unmatched
address changes the location **without a reload** and the home route stops
rendering — which is what proves the router is genuinely mounted rather than
merely installed. The emitted bundle contains React Router's own code, the MUI
provider still renders inside the router, and there are no console errors and no
unresolved tokens.

**Unchanged.** The four V1 golden files are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`),
`templates/` was not touched, no existing golden moved, and React + Tailwind,
React + Bootstrap and React + MUI all rebuild to the same asset hashes as
before.

**Known limitations, stated rather than implied:**

- **No real 404 for React, and none is faked.** A client-side catch-all is a
  component, not a status code. Giving React a genuine not-found response needs
  either host configuration or server rendering — a future architectural
  concern, not something this adapter can honestly provide.
- **One route.** The generated router declares `/` and nothing else. A scaffold
  shipping `/about` and `/contact` would hand you pages to delete, each a guess
  about a site nobody has designed.
- **No data routers, loaders, guards or lazy routes.** The adapter mounts a
  router; everything beyond that is the developer's.
- **`client-side-routing` has no consumer yet.** It is declared because it is
  true and because it is the capability a future client-side fallback feature
  would require — the same footing as MUI's `css-in-js`. _Stage 13 is that
  consumer._
- **`react + vite + bootstrap + react-router` is golden-covered but not
  build-tested**, so it is listed as compatible rather than supported.
- **No public CLI selection**, and no release: the version stays 1.0.2.

### Stage 13 — the client-side route fallback, and the line it refuses to cross (landed)

The second feature to require a routing capability, and the first to require the
_other_ one. Its entire reason to exist as a separate adapter is a distinction
that is easy to argue away and expensive to get wrong:

```
not-found            !=  client-route-fallback
file-based-routing   !=  client-side-routing
```

```
src/domain/client-route-fallback.ts        the contract, including what it will not claim
src/adapters/client-route-fallback.ts      the feature: one route, one view, nothing else
templates/feature/client-route-fallback/   the view it contributes
src/domain/route-composition.ts            the route table, composed rather than templated
src/adapters/react.ts                      page.notFound, mapped as a slot
```

**Support matrix — supported means generated, installed, typechecked, built and
loaded in a browser:**

| Stack                                                                  | Result                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `react + vite + tailwind + react-router + client-route-fallback`       | **supported** — new in this stage                      |
| `react + vite + bootstrap + react-router + client-route-fallback`      | **supported** — same view, the other stylesheet        |
| `react + vite + tailwind + mui + react-router + client-route-fallback` | **supported** — and it found a real defect; see below  |
| `react + vite + tailwind + react-router`                               | supported, **unchanged** — the feature is opt-in       |
| `react + vite + react-router + not-found`                              | **refused, deliberately** — unchanged from Stage 12    |
| `react + vite + react-router + not-found + client-route-fallback`      | **refused** — selecting the fallback satisfies nothing |
| `react + vite + tailwind + client-route-fallback` (no router)          | refused — React alone has `spa-routing`, not routing   |
| `astro + client-route-fallback`                                        | refused — Astro provides no `client-side-routing`      |
| `astro + not-found`                                                    | supported, unchanged                                   |
| a hypothetical non-React router providing `client-side-routing`        | accepted, unmodified and unnamed                       |

**The distinction, stated once.** One is a property of the **response**; the
other is a property of the **render**.

| Feature                 | Requires              | What it produces                                      | Status seen by a crawler |
| ----------------------- | --------------------- | ----------------------------------------------------- | ------------------------ |
| `not-found`             | `file-based-routing`  | a real not-found **document**, before JavaScript runs | 404                      |
| `client-route-fallback` | `client-side-routing` | a **rendered view**, after the response was sent      | whatever the host sent   |

That is why mapping `page.notFound` for React does **not** make `not-found`
reachable there. Compatibility is decided by capability, never by whether a role
happens to be mapped, and the refusal still names the missing capability:

```
That combination will not work.
  - Not-found page requires file-based-routing
    (an unmatched path has to reach the page for it to be a 404
     rather than an unreachable file)

  The selected stack provides: client-side-routing, composed-stylesheet, ...
```

Note the last line. The stack _does_ provide `client-side-routing` — and it
still is not enough, because the two capabilities do not imply each other in
either direction. A test asserts both directions.

**The HTTP status is out of scope, in the contract rather than only in prose.**
`CLIENT_ROUTE_FALLBACK_OUT_OF_SCOPE` names `http-404-status`,
`server-rendered-not-found`, `crawler-visible-not-found`, `host-configuration`
and `fallback-page-metadata`. A test scans every guarantee for the words
`404`, `status`, `http`, `server` and `crawler` and fails if one appears. A
future edit deciding the feature "is really a 404 after all" has to delete a
test that says otherwise in so many words.

The generated files say it too, twice, so the caveat survives deleting either
one: `AppRouter.tsx` explains that a catch-all renders "after the server has
already answered, so the response itself is still whatever your host sent —
usually a 200 for `index.html`", and `NotFoundPage.tsx` names the failure mode,
_soft 404_, and says where a real one has to come from.

**Why the view sets no document title.** `useDocumentMeta('Page not found', …)`
is right there and was deliberately not called. Announcing "Page not found" in
the title of a document the host returned as `200` is precisely the signal that
makes a soft 404 worse rather than better. The generated file explains this and
points at the hook, so a developer whose host does return a real status can add
it in one line.

**One generic change: the route table is composed.** Stage 12 shipped
`AppRouter.tsx` as a template with one route written into it. A second adapter
needed to add a catch-all, and there were only two ways to do that — edit
another owner's file with string replacement, or make the file composed. So the
route table joined `package.json`, `vite.config.ts` and `App.tsx`:

```ts
{ target: 'app.router', at: 'routes',
  value: { path: '/', element: { kind: 'children' }, order: 0 } }          // the router

{ target: 'app.router', at: 'routes',
  value: { path: '*',
           element: { kind: 'component', importName: 'NotFoundPage', role: 'page.notFound' },
           order: 10_000 } }                                              // the feature
```

Routes carry an explicit `order` and are sorted by it, because here the ordering
is semantic rather than cosmetic: a catch-all placed above `/` swallows the home
page, and "it worked because the objects happened to iterate that way" is not a
property anyone can rely on. The order lives in the contract, not in the
adapter, so a test can assert it. Two adapters claiming the same path
identically de-duplicate; claiming it differently is a hard failure, because one
address cannot render two things and picking a winner silently is how a project
ends up serving a page nobody chose.

Each component route names the **role** holding its component, never a path, so
the feature never learns that React keeps the view at
`src/pages/NotFoundPage.tsx`. The refactor landed with **zero golden churn**:
composed `AppRouter.tsx` was byte-identical to the deleted template, down to the
`origin` line still reading `router:react-router`.

**A real defect this stage found, in Stage 12's work.** Stage 12 put the router
outermost, reasoning that route context should be available to every wrapper
inside it. With only one route, nothing exposed the cost. With two:

```tsx
<AppRouter>
  {' '}
  {/* Routes: "/" -> children, "*" -> NotFoundPage */}
  <AppProviders>
    {' '}
    {/* ...is the element of the "/" route, and only that one */}
    <HomePage />
  </AppProviders>
</AppRouter>
```

The page a router wrapper is handed **becomes one route's element**. So
`AppProviders` wrapped the home route and nothing else, and the fallback
rendered with no theme, no CSS baseline and no styling engine. Nothing failed;
the browser check for MUI's emotion style tags returned `0` on the fallback and
`2` on the home page, which is the only reason it was noticed at all.

The fix is to make the router the **innermost** wrapper (order 0 → 100), so
everything that wraps "the application" genuinely wraps all of it:

```tsx
<AppProviders>
  <AppRouter>
    <HomePage />
  </AppRouter>
</AppProviders>
```

A hypothetical benefit traded for a demonstrated defect. A wrapper that really
does need route context can still declare an order above the router's. One
golden moved — `react-router-mui.txt` — and a structural test now asserts the
router closes last, so no future reorder can silently re-break it.

**What it contributes:** one route and one view. **No packages, no scripts, no
build configuration** — a feature that quietly installed something would be the
worst version of this abstraction, and a test asserts the generated
`package.json` and `vite.config.ts` are byte-identical with the feature selected
and without it. The guarantee is enforced the Stage 8 way: `requiredRoles:
['page.notFound']`, checked against the finished plan by resolved path before
anything is written.

**The view names nothing it does not need.** It uses the semantic classes both
stylesheets already define (`hero`, `eyebrow`, `page-title`, `lead`,
`button-primary`), so it is byte-identical under Tailwind, Bootstrap and MUI — a
test asserts that, and another asserts every class it uses is defined in **both**
stylesheets. It names no router package either: the link home is a plain
`<a href="/">` rather than the router's `Link`, so swapping the router needs no
edit here. The cost is a real page load on the way back to a page that exists,
which is the cheaper half of that trade.

**`page.notFound` is now mapped for React, as a slot rather than a promise.**
Mapping a role says where a file would go, not that one exists — the same
footing as `app.providers` and `app.router`. Nothing fills it unless both a
client-side router and this feature are selected, so it is excluded from the
"every mapped role produces a file" test alongside the other two, and it is the
feature's own suite that asserts the filled case.

**Evidence, from real generated projects.** All four generated through the
production path, then installed, typechecked, built and loaded in a browser:

| Scenario           | install      | typecheck | build (js) | `/` | `/stage13-does-not-exist` |
| ------------------ | ------------ | --------- | ---------- | --- | ------------------------- |
| `+ tailwind`       | 44 packages  | clean     | 262.75 kB  | 200 | **200**, fallback renders |
| `+ bootstrap`      | 29 packages  | clean     | 262.75 kB  | 200 | **200**, fallback renders |
| `+ mui`            | 119 packages | clean     | 352.90 kB  | 200 | **200**, fallback renders |
| router, no feature | 44 packages  | clean     | 262.17 kB  | 200 | **200**, empty document   |

**The status column is the point of the table.** `GET /stage13-does-not-exist`
returns **`200 OK`**, and the body it returns is `index.html` byte-for-byte —
`diff` against `GET /` reports no difference, and the served HTML contains no
occurrence of "not found" anywhere. The fallback is produced entirely by
JavaScript afterwards. That is exactly what the feature claims and exactly what
it refuses to call a 404.

The rest of the browser evidence: one `<h1>` reading "This page does not exist",
inside the single `<main>` landmark the shared layout provides; the link home is
a real `<a href="/">` with `tabIndex 0`; no `aria-label`, no `alt`, no injected
`<meta>` or `<link rel=canonical>`; the document title stays the site name; no
console errors. A `pushState` between `/` and an unmatched address swaps the
rendered view **without a document load** — the same `window` sentinel survives
both — which is what proves the matching is happening in the browser. Clicking
"Back to home" _does_ perform a real navigation, by design, and lands on the
home route.

The last row is the honest contrast: with the router but without the feature, an
unmatched address still answers `200` and renders an **empty document** —
`#root` has zero children. That emptiness is what the feature is for.

**Mutation testing: 36 designed, 36 caught.** Every capability swap (the
fallback requiring `file-based-routing`, `spa-routing`; `not-found` relaxed to
`client-side-routing`; React Router claiming `file-based-routing`; React
claiming `client-side-routing`), every contract edit (dropping
`http-404-status` from the out-of-scope list, adding it to the guarantees),
every ordering defect (`CATCH_ALL_ORDER` inverted, the collector's sort removed,
the router's wrapper order reverted), every contribution defect (no route, no
view, no required role, a smuggled package), every emitter defect (the
disclosure line removed, `hasCatchAll` forced false, the conflict throw
disabled), and every view defect (no link home, a `div` with `onClick` instead
of an anchor, a second `<h1>`, a fabricated `aria-label`, a Tailwind-only class,
the `200` disclosure removed, the layout escaped).

Three of those deserve naming because the stage brief asked for them
specifically:

- **rewriting a test to claim an HTTP 404** — `expect(contract.guarantees).toContain('http-404-status')`
  and `expect(view).toMatch(/status.*404/i)` both **fail against honest code**.
  The tests cannot be edited into claiming a 404 and still pass, because there
  is no 404 anywhere to find.
- **suppressing the distinction** — rewriting the suite to assert the two
  features want the same capability fails for the same reason.
- **redundancy** — four mutations delete an assertion _and_ introduce the defect
  it guarded, to check something else still notices. All four were caught by
  other tests.

**Unchanged.** The four V1 golden files are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), every
Astro golden is untouched, the V1 clean-room smoke test passes all 305
assertions, the CLI still has no new flags and zero runtime dependencies, and
the version stays 1.0.2. Twelve React goldens moved, by exactly two changes: the
MUI nesting correction above, and a README rewrite. The generated README said
"**No router.** One page." and "**No 404 page.**" in projects that now have
both — a generated file describing itself incorrectly, which this codebase
treats as worse than no comment. It now states what is true either way,
including that a client-side catch-all does not change the status.

**Known limitations, stated rather than implied:**

- **This is not an HTTP 404, and nothing here pretends otherwise.** The response
  is the host's. A real not-found needs host configuration or server rendering;
  neither is generated.
- **A crawler that does not execute JavaScript sees the entry HTML**, which says
  nothing about the page being missing. Relying on this for SEO is the soft-404
  failure mode, and the generated files name it.
- **No metadata for the fallback** — no title, no canonical, no robots
  directive. The generator has no truthful source for what a page nobody asked
  for should say about itself.
- **The link home is a real navigation**, not a client-side transition. That is
  the cost of a view that names no router package.
- **One fallback implementation, for React.** The contract is
  framework-independent and the requirement is a capability, so a second
  client-side router works unmodified; a second _framework_ would need its own
  view, the same way `not-found` leaves markup to whoever knows the framework.
- **No public CLI selection**, and no release: the version stays 1.0.2.

### Stage 22 — Next.js, and what a third framework costs (landed)

Astro proved the contract could describe an existing product. React proved it
generalised to a second framework with a separate build tool. Both were the easy
direction: Astro and React overlap in almost nothing, so "no shared assumptions"
was cheap to hold.

Next is the hard direction, because it is _nearly_ React:

```
provides react-runtime      ->  every React-only library is a candidate
routes its own files        ->  a client router has nothing to own
root is a server component  ->  nothing can wrap it in context
ships its own CSS + head    ->  no adapter composes either
```

Three of those four are refusals, and every one comes out of the capability set.
The compatibility engine contains no mention of Next; the Next adapter mentions
no other adapter; the starter contract learned nothing.

```
src/adapters/nextjs.ts        the adapter, the architecture, the template identity
templates/nextjs/base/        app/layout.tsx, styles/globals.css, lib/, next.config.ts
templates/nextjs/modes/*/     the same two starters every framework answers to
```

**What it cost: two capabilities that had been one.**

`react-runtime` and `client-app-root` were indistinguishable while React was the
only thing providing either. MUI and React Router both said in prose that they
"mount React context above" the application; both only required the runtime.
Next provides the runtime and no client root, which made the conflation visible
and load-bearing. The same split was needed for the head: `document-metadata`
says the head is rendered before the response is sent, which Next genuinely
does; `composed-metadata` says this generator writes into it, which Next does
not. Without the second, `--features seo` on Next was accepted and produced a
byte-identical project.

| Capability            | Astro | React | Next |
| --------------------- | ----- | ----- | ---- |
| `react-runtime`       |       | ●     | ●    |
| `client-app-root`     |       | ●     |      |
| `file-based-routing`  | ●     |       | ●    |
| `document-metadata`   | ●     |       | ●    |
| `composed-metadata`   | ●     |       |      |
| `composed-stylesheet` |       | ●     |      |
| `vite-plugins`        | ●     |       |      |

Every Stage 22 refusal is a missing cell in that table, and none of them is a
rule naming a framework.

**One contract change.** `FrameworkAdapter` gained optional `defaultStyling` and
`defaultUiLibrary`. Styling remains a global dimension that no framework owns -
a stated value still wins and still reaches the compatibility engine - but a
framework may now say what it ships with when nobody asks. Without it,
`--framework nextjs` alone would inherit V1's Tailwind default and be refused
for a choice the user never made. Astro and React declare neither and resolve
exactly as before.

**Unchanged.** The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), no
existing golden moved, no new runtime dependency, and the version stays 1.0.2.

**Known limitations, stated rather than implied:**

- **No `lint` script.** Next 16 removed `next lint`, so there is no native
  command to bind it to, and adding one would mean ESLint plus its Next config -
  outside this stage's dependency baseline. The generated README says so.
- **No not-found page.** `page.notFound` is deliberately unmapped rather than
  pointed at `app/not-found.tsx`, because nothing writes that file. Selecting
  `--features not-found` is refused by name.
- **No static export.** `next build` produces a server application; Next does
  not declare `static-output` and no deployment configuration is generated.
- **Next reformats `tsconfig.json` on first build.** The values it wants are
  already there - the file survives a build semantically unchanged - but Next
  rewrites the JSON with one array element per line.
- **No SEO, structured data or accessibility.** Each is refused rather than
  ignored, and each would need Next's layout to compose contributed metadata.

### Stage 23 — Tailwind on Next.js, without a Next-specific Tailwind (landed)

Stage 22 refused `nextjs + tailwind`, and the refusal named `vite-plugins`.
That was correct given what Tailwind declared, and the declaration turned out to
be over-specified in exactly the way Stage 22's own capabilities had been.

Tailwind v4 does not require Vite. It requires one of the two build plugins it
ships to have somewhere to run:

```
before   requires        vite-plugins
after    requiresOneOf   vite-plugins | postcss
```

Next reads `postcss.config.mjs` natively, so it declares `postcss` - a fact
about Next that predates any styling system. The Tailwind adapter then chooses
which of its two plugins to contribute by asking the _project_ what it can run:

```ts
const vite = project.capabilities.has('vite-plugins');
```

A capability, never a framework. `manifest.framework === 'nextjs'` would have
been shorter, wrong, and the first crack in the styling dimension.

|                     | Astro               | React + Vite        | Next.js                |
| ------------------- | ------------------- | ------------------- | ---------------------- |
| pipeline capability | `vite-plugins`      | `vite-plugins`      | `postcss`              |
| plugin package      | `@tailwindcss/vite` | `@tailwindcss/vite` | `@tailwindcss/postcss` |
| registered in       | its own template    | `config.build`      | `config.styling`       |
| stylesheet owner    | its own template    | Tailwind            | Tailwind               |

**The negative result is the important one.** Bootstrap requires
`composed-stylesheet`, which Next still does not provide, so it is exactly as
refused as it was before - and MUI and React Router are untouched. Adding a
pipeline capability made Tailwind work and nothing else.

**Two owners, one stylesheet.** Next's template shipped `styles/globals.css` as
a file in its base layer, and a layer file is written unconditionally - so
selecting Tailwind put two owners on one path, which the composer correctly
refused. The fix was to make the plain stylesheet a _contribution_ rather than a
layer file, so the two compete on equal terms and exactly one is ever claimed.
The condition is "is there a styling adapter at all", never which one.

**The shared style contract did the rest.** Next's starters name semantic
classes - `hero`, `page-title`, `button-primary` - which every styling system
already implements, the same contract React's starters have used since Stage 5.
Composing Tailwind therefore changes the stylesheet, the plugin and one
dependency, and not one byte of the component tree. A test asserts that
equality directly.

**Unchanged.** The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), no Astro
or React golden moved, no new runtime dependency, and the version stays 1.0.2.

### Stage 24R — a capability declaration that stopped describing the code (landed)

Stage 24 set out to prove that `nextjs + bootstrap` was refused for a genuine
missing capability. The investigation proved the opposite, and the stage was
reported BLOCKED rather than completed. This is the correction.

```
Stage 22   Next's template shipped styles/globals.css
           styles.global was template-owned
           composed-stylesheet correctly withheld

Stage 23   the stylesheet left the template layer so Tailwind could own the role
           styles.global left templateOwnedRoles
           composed-stylesheet was not revisited      ← the drift

Stage 24R  Next declares composed-stylesheet, because it now does
```

The capability's definition never changed and did not need to:

> The global stylesheet is composed from contributions rather than shipped by
> the framework's template.

Post-Stage-23 Next matches that sentence exactly. The declaration did not, and
the comment justifying it still asserted the Stage 22 arrangement — _"Next ships
`styles/globals.css` from its own template, so a styling adapter contributing a
second one would collide"_ — of which neither half remained true.

**`postcss` and `composed-stylesheet` are not the same capability**, and Next
provides both for unrelated reasons:

|                       | question it answers                                               | who needs it |
| --------------------- | ----------------------------------------------------------------- | ------------ |
| `postcss`             | is there a pipeline a build plugin can run in?                    | Tailwind v4  |
| `composed-stylesheet` | is there a stylesheet surface a contribution can be written into? | Bootstrap    |

A framework can have either without the other. Astro has the second and not the
first in the PostCSS sense; a framework that processed CSS but shipped its own
stylesheet would have the first and not the second. Conflating them is how a
styling system gets accepted and then silently ignored.

**Why it survived three stages.** Every test asserted the refusal; none asserted
the reason. Goldens, mutation runs and CI all passed over a declaration that had
stopped matching the code, because "Next + Bootstrap is refused" was true
throughout — for a reason that had quietly expired. The guard added here is
direct:

```ts
expect(NEXTJS_DECLARATION.provides).toContain('composed-stylesheet');
expect(adapters.framework('nextjs').templateOwnedRoles).not.toContain('styles.global');
```

**The synthetic-framework proof.** Bootstrap working on Next proves Bootstrap
works on Next. What proves the _contract_ is a framework that does not exist: a
declaration providing `composed-stylesheet` and nothing else — no runtime, no
language, no build pipeline — composes with Bootstrap, and the same declaration
with that one entry removed does not. It lives as a literal in a test file, is
absent from the registry and from `FrameworkId`, and a test asserts it cannot be
selected.

**Unchanged.** The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), no
existing golden moved, Bootstrap is untouched, Astro still refuses Bootstrap for
the reason that was always true, no preset was added, and the version stays
1.0.2.

### Stage 25 — `client-app-root`, verified rather than inherited (landed)

Stage 24R's lesson was that a refusal staying true does not prove its reason
still holds. So this stage re-opened the MUI refusal with no presumption in
either direction, and the result is that the capability survives investigation —
but the investigation, not the previous stage, is what establishes it.

**The definition, unchanged:**

> The application has a client-rendered root that React context can be mounted
> above.

**What MUI actually needs**, traced through the adapter rather than read off the
declaration:

```
MUI contributes   a provider file         -> role app.providers
MUI contributes   a wrapping request      -> role app.root, slot "providers"
MUI's template    ThemeProvider + CssBaseline, and no "use client"
```

Three things, and the App Router satisfies none of them:

|                           | React standard | Next App Router |
| ------------------------- | -------------- | --------------- |
| `app.root` mapped         | ●              |                 |
| `app.providers` mapped    | ●              |                 |
| `rootExportName`          | `App`          | —               |
| `composesAppRoot(...)`    | `true`         | `false`         |
| generated client boundary | the whole tree | none            |

**The experiment.** `client-app-root` was added to Next's declaration and a
project generated. It did not produce a working Next + MUI project; it failed
with `Architecture "next-app" does not define a path for the file role
"app.providers"`. The refusal is overdetermined — the capability is absent, and
so is every structure the capability would have implied. The change was reverted
and nothing shipped from it.

**Outcome B.** Next continues not to provide `client-app-root`; Next + MUI
remains refused, naming the capability and never the framework.

**What changed is how it is defended.** The old suite asserted the refusal. The
new one asserts each premise separately, against the code:

```ts
// the declaration and the architecture must not be able to drift apart
expect(NEXTJS_DECLARATION.provides.includes('client-app-root')).toBe(
  composesAppRoot(NEXTJS_ARCHITECTURE) && definesRole(NEXTJS_ARCHITECTURE, 'app.providers'),
);
```

Four mutations exist purely for that shape — mapping a role while withholding
the capability, or keeping the capability while removing the role, on both Next
and React. Every one is caught. A suite that only asserted "Next + MUI is
refused" would pass all four, which is exactly how Stage 24R's drift survived
three stages.

**`client-app-root` is stricter than MUI's theoretical minimum**, and that is
worth stating rather than hiding. MUI needs a client boundary _somewhere_ above
the content; the App Router can express one (a `'use client'` provider inside a
server layout). Making that work would need two new role mappings, a modified
layout template and, for correct SSR style flushing, an additional package.
That is implementing Next + MUI, not discovering that it already works — which
is the difference between this stage and Stage 24R, where the code had already
changed and only the declaration lagged.

**Unchanged.** MUI's declaration, the compatibility engine, every generated
byte, the four V1 goldens
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), and the
version at 1.0.2. No README change: no supported combination moved.

### Stage 26 — Next.js + MUI, composed rather than special-cased (landed)

Stage 25 verified the refusal was genuine and located it precisely: MUI needs
somewhere to put a provider and something to wrap, and the App Router
architecture mapped neither. That was an _architecture_ gap rather than a
capability lie, which is why it needed implementing rather than correcting.

**The change is one idea, already used twice here.** The layout always wraps the
application in whatever fills `app.providers`, and the framework contributes an
empty one when nothing else does — exactly the arrangement the stylesheet has
had since Stage 23.

```
app/layout.tsx          server component, always
  └─ <AppProviders>     role app.providers
       └─ {children}

uiLibrary: none   Next contributes a pass-through, no client bundle
uiLibrary: mui    MUI contributes its own, carrying 'use client'
```

The layout never becomes a client component, and the boundary is exactly one
component deep. Which is why §5's warning — do not solve this by marking
`app/layout.tsx` as `'use client'` — did not have to be taken.

**Two things only a browser could tell us**, neither visible in the code and
neither caught by a passing production build:

1. **MUI's provider needed `'use client'`.** One line, added to the single
   shared template. Inert under a client-rendered root — React + Vite builds
   unchanged — and load-bearing under a server-rendered one. One template, not
   a fork.
2. **Emotion emitted its styles into `<body>`.** React 19 hoists `<style>` into
   `<head>` while hydrating, so the two disagreed: a recoverable hydration error
   (React #418) on every page load, while `next build` reported success
   throughout. Found by loading the page, not by reading anything.

The second produced the stage's one new capability:

|                        | question it answers                                          | who has it  |
| ---------------------- | ------------------------------------------------------------ | ----------- |
| `client-app-root`      | is there a root above the application a provider can occupy? | React, Next |
| `server-inserted-head` | can markup made during a server render reach the head?       | Next only   |

Nothing _requires_ `server-inserted-head` — a library needing it on a
server-rendering framework needs nothing on a client-only one. It is a fact to
branch on, and MUI is the one adapter that reads it, choosing between its two
provider variants and installing `@mui/material-nextjs` only where there is a
server render to integrate with. The same shape Tailwind has used since Stage 23
to choose between its two build plugins.

**The guard that mattered most.** React Router required `client-app-root` and
nothing else, so giving Next that capability would have made it
capability-compatible while still having no route table to own — resolving, then
failing at generation on an unmapped role. The fix is a _conflict_, not a
framework branch:

```ts
{ kind: 'conflicts', capability: 'file-based-routing',
  because: 'a framework that routes its own files leaves no route table for it to own' }
```

That holds for Astro too and names neither. Four mutations exist for this
boundary alone; all are caught.

**Dependency direction.** MUI owns every MUI package, including the Next
integration. The package is MUI's own and its vendor named it after the
framework it targets — that name appears in a dependency entry and one template
import, never in a condition. Next depends on no UI library, and a test asserts
ownership on each dependency's own `owner` field.

**Unchanged.** The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), no preset
was added, no combination adapter exists, and the version stays 1.0.2. Thirteen
V2 goldens moved, from exactly two causes: the MUI provider gained its directive
(five React goldens) and the Next layout gained its provider boundary (eight
Next goldens).

### Stage 27 — the provider composition contract (landed)

Stage 26 gave Next one provider slot, hard-wired into the layout. That works for
one contributor and has no answer for two: a second would collide on the file,
and nothing anywhere said which should be outermost. The Stage 26 report named
the risk — _"two wrappers would have no declared nesting order"_ — and this
stage closes it before a second contributor exists.

**1. The semantic role.** `app.providers` was already right and is reused: it is
where _a_ wrapper's own component lives. What was missing is a name for the
_chain_, so `app.shell` was added — the component a framework's own entry
renders around the application content, composed from every contributed wrapper.

**2. Contribution ownership.** Unchanged. A wrapper is a `ConfigContribution`
targeting `app.root` at slot `providers`, carrying an `importName`, the `role`
holding its own file, and an `order`. The owner is the contributing adapter's
ref, and it appears in the composed file's `origin`.

**3. The ordering model** — explicit numeric order, which React has used since
Stage 7:

```
lower order is further out; ties break on the owner's adapter ref
```

Chosen over semantic phases (a vocabulary to agree on before anyone needs it),
`before`/`after` constraints (expressible contradictions, needing detection and
resolution), and architecture-defined ordering (a per-architecture table, which
is a matrix). It is the smallest model that answers the question, and it was
already load-bearing: MUI at 10 and React Router at 100 is what puts the theme
_outside_ the router, which Stage 13 established by finding the alternative
broken.

**Cycles are not detected because they cannot be expressed.** Integers are
totally ordered and the tiebreak is total, so there is no graph. A `before`/
`after` model would need cycle detection to earn behaviour this already has.

**4. Duplicate policy.** A byte-identical claim contributed twice collapses to
one — nesting a component inside itself is meaningless, and refusing would make
a legitimate double-reach an error. Anything else sharing a binding name is a
conflict, including the same owner contributing the same name with a different
order.

**5. Conflict policy.** Two owners wanting one binding fails by name. So does a
wrapper whose file nothing produces, and a wrapper whose role the architecture
cannot place. New here: a wrapper may not share the _shell's_ own export name —
the one collision the claim list cannot see, because that name belongs to the
architecture. Found while building this stage, when MUI's `AppProviders` and
Next's shell were both called `AppProviders` and the emitted module redeclared
its own export.

**6. Next.** `app/layout.tsx` stays framework-owned and server-rendered, and
renders the composed shell:

```
app/layout.tsx                    server, framework-owned
  └─ Providers                    app.shell   — composed from wrappers
       └─ AppProviders            app.providers — MUI's, 'use client'
            └─ {children}
```

**7. React.** Unchanged, and byte-identical: it composes `app.root`, which
renders _the page_ rather than children.

```
src/App.tsx                       app.root — composed
  └─ AppProviders                 app.providers — MUI, order 10
       └─ AppRouter               app.router — React Router, order 100
            └─ <HomePage />
```

**8. Why `app.root` stays separate.** A root _is_ the application: it renders
the page, so composing it decides what the application shows. A shell wraps
content it is handed. The two genuinely differ, and each architecture maps
exactly one — Next maps no `app.root`, and inventing one would emit a component
nothing renders. Everything above the two emitters is shared: the same claims,
the same sort, the same role indirection.

**9. Why adapter registration order is not authoritative.** Because it is not a
decision anyone made. Registration order is a fact about a `Map` literal;
nesting order is a design choice with consequences a user can see. A test
composes three wrappers in all six permutations and asserts one identical
result.

**Unchanged.** React's generated output is byte-identical — zero React goldens
moved. The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), no adapter
or preset was added, and the version stays 1.0.2. Eleven Next goldens moved,
from one cause: the shell is now composed rather than contributed, so the
provider file is emitted and its occupant moved to `UiProviders.tsx`.

### Stage 28 — the capability ↔ architecture contract (landed)

**The gap.** The compatibility engine reads declarations and nothing else. The
architecture is resolved _afterwards_, from the framework whose declarations
were just judged — so nothing anywhere compared the two. That left one shape of
drift with no guard at all:

```text
capability declared
      ↓
consumer becomes compatible
      ↓
architecture cannot materialize the surface
      ↓
failure, halfway through planning, naming a role and no reason
```

Stage 25 walked that path with `client-app-root`. The refusal was correct, and
it arrived as `Architecture "next-app" does not define a path for the file role
"app.providers"` — a sentence naming neither the capability, nor who wanted it,
nor why. Stage 26 mapped the role and the symptom disappeared; the gap did not.
Stage 28 turns the lesson into an invariant:

> A capability that promises a generated surface may only be declared by a stack
> whose architecture can place that surface.

Note what this is _not_. It is not a compatibility error — the consumer was
right to ask. It is a **false declaration**, and the fix is to change the
declaration or the architecture, never the selection.

**Three concepts, still three.** The stage deliberately does not merge them:

| Concept      | Says                                           |
| ------------ | ---------------------------------------------- |
| Capability   | this project can perform X                     |
| Role mapping | this architecture knows where X is represented |
| Contribution | this adapter wants to provide or use X         |

Mapping a role does not grant a capability, and the codebase already relies on
that in both directions: React maps `page.notFound` and has no file-based
routing; Next maps `app.layout` and does not compose metadata into it. If
mapping granted capabilities, an architecture could award itself anything by
naming a path, and `provides` would stop meaning anything.

#### The four categories

Every capability is classified, and `CAPABILITY_CONTRACTS` is a total
`Record<Capability, …>` — a capability added without a contract fails to
compile, because the failure this stage exists to prevent is a capability nobody
thought about.

| Capability             | Category      | Surface required?               | Contract                                                                            |
| ---------------------- | ------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `react-runtime`        | pure          | no                              | React is on the page; every file may import it and none represents it               |
| `angular-runtime`      | pure          | no                              | the same, for Angular                                                               |
| `jsx`                  | pure          | no                              | a property of the source, not a place                                               |
| `typescript`           | pure          | no                              | every file carries it, no file owns it                                              |
| `spa-routing`          | pure          | no                              | a shape of application; the route table belongs to `client-side-routing`            |
| `ssr`                  | tooling       | no                              | happens in the framework's runtime                                                  |
| `static-output`        | tooling       | no                              | a property of the build                                                             |
| `file-based-routing`   | tooling       | no                              | which pages exist is the project's business                                         |
| `document-metadata`    | tooling       | no                              | a claim about _when_ the head reaches the client                                    |
| `server-inserted-head` | tooling       | no                              | a hook an adapter branches on                                                       |
| `postcss`              | tooling       | no                              | a pipeline in the build                                                             |
| `sass`                 | tooling       | no                              | a pipeline in the build                                                             |
| `css-framework`        | tooling       | no                              | presence, so a second one can refuse to join it                                     |
| `css-in-js`            | tooling       | no                              | styles generated at runtime                                                         |
| `vite-plugins`         | tooling       | no                              | a plugin array in the build configuration                                           |
| `client-app-root`      | architectural | **yes** — `app.providers`, file | there is somewhere above the application to mount context, and a provider is a file |
| `client-side-routing`  | architectural | **yes** — `app.router`, file    | routes matched in the browser need a route table the project owns                   |
| `composed-stylesheet`  | composition   | **yes** — `styles.global`, file | the stylesheet is contributed, so the role must be mapped _and_ left unowned        |
| `composed-metadata`    | composition   | **yes** — `app.layout`, data    | the shell is assembled from contributed values, so mapping is the whole requirement |

`pure` and `tooling` name no surface, and a test enforces that correspondence in
both directions. That guard exists because the likeliest way to get this stage
wrong is the opposite of the problem it solves: deciding every capability ought
to map a role, inventing `language.typescript`, and making the vocabulary less
true in the name of rigour. Adding a surface to a pure capability now requires
reclassifying it — a deliberate act somebody has to defend.

#### `via: 'file'` versus `via: 'data'`

The two surface kinds are the difference between Astro's stylesheet and Astro's
layout, and they are why the contract checks template ownership rather than
mapping alone.

A `file` surface means an adapter writes a file there, so the architecture must
map the role **and** leave it unowned by its own template layers — a
template-owned role refuses contributions, which makes the capability a promise
the project cannot keep. A `data` surface means contributions are folded into a
file the framework already owns, so mapping is all that is required.

Astro ships `global.css` from its template and declares `styles.global`
template-owned, so it does _not_ provide `composed-stylesheet` — and Bootstrap,
which contributes a stylesheet file, stays refused there. Astro also ships
`BaseLayout.astro` from its template and _does_ provide `composed-metadata`,
because a metadata feature contributes values rather than a file. One rule, both
answers, and neither mentions Astro.

#### The case studies

**`client-app-root`.** The surface is `app.providers`, not `app.root` — and the
distinction is exactly what Stage 27 established. React's root _is_ the
application; Next's shell wraps content the framework hands down. Both can mount
context above the tree, and requiring `app.root` would refuse Next for having a
different shape rather than a missing one. React materializes the capability
through `app.root` + `app.providers`, Next through `app.shell` + `app.providers`,
and the contract names only the surface they share.

**`composed-stylesheet`.** Next and React both declare it and both leave
`styles.global` to a contributor. Astro maps the same role and owns it. The
contract distinguishes them structurally, so a mutation that gives Astro the
capability is caught by the contract itself rather than only by a Bootstrap
test.

**`composed-metadata`.** Next maps `app.layout` and does not own it from a
template layer, so it satisfies the _structural_ half of the contract — and the
capability is still false, because Next's layout declares its own `metadata`
export and reads no contributions. `Next + seo`, `Next + structured-data` and
`Next + accessibility` stay refused at compatibility. This is the honest limit
of the mechanism: the contract is a **necessary condition on declaring a
capability, never a sufficient one**. It catches an architecture that cannot
keep a promise; it cannot catch a framework that lies about one it could keep.
Behaviour tests remain the only guard against that, and they are.

#### The other direction, and one real late failure

Searching for combinations that pass compatibility and fail later turned up
three classes, of which only one was a defect.

1. **Probe artifacts** — Astro planned through the wrong entry point. Not real.
2. **`react + styling:none`** — `styles.global` is mapped and nothing filled it.
   Correctly deferred: whether a contribution _materialized_ is a fact about the
   finished plan, and `assertRequiredRoles` still answers it.
3. **`nextjs + not-found`** — compatible (Next really does route by file), then
   dead halfway through planning with `Architecture "next-app" does not define a
path for the file role "page.notFound"`, naming no feature, giving no reason,
   and offering a hint about styling. **Evidence the contract was incomplete.**

Whether an architecture _can place_ a role is knowable from the architecture
alone, so `assertRolesArePlaceable` now answers it at resolution, naming the
adapter that asked. The refusal boundary is unchanged; only its timing and its
wording are. `MergedResolution` gained `requiredRoleOwners` to carry the
provenance that makes the sentence worth reading.

Both checks run in `resolveProject`, at the first moment a capability set and an
architecture exist together — upstream of every contribution, so a refusal costs
zero `FileOperation`s. **The planner's guards were not moved and not removed.**
This layer says the architecture _could_ place a surface; the planner still asks
whether anything did.

#### Why this is not a matrix

`CAPABILITY_CONTRACTS` has one row per capability and no framework axis at all.
Nothing in it knows that Next, React or Astro exist, and adding a fourth
framework adds no row — a framework is held to the contract by what it declares,
never by its name. A structural test scans the validation layer with comments
stripped and fails on any framework, UI-library or styling literal, and a
mutation inserting `manifest.framework !== 'nextjs'` into the check is caught by
it.

**Unchanged.** **Zero goldens moved** — no adapter, template or architecture was
edited, which is the result a hardening stage should produce. The four V1
goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), every
supported stack still resolves, every refusal still refuses, no CLI flag,
manifest dimension or preset was added, the CLI still has zero runtime
dependencies, and the version stays 1.0.2.

### Stage 29 — what `composed-metadata` actually means (investigation, landed)

**Outcome C — architectural gap; implementation deferred.** Next does not gain
the capability, and no metadata composition mechanism was built. What this stage
produced is a corrected definition, a set of pinned measurements, and a clear
statement of what a real mechanism would have to be.

#### The question, and why the premise was wrong

The stage asked whether Next can truthfully provide `composed-metadata`, or
whether ClientKit needs a new metadata composition abstraction first. The
investigation found a third answer: **there is no metadata composition anywhere,
including on Astro**, so the comparison the question assumed does not exist.

The measurement. Generating an Astro project with
`--features seo --features structured-data --features accessibility` produces a
tree **byte-identical** to one generated without them, apart from the feature
list recorded in `.client-site.json`:

```text
diff -r a-none a-all
  .client-site.json   "features": [] -> ["accessibility","seo","structured-data"]
  package.json        "name"
  (no other difference)
```

The trace explains it. Each of the three features contributes exactly one
`ConfigContribution` at role `app.layout` — `seo` at slot `metadata`,
`structured-data` at `structured-data`, `accessibility` at `accessibility` — and
no files, dependencies, scripts or template layers. `planManifest` collects
those claims through `collectClaims`, refuses two that disagree, and hands them
back on `AdapterPlanResult` as `metadata`, `structuredData` and `accessibility`.
**`src/commands/create.ts` reads none of them.** No code path turns a claim into
file content: `applyMerges` handles JSON file contributions only, and the
`append` intent is in the `FILE_INTENTS` vocabulary with no implementation
behind it.

Astro's head is emitted by `Seo.astro`, `StructuredData.astro` and
`BaseLayout.astro`, shipped unconditionally by its template and driven by
`site.config.ts`. The features do not feed it and never did.

#### The definition that was wrong

The capability's own comment read:

> "The document head is composed from contributions rather than declared by the
> framework's own template. … Astro's layout is built from contributed metadata,
> so it provides this."

The second sentence is false, and had been since the feature was written. Stage
22 reasoned from "`--features seo` on Next produced a byte-identical project" to
"Next lacks `composed-metadata`" — without noticing that **the same sentence is
true of Astro**. The conclusion was right; the reason given for it was not.

This is the same class of defect Stage 24R found and Stage 28 was built to
prevent: a declaration whose stated justification stopped describing the code.
Stage 28 could not catch it, because Stage 28 checks _structure_ — and Next
satisfies `composed-metadata`'s structural contract today. That limit was stated
when it was written ("a necessary condition on declaring a capability, never a
sufficient one"), and this is the case that makes it concrete.

#### What the capability truthfully distinguishes

Not composition — **coverage that has been checked**:

|                                           | Astro                                                 | Next                      |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------- |
| `app.layout` mapped                       | yes                                                   | yes                       |
| shell states title, description, language | yes                                                   | yes                       |
| robots, canonical, Open Graph, Twitter    | yes                                                   | no                        |
| JSON-LD                                   | yes                                                   | no                        |
| contract verified against real built HTML | yes — `test/seo-feature.test.ts`, `scripts/smoke.mjs` | nothing verifies anything |

Next's head is real and server-rendered — that is `document-metadata`, which
Next genuinely provides. What is absent is the rest of what the features
describe, and any check that the two agree.

#### The experiment

Next was temporarily granted `composed-metadata` — in the working tree only,
never committed — and three projects generated:

```text
next                                          14 files
next + seo                                    14 files
next + seo + structured-data + accessibility  14 files
```

Resolution succeeded, planning succeeded, and the three projects are
**byte-identical** apart from the feature list in `.client-site.json`. No build
or browser validation was performed, because there was nothing to validate: the
generated source does not differ. Accepted and ignored is exactly the failure
the requirement exists to prevent, so the declaration would have been false and
was reverted.

A second experiment used a test-only contributor with a deliberately generic
purpose (`document-facts`, stating a title and a language, naming no framework).
Its claim was collected at `app.layout` and reached no file, and the only file
contribution anywhere in a Next stack targets `styles.global`. A `merge` file
contribution cannot reach a `.tsx` layout — `applyMerges` refuses anything but
JSON — and `append` has no implementation. There is no generic path from a
contribution to the document head on any framework.

#### What a real mechanism would require

Deferred deliberately, and recorded so the next stage starts from evidence:

1. **A composed document shell.** `app.layout` would have to become a composed
   surface the way `app.root` and `app.shell` became composed in Stages 26–27 —
   emitted from claims rather than shipped by a template. That changes Astro,
   React and Next together, and it would move Astro's head out of
   `BaseLayout.astro`, so every Astro golden moves.
2. **A head-markup contribution type, or a much richer claim.** JSON-LD is a
   `<script type="application/ld+json">` element, not a metadata field; Next's
   `metadata` export cannot carry it, and forcing it into a generic metadata
   object would lose its semantics. Accessibility contributes document-level
   guarantees (language, landmarks) that are not head tags at all. One claim
   shape does not obviously cover the three.
3. **A per-framework emitter.** The same claims must become a Next `metadata`
   export plus a JSON-LD element, and Astro component markup. That is the
   `emitProviderShell` pattern applied to the head — generic composer, per-
   architecture emitter — and it is a stage of its own.
4. **A collision policy for fields rather than slots.** Today three features
   never collide because each owns a slot. Once claims merge into one head, two
   contributors can both want `title`, and `collectClaims`' "identical
   de-duplicates, differing is a conflict" rule would need to apply per field.

Until those exist, `Next + seo`, `Next + structured-data` and `Next +
accessibility` stay refused, and the refusal stays honest: the capability is
absent because the coverage is absent.

#### What changed here

Comments and tests only — **no behaviour, and zero goldens moved.** The
capability's definition and the Stage 28 contract's `because` were corrected to
describe what the code does. `test/metadata-composition.test.ts` (25 tests) pins
the measurement: that all three features change no generated file on Astro, that
nothing contributes a file at `app.layout`, that each feature owns its own slot,
that the collection is deterministic across feature order, what Next's shell
does and does not state, and that every Next metadata combination stays refused
with zero writes. If a later stage builds real composition, the first of those
tests is the one that should fail — and its failure will be a decision somebody
made rather than a drift nobody noticed.

**Unchanged.** Zero goldens moved. The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`). Next
declares no new capability, no feature, framework, preset or starter was added,
the CLI still has zero runtime dependencies, and the version stays 1.0.2.

### Stage 31 — the document contribution payload model (landed)

**Why Stage 30 could not proceed.** It set out to build a document-shell
composer and stopped on a specific fact: the provider shell composes without a
payload model because a provider has exactly one universal prop, `children`.
Every wrapper is `{ importName, from }`, and the composer nests N of them
knowing nothing about any of them. Head entries have no `children` equivalent,
so a document composer has to carry a payload — and there was no model for one.
Every candidate payload closed a different door: a component reference could not
carry Astro's per-page parameters, structured head elements were the metadata
semantics a later stage owns, and raw markup was ruled out outright.

**What a payload model has to survive.** Two things, both discovered rather than
assumed:

1. The three concerns are not the same kind of thing. Metadata describes _this
   page_ to a crawler; structured data describes _the organisation_ to a
   knowledge graph and is JSON-LD with its own serialisation; document
   guarantees are properties of the document itself, most of which are not head
   entries at all.
2. Statements vary per page, and the variation carries correctness weight. The
   generated not-found page must not be indexed and must not claim to be the
   organisation's home. Both facts lived only as props on a framework's own
   layout, so the domain could not say either.

#### The model

A discriminated union, one variant per concern, each **wrapping the
feature-level contract that already exists** rather than replacing it. The
contracts were right; what was missing was a way to attach one to a document.

```ts
type DocumentContribution =
  | { kind: 'metadata'; metadata: DocumentStance<SeoContract> }
  | { kind: 'structured-data'; jsonLd: DocumentStance<OrganizationContract> }
  | { kind: 'document-guarantees'; guarantees: DocumentStance<AccessibilityContract> };
```

Each carries an `owner`, a `reason` and a `scope`. There is no
`Record<string, unknown>`, no markup, no component reference and no framework
type anywhere in it — a structural test asserts each of those absences.

**Scope** is how per-page statements became sayable:

```ts
type DocumentScope = { kind: 'every-page' } | { kind: 'page'; role: FileRole };
```

A page is named by the semantic role it already had. `page.notFound` is the
generator's existing vocabulary for "the page an unmatched address reaches", it
maps to a different file in every architecture, and it names no framework. That
is the whole reason the 404's opt-outs can be expressed here without anything
knowing what a `.astro` file is.

**Stance** keeps three states apart that a two-state model would merge:

```ts
type DocumentStance<T> = { state: 'stated'; value: T } | { state: 'suppressed'; because: string };
// and absent — no contribution at all
```

"Nobody configured structured data" and "this page deliberately suppresses
structured data" produce the same document today and must not produce the same
_model_. The first is a project that has not set anything up; the second is a
correctness decision with a reason attached. Collapsing the middle state into
`undefined` is how a later composer eventually restores a suppressed statement by
"filling in a gap". `because` is mandatory on a suppression for the reason
`Constraint.because` is: a decision nobody wrote a reason for is one nobody can
review.

#### Why the three stay distinct

**SEO** keeps `SeoContract` whole — title, description, robots, canonical, and
Open Graph and Twitter as nested structures rather than flattened strings. A
round-trip test compares it field for field against what `resolveSeoContract`
produced, so nothing may be dropped on the way in.

**Structured data** keeps `OrganizationContract` as an object. It is never a
string here and never a `<script>` element: JSON-LD has a serialisation of its
own in `serialiseOrganization`, and an HTML representation on top of that, and
both belong to whatever eventually renders it. A test asserts the serialised
model contains neither `<script` nor `application/ld+json`, and that there is no
path from a metadata statement to an `@type`.

**Accessibility** keeps `AccessibilityContract` whole, including the
`outOfScope` half — a model that carried only the promises would turn a bounded
claim into an unbounded one. `GUARANTEE_SURFACES` records which part of the
document each guarantee is about, and the spread is the evidence against the
simplification a later stage will be tempted by:

| Surface              | Guarantees                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `document-element`   | `document-language`                                                                                         |
| `head`               | `document-title`, `scalable-viewport`                                                                       |
| `document-structure` | `main-landmark`, `skip-link`, `contentinfo-landmark`, `primary-heading`, `navigation-landmark-when-present` |

Five of eight are body structure and one is an attribute on the root element.
"Accessibility is head markup" is false, and now measurably so.

#### The 404, said in the domain

The correctness fact Stage 30 found sitting in a template prop:

```ts
// what an unmatched address should tell a crawler
{ kind: 'metadata', scope: onPage('page.notFound'),
  metadata: stated(resolveSeoContract(site, { pageTitle: 'Page not found', noindex: true })) }

// an unmatched address is not the organisation home
{ kind: 'structured-data', scope: onPage('page.notFound'),
  jsonLd: suppressed('an unmatched address is not the organisation home') }
```

`robots` becomes `noindex, nofollow`, the canonical and `og:url` go empty, and
the organisation claim is refused rather than missing — while every other page
keeps `index, follow` and its structured data. A test asserts no framework name
appears anywhere in that representation.

#### Identity, ordering and collisions

Identity is `kind` plus `scope`, deliberately **not** owner: two adapters
describing the metadata of one page are making one statement about one thing,
and including the owner would make every contribution unique and leave nothing to
collide. Ordering comes from the `DOCUMENT_CONTRIBUTION_KINDS` literal, then
scope, then owner — a declaration rather than arrival order, the same rule
`CAPABILITIES` follows.

The arbitration policy is inherited from `collectClaims`, which has arbitrated
the same three features since Stage 10, rather than invented here: identical
statements de-duplicate and keep every claimant; differing statements on one
identity are a conflict naming both owners. There is no first-wins, last-wins,
feature-order or framework precedence anywhere.

**Field-level collisions are explicitly deferred.** Two owners both stating the
metadata of one page conflict today even if one only wanted the canonical and
the other only the title. Merging at field granularity needs a precedence rule
per field, and inventing one here would be the unjustified winner policy this
refuses. The abstraction boundary is `documentContributionIdentity` — that is
where a field-level resolver slots in.

#### What this stage did not do

No composer. `canonicalDocumentContributions` orders, de-duplicates and
arbitrates a list it is _handed_; it collects nothing, knows no architecture,
resolves no role and emits nothing. It exists because deterministic identity and
a collision policy cannot be demonstrated without something that orders and
compares.

**Nothing is wired up.** The model is imported by no adapter — a test asserts
that `bridge.ts` does not mention it. The three features still contribute their
`ConfigContribution` claims exactly as before, which is why no generated file
moves. Astro, Next and React are untouched: `Next + seo`, `Next +
structured-data` and `Next + accessibility` remain refused for the same reason
Stage 29 established, `composed-metadata` remains ungranted on Next, and React
still provides neither document capability. **A payload model is not coverage**,
and no framework gained metadata support here.

#### What Stage 32 needs

The composer this was the prerequisite for: collection from contributions,
architecture-neutral resolution, and per-architecture emission. It will also
have to decide field-level precedence, and whether the three feature adapters
start producing `DocumentContribution`s instead of — or alongside — their
current claims.

**Unchanged.** Zero goldens moved and no adapter, template or architecture file
was touched. The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), no CLI
flag, prompt, manifest dimension or preset was added, the CLI still has zero
runtime dependencies, and the version stays 1.0.2.

### Stage 32 — field-level document resolution (landed)

**Why statement-level conflict was not enough.** Stage 31 arbitrated whole
statements: two owners saying anything different about one identity were
refused. That is too coarse in one direction and too quiet in the other. Two
owners setting _disjoint_ metadata fields were refused for disagreeing when they
had not; and when they genuinely did disagree, the diagnostic could only say
"these two statements differ", never which field.

**The rule the layer is built around.**

```text
deterministic ordering  ≠  semantic precedence
```

Contributions are ordered by vocabulary, then scope, then owner, so the same
input always produces the same output and the same message. Nothing reads that
order to decide whose value wins, because nothing decides that at all. There is
no first-wins, last-wins, feature-order, CLI-order, alphabetical-owner or
framework precedence anywhere. Two owners making incompatible claims about one
field is a conflict, and the fix is for one of them to withdraw.

Keeping those two ideas apart is the whole difficulty, and it is what the
sharpest mutation in the suite attacks: replacing the conflict with "the last
owner wins" produces output that is valid, deterministic and wrong.

#### Granularity is declared per kind

The three concerns do not resolve the same way, and forcing them through one
mechanism is how the distinctions Stage 31 preserved would be lost again.

| Kind                  | Granularity        | Why                                                                                                                                                            |
| --------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata`            | field by field     | its fields are independent claims about a page, and a contributor may speak to only some                                                                       |
| `structured-data`     | the whole object   | two JSON-LD descriptions are the same organisation or different ones; a field-wise merge would let two contributors assemble an organisation neither described |
| `document-guarantees` | the whole contract | a guarantee is a promise about generated output, and unioning promises from separate owners asserts something nobody verified                                  |

`MetadataContribution` widened from `SeoContract` to `Partial<SeoContract>`.
That widening is what makes field-level resolution mean anything: Stage 31
carried a complete contract because the one contributor that exists computes a
complete one, so two owners could only agree entirely or disagree entirely, and
"disjoint fields merge" was a case the type could not express. A complete
contract is still a valid value.

#### SEO, field by field

| Field         | Rule                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | single value — identical de-duplicates, differing conflicts                                                                                           |
| `description` | single value                                                                                                                                          |
| `robots`      | single value, never concatenated. Preferring `noindex` would be defensible and is still invented precedence; scope is how the 404 gets its own answer |
| `canonical`   | single value. `''` means no canonical is claimed and is never replaced by a fabricated address                                                        |
| `openGraph`   | **one unit**                                                                                                                                          |
| `twitter`     | **one unit**                                                                                                                                          |

The compound treatment of the social blocks is a correctness rule rather than a
simplification. `resolveSeoContract` derives `openGraph.title` from `title`,
`openGraph.description` from `description` and `openGraph.url` from `canonical`.
Taking `title` from one owner and `openGraph` from another would emit a document
whose `<title>` and `og:title` disagree — valid HTML, a clean build, and wrong in
the only place it matters. So each block is resolved whole, by the owner that
computed it.

One honest note about `canonical`: `''` arises from two distinct causes — no
configured site URL, or a page that is `noindex`. `SeoContract` already
collapses them, and this stage did not invent a distinction that the contract
does not make. What the resolver guarantees is narrower and checkable: it never
turns an absent field into a value, and never manufactures a domain.

#### Scope

`every-page` and `page.notFound` are separate identities and each resolves on
its own, so a site-wide statement cannot overwrite a page-specific one. There is
deliberately **no inheritance**: how a page's statement relates to the
document's is a composition question, and inventing a rule for it here would be
precedence by another name. A page scope that claims only a title therefore
resolves to only a title — the description is not inherited, and a test asserts
that.

#### Stance

| Combination                | Result                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| stated + stated, identical | de-duplicate, keep every claimant                                  |
| stated + stated, differing | conflict, naming the field                                         |
| stated + suppressed        | conflict — "say this" and "do not say this" is a real disagreement |
| suppressed + suppressed    | agree; every reason is kept                                        |
| absent + anything          | the anything; absence contributes nothing                          |

A resolved suppression carries `becauses` rather than one `because`. Two owners
refusing to state something agree about the document even if they explain it
differently, so the reason is provenance rather than semantic content — the
treatment `reason` gets everywhere else.

#### Provenance

Every resolved metadata field records the owners and reasons that claimed it,
and every resolved statement records the owners that contributed to it. Owner
identity is never part of semantic equality — two adapters computing the same
value cooperate — but it is what makes a conflict actionable:

```text
Two adapters disagree about metadata.canonical for every page.
  contributor:a
    "https://acme.example/"
    reason: …
  contributor:b
    "https://other.example/"
    reason: …
  One document can only say one of these, and nothing here picks a winner: the
  order contributions are resolved in is fixed so the result is reproducible,
  not so that one of them takes precedence.
```

#### The 404 invariant

Still the fact the whole line of stages exists to protect, and now proven
through resolution rather than only representation: with a site-wide SEO
statement, a page-scoped SEO statement and a page-scoped structured-data
suppression all present at once, `page.notFound` resolves to `noindex, nofollow`
with no canonical, the organisation claim on that page stays suppressed, and the
site-wide statement keeps `index, follow` and its organisation. A test asserts
no framework name appears anywhere in the resolved result.

#### What changed, and what did not

`canonicalDocumentContributions` was superseded: it became
`groupDocumentContributions`, which groups and orders and has no opinion about
whether a group agrees, and all arbitration moved to
`resolveDocumentContributions` so there is exactly one arbiter. Stage 31's tests
now run through the resolver and all still pass.

**Nothing is wired up.** The resolver is imported by no adapter — a test asserts
`bridge.ts` does not mention it — so no generated file changes, `Next + seo`,
`+ structured-data` and `+ accessibility` remain refused for the coverage
reasons Stage 29 established, `composed-metadata` remains ungranted on Next, and
React is untouched. A resolver is not coverage.

#### What remains for Stage 33

The document-shell composer this was the second prerequisite for: collection
from real contributions, per-architecture emission, and the decision about
whether the three feature adapters begin producing `DocumentContribution`s
instead of their current claims. Scope precedence — how a page statement
combines with the document's — is a composition question and is still open.

**Unchanged.** Zero goldens moved and no adapter, template or architecture file
was touched. The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), no CLI
flag, prompt, manifest dimension or preset was added, the CLI still has zero
runtime dependencies, and the version stays 1.0.2.

### Stage 33 — document scope composition (landed)

**Why it was deferred.** Stage 32 resolves every statement about the document
and stops, producing one entry per `(kind, scope)` with no relationship between
them. That was deliberate: how a page's statement combines with the document's
is a composition question, and inventing a rule for it inside the resolver
would have been precedence by another name. This is that rule, made explicit.

#### Specificity is declared, not sorted

The property the whole stage protects:

```text
deterministic ordering  ≠  semantic precedence
```

A page-scoped statement takes precedence over a site-wide one because
`SCOPE_SPECIFICITY` says a page is more specific than the document — and for no
other reason. It is emphatically **not** because `page:…` sorts after `''` in
the canonical order. That order exists so output is reproducible, and a rule
riding on it would silently change meaning the day the ordering was adjusted for
an unrelated reason. A mutation that sets `page: 0` is caught.

The two entries are numbered `0` and `10`. The gap is deliberate: a future scope
between the document and a page has somewhere to go without renumbering, and
adding one is a decision somebody writes down rather than a consequence of
alphabetical position.

#### The model: page overlays document, field by field

**Model A**, selected. Rejected alternatives:

- **Model B — a page replaces the whole kind.** The 404 would lose its inherited
  description, which is the return to whole-statement semantics Stage 32 was
  written to prevent. Rejected.
- **Model C — a page declares which fields it inherits.** A new declaration
  surface no contributor needs, invented for a case that does not exist.
  Rejected as speculative.

The target is a domain concept and stays semantic:

```ts
type DocumentTarget = { kind: 'site' } | { kind: 'page'; role: FileRole };
```

Distinct from `DocumentScope` despite the same shape, because they answer
different questions — a scope is what a contribution _declares it applies to_, a
target is what somebody is _asking for_. No route, pathname, URL or file appears
anywhere; a routing-aware scope system would be its own stage, and a structural
test fails on `pathname`, `RegExp`, `glob`, `route` or `URL(`.

#### Inheritance, every combination

| every-page | page       | result                                             |
| ---------- | ---------- | -------------------------------------------------- |
| stated     | stated     | field-by-field overlay, page wins per field        |
| stated     | suppressed | **suppressed**                                     |
| stated     | absent     | inherited                                          |
| suppressed | stated     | stated                                             |
| suppressed | suppressed | suppressed                                         |
| suppressed | absent     | **suppressed** — an inherited refusal is not a gap |
| absent     | stated     | stated                                             |
| absent     | suppressed | suppressed                                         |
| absent     | absent     | nothing said                                       |

Each of the nine has a test.

#### SEO scope

Field-level throughout. A page that states a title overrides the inherited title
and inherits everything else; a page that states nothing inherits everything.

`canonical: ''` is a **statement, not a gap**, and this is what made the rule
definable. The contract means "emit no canonical tag" by it — the generated Seo
component does `canonical !== '' && <link rel="canonical">` — so a page's empty
value overrides an inherited address rather than falling through to it. Absence
is how a contributor says nothing, and `Partial<SeoContract>` keeps the two
apart. Stage 32 recorded that `''` conflates _why_ it is empty (no site URL, or
a `noindex` page); that ambiguity is upstream and does not reach scope
composition, which only needs present-versus-absent.

#### Structured-data scope

Whole objects, never merged. A page refusing the organisation is suppressed; a
page stating a different organisation replaces it wholly; an identical
organisation at both scopes de-duplicates. There is no deep merge, so two
contributors can never assemble an organisation neither described.

#### Accessibility scope — a Stage 31 limitation resolved

Stage 31 recorded a suspicion: "`DocumentStance` permits suppressing document
guarantees, which is probably never correct." The contract settles it.
`ACCESSIBILITY_GUARANTEES` is documented as properties that hold on **every
page**, each phrased so it can be checked against real built HTML. A page that
suppressed `document-language` would still build, still pass review, and leave
the bounded claim false for the whole project — and the boundedness is what
gives the contract any value.

So the constraint is now structural: **a document guarantee may only be stated
for the document as a whole.** `assertGuaranteesAreDocumentWide` refuses a
page-scoped guarantee, stated or suppressed, naming the owner and explaining
why. Refusing beats silently ignoring, and it is applied where pages first
become meaningful.

#### Provenance survives inheritance

Each composed field records its owners, its reasons and the scope it came from,
so "this page's description came from the site-wide statement and its title from
the page's own" is a sentence the model can produce. A result that merged the
layers into an anonymous object could not.

#### Conflicts are still conflicts

Specificity combines _different_ scopes and never arbitrates between owners at
the same one. Two owners disagreeing about a field within one scope raises
exactly as it did in Stage 32, at either scope. Scope specificity is not a
general last-writer-wins.

#### The 404, composed

With site-wide SEO, page-scoped SEO, a site-wide organisation and a page-scoped
suppression all present, resolving `page.notFound` gives `robots:
'noindex, nofollow'`, `canonical: ''`, the page's own title, and a suppressed
organisation — while the site keeps `index, follow`, its canonical address and
its organisation, and `page.home` keeps both. Three targets resolve
independently and nothing leaks between them.

#### What remains for Stage 34

The document-shell composer: collection from real contributions and
per-architecture emission. Nothing here is wired up — the scope resolver is
imported by no adapter, no generated file changes, `Next + seo`,
`+ structured-data` and `+ accessibility` remain refused for the coverage
reasons Stage 29 established, `composed-metadata` remains ungranted on Next, and
React is untouched. Scope composition is not coverage.

**Unchanged.** Zero goldens moved and no adapter, template or architecture file
was touched. The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), no CLI
flag, prompt, manifest dimension or preset was added, the CLI still has zero
runtime dependencies, and the version stays 1.0.2.

### Stage 35 — binding-aware document values (landed)

**Why Stage 34 was blocked.** Every layer from Stage 31 to Stage 33 assumed a
document value is a fact — `title: string`, `canonical: string`. Astro's
document is not made of facts; it is made of expressions evaluated at the
_generated project's_ build:

```astro
const pageTitle = title ? `${title} - ${SITE.name}` : SITE.name; const canonical = origin === '' ||
blocked ? '' : absoluteUrl(origin, Astro.url.pathname);
```

Writing resolved literals in their place freezes the head at generation time, so
editing `site.config.ts` stops changing the site — the one thing the generated
project's own next-steps output promises — and pages the developer adds later
emit no canonical at all, because a snapshot holds values only for the roles
ClientKit knew about.

#### The distinction that fixes it

**Ownership is about authority at build time, not about whether ClientKit knows
a current value.** `SITE.name` is written by the CLI through a `{{siteName}}`
token, so ClientKit _does_ know it — and it is still project-owned, because the
developer may change it a minute later and expects the document to follow.
Collapsing "ClientKit knows it" into "ClientKit owns it" is precisely what
froze the document in Stage 34.

| Owner           | Meaning                                                     | Examples                                        |
| --------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `generation`    | ClientKit resolved it; nothing downstream can change it     | a literal                                       |
| `project`       | the generated project's configuration decides it            | `site.name`, `site.url`, `document.socialImage` |
| `build-context` | the framework or its build supplies it, per page or per run | `page.path`, `generator.name`                   |

#### The model

```ts
type DocumentValue<K extends DocumentValueType> =
  | { kind: 'literal'; type: K; value: LiteralTypes[K] }
  | { kind: 'binding'; type: K; binding: BindingOfType<K> }
  | { kind: 'derived'; type: K; derivation: DerivationOfType<K> };
```

Parameterised by the _document_ type rather than the TypeScript type, which is
what lets `BindingOfType` reject `site.name` where a URL belongs **at compile
time** instead of by inspecting a string at runtime. Four of the seven document
types are strings in TypeScript — `text`, `url`, `path`, `language-tag`,
`asset-path` — and none may stand in for another.

Absence is deliberately not a fourth case: a field nobody claimed is absent from
the statement that would have carried it, exactly as since Stage 32, so "unsaid"
keeps one encoding rather than two.

#### The closed vocabulary

Every binding was found by reading what the shipped Astro document actually
reads, then asking who decides the value at build time:

| Binding                     | Type         | Owner         |
| --------------------------- | ------------ | ------------- |
| `site.name`                 | text         | project       |
| `site.url`                  | url          | project       |
| `site.description`          | text         | project       |
| `site.language`             | language-tag | project       |
| `document.socialImage`      | asset-path   | project       |
| `document.twitterCardStyle` | twitter-card | project       |
| `document.indexingBlocked`  | flag         | project       |
| `page.path`                 | path         | build-context |
| `generator.name`            | text         | build-context |

**Why arbitrary expressions are forbidden.** A binding is a member of this
table and nothing else. `DocumentBinding` is a union of string literals, so
`'SITE.name'` and `` `${x}` `` are type errors; `isDocumentBinding` catches the
same thing at boundaries where types have been erased. A string of source code
in the domain would be an expression language by another name — and an
evaluation surface. There is no `eval`, no `new Function`, and no equivalent.

The identifiers are **semantic**: `page.path` is "the path of the page being
rendered", never `Astro.url.pathname`. A test asserts no binding contains
`Astro`, `SITE`, `SEO`, `CONTACT`, `SOCIAL`, `next` or `react`.

#### Derivation, kept closed

One entry:

```ts
'absolute-page-url': { type: 'url', from: ['site.url', 'page.path'] }
```

Astro builds a canonical address from the site's origin and the current page's
path, and that combination is the single reason Stage 34 lost per-page
canonicals. Naming it makes it representable; writing
`` `${SITE.url}${Astro.url.pathname}` `` would make it arbitrary code wearing a
data structure. `from` is declared so an architecture can refuse a derivation
whose inputs it cannot supply.

A derivation is owned by the **least settled** of its inputs, so
`absolute-page-url` is build-context-owned.

Two further derivations exist in the shipped document and are deliberately
**not** modelled: an absolute social-image URL (needs asset resolution) and a
Twitter card style that depends on whether an image exists (needs a
conditional). Both need forms this vocabulary does not have, and inventing
either to make the set look complete is how a closed vocabulary stops being
closed.

#### Availability, with no fallback

An architecture declares which bindings it can supply, and
`assertBindingsSupported` refuses a value that reaches beyond it — naming the
architecture, the binding, its owner and its type. There is deliberately **no
fallback**: substituting the site URL for a page URL, or an empty string for a
missing path, emits a document that states something untrue and builds without
complaint, which is worse than refusing to build. A test proves every binding is
refused by an architecture that supports none.

#### Canonical

Stage 32/33 semantics are unchanged and now have a representation each:

| State         | Representation                        | Meaning                                    |
| ------------- | ------------------------------------- | ------------------------------------------ |
| absent        | no value at all                       | nobody said anything                       |
| stated `''`   | `literal('url', '')`                  | this page claims no canonical address      |
| stated URL    | `literal('url', …)`                   | this exact address                         |
| page-tracking | `derived('url', 'absolute-page-url')` | the address of whichever page is rendering |

`canonical: ''` stays a **literal**, never a binding: turning it into a binding
would make it track a project value and quietly acquire an address the page
refused.

#### Robots

Stays a literal in the domain. The shipped template also consults
`SEO.noindex`, which is project-owned, so `document.indexingBlocked` is in the
vocabulary for the emitter that will have to honour that switch — included
because real behaviour requires it, not to round out the table.

#### Page props

`title`, `description`, `noindex` and `structuredData` are **template-authored
call sites**, not domain bindings — the shipped 404 passes them as literals in
its own source. They are classified as template-owned and deliberately not
abstracted; the objective is truthful ownership, not maximum abstraction.

#### The Astro boundary

```text
document domain  →  semantic binding  →  ASTRO_BINDING_EXPRESSIONS  →  Astro expression
```

`src/adapters/astro-bindings.ts` is the only place a semantic binding meets
Astro syntax. The domain never imports it, and a test asserts the arrow does not
reverse. Every mapping is checked against the shipped template, so a mapping
that described a project that no longer exists would fail.

#### `site.config.ts` stays authoritative

The generated project remains the source of truth for project-owned
configuration. Nothing here generates a replacement, and nothing reduces the
configuration surface to what ClientKit models — `CONTACT`, `SOCIAL`, `NAV`,
`THEME` and `LAUNCH` are project concerns the generator never sees.

#### The fields Stage 34 found missing

| Field                                         | Classification                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `og:image`, `twitter:image`                   | **C** — derived project-owned; needs an asset-resolution derivation, deferred |
| `twitter:card = summary_large_image`          | **C** — derived project-owned; needs a conditional derivation, deferred       |
| Organization `email`, `telephone`, `location` | **E** — intentionally template-owned; ClientKit never sees them               |
| Organization `sameAs`                         | **E** — intentionally template-owned                                          |

None of the contracts were expanded. The classification shows a binding model
_can_ represent the first three without ClientKit claiming to know values it does
not — which was the question — while the last four stay where they belong.

#### Structured data and accessibility

Structured data keeps `OrganizationContract` as a typed object. Several of its
template-emitted fields are project-owned, so a binding-aware variant will be
needed eventually; designing it here would have been a structured-data redesign
and is **explicitly deferred**.

Accessibility needed no binding of its own. The one guarantee with a
document-level value is `document-language`, and the value it needs is the
site's language — already in the vocabulary. The Stage 33 split is unchanged:
two head facts, one root-element attribute, five structural guarantees that stay
outside this model.

#### Why the emitter is still deferred

Stage 35 stops at the representation. What exists now is a way to say what a
document value _is_ and who owns it; what does not exist is anything that turns
a resolved document into generated source. That remains a later stage, and it
now has a representation that will not force it to choose between lying about
what ClientKit knows and freezing a project the developer owns.

**Unchanged.** Zero goldens moved and no template, adapter behaviour or
architecture was touched. The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), `Next +
seo`, `+ structured-data` and `+ accessibility` remain refused,
`composed-metadata` remains ungranted on Next, React is untouched, the CLI still
has zero runtime dependencies, and the version stays 1.0.2.

### Stage 36 — bindings through the document pipeline (landed)

**Where Stage 34 stopped, and what Stage 35 built.** Stage 34 could not emit a
document because every resolved field was a generation-time fact, while Astro's
head is a set of expressions evaluated at the _generated project's_ build.
Stage 35 gave a value three forms — `literal`, `binding`, `derived` — and an
owner: `generation`, `project`, or `build-context`. This stage threads that
model through the existing pipeline.

#### Where bindings enter

At the **statement type**, not at the contract and not at the resolver:

```ts
interface MetadataStatement {
  readonly title?: DocumentValue<'text'>;
  readonly description?: DocumentValue<'text'>;
  readonly robots?: DocumentValue<'text'>;
  readonly canonical?: DocumentValue<'url'>;
  readonly openGraph?: DocumentValue<'open-graph'>;
  readonly twitter?: DocumentValue<'twitter'>;
}
```

`SeoContract` did not change. `metadataFromContract` lifts it into statements,
every one a literal, because a value the feature resolved from the manifest _is_
a generation-time fact — claiming otherwise would be the opposite lie from
Stage 34's. A contributor that knows better builds its statement directly and
states a binding.

**The resolver needed no logic change at all.** Stage 32 compares values
structurally, so it already handled whatever a field contains. That the
integration required zero resolver edits is the evidence the boundary is in the
right place.

#### Two new value types, and what they prove

`open-graph` and `twitter` joined the vocabulary so each social block is **one
value** rather than six fields. No binding and no derivation declares either
type, so `BindingOfType<'open-graph'>` is `never` — today a social block can
only be a literal, and **the compiler says so** instead of a comment. The Stage
32 coupling rule is now carried by the type system.

#### Kind is representation, not rank

The rule most at risk in this stage:

```text
three value kinds  ≠  three levels of authority
```

A binding does not beat a literal; a derivation does not beat either. At one
scope, any disagreement is a conflict — `literal` vs `binding`, `literal` vs
`derived`, `binding` vs `derived`, and differing values of the same kind all
raise, naming the field and both owners. Four mutations install kind precedence
and all four are caught.

Across scopes, **specificity** decides, exactly as Stage 33 established, and the
resolver never inspects a value's kind to choose:

| every-page                   | page.notFound               | result                    |
| ---------------------------- | --------------------------- | ------------------------- |
| `binding(site.name)`         | `literal('Page not found')` | the literal               |
| `derived(absolute-page-url)` | `literal('')`               | the empty literal         |
| `binding(site.description)`  | absent                      | the binding, inherited    |
| `derived(absolute-page-url)` | absent                      | the derivation, inherited |

#### Nothing is evaluated

The resolver never turns a binding or a derivation into a value. A test
serialises a fully resolved document and asserts it contains neither `Acme Ltd`
nor `https://acme.example` while containing `site.name` and
`absolute-page-url`. That is the Stage 34 failure guarded at the semantic layer.

#### Pages ClientKit has never heard of

`FileRole` is closed — `page.home` and `page.notFound` are the only pages the
generator can name — so a developer's `/contact` page can never be _scoped_.
That is not a gap, and this is the stage's sharpest point: the statement that
covers such a page is scoped to **every page** and carries a **derivation**, so
its address is computed per page at the project's build, for pages nobody
enumerated. A literal canonical could not do this, which is exactly why Stage
34's snapshot emitter would have left user-added pages with no canonical at all.

A test resolves the same every-page derivation at three targets and asserts it
comes back identical and unevaluated at each, and that no URL is fabricated for
any of them.

#### Canonical

All four states stay distinct: absent (no value), `literal('url','')` (this page
claims no canonical), `literal('url', …)` (this exact address), and
`derived('url','absolute-page-url')` (whichever page is rendering). The empty
literal still overrides an inherited derivation, and it does so through scope
specificity rather than by comparing representations.

#### Robots

Unchanged, and still a literal. The template also consults the project-owned
`SEO.noindex`, and `document.indexingBlocked` exists in the vocabulary for it —
but converting a flag into a directive string needs a _conditional_ derivation,
which Stage 35 deliberately did not model. Inventing one here to make robots
bindable would have been exactly the speculative expansion this line of stages
keeps refusing.

#### Title

`SeoContract.title` is a string, so the lift produces a literal. Astro composes
its title as `title ? \`${title} - ${SITE.name}\` : SITE.name`, which a faithful
emitter will eventually need as a *parameterised* derivation — one taking a page
title alongside `site.name`. Stage 35's derivations take bindings only, so that
form does not exist and was not invented. The pipeline is nonetheless proven to
carry `title: binding(site.name)` when a contributor states one.

#### Structured data and accessibility

Both unchanged. `OrganizationContract` stays a typed object with no binding
awareness; several of its template-emitted fields are project-owned and a
binding-aware variant remains deferred. Accessibility keeps its Stage 33
constraint — a page-scoped guarantee is still refused — and `DocumentValue` was
not used to route around it.

#### Provenance

Survives intact. Each composed field still reports its owners, its reasons and
the scope it came from, and an inherited binding reports `from: every-page`
while an overriding literal reports the page.

#### What is still deferred

The emitter. `ResolvedPageDocument` can now carry everything an emitter needs —
values that know who owns them, unevaluated — but nothing turns one into
generated source. Next remains refused, React is untouched, and no template
changed.

**Unchanged.** Zero goldens moved and no template or adapter behaviour was
touched. The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), the CLI
still has zero runtime dependencies, and the version stays 1.0.2.

### Stage 37 — parameterized document derivations (landed)

**The gap Stage 36 left.** Two document facts could not be represented. A title
is `title ? \`${title} - ${SITE.name}\` : SITE.name` — composed from a page part
that differs per contributor and a project-owned site name. A robots directive
follows the project's own indexing switch. Stage 35's derivations had a _fixed_
pair of bindings and no way to take an argument, so both stayed literals, and a
literal title freezes the site name into every page that states one.

#### A signature, not an expression tree

A derivation now declares an ordered **parameter signature** and a result type;
a value supplies the arguments.

```ts
DOCUMENT_DERIVATIONS = {
  'absolute-page-url': { type: 'url', parameters: ['url', 'path'] },
  'page-title-with-site-name': { type: 'text', parameters: ['text', 'text'] },
  'indexing-directive': { type: 'text', parameters: ['flag'] },
};
```

**Why this is not a general AST.** A derivation names _what happens_, never how
to compute it. There is no concatenation node, no conditional, no property
access, no call and no operator — the four things an expression tree is made of
are all absent, and a test fails if any of them appears. The vocabulary grows
only when a real document behaviour needs a name.

Arguments are typed position by position through a mapped tuple
(`DerivationArguments<D>`), so supplying a `url` where `text` is required is a
compile error. `assertDerivationInputs` repeats the check at boundaries where
types have been erased, recursively.

#### What the source actually says

Both derivations were read off `Seo.astro` rather than from the brief, and both
readings differ from what a summary would suggest.

**Title makes no absent/empty distinction.** The template tests truthiness, so
`undefined` and `''` behave identically. The model therefore makes no
distinction either — an empty page title is simply how a page says it adds
nothing. Inventing a distinction the source does not make would be modelling
behaviour that does not exist.

**Robots has two inputs, not one.** The template computes
`blocked = noindex || SEO.noindex` — a page's own opt-out **or** the project
switch. Only the switch is an input to `indexing-directive`, and the
disjunction is not missing: a page that opts out states its own directive at its
own scope, and **scope specificity is what combines the two**. Modelling `||`
would have added a boolean operator to a vocabulary that deliberately has none,
to express something the scope model already expresses. The template's default
`noindex = false` means "say nothing", not "say index", and absence is exactly
how the model says nothing.

#### Ownership

Still the least settled of the inputs, and the rule survives parameters
unchanged: a value is only as settled as its least settled ingredient. It is now
**recursive**, because an argument may itself be a derivation.

| Value                                              | Owner                                         |
| -------------------------------------------------- | --------------------------------------------- |
| `pageTitleWithSiteName(literal('Page not found'))` | `project` — half of it is still the project's |
| `derived(page-title…, literal, literal)`           | `generation` — nothing unsettled remains      |
| `indexingDirective()`                              | `project`                                     |
| `absolutePageUrl()`                                | `build-context`                               |

A title is **not** generation-owned merely because ClientKit knows the page
title and seeds the site name; the composed value is evaluated in the generated
project, so the project owns the result.

#### Equality became structural in fact, not just in name

Stage 32 has always described this equality as _structural_, and the
implementation compared with `JSON.stringify` — which preserves key insertion
order. That went unnoticed while every value came from the same constructors.
Derivations, which can be read back from JSON or assembled by hand, made the gap
reachable, so comparison now uses a canonical form with sorted keys.

**Array order is preserved.** `f(a, b)` is not `f(b, a)`: a title composed as
"Alpha - Beta" says something different from "Beta - Alpha", and sorting
arguments to tidy the comparison would silently merge two different statements.

#### Nesting

Permitted, because an argument is a value and a value may be derived. Cycles
cannot be built: values are immutable and assembled bottom-up, so one would have
to contain itself before it existed — the same reason Stage 27's wrapper
ordering needs no cycle detection. Depth is unbounded and every branch
terminates at a literal or a binding.

#### Nothing else moved

Same-scope disagreement is still a conflict with **no kind precedence** — a
derivation does not beat a literal and a literal does not beat a derivation.
Cross-scope override is still decided by specificity alone. Stance is unchanged:
a page suppression still beats an inherited derivation.

The 404 result is identical to Stage 36's. The page states its own title,
robots and canonical, so all three stay literals — the site-wide derivations do
not reach down and make them dynamic — while the site keeps all three derived.

`FileRole` is still closed, and a page nobody enumerated is still covered by an
every-page derivation that is never evaluated.

#### The Astro boundary

`src/adapters/astro-derivations.ts` declares **which derivations Astro can
realise** and nothing else. Separate from `astro-bindings.ts` on purpose: a
binding maps to one expression Astro already writes, while a derivation is an
operation whose realisation is emitter work. Keeping them in one file would
invite the spelling to be added alongside the mapping, which is the emitter
arriving by the back door. A test asserts the file contains no template
literal, no conditional and no directive string.

#### Why the emitter is still deferred

The vocabulary can now represent every dynamic document fact the shipped Astro
head computes, unevaluated and with ownership attached. Turning that into
generated source — deciding how Astro spells each operation, and where the
result is written — is the next stage's work. Nothing here is wired: Next
remains refused, React is untouched, and no template changed.

**Unchanged.** Zero goldens moved. The four V1 goldens are byte-identical
(`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`), the CLI
still has zero runtime dependencies, and the version stays 1.0.2.

### Stage 38 — the document emission boundary (landed)

**Where this sits.** Stage 34 stopped because resolved facts could not be
emitted without freezing the generated project. Stage 35 gave a value three
forms and an owner, Stage 36 threaded them through resolution, Stage 37 gave
derivations typed parameters. This stage draws the line those four were
building toward:

```text
ResolvedDocument  →  emission IR  →  architecture realization  →  (Stage 39)
```

Everything left of the IR is **semantics** — what the document says, which scope
won, who disagreed. Everything right of it is **spelling**. The IR exists so
neither side has to know the other.

#### What an emitter is handed

```ts
interface DocumentEmissionPlan {
  target: DocumentTarget;
  items: readonly DocumentEmissionItem[];
}
```

An emitter never sees a contribution, a scope, an owner's disagreement, a
feature, a manifest or a conflict — **it does not repeat resolution**. It sees a
list of document facts in a fixed order, each either stated or refused, and it
carries the target so a failure can name the page.

Seven fields, in this order: `title`, `description`, `robots`, `canonical`,
`open-graph`, `twitter`, `structured-data`. The order is semantic and is **not**
precedence; arbitration finished before the IR existed.

#### Three states, still three

| State      | Representation                            |
| ---------- | ----------------------------------------- |
| stated     | an item carrying a value                  |
| suppressed | an item carrying reasons and **no** value |
| absent     | no item at all                            |

A suppression is not an item with an empty value, and an absence is not a
suppression — an emitter that could not tell them apart would eventually fill a
gap somebody deliberately refused. A suppressed metadata statement produces a
suppressed item for _every_ metadata field, so none of them looks merely
unmentioned.

#### Nothing is evaluated

A binding stays a binding; a derivation stays a derivation with its arguments
intact, nested ones included. A test serialises a full plan and asserts it
contains neither `Acme Ltd` nor `https://acme.example` while containing
`site.name` and `absolute-page-url`. Turning those into values here would freeze
what the project owns — the Stage 34 failure, arriving one layer later.

#### No markup, ever

There is no `html`, `markup`, `source`, `expression` or `code` field anywhere in
the IR, and a test fails if one appears. An IR carrying a string of source would
have moved the framework back into the domain by the shortest possible route.

#### Canonical, all four states

| Input                        | IR                                             |
| ---------------------------- | ---------------------------------------------- |
| absent                       | no item                                        |
| `literal('')`                | an item stating emptiness — a claim, not a gap |
| `literal(url)`               | a fixed canonical                              |
| `derived(absolute-page-url)` | a dynamic canonical, unevaluated               |

A test asserts all four serialise differently.

#### The realization contract

```ts
interface RealizationSupport {
  architecture: string;
  bindings: readonly DocumentBinding[];
  derivations: readonly DocumentDerivation[];
}
```

A declaration, not a set of functions — _how_ an architecture writes any of it is
Stage 39's problem, and putting a function here would be that stage arriving
early. `bindingsRequiredBy` and `derivationsRequiredBy` report what a given plan
actually needs, which is how **required-for-this-plan** stays separate from
**known-but-unused**: a plan of literals requires nothing, and an architecture
supporting nothing can realise it.

`assertPlanRealizable` refuses anything the architecture cannot spell, naming the
field, the value, the architecture, the reason and the page. **There is no
fallback**: nothing is dropped, substituted, turned into a literal or fabricated.
A test asserts the plan is unchanged after a refusal.

#### Malformed values

The boundary also rejects what a cast can smuggle past the type system: a
binding or derivation outside the vocabulary, wrong argument types, wrong
argument counts, and values nested past any honest depth.

The depth bound is **not** a cycle detector. Stage 37 established that cycles
cannot be constructed — values are immutable, built bottom-up, and `JSON.parse`
cannot express one. What remains is a malformed value arriving through an erased
cast, where an unbounded walk would hang instead of failing. A bound turns that
into a named refusal for the cost of a counter, and the deepest thing the
vocabulary can honestly express is two levels.

#### Accessibility contributes nothing, and why

Its one valued fact is the document's language — and the shipped Astro layout
writes that as `lang={SITE.locale}`, a **binding**. `AccessibilityContract`
holds a generation-time snapshot of the same value, so emitting it would freeze
what the project owns: Stage 34's failure exactly. Representing it truthfully
needs a binding-aware accessibility contract, which stays deferred. The
remaining guarantees are body structure and assertions about the shell rather
than values, and belong to a document-structure boundary this stage does not
build.

#### Provenance

Each item carries the owners that claimed it, for diagnostics. The contribution
graph is **not** duplicated — a test asserts the plan contains no scope,
specificity or contribution machinery, so an emitter cannot re-run arbitration
even if it wanted to.

#### Ordering

From the vocabulary, by construction. The build walks `EMISSION_FIELDS`
directly; an earlier draft walked a `Record` literal and sorted afterwards,
which produced the right answer for the wrong reason — the record's keys already
matched, so the sort was unreachable and the real ordering came from object
insertion order. That is the dependence this layer exists to avoid, so the walk
was inverted and the sort removed rather than kept as a guard nobody could
prove.

#### Why Stage 39 is still ahead

Everything the Astro head computes is now representable, unevaluated, with
ownership attached, and Astro declares that it can realise all of it. What does
not exist is any code that decides how Astro _spells_ a binding or performs a
derivation, or where the result is written. That is Stage 39.

**Unchanged.** Zero goldens moved, no template touched. The four V1 goldens are
byte-identical (`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`),
Next remains refused, React is untouched, the CLI still has zero runtime
dependencies, and the version stays 1.0.2.

### Stage 40 — a composition-owned Astro document surface (landed)

Stage 39 stopped without writing an emitter. This stage builds the thing whose
absence stopped it: a place in the generated Astro project where a future
realization can render, which costs nothing when nothing renders there.

#### Why Stage 39 was blocked

The emission plan was complete and Astro declared it could realise every field
in it, but there was nowhere to put the result. Astro's document is spread
across `BaseLayout.astro`, `Seo.astro`, `StructuredData.astro` and the pages,
and every byte of all of them is captured by the four V1 goldens. V1 selects no
features, so there is no variant path through those files — any emitter that
wrote into them wrote into V1's bytes.

That left two moves, and Stage 39 refused both. Changing the goldens would
retire the only evidence that V1 still works. Generating a component nothing
imports would produce a file that exists, type-checks, builds, and is dead:
the failure mode where the pipeline looks finished because its output is
syntactically present.

#### The surface, and why it composes rather than replaces

`composeAstroDocumentHead` in `src/adapters/astro-document-surface.ts` takes the
planned file operations and a list of head entries, and returns operations. With
no entries it returns the array it was given, by reference:

```text
no contributions  ->  no component, no import, no change
contributions     ->  a component, imported, rendered after <Seo />
```

The reference return is the point. The default path is byte-identical because it
performs no work — not because it carefully reconstructs the original output and
is checked against it. A reconstruction can be subtly wrong; doing nothing
cannot. It is wired into the bridge in its no-op form deliberately, so the V1
goldens prove the identity on every run rather than the code path sitting
unexercised until something first contributes.

When entries do arrive, the component is written at the path the architecture
maps to `app.document.head`, an import is spliced after the shell's last existing
frontmatter import, and `<DocumentHead />` is inserted after an anchor line in
the shell. Neither path is a literal here: both come from `resolveRole`, because
where Astro keeps its layouts is Astro's decision and copying it into the
composer would give that decision two homes that drift.

#### The anchor

`ASTRO_HEAD_ANCHOR` is the shell's `<Seo … />` line, matched exactly once. Astro's
head is ordered — the descriptive tags come from `<Seo />` and composed entries
follow them — so the insertion point is part of the architecture rather than
somewhere convenient. Finding zero or two occurrences is refused rather than
guessed at, and a test matches the constant against the shipped template, so a
template edit that moved the line fails at the boundary instead of quietly
placing composed entries where nobody chose.

#### Template ownership versus composition ownership

`src/domain/document-surface.ts` is the model, and it is pure domain — it knows
the emission vocabulary and that somebody owns each field, and nothing about
Astro. An architecture declares which fields its composed surface may emit;
everything else in `EMISSION_FIELDS` is template-owned by omission, which is the
safe default, since a field nobody thought about stays with the implementation
that already works.

Ownership is **not** arbitration. Which _value_ a field carries was settled by
Stages 31–33. This says only who renders it, and nothing in the file reads a
scope, a contributor, a conflict or a precedence rule.

#### Partial ownership, and why Twitter is not composed

Astro composes `title`, `description`, `robots`, `canonical` and `open-graph`.
It keeps `twitter` and `structured-data`, each with a stated reason, because for
those two the shipped template is **more capable than the semantic contract**:

- `Seo.astro` upgrades `twitter:card` to `SEO.twitterCard` once a social image
  is configured and emits `twitter:image`; `TwitterContract` hard-codes
  `'summary'` and models no image at all.
- `StructuredData.astro` emits email, telephone, `sameAs` and a location from the
  project configuration; `OrganizationContract` carries none of them.

So "replace the template's head with the composed one" is not a refactor, it is
a regression, and the ownership split exists to say so precisely. Open Graph
splits cleanly — the semantic block's six fields are disjoint from `og:image`,
which stays with `Seo.astro`. Twitter does not split, because `card` is claimed
by both sides with the template winning, so it stays template-owned whole rather
than being carved up field by field inside a field.

#### Preventing the document that says everything twice

Two guards, because there are two ways to get there. A declaration listing a
field as composed _and_ giving it a template-owned reason contradicts itself and
is refused when it is read. A contribution aimed at a field the architecture
keeps is refused when it arrives, naming the reason the template owns it.

Both failures produce valid Astro that builds without complaint and renders two
`<title>` elements, or two `twitter:card` metas with different values. They are
structurally detectable, so they are detected here rather than in a browser.

#### Values the project owns stay the project's

Nothing about this changes where the document's dynamic values come from. A
generated project was edited after generation — site name, URL, description and
locale — and rebuilt **without re-running ClientKit**; the head followed:
`<html lang="fr-FR">`, the new title, the new description, and a canonical on
the new origin. A page the user added afterwards got the same treatment:
`Contact - Renamed Ltd` and a canonical at `/contact/`. The composed surface is
a render site, not a snapshot, and Stage 34's failure — freezing build-time
values into shipped source — is not reintroduced.

#### 404 and the rest of the existing document

The 404 page still passes `noindex={true}`, still emits `robots: noindex,
nofollow`, still carries no canonical and no JSON-LD, while the home page
carries exactly one title and one JSON-LD block. None of that is new behaviour;
it is behaviour that had to survive, and it is now asserted rather than assumed.

#### Capability contract interaction

`app.document.head` joins the semantic roles as the first **composed** role —
mapped by the architecture, but generated rather than shipped. Stage 28's
invariant that every mapped role points at a file the template actually ships
now skips composed roles, and gains an inverse: a composed role whose path the
template _does_ ship is refused, because that is the collision where a generated
file and a shipped file claim the same place. The capability contract itself is
unchanged; no capability was reclassified and no surface changed its `via`.

#### Synthetic validation

Stage 40 ships no contributor — realization is a later stage — so the render
path is proven by a synthetic one in the tests: entries in, component out,
imported and rendered inside `<head>`, at the mapped path, in an order that comes
from the document vocabulary rather than from arrival (six permutations, one
result). That the production wiring passes an empty list is exactly why the
goldens can prove byte-identity; the synthetic path is what proves the other
branch is not vapour.

#### Why realization is still ahead

What exists now is a place to render and a statement of what may be rendered
there. What does not exist is any code that turns a `DocumentEmissionPlan` into
Astro source — no binding is spelled, no derivation is performed, no plan is
consumed. The bridge passes an empty list of entries and nothing in the
repository passes a non-empty one outside the tests. **The Astro emitter is not
implemented.** This stage answers only "where can a realization safely render?",
which is the question Stage 39 could not answer and the reason it stopped.

#### Next.js and React remain untouched

Next is still refused at selection. React has no document surface declaration,
because nothing has established what React's document _is_ — the provider-shell
pattern that describes its component tree does not describe a head. Declaring
ownership for an architecture whose render site nobody has identified would be
inventing the answer rather than recording it.

#### Mutation testing

24 mutations, zero survivors. Beyond the obvious guards, four mutate shipped
template bytes rather than source, on the grounds that "the existing document
keeps working" is only worth asserting if a regression in the template is caught
too: dropping `noindex` from 404, flattening the `twitter:card` upgrade, moving
the anchor line, and shipping a file at the composed role's path. The two Stage
39 named as the real risks — a component generated but never rendered, and a
field composed that the template already owns — are mutated directly and caught
by the tests written for them.

**Unchanged.** Zero goldens moved, no template byte edited. The four V1 goldens
are byte-identical (`812c438185ecb2317cc5d741e7f83f1a06750f2a83e9b22551205eb60d4dbc0d`),
no `DocumentHead.astro` is generated by any real selection, Next remains refused,
React is untouched, the CLI still has zero runtime dependencies, and the version
stays 1.0.2.

#### Known limitations

1. No realization. Nothing converts an emission plan into head entries, so the
   composed surface is inert in every generated project today.
2. Astro only. The ownership model is architecture-neutral; exactly one
   architecture declares against it.
3. The composed surface is head-only. `app.document.body` and the rest of the
   document shell have no surface, and the structural guarantees Stage 38
   deferred are still deferred.
4. `twitter` and `structured-data` are template-owned indefinitely, not
   temporarily. Composing them needs the semantic contracts to grow an image
   model and contact/location fields first; until then the split is the honest
   description, not a migration step.
5. The anchor is a line match. It is verified against the shipped template by a
   test, but a template refactor still has to be accompanied by an anchor update
   — the coupling is checked, not eliminated.
6. Ordering inside the composed head is alphabetical by field. It is
   deterministic and it is not precedence; if a future architecture needs head
   order to carry meaning, it will need to say so explicitly rather than rely on
   this.
7. The render site is the shell, so it is per-project, not per-page. A real
   build with a synthetic contributor confirmed the composed entries appear on
   every page that uses `BaseLayout.astro`, the 404 included. The 404's own
   semantics are untouched — it still asks not to be indexed, carries no
   canonical and no JSON-LD — but a composed entry today is site-wide. Anything
   page-varying needs the entries to be computed per page and threaded through
   the layout, which is realization's problem, not the surface's.
