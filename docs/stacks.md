# Supported stacks

Every combination below is accepted by the CLI today — 140 in total, counting
each set of features and both starting modes. Anything outside this list is
refused before a file is written, with the reason.

`--help` always shows what your installed version supports.

## At a glance

| Framework                   | Styling                         | Component library            | Routing            | Features                                                                    |
| --------------------------- | ------------------------------- | ---------------------------- | ------------------ | --------------------------------------------------------------------------- |
| **Astro 7** (default)       | Tailwind CSS 4                  | —                            | file-based         | `seo`, `robots`, `sitemap`, `structured-data`, `accessibility`, `not-found` |
| **React 19 + Vite 8**       | Tailwind CSS 4, Bootstrap       | none, Material UI, Chakra UI | none, React Router | `client-route-fallback` (requires React Router)                             |
| **Next.js 16** (App Router) | Tailwind CSS 4, Bootstrap, none | none, Material UI, Chakra UI | file-based         | `seo`, `robots`, `sitemap`, `structured-data`, `not-found`                  |

Within a row, every styling option works with every component library, and
every feature can be combined with the others. Every project is TypeScript.

## Astro

The default. A static site that ships no client-side JavaScript by default.

- **Styling:** Tailwind only. Astro's config needs a CSS framework plugin, and
  Tailwind is the one ClientKit provides for it — so Astro is never asked about
  styling.
- **Component library:** none. Material UI and Chakra UI are React libraries.
- **What's always included:** the full SEO layer (title, description,
  canonical, Open Graph, X/Twitter card, robots directives), `robots.txt`, a
  sitemap, `Organization` structured data, a custom 404 and a skip link. See
  [The generated project](./generated-project.md#astro).
- **Features:** `seo`, `structured-data`, `accessibility` and `not-found` are
  all accepted, and add a composed document head. The base template already
  covers these areas, so they are optional on Astro. `robots` and `sitemap`
  are accepted and change nothing: the template serves `robots.txt` and builds
  the sitemap on every project, selected or not.

## React + Vite

A client-rendered single-page app. ClientKit's React starter generates no
server rendering or prerendering; that is a limit of this starter, not of
React or Vite.

- **Styling:** Tailwind or Bootstrap. `--styling none` is refused — the React
  template's entry point imports a stylesheet built by one of them.
- **Component library:** Material UI or Chakra UI, each mounted through an
  `AppProviders.tsx` file you can edit. Chakra's CSS reset is turned off so it
  does not override your styling system.
- **Routing:** none (a single page) or React Router.
- **Features:** only `client-route-fallback`, which renders a not-found view for
  unmatched routes. It requires React Router.

### Why React refuses `seo`, `robots`, `sitemap`, `structured-data` and `not-found`

These features need to put something in the HTML the server sends — a
canonical link, JSON-LD, or a real 404 status — or a route the server answers,
like `/robots.txt`. The React app ClientKit generates builds the page in
the browser, after the response has already been sent, so it cannot do that
honestly. Rather than generate tags that crawlers may never
see, the CLI refuses and explains why:

```text
$ npm create clientkit@latest acme-app -- --framework react --features seo

x That combination will not work.
    - Search-engine metadata requires document-metadata (the contract has to reach the document head before the response is sent, or crawlers never see it).
  - Search-engine metadata requires composed-canonical (it writes the canonical link into the head; the title and description the head also states belong to the framework, not to this feature).
```

`client-route-fallback` is React's equivalent of a 404 page, and does not claim
to be one: it shows a view, but the server still answers with whatever status
your host gives unknown paths.

If search visibility matters, choose Astro or Next.js.

## Next.js

App Router, with the root layout kept as a server component.

- **Styling:** Tailwind (through PostCSS), Bootstrap, or `none` for plain CSS.
  With no `--styling` given, Next.js defaults to `none`.
- **Component library:** Material UI or Chakra UI. The generated provider
  handles collecting their styles during the server render, which avoids React
  hydration errors.
- **Routing:** file-based (the App Router). React Router is refused — it needs
  a route table, and a file-routed framework does not have one.
- **Features:** each generates only what it names.
  - `seo` adds a canonical URL (built from the origin of `SITE.url`) to the
    root layout's metadata.
  - `robots` adds `app/robots.ts`, which allows every crawler.
  - `sitemap` adds `app/sitemap.ts`, which lists `/`. Next.js does not
    discover routes for a sitemap, so pages you add later go in its `ROUTES`
    list.
  - `structured-data` adds `components/StructuredData.tsx` and renders it on
    the home page. It is not rendered in the root layout, because Next renders
    the not-found page inside that layout too.
  - `not-found` adds metadata to the custom not-found page.

  `accessibility` is refused: it needs more control of the document head than
  Next's metadata API exposes to a generator.

Unlike Astro, a Next.js project has none of these unless you ask for them.
`seo` does not switch on the others. There is no `noindex` setting on Next.js
yet, so `app/robots.ts` always allows crawling.

## Presets

| Preset            | Sets                         | In **Start from** |
| ----------------- | ---------------------------- | ----------------- |
| `astro-tailwind`  | Astro, Tailwind              | yes (default)     |
| `react-tailwind`  | React, Tailwind              | yes               |
| `nextjs-tailwind` | Next.js, Tailwind            | yes               |
| `react-bootstrap` | React, Bootstrap             | —                 |
| `react-mui`       | React, Tailwind, Material UI | —                 |

The interactive **Start from** menu offers the first three, plus **Custom —
choose your stack**, which reaches every combination on this page. There is no
Chakra preset; use `--ui-library chakra` or choose it under Custom. See
[CLI reference → Presets](./cli.md#presets).

## Not supported

Other frameworks (Vue, Svelte, Angular, …), JavaScript-only projects, and other
styling or component libraries are not implemented. Some names — `angular`,
`angular-material` — are recognised and refused with "no adapter implements
it"; anything else is refused as unknown. The CLI never substitutes a supported
choice for one it does not support.

## How combinations are checked

Each framework, styling system, library and feature declares what it provides
and what it requires. The CLI checks those declarations before generating, and
the interactive menus are built from the same check, so a combination the menus
offer is one the CLI will generate.

The previous release's 104 combinations (everything except Chakra UI) were each
generated, installed, type-checked and built; the recorded results are in
[integration-matrix.json](./integration-matrix.json). The design is described in
[v2-architecture.md](./v2-architecture.md).
