# {{siteName}}

{{description}}

Scaffolded with [create-clientkit](https://www.npmjs.com/package/create-clientkit).
This is your code now - edit anything.

## Getting started

```sh
npm install
npm run dev
```

| Script            | What it does                           |
| ----------------- | -------------------------------------- |
| `npm run dev`     | Start the dev server                   |
| `npm run check`   | Type-check `.astro` files and the site |
| `npm run build`   | Build the production site to `dist/`   |
| `npm run preview` | Preview the production build           |

## Where to start

1. **`src/config/site.config.ts`** - the single source of truth, and the only
   file you need for most client changes:
   - `SITE` - name, description, production URL, locale, author
   - `NAV` - header links (empty means no menu is rendered at all)
   - `SOCIAL` - social profiles (empty means no links are rendered)
   - `CONTACT` - email, phone, location; each is optional
   - `LAUNCH` - optional launch date and countdown
   - `THEME` - `appearance` (`system`/`light`/`dark`) and a brand `accent` hex
   - `SEO` - social preview `image`, `twitterCard`, and `noindex`

   An empty string or empty array means "not set", and the UI omits that piece
   rather than showing a placeholder. Nothing is ever invented for you.

2. **`src/pages/index.astro`** - the home page.
3. **`src/pages/404.astro`** - the custom not-found page.
4. **`src/layouts/BaseLayout.astro`** - the shared shell: `<head>`, skip link,
   header, footer, and the `measure` prop that sets the page column width.
5. **`src/components/`** - `Header`, `Footer`, `Brand`, `SocialLinks`,
   `LaunchNotice`.
6. **`src/styles/global.css`** - the design system. Tailwind v4 is configured in
   CSS via `@theme`; there is no `tailwind.config.js`. Colours, type scale,
   radii, shadows and spacing all live here, and light/dark are one block of
   custom properties rather than duplicated components.
7. **`public/favicon.svg`** - replace with the client's mark.

## SEO

Metadata is generated into the static HTML at build time - nothing depends on
JavaScript, so crawlers and social platforms get the full picture from the
source.

`src/components/Seo.astro` is the single place that emits `<title>`,
description, canonical, robots, Open Graph and Twitter tags, and
`src/layouts/BaseLayout.astro` renders it for every page. A page only passes
what it needs to override:

```astro
<BaseLayout title="About" description="Something specific to this page." />
```

**Everything derives from `SITE`.** You never repeat the site name,
description or URL.

### Set the URL before the final build

`SITE.url` is read at **build time**, so canonical tags, `og:url` and the
sitemap are baked into the output. Moving a built site to a different domain
leaves them pointing at the old one - rebuild after changing it.

### Before you have a domain

`SITE.url` starts empty and that is a supported state, not a broken one. While
it is empty the site omits every absolute tag - canonical, `og:url`, the
sitemap and the sitemap line in `robots.txt` - rather than pointing them at a
domain nobody owns yet. Fill `SITE.url` in and they all appear. Only the
origin is used; a subpath deployment also needs Astro's `base` option.

### Social previews and the description

`SITE.description` arrives as `Official website of {{siteName}}.` That is a
placeholder, not a suggestion. It was generated without knowing anything about
the business, and it becomes the meta description, `og:description` and the X
card description - so it is worth replacing with real copy, roughly 120-160
characters, before launch.

`SEO.image` starts empty and no `og:image` is emitted while it is. The X card
stays `summary` in that state rather than claiming `summary_large_image` with
no image to show, which renders as an empty card. Drop a 1200x630 image into
`public/`, point `SEO.image` at it, and the card switches to the large format
on its own.

### Indexing

`SEO.noindex` controls it, and it is `false` by default so a launched site is
findable. Set it to `true` while a holding page is up if you would rather it
stayed out of search - and remember to switch it back at launch.

| `SITE.url` | `SEO.noindex` | Result                                                       |
| ---------- | ------------- | ------------------------------------------------------------ |
| set        | `false`       | Canonical, `og:url`, sitemap, `Sitemap:` line in robots.txt  |
| set        | `true`        | `noindex, nofollow`, no canonical, no sitemap, `Disallow: /` |
| empty      | `false`       | No absolute tags, no sitemap, permissive robots.txt          |
| empty      | `true`        | No absolute tags, no sitemap, `Disallow: /`                  |

The 404 page is always `noindex, nofollow` and carries no structured data,
whatever the site setting says.

### Social preview image

`SEO.image` is empty by default, so no `og:image` is emitted at all - better
than pointing Facebook and X at a file that isn't there. Drop a 1200x630 PNG
into `public/` and set `image: '/og.png'`.

### Structured data

`src/components/StructuredData.astro` emits a schema.org `Organization` block
built only from values you have actually configured. No logo, address, rating
or review is invented - fields you leave empty simply do not appear.

## Design notes

- **Zero client-side JavaScript by default.** The only script in the project is
  a ~20-line countdown, and it ships only when you set a launch date. Without
  JavaScript the launch date still renders; only the ticking numbers are lost.
- **Dark mode needs no JavaScript.** It follows the visitor's system preference,
  or you can force one via `THEME.appearance`.
- **Set `THEME.accent`** to the client's brand hex and buttons, focus rings and
  the background wash all follow. Readable text on the accent is chosen for you.
- **Motion is opt-out-aware**: entrance animation only runs under
  `prefers-reduced-motion: no-preference`, so content is never hidden behind an
  animation that may not play.

## Stack

- [Astro](https://astro.build) 7 - static output, zero client JS by default
- [Tailwind CSS](https://tailwindcss.com) 4 - loaded through `@tailwindcss/vite`
- TypeScript in strict mode

Requires Node.js 22.12 or newer.

## Notes

`.client-site.json` records how this project was generated. Leave it in place -
future `create-clientkit` tooling reads it. It contains no secrets.

This project is private and unlicensed by default (`"private": true`,
`"license": "UNLICENSED"`), because client work is normally proprietary. Change
that in `package.json` if the site is meant to be open source.
