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
