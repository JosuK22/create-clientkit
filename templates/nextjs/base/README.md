# {{siteName}}

{{description}}

Built with [Next.js](https://nextjs.org) (App Router), TypeScript and plain CSS.

## Getting started

```bash
npm install
npm run dev
```

The site runs at http://localhost:3000.

## Scripts

| Script              | What it does                          |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Development server with hot reloading |
| `npm run build`     | Production build                      |
| `npm run start`     | Serves the production build           |
| `npm run typecheck` | Type-checks without emitting          |

There is no `lint` script. Next 16 removed the `next lint` command, and adding
one would mean adding ESLint and its Next configuration - a choice better made
by you than assumed here.

## Where things live

```
app/
  layout.tsx      the root layout: <html>, <body>, baseline metadata
  page.tsx        the home page
components/ui/    presentational pieces
lib/
  site.config.ts  everything client-specific, in one file
public/           static assets served from /
styles/
  globals.css     the only stylesheet; custom properties are the design system
```

## First things to change

- `lib/site.config.ts` — name, description, locale and contact all live there.
- Set `SITE.url` once the domain is known. It is empty on purpose: nothing
  absolute is emitted until it is filled in, so no page points at a domain
  nobody owns.
- Replace `public/favicon.svg` with the client mark.

## What is deliberately not here

No CSS framework, no component library, no client-side router, no analytics and
no deployment configuration. Each of those is a decision with consequences, and
a scaffold that makes them for you is one you have to undo first.
