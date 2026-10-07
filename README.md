# create-clientkit

[![npm](https://img.shields.io/npm/v/create-clientkit)](https://www.npmjs.com/package/create-clientkit)
[![CI](https://github.com/JosuK22/create-clientkit/actions/workflows/ci.yml/badge.svg)](https://github.com/JosuK22/create-clientkit/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/create-clientkit)](https://nodejs.org)
[![licence](https://img.shields.io/npm/l/create-clientkit)](./LICENSE)

**Build the website, not the boilerplate.**

Every new client site starts with the same setup: a config file for the
client's details, a layout, a holding page, a 404, SEO tags, `robots.txt`, a
sitemap, a favicon. `create-clientkit` generates that foundation for Astro,
React + Vite or Next.js, so the first thing you work on is the client's site.

```sh
npm create clientkit@latest acme-website
```

It asks a few questions, writes plain source files you own, installs
dependencies and initialises git. Then it gets out of the way — nothing it
generates depends on ClientKit.

---

## Contents

- [Quick start](#quick-start)
- [Why create-clientkit?](#why-create-clientkit)
- [What you get](#whats-included)
- [Supported stacks](#supported-stacks)
- [Common workflows](#common-workflows)
- [CLI at a glance](#cli-at-a-glance)
- [Generated project](#the-generated-project)
- [How it compares to framework starters](#why-not-just-use-create-next-app-vite-or-create-astro)
- [Who it is for — and who it is not](#who-its-for)
- [Documentation](#documentation)

## Quick start

Requires **Node.js 20.19+** to run the CLI.

```sh
npm create clientkit@latest acme-website
cd acme-website
npm run dev
```

Dependencies are installed during generation, so `npm run dev` works straight
away. (Pass `--no-install` to skip that, and run `npm install` yourself.)

Run it with no arguments and it asks. These are the questions, in order —
the notes on the right are explanation, not CLI output:

```text
$ npm create clientkit@latest

Project directory
Client / site name        defaults to the directory name, title-cased
Production URL            optional — press Enter to skip
Start from                Astro + Tailwind, React + Tailwind, Next.js + Tailwind,
                          or Custom — choose your stack
Framework                 Custom only: Astro, React, Next.js
Styling                   only if the framework offers a choice
Component library         only if the framework can mount one
Routing                   only if the framework offers a choice
Features                  any number, or none
Starting mode             Coming Soon — Minimal launch page, or
                          Full Starter — Full application starter
```

Then it writes the files, installs dependencies and initialises Git, printing
each step as it runs. Neither is a question: `--no-install` and `--no-git` turn
them off, and `--dry-run` lists them without running either.

Pick one of the three presets and the framework and styling are set for you.
Pick **Custom** to choose every part of the stack yourself. It reaches every
supported combination, including Bootstrap, Material UI and Chakra UI.
Questions with only one valid answer are skipped — Astro is never asked about
styling, because only Tailwind works there.

Prefer no questions? Every prompt has a flag, and `--yes` accepts the defaults
(Astro + Tailwind, Coming Soon mode):

```sh
npm create clientkit@latest acme-website -- --yes --name "Acme Ltd" --url https://acme.example
```

> **Note the `--`.** With `npm create`, put `--` before the options. Without it npm keeps options
> like `--yes` and `--dry-run` for itself and ClientKit never sees them.
> `npx create-clientkit@latest acme-website --yes …` needs no separator.

> The package manager that installs the project is detected from the one you
> ran the CLI with, or forced with `--pm npm|pnpm|yarn|bun`.

## Why create-clientkit?

The part of a client project nobody bills for is the part you repeat every
time:

**Without it**

```text
new client
  → scaffold the framework
  → add Tailwind / Bootstrap / a component library and wire it up
  → write a config for name, URL, contact details, social links
  → build a header, footer and base layout
  → make a holding page for launch
  → add a 404
  → add title, description, canonical, Open Graph, robots.txt, sitemap
  → swap the favicon, set up .gitignore, init git
  → start on the actual website
```

**With it**

```text
new client
  → npm create clientkit@latest
  → start on the actual website
```

What's in "the foundation" depends on the stack — Astro gets the most, because
a static site can put everything into the HTML at build time. See
[What's included](#whats-included) for exactly what each framework gets.

Two things it is careful about, because they come up with every client:

- **Nothing is invented.** No placeholder domain, no fake phone number, no
  default social image. Anything you have not provided is left out of the page
  and out of the metadata, rather than filled with something you would have to
  remember to remove.
- **The domain is often not decided yet.** Skip the production URL and the site
  still builds; canonical tags and the sitemap switch on the moment you set it.
  Nothing needs regenerating.

## What's included

### Every project

- **One config file for the client's details** — name, description, URL,
  navigation and contact details live in `site.config.ts`. Change the client,
  change one file.
- **A layout that's already put together** — header, footer and a base layout
  wired to that config. Empty fields are omitted, not rendered as blanks.
- **A starting page you can ship** — **Coming Soon** (a single launch page) or
  **Full Starter** (a small multi-section home page), on the same styling.
- **Project hygiene** — `.gitignore`, `.gitattributes` for consistent line
  endings, a favicon to replace, a project README with the scripts, and a git
  repository with dependencies installed.
- **Exact dependency versions** — every package is pinned, so a project
  generated today installs the same versions next month.
- **Private by default** — `"private": true` and `"license": "UNLICENSED"`,
  because client work normally is not open source.
- **TypeScript throughout**, with a `typecheck` (or `check`) script.

### Astro projects (the default)

A static site with no client-side JavaScript by default, and the complete
website layer built in:

- **SEO metadata generated into the HTML** — title, description, canonical,
  Open Graph, X/Twitter card and robots directives, all driven by the config.
- **`robots.txt` and a sitemap**, which follow the production URL and a
  `noindex` switch — useful for staging sites and pre-launch pages.
- **schema.org `Organization` structured data**, containing only the details
  you have filled in.
- **A custom 404 page.**
- **Light and dark themes** from design tokens, with a single accent colour to
  set to the client's brand.
- **An optional launch date** on the Coming Soon page, with a countdown that is
  progressive enhancement.
- **An accessibility baseline** — skip link, landmarks and visible focus
  styles. (Checked with axe in CI; that is not a claim of WCAG compliance.)

### React + Vite projects

A single-page app with the same config-driven layout:

- **Tailwind or Bootstrap**, optionally with **Material UI** or **Chakra UI**
  wired into a provider file you can edit.
- **React Router** (optional). Unmatched routes render a not-found view inside
  the site layout. This happens in the browser: the server still answers
  `200`, and your host has to serve `index.html` for unknown paths (see the
  generated README). `--features client-route-fallback` makes that view a
  checked guarantee.
- **Page titles and descriptions** set per page with a small `useDocumentMeta`
  hook.

React renders in the browser, so there is no server-rendered SEO layer and no
sitemap. If search visibility matters for the site, pick Astro or Next.js — the
CLI will tell you the same thing if you ask for `--features seo` on React.

### Next.js projects

App Router, React Server Components by default:

- **Tailwind, Bootstrap or plain CSS**, optionally with **Material UI** or
  **Chakra UI** — including the server-side style handling those libraries need
  to avoid hydration errors.
- **Title and description metadata** from the config, plus a **canonical URL**
  with `--features seo` once the production URL is set.
- **A custom `not-found` page.**

Next.js projects do not currently include `robots.txt`, a sitemap or structured
data. Those are Astro-only for now.

## Supported stacks

| Framework             | Styling                              | Component library | Routing                 | Optional features                                      |
| --------------------- | ------------------------------------ | ----------------- | ----------------------- | ------------------------------------------------------ |
| **Astro 7** (default) | Tailwind CSS 4                       | —                 | file-based              | `seo`, `structured-data`, `accessibility`, `not-found` |
| **React 19 + Vite 8** | Tailwind CSS 4, Bootstrap            | none, MUI, Chakra | none, React Router      | `client-route-fallback` (needs React Router)           |
| **Next.js 16**        | Tailwind CSS 4, Bootstrap, plain CSS | none, MUI, Chakra | file-based (App Router) | `seo`, `not-found`                                     |

All projects are TypeScript. Every row is a real choice: any styling in a row
works with any component library in that row.

**Impossible combinations are refused before anything is written**, with the
reason. For example:

```text
$ npm create clientkit@latest acme -- --framework astro --ui-library chakra

x That combination will not work.
    - Chakra UI requires react-runtime (its components are React components).
  - Chakra UI requires client-app-root (it mounts its styling system and theme context above the whole application).
```

You will not get a project that silently ignored half of what you asked for.
The full rules and the reasoning behind them are in
[docs/stacks.md](./docs/stacks.md).

### Presets

Shortcuts for common stacks. Anything a preset sets can still be overridden.

| Preset            | Gives you                             |
| ----------------- | ------------------------------------- |
| `astro-tailwind`  | Astro + Tailwind CSS                  |
| `react-tailwind`  | React + Vite + Tailwind CSS           |
| `nextjs-tailwind` | Next.js + Tailwind CSS                |
| `react-bootstrap` | React + Vite + Bootstrap              |
| `react-mui`       | React + Vite + Tailwind + Material UI |

The first three are the interactive **Start from** choices. All five work with
`--preset` and in a config file.

```sh
npm create clientkit@latest acme-app -- --preset react-mui
npm create clientkit@latest acme-app -- --preset react-tailwind --router react-router
```

## Common workflows

### A launch page today, the real site later

The domain is not live, the design is not signed off, but the client wants
something up. Start in Coming Soon mode with no URL:

```sh
npm create clientkit@latest acme-website
```

Deploy it. When the full site is ready, the same project is where you build it.

### A marketing site with the SEO basics done

```sh
npm create clientkit@latest acme-website -- --mode full --url https://acme.example
```

Astro, with title, canonical, Open Graph, sitemap, `robots.txt` and structured
data generated into static HTML.

### A Next.js site with a component library

```sh
npm create clientkit@latest acme-web -- --framework nextjs --styling tailwind --ui-library chakra --features seo,not-found
```

### A React app with routing

```sh
npm create clientkit@latest acme-portal -- --framework react --styling bootstrap --router react-router --features client-route-fallback
```

### Your agency's standard stack, reused for every client

Save the stack once:

```json
{
  "stack": {
    "preset": "react-tailwind",
    "router": "react-router",
    "features": ["client-route-fallback"]
  },
  "site": { "locale": "en-GB" },
  "packageManager": "pnpm"
}
```

Then for each new client, pass only what changes:

```sh
npm create clientkit@latest northwind-bakery -- --from agency.json \
  --name "Northwind Bakery" --url https://northwind.example --mode full --yes
```

Flags override the file, so one file covers every client. The file is strict
JSON — never executed — and unknown keys are errors, so a typo fails loudly
instead of being ignored. See [docs/cli.md](./docs/cli.md#config-file---from).

### Check before you write

```sh
npm create clientkit@latest acme-app -- --preset react-mui --dry-run
```

Prints the resolved stack, every file it would create or replace, and the
install and `git init` commands it would run. It writes, installs and runs
nothing. If the target already has files, it says whether a real run would ask
first or stop. Add `--debug` to see where each value came from (flag, file,
preset, prompt or default). See
[docs/cli.md](./docs/cli.md#previewing-with---dry-run).

### Change the stack of a project later

```sh
npm create clientkit@latest upgrade ./acme-app -- --styling bootstrap --dry-run
```

`upgrade` shows exactly which generated files it would replace or add, asks
before writing, never deletes anything and never touches files it did not
generate. See [docs/upgrading.md](./docs/upgrading.md) for what it does and
does not preserve.

### Check an existing project

```sh
npm create clientkit@latest detect ./client-site
npm create clientkit@latest doctor ./client-site
```

`detect` reports what a project is built with and the evidence for each part.
`doctor` then says whether anything needs attention before ClientKit works with
it: an unsupported or ambiguous stack, lockfiles that disagree, a broken
`package.json`. It gives the evidence and a hint for each. Both only read
`package.json` and file names; they change nothing and need no
`node_modules`. `doctor` exits `2` when it finds an error, so it can gate a
script. See [docs/cli.md](./docs/cli.md#doctor).

## CLI at a glance

```text
npm create clientkit@latest [directory] -- [options]
npm create clientkit@latest upgrade <directory> -- [options]
npm create clientkit@latest detect [directory] -- [--debug]
npm create clientkit@latest doctor [directory] -- [--debug]
```

| Option              | What it does                                                                  |
| ------------------- | ----------------------------------------------------------------------------- |
| `--name <name>`     | Client / site name (default: title-cased directory name)                      |
| `--url <url>`       | Production URL — leave out if the domain is not decided                       |
| `-m, --mode <mode>` | `coming-soon` (default) or `full`                                             |
| `--preset <id>`     | Start from a preset (see above)                                               |
| `--framework <id>`  | `astro` (default), `react`, `nextjs`                                          |
| `--styling <id>`    | `tailwind`, `bootstrap`, `none` — what's allowed depends on framework         |
| `--ui-library <id>` | `mui`, `chakra`, `none` (default)                                             |
| `--router <id>`     | `react-router`, `none`, `file-based`                                          |
| `--features <a,b>`  | Comma-separated optional features — see [Supported stacks](#supported-stacks) |
| `-y, --yes`         | Accept defaults; never prompt                                                 |
| `--from <file>`     | Read answers from a JSON config file                                          |
| `--dry-run`         | Preview files and post steps; write, install and run nothing                  |
| `--no-install`      | Skip dependency installation                                                  |
| `--no-git`          | Skip git initialisation                                                       |
| `--pm <manager>`    | Force `npm`, `pnpm`, `yarn` or `bun`                                          |
| `--debug`           | Show where each value came from, and full stack traces on error               |
| `-h, --help`        | Show help (lists what your installed version supports)                        |
| `-v, --version`     | Show the version                                                              |

`--build-tool`, `--language`, `--architecture`, `--template` and
`--list-templates` also exist; each framework currently fixes the first three,
so you rarely need them. The complete reference — accepted values, defaults,
the config file format, precedence rules and the interactive flow — is in
**[docs/cli.md](./docs/cli.md)**.

`npx create-clientkit@latest [directory] [options]` works identically, and
needs no `--`.

## The generated project

An Astro project with the defaults:

```text
acme-website/
├── public/
│   └── favicon.svg            ← replace with the client's mark
├── src/
│   ├── components/            Header, Footer, Brand, Seo, StructuredData, …
│   ├── config/
│   │   └── site.config.ts     ← the one file to edit per client
│   ├── layouts/
│   │   └── BaseLayout.astro
│   ├── lib/seo.ts
│   ├── pages/
│   │   ├── index.astro        Coming Soon or Full Starter
│   │   ├── 404.astro
│   │   └── robots.txt.ts
│   └── styles/global.css      design tokens, light and dark
├── .client-site.json          what was generated, used by `upgrade`
├── astro.config.mjs
├── package.json
├── README.md
└── tsconfig.json
```

React and Next.js projects follow their own framework's conventions; their
trees are in [docs/generated-project.md](./docs/generated-project.md).

**Before you hand it over:** set the production URL, rewrite the placeholder
description (`Official website of <Name>.` — deliberately generic, because the
CLI won't make claims about a business it knows nothing about), replace the
favicon, and fill in contact and social details. The full checklist is in
[docs/generated-project.md](./docs/generated-project.md#before-you-deploy).

| Node.js needed by | Version                           |
| ----------------- | --------------------------------- |
| The CLI           | 20.19+                            |
| An Astro project  | 22.12+ (Astro 7's floor)          |
| A React project   | ^20.19 or 22.12+ (Vite 8's range) |
| A Next.js project | 20.9+                             |

The CLI warns before generating if your Node version is too old for the project
you chose.

## Why not just use create-next-app, Vite or create-astro?

Use them if they fit — they are excellent and ClientKit does not replace them.
The difference is where each one stops:

- **Framework starters** give you a working framework app. What goes on top —
  styling, a component library, a config for the client's details, a layout,
  a holding page, SEO tags, robots, sitemap, 404 — is up to you, every time.
- **create-clientkit** generates that layer too, for the kind of project it
  targets: small client websites. The result is a normal Astro, Vite or Next.js
  project — the same framework, the same commands, the same docs.

**Is it a framework?** No. It is a one-off generator. It runs once and is not
installed into the project.

**Does it add a runtime dependency?** No. The generated `package.json` lists
only the framework and the libraries you chose. The CLI itself also ships with
zero npm dependencies.

**Can I modify the generated project?** Yes — it is ordinary source code. There
are no hidden files to keep in sync, and `.client-site.json` is only read if you
later run `upgrade`.

**Who owns the generated code?** You do (or your client does). The CLI is MIT;
generated projects are marked private and unlicensed so they are not
accidentally published as open source.

## Who it's for

- **Freelancers** who start several client sites a year and are tired of
  rebuilding the same foundation.
- **Small agencies** that want every project to start from the same stack and
  structure — a shared config file makes that one command.
- **Developers who launch holding pages** before the real site is ready.
- **Anyone who wants the SEO basics done right** without deciding every tag
  from scratch.

### When not to use it

Be honest with yourself about the fit:

- **You're building an application, not a website** — a dashboard, a SaaS
  product, something with auth and a database. Start from the framework's own
  starter; ClientKit's layout and holding page would be in your way.
- **Your stack is not in the table.** Vue, Svelte, Angular and others are not
  supported. Asking for one is refused with an error — it is never swapped for
  something that is.
- **You need a CMS, forms, analytics, auth or deployment.** ClientKit does none
  of those, deliberately.
- **You already have a starter your team maintains.** Keep it — or compare what
  ClientKit generates and take what's useful.
- **You need search-visible content on React.** Choose Astro or Next.js; a
  client-rendered React app cannot put metadata in the initial HTML.

## Documentation

| Guide                                                | For                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| [CLI reference](./docs/cli.md)                       | Every flag, the config file, presets, precedence, interactive mode     |
| [Supported stacks](./docs/stacks.md)                 | What each framework takes, and why some combinations are refused       |
| [The generated project](./docs/generated-project.md) | File trees, `site.config.ts`, the SEO/URL rules, pre-deploy checklist  |
| [Upgrading and re-running](./docs/upgrading.md)      | Changing a project's stack later, safely                               |
| [`detect` and `doctor`](./docs/cli.md#detect)        | Inspecting an existing project, and whether ClientKit can work with it |
| [Troubleshooting](./docs/troubleshooting.md)         | Old versions, Node errors, non-empty directories                       |
| [Changelog](./CHANGELOG.md)                          | What changed in each release                                           |

## How it's built

- One bundled CLI file, **zero runtime dependencies**, MIT licensed.
- Published from CI with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
  and each release approved by a human.
- Tested on Linux, Windows and macOS on Node 20.19, 22 and 24. The default
  Astro project is generated, installed, checked and built on every push, and
  audited with axe and Lighthouse.
- **Generation is atomic**: files are written to a temporary directory and moved
  into place only when every file succeeded. A failure leaves nothing behind.
- Never overwrites a file without asking, and never touches files it did not
  generate. Run again on a project it generated, it changes only what differs,
  and nothing at all if nothing does.
- Nothing phones home.

## Contributing

Bug reports and ideas are welcome — the
[issue templates](https://github.com/JosuK22/create-clientkit/issues/new/choose)
ask for the exact command and versions up front, which is usually all that's
needed to fix something. See [CONTRIBUTING.md](./CONTRIBUTING.md) for working on
the code.

## Licence

MIT — see [LICENSE](./LICENSE). Generated client projects are **not** MIT; they
ship private and unlicensed.
