# {{siteName}}

{{description}}

Scaffolded with [create-clientkit](https://www.npmjs.com/package/create-clientkit).
This is your code now - edit anything.

## Getting started

```sh
npm install
npm run dev
```

| Script            | What it does                        |
| ----------------- | ----------------------------------- |
| `npm run dev`     | Start the dev server                |
| `npm run build`   | Build the production site to `dist/` |
| `npm run preview` | Preview the production build        |

## Where to start

1. **`src/config/site.config.ts`** - the single source of truth. Name,
   description, production URL, locale and author all live here, and the layout
   reads from it. Set `url` once the domain is known; it is intentionally empty
   until then.
2. **`src/pages/index.astro`** - the home page.
3. **`src/layouts/BaseLayout.astro`** - the shared shell: `<head>`, skip link,
   footer.
4. **`src/styles/global.css`** - Tailwind entry point and design tokens. Tailwind
   v4 is configured in CSS via `@theme`; there is no `tailwind.config.js`.
5. **`public/favicon.svg`** - replace with the client's mark.

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
