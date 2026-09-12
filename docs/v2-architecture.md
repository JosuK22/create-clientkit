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
