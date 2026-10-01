# The Generation Plan

Internal architecture. Nothing here is a public API or a new CLI feature.

ClientKit decides everything a run will write before it writes any of it. The
decision is a `GenerationPlan`, a plain data value, and a separate executor is
the only code that turns a plan into files.

```text
CLI flags / --from file / prompts
  ↓
Resolution         resolveContext()           src/context/resolve.ts
  ↓                ProjectManifest + ProjectContext
Adapters           selection + compatibility  src/adapters/selection.ts
  ↓                Contribution[]
Planning           planManifest()             src/adapters/bridge.ts
  ↓                  └ plan()                 src/generate/plan.ts
GenerationPlan                                src/generate/files.ts
  ↓
Execution          apply()                    src/generate/apply.ts
  ↓                runPostSteps()             src/generate/postSteps.ts
Files on disk, then install / git init
```

## Why planning and execution are separate

- **Nothing is half-written.** Every refusal — an incompatible stack, a missing
  required file, two adapters claiming one path, an unsafe path — happens while
  planning, before the target directory is touched.
- **The plan can be looked at.** `create --dry-run` prints it, `upgrade` lists
  the files it would replace before asking, and the golden snapshots in
  `test/golden/` pin it byte for byte.
- **Adapters only describe.** No adapter imports `node:fs` or
  `node:child_process`; a test enforces it. Adapters return contributions; the
  planner composes them; the executor applies the result.

## What a plan contains

```ts
interface GenerationPlan {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly mode: string;
  readonly targetDir: string;
  readonly operations: readonly FileOperation[];
}

type FileOperation =
  | { type: 'write'; path: string; content: string; origin: string }
  | { type: 'copy'; path: string; source: string; origin: string };
```

`write` carries final text content, generated once during planning. `copy`
names a binary asset inside the template; it is never read into memory or
token-substituted. `origin` records which template layer or adapter produced
the file and is diagnostic only.

**Dependencies and scripts** are part of the planned `package.json` write,
composed from adapter contributions (`src/domain/package-composition.ts`). The
same data in structured form — each package, its version and kind, and every
adapter that asked for it and why — is returned alongside the plan as
`AdapterPlanResult.composedPackage`. There is deliberately no second list in
the plan, so the two cannot disagree. Installing is a post-step run after
`apply()`, never during planning.

**Create versus replace** is not recorded in the plan. It depends on what is
already in the target, not on the configuration, so recording it would make
identical inputs plan differently in two directories. The executor boundary
answers it instead: `findCollisions()` before the confirmation question,
`ApplyResult.overwritten` afterwards.

**Delete** does not exist. ClientKit never deletes a developer's file; an
upgrade reports paths the stack no longer generates and leaves them in place.

## Guarantees

| Guarantee                                    | Where it is enforced                             |
| -------------------------------------------- | ------------------------------------------------ |
| Planning reads templates and nothing else    | `planManifest`, `plan()`; adapters import no I/O |
| Same inputs, same plan                       | `generatedAt` is an input; no randomness         |
| Stable order                                 | `comparePlanPaths` (collation pinned to `en`)    |
| Canonical relative POSIX paths               | `normalisePlanPath`, `assertValidPlan`           |
| No path escapes the target                   | planner (`assertValidPlan`) **and** executor     |
| One operation per path                       | `assertValidPlan`, `mergeComposed`               |
| All-or-nothing writes                        | `apply()` stages in a sibling directory          |
| Files the plan does not name are not touched | `apply()` merge path                             |

The executor re-checks every path even though the planner already has. A plan
is plain data and could reach `apply()` without passing through the planner;
the mutation boundary is the last place a mistake can be stopped.

## Errors

Both are `CliError` subclasses, so they print and exit exactly as before:

- `PlanningError` — anything `planManifest` refuses: incompatible
  configuration, invalid template or mode, a missing required file, an invalid
  or duplicated path. Nothing has been written.
- `ExecutionError` — anything `apply()` fails on: a non-empty target, a
  directory where a file should go, a refused path, a filesystem error. The
  target is left as it was.

## Debugging

With `--debug`, `create` and `upgrade` log a summary of the plan to stderr. For
React + Tailwind:

```text
debug [planner] 21 file operations (20 write, 1 copy)
debug [planner] 9 dependency operations (2 prod, 7 dev)
debug [planner] 4 script operations
```

`create --dry-run --debug` prints the plan itself.

## Status

The Generation Plan is an internal architecture, not a public interface. The
published package ships only the `create-clientkit` binary and exports none of
these types or functions, and the plan's shape may change in any release.

`--dry-run` predates this document and prints a human-readable rendering of the
plan. There is no machine-readable plan output, diff view, rollback, or
conflict resolution beyond the existing replace-confirmation.

Where a plan's template comes from, and how it is validated before planning, is
described in [templates.md](./templates.md).

What a plan guarantees about repeatability - same inputs, same plan - is
described in [deterministic-generation.md](./deterministic-generation.md).

What happens when a plan meets a project ClientKit already generated is
described in [idempotent-generation.md](./idempotent-generation.md).

How each planned file relates to an existing project, and the diff shown for
it, is described in [change-analysis.md](./change-analysis.md).
