# Project detection

`create-clientkit detect [directory]` reports what an existing project is built
with, the evidence for each answer, and whether ClientKit supports that stack.
It reads; it never changes anything.

```text
Existing project
  ↓
Detection          detectProject()          src/detect/detect.ts
  ↓                ProjectDetection         raw findings + evidence
Resolution         resolveDetectedStack()   src/detect/stack.ts
  ↓                  resolveDimensions        src/context/dimensions.ts
  ↓                  assertFrameworkOffers
  ↓                  checkCompatibility       src/adapters/selection.ts
ClientKit stack    or the resolver's reason it is not one
```

**Detection discovers. Resolution normalises.** The detector only says what the
project's files show. Turning that into a ClientKit stack goes through the same
three checks a set of flags goes through, in the same order, so there is no
second configuration system and no second opinion on what is supported.

## What it reads

- One listing of the given directory. Nothing below it is opened, so
  `node_modules`, `.git`, `dist` and source files are never read, and
  `npm install` is not needed first.
- `package.json` — `dependencies`, `devDependencies`, `name` and
  `packageManager`. A file over 1 MiB, or a link to a file outside the project,
  is not read.
- The **names** of lockfiles and configuration files at the root. No lockfile
  is ever opened.

It does not search parent directories, run a package manager or a project
script, or use the network. Nothing it is given can write: the filesystem
interface it takes has no write operation. A test snapshots a project's files,
contents and timestamps before and after `detect` and requires them to match.

## Evidence and precedence

| Dimension       | Established by                                                                 | Corroborated by (never alone)                     |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| Framework       | `package.json` dependency                                                      | `astro.config.*`, `next.config.*`, `angular.json` |
| Build tool      | `package.json` dependency                                                      | `vite.config.*` and the framework configs         |
| Language        | `tsconfig.json` or `typescript` → `ts`; `jsconfig.json` → `js`; neither → `js` | —                                                 |
| Styling         | `package.json` dependency                                                      | `tailwind.config.*`                               |
| UI library      | `package.json` dependency                                                      | —                                                 |
| Router          | `package.json` dependency                                                      | —                                                 |
| Package manager | lockfile name, `packageManager` field                                          | —                                                 |

A configuration file on its own establishes nothing: a stray `vite.config.ts`
in a project that does not depend on Vite says nothing reliable. Language is
the exception, because `tsconfig.json` is what makes a project TypeScript; a
project with both `tsconfig.json` and `jsconfig.json` is `ts`.

Lockfiles: `package-lock.json` and `npm-shrinkwrap.json` (npm),
`pnpm-lock.yaml` (pnpm), `yarn.lock` (yarn), `bun.lock` and `bun.lockb` (bun).

A framework that owns its build tooling outranks one that does not. A project
listing `next` and `react` is Next.js, and one listing `astro` and `react` is
Astro. Two owners together (`astro` and `next`) are ambiguous.

The signatures live in `src/detect/signatures.ts`, keyed by the domain's own id
types, so adding an id to `src/domain/dimensions.ts` does not compile until
detection says what it looks like. A test plans every stack ClientKit accepts,
detects each planned project, and requires the resolver to return the same
stack. The detector and the adapters therefore cannot quietly disagree.

## Outcomes

Every dimension reports one of:

| Status        | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `detected`    | One value, in ClientKit's vocabulary.                                    |
| `unsupported` | One value ClientKit has no name for, such as Vue or Gatsby.              |
| `ambiguous`   | More than one candidate of equal rank.                                   |
| `absent`      | `package.json` was read and lists none of the known packages.            |
| `unknown`     | Nothing to read it from: an empty directory or no usable `package.json`. |

- An **unsupported** value is named, never mapped to the nearest supported one.
- An **ambiguous** value is never picked from. Two lockfiles, or a lockfile and
  a `packageManager` field that disagree, count as ambiguous.
- A vocabulary id with no adapter, such as `angular`, is `detected`. The
  resolver then refuses it in the adapter registry's own words, exactly as
  `--framework angular` is refused.
- **Absent** styling or UI library resolves to `none`. An absent router
  resolves to `none` where the framework offers it (React). Otherwise the
  framework decides, as Next.js and Astro route by file.
- When the resolver fills a dimension the project did not state, the report
  says so. It is either "set by the framework" (the only value it offers) or
  "ClientKit's default" (a value the project does not actually have).

`.client-site.json` is noted when present but not read. That record belongs to
`upgrade`, and detection works the same on projects ClientKit did not create.

## The command

```sh
npm create clientkit@latest detect ./my-site
npx create-clientkit@latest detect ./my-site --debug
```

- The directory defaults to the current one.
- `--debug` also lists the packages checked for each dimension that came back
  absent.
- It exits `0` whenever detection completes, however much is unknown or
  unsupported.
- It exits `2` when the directory does not exist or is a file. It also exits
  `2` when given a generation option such as `--framework` or `--yes`; those
  are refused rather than silently ignored.
- It never prompts.

There is no machine-readable output. Detection is not validation: it does not
check whether a project is configured correctly or would build. Nothing in
`create` or `upgrade` uses detection.
