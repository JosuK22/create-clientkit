# Deterministic generation

ClientKit generates the same project from the same inputs. This page says
exactly what that means, what counts as an input, and how it is held.

## The contract

For a fixed ClientKit version, the same **inputs** produce the same:

- resolved stack and configuration;
- template, and template file list in the same order;
- Generation Plan: the same operations, in the same order, with the same
  types, destinations, sources and contents;
- generated files, byte for byte, text and binary.

The **inputs** are:

| Input             | Where it comes from                                                                   |
| ----------------- | ------------------------------------------------------------------------------------- |
| Flags and answers | the command line, the prompts, `--from` config                                        |
| Target directory  | resolved to one absolute path, however it was written                                 |
| Package manager   | `--pm`, else the `npm_config_user_agent` npm sets when it runs `npm create`, else npm |
| Generation time   | the moment of the run; it reaches only `generatedAt` in `.client-site.json`           |
| ClientKit version | recorded in `.client-site.json`                                                       |

Nothing else reaches generated output. In particular, none of these do: the
working directory, the order a filesystem lists directories in, the machine's
locale or time zone, the user name, home directory or shell, the process id,
and any other environment variable. Tests check each of them.

### The one exception

`.client-site.json` records `generatedAt`, the time the project was generated.
It is the only generated value that changes between two otherwise identical
runs, and it is there on purpose: it is part of the project's record. Every
other byte of every file is the same. No template uses the `{{year}}` token
today; if one did, the year would be a second value taken from the generation
time.

The target directory's absolute path is part of the plan (`targetDir`), because
the plan has to say where it writes. It never appears in a generated file.

## The Generation Plan is the boundary

Determinism is guaranteed and tested at the plan, before anything is written:

```text
CLI input ─► resolver ─► template catalog ─► template validation ─► Generation Plan ─► apply
   │            │                │                   │                     │
   │   one canonical config   ordered by id    issues in fixed order   operations sorted
   │                                                                    by destination
   └── equivalent spellings (./x, x/, a/../x; --features a,b vs --features b --features a)
       resolve to the same configuration
```

`apply` writes the plan's operations as given. Its temporary staging directory
has a random name, which never survives the run. A new target is published by
renaming the staging directory to it. Writing into an existing directory moves
the files in one by one, then deletes the staging directory.

## Canonical ordering

Everything that decides an order in generation goes through one comparator,
`compareText` in `src/util/order.ts`: an `Intl.Collator` pinned to `en`.
`comparePlanPaths`, which orders plan operations, is that comparator. So are
the orders in which:

- template layers are applied;
- adapter-contributed files are applied, and so which one wins;
- JSON merges run, and so the merged content;
- adapters are selected;
- Astro bindings and document fields are emitted;
- compatibility problems are listed.

Until Stage 6, six of these sorts used a bare `localeCompare`, which takes the
machine's default locale. On an English-locale machine that orders exactly as
the pinned collator does, which is why no generated output or golden snapshot
changes. On a machine set to another language, the same sorts could order
differently. A test now fails if a bare `localeCompare` or an unpinned
`Intl.Collator` appears anywhere in `src/`.

Plain `.sort()` with no comparator compares UTF-16 code units. It depends on
no locale, and is used where no person reads the order, such as dependency
names and feature ids.

Directory listings are never trusted to be in order. The planner, template
validation and the template catalog sort what they read, and tests feed them
reversed and rotated listings and require the same result.

## Paths

A target resolves to one absolute path from the working directory, so
`acme`, `./acme`, `acme/`, `x/../acme` and the absolute path, from wherever
they are run, give the same plan. On Windows `\` and `/` are equivalent.
Plan paths are POSIX, relative and canonical, and the plan's path checks
refuse anything that could leave the target. They are unchanged, and are
described in [generation-plan.md](./generation-plan.md).

## How it is tested

| Dimension          | Varied                                                                        | Where                      |
| ------------------ | ----------------------------------------------------------------------------- | -------------------------- |
| Repetition         | the same plan five times, and interleaved with others                         | `test/determinism.test.ts` |
| Directory listings | reversed and rotated, for every stack in the matrix                           | `test/determinism.test.ts` |
| Catalog, adapters  | enumerated in reverse                                                         | `test/determinism.test.ts` |
| Layers, merges     | contributions reversed                                                        | `test/determinism.test.ts` |
| Locale             | Turkish collation for every locale-default comparison; comparison unavailable | `test/determinism.test.ts` |
| Target path        | relative, absolute, redundant, other working directories                      | `test/determinism.test.ts` |
| Environment        | user, home, shell, locale, time zone set; package manager                     | `test/determinism.test.ts` |
| Time               | two generation times: only `generatedAt` differs                              | `test/determinism.test.ts` |
| CLI spellings      | defaults implicit and explicit, feature lists reordered                       | `test/determinism.test.ts` |
| Process            | the same dry run in fresh processes                                           | `scripts/smoke.mjs`        |
| Locale, for real   | a fresh process under `LC_ALL=tr_TR.UTF-8`                                    | `scripts/smoke.mjs`        |
| Generation         | two real generations: same files, same bytes                                  | `scripts/smoke.mjs`        |
| Package            | the installed tarball plans what the source tree plans                        | `scripts/smoke.mjs`        |

Two notes on locale. Node takes its default locale from the environment on
Linux and macOS but from the operating system on Windows, so the fresh-process
Turkish run exercises Turkish only on the first two. The in-process tests
replace every locale-default comparison instead, and work on all three. For
today's adapter names, Turkish and English happen to order the same way, so
the test that catches a regression is the one that makes locale-default
comparison throw: any use of it during generation fails, whatever the names.

## Not in scope

Determinism is about the plan for a set of inputs. What happens when that plan
meets a project ClientKit already generated is described in
[idempotent-generation.md](./idempotent-generation.md). Diffing and rolling
back are not features.
