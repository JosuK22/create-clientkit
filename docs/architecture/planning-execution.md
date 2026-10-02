# Planning and execution

Where ClientKit is allowed to change a project, and where it is not.

**The rule:** planning describes what ClientKit would do. Execution is the only
layer that writes to the filesystem or starts a process, and it runs only what
planning already decided and a person (or the absence of any conflict)
approved.

```text
CLI input / --from / prompts
  ↓
Resolution                resolveContext()                    src/context/resolve.ts
  ↓
Template resolution       template catalog                    src/adapters/template-catalog.ts
  ↓
Template validation       validateTemplate()                  src/templates/validation.ts
  ↓
Generation Plan           planManifest() → plan()             src/adapters/bridge.ts, src/generate/plan.ts
  ↓
Existing state            inspectTarget()                     src/commands/regenerate.ts
  ↓                       comparePlan() / observeTarget()     src/generate/compare.ts
Change analysis / diff    analyzeChanges(), diffText()        src/generate/changes.ts, diff.ts
  ↓
Post-step plan            planPostSteps()                     src/generate/postStepPlan.ts
  ↓
UI                        renderDryRun(), renderChanges()     src/ui/plan.ts
  ↓                       ── a dry run stops here ──
Questions                 the conflict / non-empty question   src/commands/create.ts, upgrade.ts
  ↓
Execution decision        decideExecution()                   src/commands/regenerate.ts
══════════════════════════ EXECUTION BOUNDARY ══════════════════════════════════
  ↓
Filesystem mutation       apply()                             src/generate/apply.ts
  ↓
Post steps                runPostSteps()                      src/generate/postSteps.ts
```

Everything above the boundary is safe to run, repeat and test against a real
project: it reads, and it returns data.

## Where ClientKit may change a project

In exactly two modules:

| Module                      | Owns                                                                    | Called from                     |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| `src/generate/apply.ts`     | every write, copy, directory creation, rename and removal               | `create`, `upgrade`             |
| `src/generate/postSteps.ts` | every process ClientKit starts: the package manager install, `git init` | `create`, after `apply` returns |

Nothing else in `src` imports a `node:fs` function that writes, or
`node:child_process` at all. `test/execution-boundary.test.ts` scans the source
and fails if that changes, and it also forbids `require()`, dynamic `import()`
and `process.chdir()`, so neither rule can be got round quietly.

## Planning may

- resolve the configuration, and read templates, the catalog and the project;
- validate templates and the catalog;
- build the Generation Plan;
- compare the plan with the files on disk, analyse changes, compute diffs;
- decide which post steps a run needs, and describe their exact commands;
- produce diagnostics (`detect`, `doctor`) and the dry-run preview.

## Planning must not

- write, create, copy, rename or delete anything, anywhere, including
  temporary files, caches, `package.json`, lockfiles and `.client-site.json`;
- start any process: no npm, pnpm, yarn or bun, no git, no project script, no
  framework CLI;
- change git state: no init, commit, index, config or branch change;
- depend on whether planning ran before. There is no hidden mutable state, and
  the plan is never changed after it is built. The tests deep-freeze every
  plan the planner returns and run a whole `create` against it.

`detect` and `doctor` are planning in this sense. They diagnose and never
repair. A finding that needs a change names the command that makes it.

## Execution

`apply(plan, { allowNonEmpty, expected })` takes a Generation Plan and makes it
true on disk. It does not resolve a stack, read a template, compare files or
choose a file set. Every path it writes is in the plan it was handed, and only
those. Its own checks are execution-time safety checks, not a second planner:

- every destination stays inside the target directory;
- a directory where a file should go is refused, never replaced;
- a non-empty target needs `allowNonEmpty`, which only a decision grants;
- **every path still holds what it held when the decision was made**
  (`expected`, below);
- everything is staged in a sibling directory first. A new project is
  published with one rename. A merge moves files one at a time with backups,
  and restores them all on failure.

### The execution decision

For a project ClientKit generated, `decideExecution()` turns the decision into
exactly what the executor may do, once every question has been answered:

