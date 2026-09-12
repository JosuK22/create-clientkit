# Golden snapshots

`test/golden.test.ts` and `test/golden/*.txt` record exactly what
`create-clientkit@1.0.2` generates.

They exist for one reason: the V2 adapter refactor
([v2-architecture.md](./v2-architecture.md)) rebuilds how generation works, and
we need to be able to prove it did not change **what** is generated. These
snapshots are the boundary that makes that refactor safe to attempt.

## What is captured

A rendering of the complete `GenerationPlan` returned by `plan()`:

- `templateId`, `templateVersion`, `mode`, operation count
- an **ORDER** block — every operation's type and path, in the order `plan()`
  emits them
- a **FILES** block — for each operation, its `type`, `origin`, and the full
  generated content byte for byte

Content is recorded in full. A snapshot of file names and counts would not
detect the regressions worth worrying about.

## Covered configurations

| Snapshot              | Configuration                                     |
| --------------------- | ------------------------------------------------- |
| `coming-soon-url.txt` | Coming Soon, `SITE.url` set                       |
| `full-url.txt`        | Full, `SITE.url` set                              |
| `url-less.txt`        | Coming Soon, no URL                               |
| `cli-resolution.txt`  | Flags → resolver → `ProjectContext` + `SourceMap` |

The first three call `plan()` with a context built directly. The fourth drives
the real flag-parsing and resolution path, so the CLI-input half of the
contract is pinned too — including which precedence layer each value came from.

## Normalisation

Two substitutions, both for values that are genuinely machine-specific:

| Value                                           | Rendered as     |
| ----------------------------------------------- | --------------- |
| `plan.targetDir` (absolute)                     | `<TARGET_DIR>`  |
| `copy.source` (absolute path into `templates/`) | `<TEMPLATES>/…` |

Nothing else is touched. Generated content is not reformatted, sorted or
trimmed. Production already normalises line endings to LF and emits
POSIX-separated relative paths, so there is nothing left to canonicalise —
and tests assert both of those properties rather than assuming them.

`cliVersion` (`9.9.9`) and `generatedAt` (`2026-01-01T00:00:00.000Z`) come from
the shared test context, which also pins the `{{year}}` token. The snapshots
therefore survive a version bump and a change of calendar year.

## Do not casually re-record

**A golden failure means the generated output changed. Treat that as a defect
until proven otherwise.**

Read the diff first. It will name the file and show the exact lines. Then
decide whether the change was intended.

Re-recording (`vitest run test/golden.test.ts --update`) is correct only when a
product change to the generated output has been agreed. The snapshot diff is
then the review artifact — it should be read in the pull request, not skimmed.

Re-recording to make a red suite green is how a safety net becomes decoration.

## What these do _not_ cover

Worth stating plainly, because the gap is easy to misread.

`url-less.txt` differs from `coming-soon-url.txt` by **two lines**: the
`siteUrl` field in `.client-site.json`, and `url:` in
`src/config/site.config.ts`. That is correct. The visible URL-less behaviour —
no canonical tag, no `og:url`, no sitemap, no `Sitemap:` line in `robots.txt` —
is produced when Astro _builds_ the project, because the template's own code
branches on `SITE.url`. It is not a generation-time difference.

So these snapshots prove the **input** that produces that behaviour is
unchanged. Proving the behaviour itself still requires building the site, which
is what `npm run smoke` and the CI audit job already do. Both layers are
needed; neither replaces the other.

## A note on ordering

`plan()` sorts operations by path using `localeCompare`, which resolves against
the runtime's default locale rather than code points — `README.md` sorts after
`package.json`, not before. The ordering was checked against seven locales
(`en-US`, `en-GB`, `de-DE`, `sv-SE`, `tr-TR`, `cs-CZ` and the default) and is
identical in all of them, so it is stable in practice. It does depend on ICU
being present, which Node 20+ satisfies by default.

This is recorded rather than changed — Stage 0 does not touch production
behaviour. If a runtime ever ordered differently, the ORDER block is where it
would surface, which is the point of having it.

## Using these during the V2 migration

The Astro adapter is correct when it reproduces these snapshots **byte for
byte**. That is the gate on step 2 of the implementation sequence.

If the adapter cannot reproduce them, the design is wrong and that is the
cheapest possible place to find out. Revise the design; do not adjust the
snapshots.
