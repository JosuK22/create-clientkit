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

## 1.0.0 — prepared, not yet released

> **Status: prepared.** These notes are written and reviewed, but 1.0.0 has not
> been tagged or published. The remaining release gates are external —
> see "Outstanding before release" below.

The first stable public release of the CLI contract.

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

### Outstanding before release

- [ ] CI executed on GitHub-hosted runners
- [ ] Author and repository metadata resolved
- [ ] npm account with 2FA, trusted publishing configured
- [ ] A generated site deployed to a real domain and validated
