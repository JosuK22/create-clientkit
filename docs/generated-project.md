# The generated project

What lands on disk, where to edit it, and what to do before it goes live.

The generated project is ordinary source code for its framework. It does not
depend on ClientKit, and every file is yours to change. Each project also gets
its own `README.md` with its scripts and the files to start from.

## Contents

- [Astro](#astro)
- [React + Vite](#react--vite)
- [Next.js](#nextjs)
- [Files every project has](#files-every-project-has)
- [`site.config.ts`](#siteconfigts)
- [The production URL](#the-production-url)
- [Before you deploy](#before-you-deploy)

## Astro

`npm create clientkit@latest acme-website -- --yes`

```text
acme-website/
├── public/
│   └── favicon.svg
├── src/
│   ├── components/
│   │   ├── Brand.astro
│   │   ├── Footer.astro
│   │   ├── Header.astro
│   │   ├── LaunchNotice.astro      launch date and countdown
│   │   ├── Seo.astro               every <head> tag, in one place
│   │   ├── SocialLinks.astro
│   │   └── StructuredData.astro    schema.org Organization
│   ├── config/
│   │   └── site.config.ts          the file to edit per client
│   ├── layouts/
│   │   └── BaseLayout.astro        <head>, skip link, header, footer
│   ├── lib/
│   │   └── seo.ts
│   ├── pages/
│   │   ├── 404.astro
│   │   ├── index.astro             Coming Soon or Full Starter
│   │   └── robots.txt.ts
│   └── styles/
│       └── global.css              Tailwind v4 @theme tokens, light and dark
├── .client-site.json
├── .gitattributes
├── .gitignore
├── astro.config.mjs                includes the sitemap integration
├── package.json
├── README.md
└── tsconfig.json
```

| Script            | What it does                           |
| ----------------- | -------------------------------------- |
| `npm run dev`     | Start the dev server                   |
| `npm run check`   | Type-check `.astro` files and the site |
| `npm run build`   | Build the static site to `dist/`       |
| `npm run preview` | Preview the production build           |

Requires Node.js 22.12+ (Astro 7's minimum). Output is static HTML with no
client-side JavaScript by default; deploy `dist/` to any static host.

With `--features`, Astro also gets a composed head component the layout
renders: `src/components/DocumentHead.astro` for `seo`, `structured-data` and
`accessibility`, and `DocumentHeadPageNotFound.astro` for `not-found`.
`robots` and `sitemap` are accepted and add nothing: `robots.txt.ts` and the
sitemap integration are already part of every Astro project.

## React + Vite

`npm create clientkit@latest acme-app -- --yes --framework react --router react-router --features client-route-fallback`

```text
acme-app/
├── public/
│   └── favicon.svg
├── src/
│   ├── components/
│   │   ├── common/Brand.tsx
│   │   ├── layout/Footer.tsx
│   │   ├── layout/Header.tsx
│   │   └── ui/Container.tsx
│   ├── config/
│   │   └── site.config.ts          the file to edit per client
│   ├── hooks/
│   │   └── useDocumentMeta.ts      sets the title and description per page
│   ├── layouts/
│   │   └── BaseLayout.tsx
│   ├── pages/
│   │   ├── HomePage.tsx            Coming Soon or Full Starter
│   │   └── NotFoundPage.tsx        only with client-route-fallback
│   ├── routes/
│   │   └── AppRouter.tsx           only with react-router
│   ├── styles/
│   │   └── index.css
│   ├── App.tsx
│   ├── main.tsx
│   └── vite-env.d.ts
├── .client-site.json
├── .gitattributes
├── .gitignore
├── index.html
├── package.json
├── README.md
├── tsconfig.json
└── vite.config.ts
```

With `--ui-library mui` or `chakra`, `src/components/ui/AppProviders.tsx` is
added and wraps the app in that library's provider.

| Script              | What it does                 |
| ------------------- | ---------------------------- |
| `npm run dev`       | Start the Vite dev server    |
| `npm run build`     | Build to `dist/`             |
| `npm run preview`   | Preview the production build |
| `npm run typecheck` | Type-check with `tsc`        |

Requires Node.js `^20.19.0 || >=22.12.0`, Vite 8's range.

## Next.js

`npm create clientkit@latest acme-web -- --yes --framework nextjs --features seo,not-found`

```text
acme-web/
├── app/
│   ├── layout.tsx                  root layout and metadata
│   ├── not-found.tsx
│   └── page.tsx                    Coming Soon or Full Starter
├── components/
│   ├── providers/AppProviders.tsx  pass-through, or your UI library's provider
│   └── ui/Mark.tsx
├── lib/
│   └── site.config.ts              the file to edit per client
├── public/
│   └── favicon.svg
├── styles/
│   └── globals.css
├── .client-site.json
├── .gitattributes
├── .gitignore
├── next.config.ts
├── package.json
├── README.md
└── tsconfig.json
```

Tailwind adds a `postcss.config.mjs`. The Full Starter adds
`components/ui/Section.tsx`.

The search features add files only when selected:

| Feature           | Adds                                          | Changes                                    |
| ----------------- | --------------------------------------------- | ------------------------------------------ |
| `seo`             | —                                             | canonical in `app/layout.tsx`, `not-found` |
| `robots`          | `app/robots.ts`                               | —                                          |
| `sitemap`         | `app/sitemap.ts`, `lib/seo.ts`                | —                                          |
| `structured-data` | `components/StructuredData.tsx`, `lib/seo.ts` | renders it in `app/page.tsx`               |

`lib/seo.ts` holds the URL and JSON-LD helpers those files share. `robots`
alone does not need it; with `sitemap` it does, to build the `Sitemap:` line.

| Script              | What it does               |
| ------------------- | -------------------------- |
| `npm run dev`       | Start the dev server       |
| `npm run build`     | Production build           |
| `npm run start`     | Serve the production build |
| `npm run typecheck` | Type-check with `tsc`      |

There is no `lint` script: Next 16 removed `next lint`, and choosing an ESLint
setup is left to you. Requires Node.js 20.9+.

## Files every project has

| File                 | Why                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------- |
| `site.config.ts`     | The client's details in one place                                                     |
| `public/favicon.svg` | A neutral placeholder mark — replace it                                               |
| `README.md`          | The project's own scripts and where to start                                          |
| `.gitignore`         | Build output, dependencies, env files                                                 |
| `.gitattributes`     | Consistent line endings across macOS, Linux and Windows                               |
| `.client-site.json`  | Records the stack and options used, so [`upgrade`](./upgrading.md) knows the baseline |
| `package.json`       | Exact dependency versions, `"private": true`, `"license": "UNLICENSED"`               |

`.client-site.json` is safe to commit and nothing at runtime reads it. It does
not store the site description or author.

The project is marked private and unlicensed because client work usually is.
Change both if the site is meant to be open source.

## `site.config.ts`

The client-specific file. Empty values mean "not set", and the site leaves that
piece out rather than showing a placeholder.

| Export    | Astro | React | Next.js | Holds                                                       |
| --------- | :---: | :---: | :-----: | ----------------------------------------------------------- |
| `SITE`    |   ✓   |   ✓   |    ✓    | name, description, production URL, locale, author           |
| `NAV`     |   ✓   |   ✓   |    ✓    | header links                                                |
| `CONTACT` |   ✓   |   ✓   |    ✓    | email, phone (and location on Astro)                        |
| `SOCIAL`  |   ✓   |       |         | social profile links                                        |
| `LAUNCH`  |   ✓   |       |         | optional launch date and note for the Coming Soon page      |
| `THEME`   |   ✓   |       |         | `appearance` (`system`/`light`/`dark`) and a brand `accent` |
| `SEO`     |   ✓   |       |         | social preview `image`, `twitterCard`, `noindex`            |

Location: `src/config/site.config.ts` (Astro, React) or `lib/site.config.ts`
(Next.js).

## The production URL

You can generate a project before the domain is decided. Leave out `--url`
(or press Enter at the prompt) and `SITE.url` starts empty.

While it is empty, anything that needs an absolute address is **left out**
rather than pointed at a guess. Fill it in later and they appear on the next
build — nothing needs regenerating.

On **Astro**, `SITE.url` and `SEO.noindex` together decide the output:

| `SITE.url` | `SEO.noindex` | Result                                                       |
| ---------- | ------------- | ------------------------------------------------------------ |
| set        | `false`       | Canonical, `og:url`, sitemap, `Sitemap:` line in robots.txt  |
| set        | `true`        | `noindex, nofollow`, no canonical, no sitemap, `Disallow: /` |
| empty      | `false`       | No absolute tags, no sitemap, permissive robots.txt          |
| empty      | `true`        | No absolute tags, no sitemap, `Disallow: /`                  |

`SEO.noindex` defaults to `false`, including for Coming Soon pages: a holding
page that gets indexed is simply replaced at the next crawl, whereas a
`noindex` forgotten after launch keeps the real site invisible. Turn it on for
staging deployments.

Only the origin of `SITE.url` is used. To deploy an Astro site under a subpath,
also set `base` in `astro.config.mjs`.

On **Next.js**, the search features read `SITE.url` at build time and use
only its origin — a path, query or fragment in it is ignored, the same as on
Astro:

| `SITE.url` | `seo`                           | `robots`                      | `sitemap`               | `structured-data` |
| ---------- | ------------------------------- | ----------------------------- | ----------------------- | ----------------- |
| set        | `metadataBase` and canonical    | allow all, `Sitemap:` line\*  | the home page, absolute | includes `url`    |
| empty      | no `metadataBase`, no canonical | allow all, no `Sitemap:` line | empty                   | no `url`          |

\* Only when `sitemap` is also selected. A missing URL never blocks indexing:
there is no `noindex` setting on Next.js, and nothing is disallowed. A value
that is not an absolute `http:` or `https:` URL — whitespace, a bare domain, a
typo — counts as empty for all four, rather than failing the build.

On **React**, `SITE.url` is available to your code but nothing is generated
from it.

## Before you deploy

1. **Set `SITE.url`** — canonical URLs, the sitemap and the `Sitemap:` line
   in `robots.txt` depend on it (on Next.js, for the features you selected).
   **Next.js with `sitemap`:** add every page you create to `ROUTES` in
   `app/sitemap.ts`; it is not discovered automatically.
2. **Rewrite `SITE.description`.** It is generated as
   `Official website of <Name>.` — deliberately generic, because the CLI won't
   make claims about a business it knows nothing about. It becomes the meta
   description (and on Astro, the Open Graph and X card description). Aim for
   roughly 120–160 characters of real copy.
3. **Replace `public/favicon.svg`** with the client's mark.
4. **Fill in `CONTACT`** (and on Astro, `SOCIAL`). Anything left empty is not
   rendered, and not claimed in the structured data. On Next.js with
   `structured-data`, render `<StructuredData />` on any page you add that
   should carry it.
5. **Astro: add a social image.** Put a 1200×630 image in `public/` and set
   `SEO.image`. Until you do, no `og:image` is emitted and the X card stays
   `summary`.
6. **Build it** — `npm run check && npm run build` on Astro,
   `npm run typecheck && npm run build` on React and Next.js.