```ts
interface ExecutionDecision {
  plan: GenerationPlan; // the Generation Plan, narrowed to the decided paths
  expected: TargetObservation; // what each planned path held when it was compared
  postSteps: readonly PostStep[]; // the steps that follow these writes; none if nothing is written
}
```

The narrowed plan is not a new plan. Its operations are the Generation Plan's
own, in its order, with its content (`narrowPlan`). A refused or declined
conflict narrows it to nothing, and the commands return before reaching
`apply` at all.

A first generation, or one into a directory ClientKit did not generate, passes
the full plan and an `observeTarget()` taken before its question.

## Post steps

Post steps are planned, then executed:

```text
manifest.postSteps ──► postStepsAfter()   which steps this run needs         regenerate.ts
                  ──► planPostSteps()     the exact command, or why skipped   postStepPlan.ts
                  ──► runPostSteps()      runs exactly those commands         postSteps.ts
```

`planPostSteps` only describes commands, and the dry run shows its output.
`runPostSteps` executes from the same function, so the preview cannot describe
a command the real run would not use. Commands and arguments are CLI-owned
constants; a template can only name an identifier from a fixed list.

Post steps run only after `apply` returned successfully. A run that writes
nothing runs none. A re-run installs only if it wrote `package.json`, and runs
`git init` only if there is no `.git`. `upgrade` runs none.

## The dry run

`--dry-run` builds the same plan, makes the same target inspection, comparison,
change analysis and post-step plan as a real run, prints them, and returns. It
never reaches `apply()` or `runPostSteps()`, asks no question and starts no
process. That is tested structurally: the suite records every mutating
`node:fs` call, every `node:child_process` call and every call into the
executor while a dry run runs, and requires all three to be empty, and the
project to be byte-for-byte unchanged, `.git` included.

## `--yes` and the question

`--yes` only changes who may answer. It selects a prompter that cannot agree to
replacing a file, so a run with a conflict and `--yes` (or no terminal) stops
before execution and writes nothing. The plan and the analysis are the same
with or without it.

Interactively, the question comes after the whole analysis and before any
write. A run never writes some files and then asks about the rest. A "no"
writes nothing, not even the missing files that needed no question.

## Between deciding and writing

A person may take minutes to answer, and anything can change the project
meanwhile: an editor saving, a formatter, a `git checkout`. The plan was right
about the project as it was.

So the decision records what it saw. `comparePlan()` keeps, from the reads it
already makes, an observation of every planned path: absent, not a file, or the
SHA-256 of its bytes. `observeTarget()` makes the same observation for a run
that does not compare content. Just before anything reaches the target, after
staging, `apply` observes each path it is about to write again. If any differs,
because a file appeared, was edited again or was removed, it writes nothing and
says which:

```text
x 1 file(s) changed after ClientKit checked them, so nothing was written.
    README.md
Something else modified the project while this run was deciding. Run the command again to review it as it is now.
```

What this does and does not guarantee:

- It catches any change made between the analysis and the start of
  publishing, which in practice is the time a person spends answering.
- It cannot close the window completely. A change made in the milliseconds
  between the final check and the rename that publishes a file is not seen.
  ClientKit takes no locks, and the filesystem offers no portable
  compare-and-swap. Closing that window would need a locking system, and this
  is deliberately not one.
- Files the run does not write are not checked. A file decided `unchanged`
  that changes meanwhile is simply not written, so nothing of it is lost.
- Files the plan does not name are never read or touched, before or after.

## Dependency direction

```text
resolution → templates → planning → change analysis → execution
```

- Planning modules (`generate/plan.ts`, `compare.ts`, `changes.ts`, `diff.ts`,
  `postStepPlan.ts`, `commands/regenerate.ts`) never import `apply.ts` or
  `postSteps.ts`.
- The executor may import plan types and the read-only observation it checks
  against (`compare.ts`). Nothing points the other way.
- `ui/plan.ts` imports only post-step types.
- Only `commands/create.ts` and `commands/upgrade.ts` import `apply`. Only
  `commands/create.ts` imports `runPostSteps`.

## Not included

No locking, no rollback after a successful run, no merge engine, and no
retrying a write that failed its check. A refused run is simply run again.
