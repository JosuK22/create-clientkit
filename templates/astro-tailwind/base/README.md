# {{siteName}}

{{description}}

Scaffolded with [create-clientkit](https://www.npmjs.com/package/create-clientkit).
This is your code now - edit anything.

## Getting started

```sh
npm install
npm run dev
```

| Script            | What it does                          |
| ----------------- | ------------------------------------- |
| `npm run dev`     | Start the dev server                  |
| `npm run check`   | Type-check `.astro` files and the site |
| `npm run build`   | Build the production site to `dist/`   |
| `npm run preview` | Preview the production build          |

## Where to start

1. **`src/config/site.config.ts`** - the single source of truth, and the only
   file you need for most client changes:
   - `SITE` - name, description, production URL, locale, author
   - `NAV` - header links (empty means no menu is rendered at all)
   - `SOCIAL` - social profiles (empty means no links are rendered)
   - `CONTACT` - email, phone, location; each is optional
   - `LAUNCH` - optional launch date and countdown
   - `THEME` - `appearance` (`system`/`light`/`dark`) and a brand `accent` hex

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
