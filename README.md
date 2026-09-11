# create-clientkit

[![npm](https://img.shields.io/npm/v/create-clientkit)](https://www.npmjs.com/package/create-clientkit)
[![CI](https://github.com/JosuK22/create-clientkit/actions/workflows/ci.yml/badge.svg)](https://github.com/JosuK22/create-clientkit/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/create-clientkit)](https://nodejs.org)
[![licence](https://img.shields.io/npm/l/create-clientkit)](./LICENSE)

**Create the boring foundation of your next client website in seconds.**

```sh
npm create clientkit@latest acme-website
```

A scaffolding CLI for developers who build client websites over and over:
freelancers, agencies and frontend teams. It generates the foundation you
rebuild every time — layout, a Coming Soon page, a custom 404, SEO metadata,
`robots.txt`, a sitemap, structured data, a favicon, an accessibility baseline
and build config — and then gets out of the way.

It is **not** a website builder. You own the generated source from the moment
it lands on disk.

**What it generates** — a static [Astro](https://astro.build) 7 +
[Tailwind CSS](https://tailwindcss.com) 4 site in TypeScript: responsive, light
and dark themes, and no client-side JavaScript by default. Start in
**Coming Soon** mode for a launch page, **Full** for a small multi-section home
page, or **URL-less** when the domain is not decided yet.

**What it is** — one bundled CLI with **zero runtime dependencies**, MIT
licensed, published from CI with
[provenance](https://docs.npmjs.com/generating-provenance-statements) and
tested on Linux, Windows and macOS across Node 20.19, 22 and 24. The site it
generates has its own dependencies — Astro and Tailwind, pinned exactly — which
is a separate thing from the CLI's own dependency count.

---

## Requirements

|                | Node.js            | Why                                |
| -------------- | ------------------ | ---------------------------------- |
| The CLI        | **20.19** or newer | Enforced before anything else runs |
| Generated site | **22.12** or newer | Astro 7's own floor                |

The CLI deliberately supports an older Node than the site it generates, so it
can host future templates with lower floors. Running the CLI on Node 20 works
and warns before generating that the project itself will need 22.12+.

### Supported platforms

|         | CLI | Generated site | Covered by the CI matrix          |
| ------- | --- | -------------- | --------------------------------- |
| Linux   | yes | yes            | Node 20.19, 22, 24 (site: 22, 24) |
| Windows | yes | yes            | Node 20.19, 22, 24 (site: 22)     |
| macOS   | yes | yes            | Node 20.19, 22, 24 (site: 22)     |

> **Verification status.** Every row above is observed, not intended: the CI
> workflow runs on GitHub-hosted runners for all three platforms on each push.
> One exception is called out honestly — Ctrl+C cancellation cannot be tested
> on Windows, which has neither pty allocation nor POSIX signal delivery to a
> child process, so `scripts/cancel-check.mjs` prints the manual procedure
> there instead of asserting anything.

## Usage

Recommended — nothing to install first, and `@latest` sidesteps npm's
initializer cache:

```sh
npm create clientkit@latest [directory] [options]
```

The same binary is reachable through `npx`, if that suits your workflow better.
It does the same thing:

```sh
npx create-clientkit@latest [directory] [options]
```

Note that this is about how you _invoke_ the CLI. Which package manager installs
the generated project's dependencies is a separate choice — detected from your
environment, or forced with `--pm`.

| Flag                  | Description                               |
| --------------------- | ----------------------------------------- |
| `-t, --template <id>` | Template to scaffold from                 |
| `--list-templates`    | List available templates and exit         |
| `--name <name>`       | Client / site name                        |
| `--url <url>`         | Production URL (omit if not decided yet)  |
| `-m, --mode <mode>`   | `coming-soon` or `full`                   |
| `-y, --yes`           | Accept all defaults; never prompt         |
| `--from <file>`       | Read answers from a JSON config file      |
| `--dry-run`           | Resolve and print the plan; write nothing |
| `--no-git`            | Skip git initialisation                   |
| `--no-install`        | Skip dependency installation              |
| `--pm <manager>`      | Force `npm`, `pnpm`, `yarn` or `bun`      |
| `--debug`             | Print diagnostics and full stack traces   |
| `-h, --help`          | Show help                                 |
| `-v, --version`       | Show the version                          |

### Interactive flow

Five questions, and the first is skipped when you pass a directory:

1. **Project directory**
2. **Client / site name** — defaults to the title-cased directory name
3. **Production URL** — optional; skipping it leaves it explicitly unset
4. **Starting mode** — Coming Soon, or Full Starter
5. **Setup** — install dependencies, initialise git (both on by default)

The package manager is detected from `npm_config_user_agent` and never asked
about. Override it with `--pm`.

### Non-interactive use

Every prompt has a matching flag, so a scripted run needs no config file:

```sh
npm create clientkit@latest acme-website --yes --name "Acme Ltd" --mode full
```

`--yes` never prompts, and a non-TTY stdin without `--yes` fails immediately
rather than hanging.

### Config file (`--from`)

Strictly JSON — never executed, and never a way around validation. Unknown keys
and wrong types are errors. See [`example.preset.json`](./example.preset.json).

### Configuration precedence

```
CLI flags  >  --from file  >  interactive answers  >  template defaults  >  built-in defaults
```

Prompts are only issued for values no higher-precedence source supplied.

## Templates and modes

One template ships in V1:

| Template         | Stack                                   | Modes                 |
| ---------------- | --------------------------------------- | --------------------- |
| `astro-tailwind` | Astro 7, Tailwind CSS 4, TypeScript 5.9 | `coming-soon`, `full` |

- **`coming-soon`** — a single polished launch page you can put live today,
  with an optional launch date and a progressive-enhancement countdown.
- **`full`** — a small multi-section home page, on the same design system.

Both include the custom 404, the design system and the full SEO layer.

### URL-less

Not a third mode — a state either mode starts in, and a supported one. When you
have not decided on a domain, leave the production URL unset and the generated
site **omits** every absolute tag rather than pointing it at a guess: no
canonical, no `og:url`, no sitemap, and no `Sitemap:` line in `robots.txt`.

```sh
npm create clientkit@latest acme-website --yes   # no --url: URL-less
```

Set `SITE.url` in `src/config/site.config.ts` whenever the domain is known and
all of it appears on the next build. Nothing needs regenerating, and no
placeholder domain was ever written to disk.

## The generated project

```sh
cd acme-website
npm install
npm run dev
```

| Script            | What it does                           |
| ----------------- | -------------------------------------- |
| `npm run dev`     | Start the dev server                   |
| `npm run check`   | Type-check `.astro` files and the site |
| `npm run build`   | Build the production site to `dist/`   |
| `npm run preview` | Preview the production build           |

Everything client-specific lives in **`src/config/site.config.ts`**: identity,
navigation, social links, contact details, launch date, theme accent and SEO.
Empty means "not set", and the UI omits that piece rather than inventing one.

The generated project is `"private": true` and `"license": "UNLICENSED"`,
because client work is normally proprietary. Change that if the site is meant
to be open source.

### SEO and the production URL

`SITE.url` starts empty and that is a supported state. While it is empty the
site omits every absolute tag — canonical, `og:url`, the sitemap and the
sitemap line in `robots.txt` — rather than pointing them at a domain nobody
owns. Fill it in and they all appear.

| `SITE.url` | `SEO.noindex` | Result                                                       |
| ---------- | ------------- | ------------------------------------------------------------ |
| set        | `false`       | Canonical, `og:url`, sitemap, `Sitemap:` line in robots.txt  |
| set        | `true`        | `noindex, nofollow`, no canonical, no sitemap, `Disallow: /` |
| empty      | `false`       | No absolute tags, no sitemap, permissive robots.txt          |
| empty      | `true`        | No absolute tags, no sitemap, `Disallow: /`                  |

`SEO.noindex` defaults to `false`, including for coming-soon pages: a holding
page that gets indexed is replaced at the next crawl, whereas a `noindex` left
on after launch keeps the real site invisible.

### Before you deploy

1. Set `SITE.url` in `src/config/site.config.ts` — canonical URLs and the
   sitemap depend on it.
2. Rewrite `SITE.description`. It is generated as `Official website of <Name>.`
   — deliberately generic, because the CLI will not invent claims about a
   business it knows nothing about. It is a placeholder, and it becomes the
   meta description, `og:description` and the X card description. Aim for
   roughly 120–160 characters of real copy.
3. Replace `public/favicon.svg` with the client's mark.
4. Add a 1200×630 image to `public/` and set `SEO.image` if you want social
   previews. No `og:image` is emitted until you do, and the X card stays
   `summary` rather than rendering an empty `summary_large_image`.
5. Fill in `CONTACT` and `SOCIAL` — anything left empty is not rendered, and
   not claimed in the structured data.
6. `npm run check && npm run build`, then deploy `dist/` as a static site.

Only the origin of `SITE.url` is used. To deploy under a subpath, also set
`base` in `astro.config.mjs`.

## Troubleshooting

**`npm create clientkit@latest` runs an old version.** npm caches initializers.
Clear the npx cache, or run `npm cache clean --force`. The banner prints the
version actually running.

**"requires Node.js 20.19 or newer".** The CLI refuses to run on older Node.
Upgrade, or use `nvm`/`fnm`.

**The generated project fails to install on Node 20.** Expected: Astro 7
requires Node 22.12+. The CLI warns about this before generating.

**"Directory … already exists and is not empty".** The CLI never writes into a
non-empty directory without asking. Run it interactively to confirm a merge,
or choose an empty directory. Files the template does not name are never
touched.

**Nothing was written after an error.** By design — generation stages into a
temporary sibling directory and only moves into place once every file
succeeds.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

| Script                  | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `npm run smoke`         | Pack, install into a clean dir, generate, check and build   |
| `npm run smoke:audit`   | The above, plus axe and Lighthouse on each generated site   |
| `npm run check:package` | Validate tarball contents and dependency guards             |
| `npm run third-party`   | Regenerate `THIRD-PARTY.md` from the dependency graph       |
| `npm run drift:report`  | Compare template pins against the latest published versions |
| `npm run preflight`     | Every release gate, in order                                |

The CLI publishes with `dependencies: {}` — its dependencies are bundled into
`dist/cli.js` at build time, so `npm create` is one tarball and no dependency
resolution. See [THIRD-PARTY.md](./THIRD-PARTY.md) and
[RELEASING.md](./RELEASING.md).

## Contributing

Bug reports and ideas are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
The quickest useful report is an
[issue from a template](https://github.com/JosuK22/create-clientkit/issues/new/choose),
since they ask for the versions and the exact command up front.

## Licence

MIT — see [LICENSE](./LICENSE). Generated client projects are **not** MIT; they
ship private and unlicensed.
