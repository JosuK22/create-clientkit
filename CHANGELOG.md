# Changelog

Notable changes to `create-clientkit`. Versioning policy is documented in
[RELEASING.md](./RELEASING.md).

## 0.1.0 — 2026-09-10

Pre-release, published to bootstrap npm trusted publishing: an OIDC trusted
publisher cannot be configured until a package exists. Functionally this is the
1.0.0 candidate, published locally and therefore **without provenance**. See
[npm/cli#8544](https://github.com/npm/cli/issues/8544).

Verified after publishing: `npm create clientkit@latest` resolves 0.1.0 from
the public registry, generates 22 files, and the generated project passes
`astro check` (0 errors) and builds with zero client-side JavaScript.

## 1.0.0 — 2026-09-11

The first stable public release of the CLI contract.

Published from CI through npm trusted publishing (OIDC), with no long-lived
token anywhere in the repository or the workflow. The trusted publisher is
configured for **staged publishing only**: CI prepares the release and a
maintainer approves it with 2FA, so no automated system can make a version
live unattended.

### What it is

`create-clientkit` scaffolds the repetitive foundation of a client website —
layout, a Coming Soon page, a custom 404, SEO metadata, `robots.txt`, a
sitemap, structured data, a favicon, an accessibility baseline and build
configuration — and then gets out of the way. It is a scaffolding tool, not a
website builder: the generated source belongs to the developer.

```sh
npm create clientkit@latest acme-website
```

### Supported environment

|                    | Node.js                              |
| ------------------ | ------------------------------------ |
| The CLI            | 20.19 or newer                       |
| The generated site | 22.12 or newer (Astro 7's own floor) |

Windows, macOS and Linux.

### Included template: `astro-tailwind`

Astro 7.3.2, Tailwind CSS 4.3.3 (CSS-first `@theme`, no `tailwind.config.js`),
TypeScript 5.9.3, all pinned exactly. Two modes:

- **`coming-soon`** — a single launch page, with an optional launch date and a
  progressive-enhancement countdown.
- **`full`** — a small home page with sections, on the same design system.

Both ship the custom 404, a semantic design-token system with light and dark
themes, and zero client-side JavaScript by default.

### SEO foundation

Title, meta description, canonical, robots directives, Open Graph, Twitter/X
metadata, `robots.txt`, a sitemap and schema.org `Organization` structured
data — all generated into static HTML at build time.

Nothing is fabricated. With no production URL configured, the canonical tag,
`og:url`, the sitemap and the sitemap reference in `robots.txt` are all omitted
rather than pointed at a domain nobody owns. `og:image` is omitted until a real
image is configured. Structured data carries only fields that have values.

### CLI safety

- Generation stages into a temporary sibling directory and only moves into
  place once every file succeeds — a failure leaves the target untouched.
- A non-empty directory is never written to without explicit confirmation, and
  files the template does not name are never modified or deleted.
- `--dry-run` lists the exact files that would be written.
- Templates are data: `template.json` is declarative and cannot supply shell
  commands. Post-steps are a fixed allow-list (`install`, `git-init`,
  `format`).
- Strictly JSON config via `--from`; never executed.
- Zero runtime dependencies. The CLI is a single bundled file.

### Quality gates

Verified in CI on Windows, macOS and Linux:

- 304 tests
- `astro check` on every generated project
- clean-room validation: pack, install the tarball into a fresh directory,
  generate, install, check and build
- axe-core accessibility auditing and Lighthouse performance auditing against
  the generated sites
- package-content, dependency and hygiene gates

axe reporting zero violations is not a claim of WCAG compliance; automated
rules cover a minority of real accessibility barriers.

### Release gates, all met

- [x] CI executed on GitHub-hosted runners — 17/17 jobs green across Windows,
      macOS and Linux on Node 20.19, 22 and 24
- [x] Author and repository metadata resolved
- [x] npm account with 2FA; trusted publishing configured for staged publishing
- [x] A generated site deployed to a real domain and validated

That last gate was a live deployment, not a local preview. On the deployed
site: the home page returns 200 and an unknown path returns a real 404 (not a
soft 200); `robots.txt`, `favicon.svg`, `sitemap-index.xml` and `sitemap-0.xml`
all resolve; the canonical tag, `og:url` and the structured-data `url` all
match the serving host; and the `Sitemap:` line in `robots.txt` fetches
successfully. Both SEO paths were exercised — the URL-less build, which omits
canonical, `og:url` and the sitemap entirely, and the configured-URL build.

The schema.org validator reports 0 errors and 0 warnings for the generated
`Organization` markup. Google's Rich Results Test reports no rich-result items
detected, which is the expected outcome: `Organization` is not a rich-result
type. It confirmed the page was crawled successfully.

## 1.0.1 — 2026-09-11

A documentation and help-text patch. No functional change: the CLI generates
exactly what 1.0.0 generated, and no flag, command or template output differs.

Three things shipped in 1.0.0 that were accurate when written and wrong by
release. All three were the first thing a new user read.

### Corrected CLI help text

`--help` ended with a note left over from an early milestone:

> Early build: configuration is resolved and validated, but no files are
> generated yet.

That was true before generation was implemented and false from the moment it
was. It now describes the actual defaults — dependencies installed and a git
repository initialised unless `--no-install` or `--no-git` is passed — and the
ownership model.

### Corrected package documentation

The README, which is what renders on the npm page, described the package as
`pre-release (0.1.0)` and `not yet published to npm`, and labelled the
cross-platform CI matrix as intended coverage rather than observed results.
Both were written before publication. The README now states the real release
status and the observed CI coverage, keeping the one honest exception: Ctrl+C
cancellation cannot be verified on Windows, which has neither pty allocation
nor POSIX signal delivery to a child process.

### Improved first-user guidance

`SITE.description` is generated as `Official website of <Name>.` — deliberately
generic, because the CLI will not invent claims about a business it knows
nothing about. It is a placeholder, but nothing said so, and it would ship to
production unchanged as the meta description, `og:description` and X card
description. Both the repository README and the generated project's README now
flag it in the pre-deploy checklist, alongside a note on why no `og:image` is
emitted until one is configured and why the X card stays `summary` until then.

Also added, affecting the repository rather than the published package:
`CONTRIBUTING.md`, GitHub issue templates, release-recovery procedures in
`RELEASING.md`, a preflight artifact-fingerprint stamp that stops the release
gates running twice, and a self-test for the dependency-drift probe.

## 1.0.2 — 2026-09-12

A documentation patch. No functional change: the CLI generates the same files
1.0.1 generated, and no flag, command, template output or rendered markup
differs. Every change here is comment or prose that ships inside the package.

### Where NAV does and does not appear

`NAV` reaches a page through one route — `BaseLayout` renders the header, and
the header renders the menu — so a page without a header shows no menu. The
coming-soon home page deliberately has no header: it carries its own brand
lockup, and a launch page has nowhere to navigate to yet.

That was intentional but undocumented, so setting `NAV` on a coming-soon site
appeared to work on the 404 page and do nothing on the page being launched.
`src/config/site.config.ts` now says where the links appear and how to change
it, the coming-soon page explains the decision where it is made, and the
generated README notes it alongside the other config keys.

Behaviour is unchanged, and a contract test now covers it so the decision
cannot drift silently.

### A clearer package README

The README that renders on the npm page leads with the install command and the
badges, and now covers three things it previously never mentioned: the
URL-less configuration as a named state rather than a side effect of leaving
`SITE.url` empty, the CLI's zero runtime dependencies as distinct from the
generated site's own pinned dependencies, and that releases are published from
CI with provenance. Installation states a recommended path instead of listing
alternatives as equals.

## 1.1.0 — 2026-09-24

The V2 release. `create-clientkit` generated Astro sites; it now generates
Astro, React and Next.js sites, lets you state the stack rather than accept
one, and can reconcile a project it generated earlier against what it would
generate today.

Additive throughout. `npm create clientkit@latest` with no flags produces the
same Astro project 1.0.2 produced, file for file — the only difference in the
generated tree is that `.client-site.json` now records the resolved stack, so
a later upgrade does not have to guess.

### Choosing a stack

Seven dimensions, each with a flag, resolved by a compatibility engine that
refuses combinations nothing can build rather than generating something broken:

```sh
npm create clientkit@latest acme-site \
  --framework react --styling tailwind --ui-library mui --router react-router
```

| Dimension        | Choices                                              |
| ---------------- | ---------------------------------------------------- |
| `--framework`    | `astro`, `react`, `nextjs`                           |
| `--build-tool`   | derived from the framework (`astro`, `vite`, `next`) |
| `--language`     | `ts`                                                 |
| `--styling`      | `tailwind`, `bootstrap`                              |
| `--ui-library`   | `mui`, `none`                                        |
| `--router`       | `react-router`, `file-based`, `none`                 |
| `--architecture` | derived from the framework                           |

`--preset` names a whole starting point, `--features` adds optional overlays
(SEO, structured data, accessibility, a custom 404, client-route fallback), and
`--from <file.json>` supplies any of it from a config file. A flag beats the
file, the file beats a preset, and `--debug` prints where every resolved value
came from.

**104 combinations are supported**, and each one is generated, installed,
typechecked and built in CI before a release — not asserted, measured. Anything
outside that set is refused with a reason rather than attempted.

### Upgrading a project

```sh
npm create clientkit@latest upgrade ./acme-site
npm create clientkit@latest upgrade ./acme-site --styling bootstrap --dry-run
```

`upgrade` re-generates the files ClientKit would generate today for the stack
your project recorded, with any flag you pass overriding it. The recorded
configuration is the baseline, so changing one thing means naming one thing.

It lists every file it would replace, every file it would add, and every file
your new stack no longer generates, and then asks. What it guarantees:

- **Nothing is ever deleted.** Files the new stack no longer generates are
  reported as orphan candidates and left where they are, for you to remove
  after looking at them.
- **Files ClientKit did not plan are never touched**, including your own.
- **Confirmation is required.** `--yes` is refused rather than treated as
  consent, so there is no unattended upgrade. `--dry-run` needs no confirmation
  because it writes nothing.
- **A failure changes nothing.** Every replaced file is restored if a later
  write fails, so a project is either fully updated or exactly as it was.

It refuses, without guessing, on a project with no `.client-site.json`, a
malformed one, one written by a newer ClientKit, one recording no stack, or one
whose template identity contradicts its stack.

### What upgrade does not do

It is reconciliation, not migration, and the distinction is deliberate rather
than incomplete:

- **It does not reproduce what an earlier ClientKit generated.** No template
  version is retained, so both sides of the comparison render against the
  templates shipped with the version you are running. A file whose content
  changed between releases is reported as unchanged.
- **It does not preserve every previous site field.** `site.description` and
  `site.author` are not recorded in `.client-site.json` — deliberately, since
  they are client-authored and would otherwise be committed to the client's
  repository. An upgrade therefore writes ClientKit's default description. The
  command **warns before asking**, names the wording it would write, and points
  at `--from`; there is no equivalent warning for the author.
- **It installs nothing.** A stack change rewrites `package.json`; run the
  install yourself afterwards.
- **It never infers ownership from file contents.** What ClientKit may replace
  comes from the plan and your confirmation, never from a file looking
  generated.

### One behaviour change

`upgrade` is now a command word, so `create-clientkit upgrade` runs the upgrade
command instead of creating a directory named `upgrade`. To create a directory
by that name, write `create-clientkit ./upgrade`.

### Supported environment

Unchanged from 1.0.0: the CLI needs Node 20.19 or newer. Generated sites carry
their framework's own floor — Astro 7 needs Node 22.12+.

The CLI still ships **zero runtime dependencies**.

## 1.1.1 — 2026-09-25

A bug-fix release. Generation into a OneDrive-synchronised folder could fail
intermittently on Windows, reporting:

```text
x Generation failed: EPERM: operation not permitted, rename
  '…\.my-client-site.tmp-5r2eoa' -> '…\my-client-site'
  Nothing was written to the target directory.
```

No generated output changes, and nothing in the CLI's behaviour changes except
that this failure now usually does not happen.

### Windows atomic publish reliability

A project is built in a temporary sibling directory and published by renaming
that directory into place, so the target is either complete or untouched. That
final rename can fail transiently on Windows while another process still holds
a handle on files written moments earlier — OneDrive's sync filter, Microsoft
Defender's scanner and the Windows Search indexer all open new files shortly
after they appear. The rename is perfectly legal; the path is briefly busy.

Publish-time renames now retry `EPERM`, `EBUSY` and `EACCES` a bounded number
of times with a short backoff. Every other error code still fails immediately,
so a genuinely invalid rename — a cross-device move, a missing source, a
read-only volume — reports at once rather than after a pause.

Measured against the reported case, generating repeatedly into a real
OneDrive-synchronised directory: **2 failures in 8 runs before, 0 in 40 after**.

This improves resilience when Windows filesystem processes temporarily hold
handles during publication. It does not make such failures impossible: if a
handle is held for longer than the retry budget, generation still fails — and
still leaves the target directory untouched, which is the guarantee that
matters.

### Unchanged

The atomic publication model is exactly as it was. Nothing is copied into a
half-built target, no files are moved individually into place on the fast path,
and a failed publication still writes nothing and says so.

### Also in this release

Four of the tests that sweep all 104 supported stack combinations sat just
under the suite's default five-second timeout. They passed on an idle machine
and timed out under load, which made the release gate fail for no product
reason. They now carry a time budget that reflects what they actually do; their
assertions are unchanged.

## 1.2.0 — 2026-09-26

Chakra UI as a second component library, beside Material UI.

### Added

- `--ui-library chakra`, `"uiLibrary": "chakra"` in a config file, or **Chakra
  UI** in the interactive component-library menu. `chakra` is the only
  spelling; `chakra-ui` is refused as an unknown UI library rather than
  guessed at.
- Available for React + Vite and Next.js, with Tailwind, Bootstrap or — on
  Next.js — plain CSS, and with React Router where React takes it. Astro
  refuses it, naming the capabilities it does not provide.

The generated project installs `@chakra-ui/react` 3.37.0 and its required peer
`@emotion/react` 11.14.0, and wraps the application in a provider file that is
yours to edit. On Next.js the provider also collects Chakra's styles during the
server render and flushes them into the document head, with
`@emotion/cache` 11.14.0 — without that, every page load reported a React
hydration error.

Chakra's own CSS reset is turned off in the generated provider. It lives in a
CSS layer declared after Tailwind's utilities, so left on it would override
them; the styling system you chose already resets the page. Measured in a
browser, a starter page with Chakra lays out identically to the same stack
without it, under both Tailwind and Bootstrap.

### Unchanged

Every stack that does not select Chakra generates exactly what 1.1.1 generated,
file for file. No flag, config key or default changed.

## 1.2.1 — 2026-09-27

A documentation release. No generated output changes, and no flag, config key
or default changed.

### `npm create` examples now pass their options through

With npm 10, `npm create` reads every option before a `--` as its own. Two of
ClientKit's options, `--yes` and `--dry-run`, are also npm options, so npm kept
them and the CLI never saw them. Others ended up as stray arguments and failed
with _"Expected at most one target directory"_. The README and `--help` both
showed the broken form.

Every example now puts the options after a separator:

```sh
npm create clientkit@latest acme-website -- --yes --framework react
```

`npx create-clientkit@latest acme-website --yes …` needs no separator and is
unchanged.

### Documentation

- The README is rewritten around what a new visitor needs first: what the tool
  generates, a working quick start, what each framework includes, the supported
  stacks, common workflows, and when not to use it.
- Reference material moved into guides: [CLI](./docs/cli.md),
  [supported stacks](./docs/stacks.md),
  [the generated project](./docs/generated-project.md),
  [upgrading](./docs/upgrading.md) and
  [troubleshooting](./docs/troubleshooting.md).
- Stale claims corrected. Next.js has an adapter; only Astro projects need
  Node 22.12+ (React needs `^20.19 || >=22.12`, Next.js `>=20.9`); and a config
  file may carry `template.mode` alongside `stack` — only `template.id`
  conflicts with it.
- The package description and keywords on npm now name the frameworks and
  libraries ClientKit supports.

## 1.2.2 — 2026-09-27

An internal hardening release. Generated output is byte-for-byte unchanged: the
golden snapshots were not touched, and the full plan for every accepted stack
(140 configurations, with and without a site URL) is identical to 1.2.1's. No
flag, config key, default or message changed.

### Generation plan boundary

- Every planned file path is now checked twice. Once when the plan is built,
  and again by the executor just before anything is written. A path that is
  absolute, contains `..`, or would resolve outside the target directory is
  refused, and nothing is written.
- A plan that names the same file twice is refused before writing.
- Planned operations are ordered by a collator pinned to `en` rather than the
  machine's default locale. The order is the one every earlier release
  produced; it simply no longer depends on how the machine is configured.
- Planning failures and execution failures are now distinct internally
  (`PlanningError`, `ExecutionError`). Both print and exit exactly as before.
- `--debug` logs a summary of the plan: file, dependency and script counts.
- New internal architecture notes:
  [docs/architecture/generation-plan.md](./docs/architecture/generation-plan.md).

## 1.3.0 — 2026-09-28

Adds `detect`, a read-only command that reports what an existing project is
built with. Generated output is unchanged: no template, adapter or golden
snapshot was touched.

### `create-clientkit detect [directory]`

```sh
npm create clientkit@latest detect ./acme-site
```

Reports the project's framework, build tool, language, styling system, UI
library, router and package manager, the evidence for each, and whether
ClientKit supports that stack — as the flags you would pass for it.

- **Read-only.** It reads `package.json` and the names of files in the one
  directory it is given. It never writes, prompts, installs, or runs a package
  manager or project script, and it works on a fresh clone without
  `node_modules`.
- **Evidence, not guesses.** Dependencies decide; configuration files are
  listed as corroboration but never decide alone.
- **Honest about what it cannot say.** A framework ClientKit does not support
  (Vue, Gatsby, …) is named, not mapped to a supported one. Two lockfiles, or
  two styling systems, are reported as ambiguous rather than picked between.
  An empty directory, a missing `package.json` and a malformed one are each
  reported, not crashed on.
- **One resolver.** Whether a detected stack is supported is decided by the
  same checks a set of flags goes through, and refused in the same words.
- Exits `0` whenever detection completes. Exits `2` for a missing directory, or
  when given an option that configures generation (`--framework`, `--yes`, …).

See [docs/cli.md](./docs/cli.md#detect) and
[docs/architecture/project-detection.md](./docs/architecture/project-detection.md).

### Changed

- `detect` is now a command word, as `upgrade` is: `create-clientkit detect`
  no longer creates a project named `detect`. `create-clientkit ./detect`
  still does.
- `upgrade`'s refusal for a project with no `.client-site.json` no longer says
  ClientKit does not inspect projects. It now says upgrade does not guess a
  stack, and points to `detect`.

## 1.4.0 — 2026-09-29

Adds `doctor`, a read-only command that diagnoses whether an existing project
needs attention before ClientKit works with it. Generated output is unchanged:
no template, adapter or golden snapshot was touched.

### `create-clientkit doctor [directory]`

```sh
npm create clientkit@latest doctor ./acme-site
```

`detect` discovers; `doctor` diagnoses. It runs the same detection and the
same resolution as `detect`, then reports each check as pass, info, warning or
error, with the evidence and a hint for anything that needs attention.

- **What it flags.** An unsupported or ambiguous framework, styling system, UI
  library or router; a stack ClientKit cannot build; a missing or malformed
  `package.json`; lockfiles, or a `packageManager` field, that disagree; a
  build tool ClientKit would have to assume because the project does not show
  one.
- **No second opinion.** The verdict on the stack is the resolver's, in the
  resolver's words, so `doctor` and `detect` cannot disagree.
- **Unknown is not unsupported.** Missing information is at most a warning.
  Ambiguity is reported, never resolved by picking one.
- **Read-only.** It reads exactly what `detect` reads. It never writes,
  prompts, installs, or runs a package manager or project script, and works
  without `node_modules`. There is no `--fix`.
- Exits `0` when there are no errors, warnings included, so it does not break
  a script over something that only might matter. Exits `2` when it finds an
  error, for a missing directory, or when given an option that configures
  generation.

See [docs/cli.md](./docs/cli.md#doctor) and
[docs/architecture/project-doctor.md](./docs/architecture/project-doctor.md).

### Changed

- `doctor` is now a command word: `create-clientkit doctor` no longer creates
  a project named `doctor`. `create-clientkit ./doctor` still does.

## 1.5.0 — 2026-09-29

A simpler start. The interactive **Start from** question now offers three
opinionated presets and Custom. Generated output is unchanged: no template,
adapter or golden snapshot was touched.

### Start from

```text
Start from

❯ Astro + Tailwind
  React + Tailwind
  Next.js + Tailwind
  Custom — choose your stack
```

- **One keystroke for the common path.** Choosing a preset sets the framework
  and styling, so neither is asked again. Only the questions that remain are
  asked, such as component library and routing on React.
- **Astro + Tailwind is the default.** Pressing Enter all the way through
  gives the same project as before, with fewer questions. Enter only takes a
  preset that fits what you have already passed. With `--framework react`,
  Enter means Custom, and with `--router react-router` it means React +
  Tailwind.
- **Custom keeps everything.** It asks every stack question as before, so
  every supported combination is still available: Bootstrap, Material UI,
  Chakra UI, React Router and every feature.
- `--yes` and non-interactive runs are unchanged. They use no preset.

### Added

- `--preset nextjs-tailwind`: Next.js (App Router) with Tailwind CSS. It is
  also valid in a config file (`"stack": { "preset": "nextjs-tailwind" }`).

### Changed

- `react-bootstrap` and `react-mui` are no longer in the interactive menu.
  They still work with `--preset` and in a config file, and Custom builds
  the same projects.
- Presets are now named "Astro + Tailwind" and "React + Tailwind" in `--help`
  and the menu, instead of "… + Tailwind CSS".
- With `--debug`, the framework and styling of a project made by pressing
  Enter are credited to the preset rather than to the built-in default.

### Docs

- README: the new menu, and a short workflow for `detect` and `doctor` on an
  existing project.
- `docs/stacks.md` no longer says there is no Next.js preset.
- `docs/upgrading.md` points projects without `.client-site.json` to `detect`
  and `doctor`.

## 1.5.1 — 2026-09-29

`--dry-run` now previews the whole run, not just the file list. Generated
output is unchanged: no template, adapter or golden snapshot was touched.

### `--dry-run`

```sh
npm create clientkit@latest acme-site -- --dry-run
```

- **Create or replace.** Files are listed under "Files to create" and "Files
  to replace". A file lands under replace when it already exists in the
  target, because a real run overwrites it. Files the plan does not name are
  not listed, and a real run never touches them.
- **Non-empty targets.** If the directory already has files, the preview says
  what a real run would do: ask first when interactive, or stop with `--yes`
  or without a terminal. The dry run itself asks nothing.
- **Post steps, not run.** It shows the exact install and `git init` commands
  a real run would use, or why one is skipped (`--no-install`, `--no-git`).
- **Ends with "No changes were made."** Nothing is written, installed,
  initialised or downloaded, as before.

The `DRY RUN` header and `Total: N files` line are unchanged, and `--debug`
still only adds where each file came from.

See [docs/cli.md](./docs/cli.md#previewing-with---dry-run).

## 1.5.2 — 2026-09-30

Internal groundwork: templates are now first-class, validated definitions.
Nothing you run changes: the same templates, flags, prompts and generated
output. No golden snapshot was touched.

### Changed

- **Every template is validated before anything is planned from it.** The
  React and Next.js templates now go through the same manifest checks as the
  Astro one. A template's files must stay inside the target directory, and a
  file may only use the `{{tokens}}` its manifest declares. A template that
  breaks these rules fails before a single file is written.
- **One place resolves a stack to its template**, and checks the template
  belongs to the stack's framework and offers the starting mode. Which
  styling, component library or router a stack may combine is still decided
  by the compatibility rules alone.
- Template layers are ordered with the same locale-pinned comparison as the
  rest of the plan, so the machine's language setting cannot reorder them.

See [docs/architecture/templates.md](./docs/architecture/templates.md).

## 1.5.3 — 2026-09-30

Internal groundwork: every template is now validated thoroughly, with every
problem reported at once. Nothing you run changes: the same templates, flags,
prompts and generated output. No golden snapshot was touched.

### Changed

- **Templates are checked for more than their files.** Before planning, each
  run now also refuses:
  - a template file linked from outside the template;
  - a file name Windows cannot create;
  - a template that ships ClientKit's own `.client-site.json`;
  - a path that is a file in one layer and a folder in another;
  - a starting mode with no files of its own;
  - a Node requirement ClientKit cannot read;
  - an invalid default locale.

  A problem stops the run before anything is written, naming the template,
  the file and what to change.

- **The recorded framework version is checked.** The `frameworkVersion` every
  project records in `.client-site.json` must match the version ClientKit
  actually installs.
- **The published package is checked against the source.** The release smoke
  test installs the packed package and requires each Start from preset to
  plan exactly the same files from it as from the repository.
- The React and Next.js templates no longer declare a `{{mode}}` value they
  never used.

See [docs/architecture/templates.md](./docs/architecture/templates.md#validation).

## 1.5.4 — 2026-09-30

Generation is now explicitly deterministic: the same inputs give the same
project on any machine. On an English-locale machine nothing you generate
changes, and no golden snapshot was touched.

### Fixed

- **The machine's language no longer affects generation.** Six places that
  decide an order used the machine's default locale. They decided which
  contributed file wins, the order JSON files are merged, adapter selection,
  the order of generated Astro bindings and page fields, and the order of
  compatibility problems. On a machine set to another language these could
  have ordered differently. They now all use the same fixed ordering as the
  rest of the plan, and a test fails if a locale-dependent comparison appears
  again.

### Changed

- **Determinism is tested end to end.** The same inputs are checked to give
  the same plan however directories are listed, whatever the locale, time zone
  or user environment, and wherever the command is run from. The release smoke
  test also generates the same project twice from the installed package and
  compares every byte. The one value that differs between runs is
  `generatedAt` in `.client-site.json`, the time the project was generated.

See
[docs/architecture/deterministic-generation.md](./docs/architecture/deterministic-generation.md).

## 1.6.0 — 2026-10-01

Running ClientKit again on a project it generated is now safe to repeat: it
changes only what differs, and nothing when nothing does. Generating a new
project is unchanged, byte for byte, and no golden snapshot was touched.

### Changed

- **The same command twice is a no-op.** Re-running `create` with the same
  configuration on a project ClientKit generated now says the project is
  already up to date, writes nothing, and succeeds. It doesn't reinstall
  dependencies or re-initialise git. Before, a second `--yes` run was refused
  with "already exists and is not empty".
- **Missing generated files come back.** Delete a generated file and re-run,
  and that one file is restored, without a question, because nothing is
  overwritten.
- **Your edits are never replaced silently.** A generated file that differs
  from what ClientKit would write now may hold your work, so only those files
  are listed, and they are replaced only if you confirm. With `--yes` or
  without a terminal the run stops and writes nothing.
- **`upgrade` replaces only what differs.** Files that already match are no
  longer rewritten or listed, and if everything matches it says so and asks
  nothing.
- **`--dry-run` shows the same decision** on such a project: what it would
  create, what it would replace with your confirmation, how many files are
  unchanged, or that the project is already up to date.
- `.client-site.json` is left exactly as it is when nothing else changes.

A project is recognised by its `.client-site.json`. Directories without a
usable one keep the rules they always had.

See
[docs/architecture/idempotent-generation.md](./docs/architecture/idempotent-generation.md)
and [docs/upgrading.md](./docs/upgrading.md#re-running-create-over-an-existing-project).

## 1.7.0 — 2026-10-02

`--dry-run` now shows what would change in a project ClientKit generated, file
by file, with a diff for anything that conflicts. Real runs, first-time
generation and generated output are unchanged; no golden snapshot was touched.

### Added

- **A change preview.** On a project ClientKit generated, `create --dry-run`
  and `upgrade --dry-run` classify every planned file:
  - `+` **create**: a file new to this configuration;
  - `+` **restore**: a file the project had, now missing;
  - `~` **modify**: ClientKit's own `.client-site.json`;
  - `!` **conflict**: a file that differs and may hold your edits, replaced
    only if you confirm;
  - `=` **unchanged**: already as planned, counted.

  A summary of each count follows.

- **A diff for each conflict.** Removed and added lines, with a little
  context. A missing final newline and Windows line endings show up as changes.
  Binary files are marked "(binary changed)" and never dumped. Large files and
  long diffs are summarised instead of flooding the terminal.
- `--debug` adds the reason behind every file's classification.

### Changed

- `upgrade` lists what it would replace and add from the same analysis
  `create` uses, so the two commands always agree.
- A directory ClientKit did not generate gets no diff. The preview explains
  that ClientKit cannot tell which of its files are yours.

See
[docs/architecture/change-analysis.md](./docs/architecture/change-analysis.md).

## 1.7.1 — 2026-10-03

Hardens the boundary between deciding what to write and writing it. Planning,
`--dry-run`, `detect`, `doctor` and template validation were already
read-only; this release enforces that with tests and closes one gap. Generated
output, flags and defaults are unchanged; no golden snapshot was touched.

### Fixed

- **A file that changes while ClientKit is asking is no longer overwritten.**
  If a planned file changes between ClientKit checking the project and writing
  to it (typically while the confirmation question is open: an editor saving,
  a formatter, a `git checkout`), the run now stops and writes nothing, naming
  the files that changed. Before, the newer content was silently replaced.

### Internal

- Filesystem writes live only in the executor, and processes (install,
  `git init`) only in post-step execution. Post-step planning has its own
  module, and the test suite checks both rules against the source and at
  runtime.

See
[docs/architecture/planning-execution.md](./docs/architecture/planning-execution.md).

## 1.7.2 — 2026-10-04

React + React Router projects now show a not-found page for addresses that
match no route. Before this release, they rendered an empty page.

### Fixed

- **Unknown routes render a not-found view instead of a blank page.** A React
  Router project had a single route, `/`, so `/does-not-exist` or any stale
  link rendered nothing at all: no header, no footer, no content. The route
  table now ends with a catch-all that renders `src/pages/NotFoundPage.tsx`
  inside the site layout, with a link back home. It is the same view
  `--features client-route-fallback` already generated, and selecting that
  feature now produces the same files.

  This is a client-side view: the server still answers `200`, so it is not an
  HTTP 404. In production your host must serve `index.html` for unknown paths,
  as the generated README describes. `--features not-found` stays unavailable
  on React Router for that reason.

### Upgrading

`upgrade` and `regenerate` on an existing React Router project will offer the
new `src/pages/NotFoundPage.tsx` and a changed `src/routes/AppRouter.tsx`.
Projects without a router, Astro and Next.js generate exactly what they did
before.

## 1.8.0 — 2026-10-07

Creating a project now installs its dependencies and initialises Git without
asking, and shows each step as it runs. The Starting mode choices say what each
one is. Generated output is unchanged; no golden snapshot was touched.

### Changed

- **Setup is no longer a question.** The interactive flow used to end with a
  Setup multiselect for "Install dependencies" and "Initialize Git". Both now
  run automatically once the files are written, as `--yes` already did.
  `--no-install`, `--no-git` and `"install"` / `"git"` in a `--from` file still
  turn them off. `--dry-run` still lists them under "Post steps (not run)" and
  runs neither.
- **Clearer Starting mode.** The choices read **Coming Soon — Minimal launch
  page** and **Full Starter — Full application starter**. The resolved
  configuration and the dry run show the mode the same way, with its `--mode`
  value.
- **Progress for every step.** `Creating project files...`,
  `Installing dependencies with <pm>...` and `Initializing Git...` are each
  followed by a result line in words: `Dependencies installed`,
  `Git initialized`, or `Failed to install dependencies` with the command's
  error. These are plain lines with no spinner, so CI logs and redirected
  output stay clean.

### Fixed

- A failed post step on Windows no longer prints a stray carriage return from
  the command's error output.

## 1.8.1 — 2026-10-08

Documentation only. The CLI and generated output are unchanged.

### Changed

- The README's opening example is now `npm create clientkit@latest`, without
  a directory name; the CLI asks for one.
