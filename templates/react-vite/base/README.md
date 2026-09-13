# {{siteName}}

{{description}}

Scaffolded with [create-clientkit](https://www.npmjs.com/package/create-clientkit).
This is your code now - edit anything.

## Getting started

```sh
npm install
npm run dev
```

| Script              | What it does                         |
| ------------------- | ------------------------------------ |
| `npm run dev`       | Start the Vite dev server            |
| `npm run build`     | Build the production site to `dist/` |
| `npm run preview`   | Preview the production build         |
| `npm run typecheck` | Type-check without emitting          |

## Where to start

1. **`src/config/site.config.ts`** - the single source of truth: name,
   description, production URL, locale, author, navigation and contact details.
   An empty string means "not set", and the UI omits that piece rather than
   showing a placeholder. Nothing is ever invented for you.
2. **`src/pages/HomePage.tsx`** - the page.
3. **`src/layouts/BaseLayout.tsx`** - the shared shell: skip link, header,
   main, footer.
4. **`src/components/`** - `common/` for shared pieces, `layout/` for header
   and footer, `ui/` for primitives.
5. **`src/styles/index.css`** - the global stylesheet, supplied by the styling
   system you chose. It defines the semantic classes the components use
   (`site-header`, `page-title`, `button-primary`), so restyling the site means
   editing this file rather than hunting through markup.

## vite.config.ts

Generated rather than copied. Each plugin in it was contributed by the part of
the stack that needs it - React's by the React integration, and any others by
the styling system you chose. It is an ordinary file now: add to it freely.

## What this scaffold does not include

Stated plainly so you can decide what to add rather than discover a gap later.

- **Routing, only if you asked for it.** If `src/routes/AppRouter.tsx` is here,
  a client-side router was selected and that file is the route table. If it is
  not, this is a one-page scaffold: add React Router or TanStack Router when a
  second page exists, and `App.tsx` is where it goes.
- **No HTTP 404, either way.** A client-side catch-all renders a component
  _after_ your host has already answered, so the response stays whatever was
  sent - usually `200` for `index.html`. Crawlers, uptime monitors and your CDN
  logs see that status, not a 404. A real not-found response comes from host
  configuration or from rendering on the server, and neither is generated here.
  Serve `index.html` for unknown routes so the app can render, and add a status
  rule at the host if the status itself matters.
- **Server-rendered metadata is limited.** `index.html` carries the title and
  description; `useDocumentMeta` updates them per page at runtime. A crawler
  that does not execute JavaScript sees only the initial HTML. If search
  visibility matters, that is a reason to render on the server rather than to
  add a library here.

## Before you deploy

1. Rewrite `SITE.description`. It is generated as `Official website of <Name>.`
   - deliberately generic, because the generator will not invent claims about a
     business it knows nothing about. Aim for roughly 120-160 characters.
2. Set `SITE.url` once the domain is known.
3. Replace `public/favicon.svg` with the client's mark.
4. Fill in `CONTACT` - anything left empty is not rendered.
5. `npm run typecheck && npm run build`, then deploy `dist/` as a static site.
