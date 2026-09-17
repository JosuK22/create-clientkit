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

**What it generates** — by default a static [Astro](https://astro.build) 7 +
[Tailwind CSS](https://tailwindcss.com) 4 site in TypeScript: responsive, light
and dark themes, and no client-side JavaScript by default. Start in
**Coming Soon** mode for a launch page, **Full** for a small multi-section home
page, or **URL-less** when the domain is not decided yet.

**Three frameworks** — [Astro](https://astro.build),
[React](https://react.dev) + [Vite](https://vite.dev), and
[Next.js](https://nextjs.org) (App Router). They are independent choices rather
than three products: the same starters, the same modes and the same
compatibility rules apply to each, and what a framework cannot support is
refused with the reason rather than silently ignored.

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

### Choosing a stack

By default `npm create clientkit@latest` scaffolds Astro + Tailwind, exactly as
it always has. To choose something else, configure the dimensions you care
about and leave the rest to ClientKit:

```sh
npm create clientkit@latest acme-app \
  --framework react \
  --build-tool vite \
  --language typescript \
  --styling tailwind
```

| Flag                  | Configures        | Currently supported                                                             | Default         |
| --------------------- | ----------------- | ------------------------------------------------------------------------------- | --------------- |
| `--framework <id>`    | the framework     | `astro`, `react`, `nextjs`                                                      | `astro`         |
| `--build-tool <id>`   | the bundler       | `vite` (`astro` and `nextjs` own theirs)                                        | the framework's |
| `--language <id>`     | the language      | `ts`, `js`                                                                      | the framework's |
| `--styling <id>`      | how CSS is built  | `tailwind`, `bootstrap`, `none`                                                 | the framework's |
| `--ui-library <id>`   | component library | `mui`, `none`                                                                   | `none`          |
| `--router <id>`       | routing           | `react-router`, `file-based`, `none`                                            | the framework's |
| `--architecture <id>` | folder layout     | whatever the framework defines                                                  | the framework's |
| `--features <a,b>`    | site capabilities | `accessibility`, `client-route-fallback`, `not-found`, `seo`, `structured-data` | none            |

`--language` also accepts `typescript` and `javascript`; both mean the ids
above. `--features` takes a comma-separated list, rejects an id it does not
know, and rejects the same id twice rather than quietly collapsing it.

Anything you leave out is filled in for you. Where the framework owns the
answer — React implies Vite, Astro and Next.js are their own build tools — it is
read from the framework itself rather than guessed. A framework may also say
what it ships with: Next.js ships plain CSS, so an unstated `--styling` resolves
to `none` there and to `tailwind` everywhere else. Stating one anyway still
reaches the compatibility check, which is where an impossible pairing is
refused.

#### Combinations are checked, not assumed

Not every stack is buildable, and ClientKit refuses the ones that are not
before writing anything, naming the reason:

```
$ npm create clientkit@latest acme-app --framework react --features seo

x That combination will not work.
    - Search-engine metadata requires document-metadata (the contract has to
      reach the document head before the response is sent, or crawlers never
      see it).

    The selected stack provides: composed-stylesheet, css-framework, jsx,
    react-runtime, spa-routing, typescript, vite-plugins.
```

That is a real refusal rather than a limitation of the flags: React renders in
the browser, so it has no way to put metadata in the document before the
response is sent. The same reasoning keeps `--features not-found` to frameworks
that route by file; React's equivalent is `--features client-route-fallback`,
which renders a view for an unmatched address and does not claim to be an
HTTP 404.

#### Known names versus working choices

ClientKit's vocabulary is wider than the table above — it knows `nextjs`,
`angular`, `chakra` and others. Asking for one reports that no adapter
implements it rather than silently substituting something that does:

```
$ npm create clientkit@latest acme-app --framework nextjs

x ClientKit does not support framework "nextjs" yet.
    Implemented frameworks: astro, react. "nextjs" is a known identifier but no
    adapter implements it.
```

A name ClientKit has never heard of is rejected outright, and never falls back
to a default.

#### `--template` and the stack flags

`--template` names a whole stack and the flags above configure one, so they
cannot be combined — including when they happen to agree. Use one or the other.
`--mode` is unaffected: it selects the starter content, not the technology, and
works with either.

### Interactive flow

Run it with nothing and it asks:

```sh
npm create clientkit@latest
```

1. **Project directory**
2. **Client / site name** — defaults to the title-cased directory name
3. **Production URL** — optional; skipping it leaves it explicitly unset
4. **Framework**
5. **Styling**
6. **Component library** — only when the framework can mount one
7. **Routing** — only when the framework offers a choice
8. **Features** — multiple selection, or none
9. **Starting mode** — Coming Soon, or Full Starter
10. **Setup** — install dependencies, initialise git (both on by default)

The stack questions sit between the client questions and the starter because
the starter belongs to a template, and which template that is follows from the
framework.

**Only questions worth asking are asked.** A dimension with one possible answer
is derived rather than offered as a menu of one — neither framework currently
offers a build tool, a language or an architecture worth choosing between, so
none of the three is asked. A choice that cannot be built alongside what you
have already picked is not offered either: Bootstrap does not appear under
Astro, and the client-side fallback appears only once a router does. Those
decisions come from the same compatibility engine that validates flags, so the
menus cannot disagree with it.

Answering the questions and passing the flags are two ways to say the same
thing, and they produce the same project. A flag you pass is a question you are
not asked, so partial configuration works:

```sh
# asks for styling, component library, routing and features — not the framework
npm create clientkit@latest acme-app --framework react
```

The package manager is detected from `npm_config_user_agent` and never asked
about. Override it with `--pm`.

`--yes` never prompts and accepts every default, which is Astro + Tailwind +
Coming Soon.

### Non-interactive use

Every prompt has a matching flag, so a scripted run needs no config file:

```sh
npm create clientkit@latest acme-website --yes --name "Acme Ltd" --mode full
```

`--yes` never prompts, and a non-TTY stdin without `--yes` fails immediately
rather than hanging.

### Presets

A preset is a named starting point — a handful of stack choices with a label:

```sh
npm create clientkit@latest acme-app --preset react-mui
```

| Preset            | Stack                                     |
| ----------------- | ----------------------------------------- |
| `astro-tailwind`  | Astro + Tailwind CSS                      |
| `react-tailwind`  | React + Vite + Tailwind CSS               |
| `react-bootstrap` | React + Vite + Bootstrap                  |
| `react-mui`       | React + Vite + Tailwind CSS + Material UI |

**A preset is not a template.** A template owns generated files; a preset owns
none and cannot name one. It sets dimensions, and everything downstream —
compatibility, adapter selection, generation — happens exactly as it would have
if you had typed those dimensions yourself. `--preset react-mui` and
`--framework react --styling tailwind --ui-library mui` produce the same
project, which is asserted rather than intended.

**Presets are partial and overridable.** `react-tailwind` sets a framework and
a styling system and says nothing about routing, the component library or
features — those resolve the way they always do, by being asked for or
defaulted. Anything a preset does set can be overridden:

```sh
npm create clientkit@latest acme-app --preset react-tailwind --ui-library mui
```

A preset can also be named in a configuration file, alongside overrides:

```json
{
  "stack": {
    "preset": "react-tailwind",
    "router": "react-router"
  }
}
```

**Presets compose with partial configuration.** Configure the parts you care
about and let a preset fill the rest:

```sh
npm create clientkit@latest acme-app --router react-router
```

then choose **React + Material UI** when asked. The router stays as you set it
and the preset supplies the framework, the styling system and the component
library:

```
Framework          react          [preset]
Styling            tailwind       [preset]
Component library  mui            [preset]
Routing            react-router   [flag]
```

Choosing one interactively is offered as the first stack question, with
**Custom** to answer everything yourself. A preset is listed while it can still
contribute something you have not already decided, and disappears once it
cannot — so `--framework react --styling tailwind` leaves only `react-mui` on
the menu, and adding `--ui-library mui` removes the question altogether. Where
a preset would fill only some of what its name suggests, the menu says which
dimensions it would actually set.

Nothing is ever chosen for you: the default is always **Custom**, and flags that
happen to resemble a preset do not silently become one.

**A preset does not become a default.** A bare run still resolves Astro +
Tailwind, and `--yes` without `--preset` produces exactly what it did before.

**An unknown preset is refused**, listing the ones that exist. It never falls
back to a similarly named template or to the default stack.

**Overriding into an impossible stack is still refused** — by the compatibility
engine, not by the preset. `--preset react-mui --framework astro` reports that
MUI needs `react-runtime` and Astro provides none, the same message the
equivalent flags produce.

### Config file (`--from`)

Strictly JSON — never executed, and never a way around validation. Unknown keys
and wrong types are errors.

```jsonc
{
  "dir": "acme-app",
  "site": {
    "name": "Acme Ltd",
    "url": "https://acme.example",
  },
  "stack": {
    "framework": "react",
    "buildTool": "vite",
    "language": "typescript",
    "styling": "tailwind",
    "uiLibrary": "mui",
    "router": "react-router",
    "architecture": "react-standard",
    "features": ["client-route-fallback"],
  },
  "packageManager": "npm",
  "git": true,
  "install": true,
}
```

```sh
npm create clientkit@latest -- --from clientkit.json --yes
```

Two complete examples ship with the repository:
[`example.stack.json`](./example.stack.json) for the form above, and
[`example.preset.json`](./example.preset.json) for the older template-based
form, which still works unchanged.

**Every field is optional.** A file naming only `{"stack": {"framework":
"react"}}` is valid: the rest is asked for interactively, or filled from the
same defaults a bare run uses. There are no config-file-specific defaults.

**`stack` uses the same names as the flags**, without the dashes, and takes the
same values. `features` is a JSON array — one id per entry, no commas inside an
entry — and is sorted and de-duplicated the same way `--features` is, with a
repeated id rejected rather than collapsed.

**Combinations are validated identically.** A file asking for React with `seo`
fails with the same message `--framework react --features seo` produces, from
the same compatibility engine. Unknown values are refused, and a known name
with no adapter behind it — `nextjs`, `chakra` — reports that no adapter
implements it rather than quietly substituting something else.

**`stack` and `template` are alternatives.** A template names a whole stack and
the dimensions configure one, so a file containing both is refused, as is a
file with a `template` used alongside a stack flag. This is the same rule
`--template` follows on the command line.

### Configuration precedence

```
CLI flags  >  --from file  >  interactive answers  >  template defaults  >  built-in defaults
```

This holds per value, not per source: a file that sets `framework` and
`styling` alongside `--styling bootstrap` contributes its framework and loses
its styling.

### Where a value came from

`--dry-run` prints the resolved stack, and with `--debug` each line names the
layer that supplied it:

```sh
npm create clientkit@latest acme-app --preset react-mui --router react-router --dry-run --debug
```

```
Stack
  Framework         react           [preset]
  Build tool        vite            [adapter]
  Language          ts              [adapter]
  Styling           tailwind        [preset]
  Component library mui             [preset]
  Routing           react-router    [flag]
  Architecture      react-standard  [adapter]
  Features          none            [default]
```

The sources are `flag`, `file`, `preset`, `prompt`, `adapter` and `default`.
The last two are worth distinguishing: `adapter` means the framework you chose
decided it — React needs Vite and says so — while `default` is a built-in
preference no framework owns. Neither is a choice you made, and neither
pretends to be.

Prompts are only issued for values no higher-precedence source supplied, so a
fully specified file needs no terminal and `--yes` never discards it.

## Frameworks, templates and modes

Three frameworks ship. Each is chosen with `--framework`; `--template` names
the V1 Astro stack and is kept for compatibility.

| Framework | Stack                                                                                                     | Modes                 |
| --------- | --------------------------------------------------------------------------------------------------------- | --------------------- |
| `astro`   | Astro 7, Tailwind CSS 4, TypeScript 5.9                                                                   | `coming-soon`, `full` |
| `react`   | React 19, Vite 8, TypeScript 5.9, Tailwind or Bootstrap                                                   | `coming-soon`, `full` |
| `nextjs`  | Next.js 16 (App Router), React 19, TypeScript 5.9, Tailwind, Bootstrap or plain CSS, optional Material UI | `coming-soon`, `full` |

- **`coming-soon`** — a single polished launch page you can put live today.
- **`full`** — a small multi-section home page, on the same design system.

The Astro stack includes the custom 404, the design system and the full SEO
layer. What each framework supports differs, and the differences are enforced
rather than documented. Tailwind composes with all three - through Vite on
Astro and React, through PostCSS on Next.js - from one styling adapter that
names no framework, and Bootstrap composes with React and Next.js the same
way. Next.js declares its own document head and ships no component library or
client-side router, so MUI, React Router and the SEO, structured-data and
accessibility features are refused there, each naming the capability that is
missing.

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
