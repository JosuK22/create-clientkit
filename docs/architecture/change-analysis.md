# Change analysis and diff

What ClientKit shows, and decides, when a Generation Plan meets a project it
already generated.

```text
Generation Plan           what ClientKit intends to write            src/generate/plan.ts, bridge.ts
      ↓
comparePlan()             each planned file vs the disk              src/generate/compare.ts
      ↓
analyzeChanges()          the change analysis: one kind per file     src/generate/changes.ts
      ↓
  ┌───────────────────────┴──────────────────────┐
  ↓                                              ↓
renderChanges() + diff    for a person           outcomeOf()   what the run writes
src/ui/plan.ts            src/generate/diff.ts                  src/generate/changes.ts
```

Three separate things:

- The **plan** says what ClientKit intends to write. It knows nothing about the
  disk.
- The **change analysis** is how each planned file relates to the project as it
  is. It is data: a `ChangeSet` of `FileChange`s.
- The **diff** is a rendering of that analysis for a person. Nothing reads it
  back, and nothing applies it.

`--dry-run` and a real run read the same analysis, so a preview lists exactly
what a confirmed run then writes. `create` and `upgrade` read it too, so they
cannot classify a file differently.

## The kinds

| Kind        | Mark | When                                                                                                | A run          |
| ----------- | ---- | --------------------------------------------------------------------------------------------------- | -------------- |
| `create`    | `+`  | the file does not exist, and the configuration the project records never generated it               | writes it      |
| `restore`   | `+`  | the file does not exist, but the recorded configuration generated it: it was removed                | writes it      |
| `modify`    | `~`  | the file exists, differs, and is ClientKit's own to rewrite. Only `.client-site.json` is ever this. | writes it      |
| `conflict`  | `!`  | the file exists and differs, and may hold your edit                                                 | only if agreed |
| `unchanged` | `=`  | the file is already exactly as planned                                                              | never writes   |

Every planned file has exactly one kind. A file the plan does not name is never
read, never listed and never touched.

**Create or restore** comes from the files the recorded configuration
generates, which `upgrade` already plans (`planUpgrade`). If that configuration
can no longer be planned, every missing file is a `create`. ClientKit never
guesses a restore.

**Conflict** is the rule from
[idempotent generation](./idempotent-generation.md). ClientKit keeps no record
of the bytes it once wrote, so a file that differs could be your edit, or a
file from another configuration or an earlier release. All are treated as your
work.

**`.client-site.json`** is `modify` when what it records changes, or when
anything else is written, so it always describes the last generation. It is
`unchanged` when only `generatedAt` and `cliVersion` would differ, and never a
conflict.

## What a run does: the outcome

`outcomeOf(changes, conflictsAgreed)`:

- With no conflict, or with conflicts agreed to, every file that is not
  `unchanged` is written.
- With a conflict not agreed to, the run writes **nothing**, and every pending
  change is reported as skipped. That's what `--yes`, a run without a terminal,
  and a person's "no" all mean. A run never applies half of what it showed.

There is no separate `skip` kind in the analysis. A planned file is skipped
either because it is `unchanged`, or because the whole run was blocked. Both are
already represented.

## The diff

A conflict's diff is computed only for a preview (`--dry-run`). A real run
needs the decision, not the diff.

- **Line diff:** longest common subsequence over lines, with a fixed
  tie-break, so the same two texts always give the same diff. Removed lines are
  `-`, added `+`, with two lines of context and `…` where unchanged lines are
  skipped. A missing final newline shows up as a change, and so do CRLF line
  endings. No dependency: it's `src/generate/diff.ts`.
- **Binary files:** a copied file (`.gitattributes`, images) is compared as
  bytes and shown as `(binary changed)`, never dumped.
- **Bounded:** a file over 2,000 lines on either side isn't diffed. The preview
  says `diff omitted` with both line counts. A diff stops after 40 lines and
  counts the rest. Both limits are constants in `diff.ts`.
- **Determinism:** changes are ordered by kind (create, restore, modify,
  conflict, unchanged), then by the plan's pinned path order. The diff depends
  only on the two texts. See
  [deterministic-generation.md](./deterministic-generation.md).

## What it looks like

`create --dry-run` (and `upgrade --dry-run`) on a project whose README was
edited and whose home page was deleted:

```text
Files to create (0)

Files to restore (1)
  + src/pages/index.astro

Files to modify (1)
  ~ .client-site.json

Conflicts (1)
  ! README.md
      differs from what ClientKit would write now - possibly your edit
        `"license": "UNLICENSED"`), because client work is normally proprietary. Change
        that in `package.json` if the site is meant to be open source.
      - Our notes.

Unchanged (19)
  already exactly as planned; --debug lists them

Changes
  0 files to create
  1 file to restore
  1 file to modify
  1 conflict
  19 files unchanged
```

`--debug` lists the unchanged files too, with the reason for every file.

## Directories ClientKit did not generate

No analysis and no diff. Without a usable `.client-site.json` there is no
record of which files are ClientKit's, so a diff would claim knowledge of
ownership ClientKit does not have. The preview keeps its create/replace list
and says why it cannot tell which files are yours.

## Not included

No machine-readable output: the `ChangeSet` is internal, and the CLI has no
`--json` yet. No patch files, merging, conflict resolution or rollback. The
diff is only shown, never applied.
