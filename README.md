# create-clientkit

**Create the boring foundation of your next client website in seconds.**

A scaffolding CLI for the developers who build client websites over and over:
freelancers, agencies and frontend teams. It generates the foundation you
rebuild every time — layout, Coming Soon page, 404, SEO, robots, sitemap,
favicons, accessibility baseline, build config — and then gets out of the way.

It is **not** a website builder. You own the generated source from the moment it
lands on disk.

```sh
npm create clientkit@latest acme-website
```

---

> ### Status: early build (milestone M1)
>
> The CLI resolves and validates configuration and prints the plan it _would_
> execute. **No files are generated yet** — the template engine and the
> Astro + TypeScript + Tailwind template land in M2 and M3.

---

## Usage

```sh
npm create clientkit@latest [directory] [options]
npx create-clientkit@latest [directory] [options]
```

| Flag                  | Description                               |
| --------------------- | ----------------------------------------- |
| `-t, --template <id>` | Template to scaffold from                 |
| `--list-templates`    | List available templates and exit         |
| `-y, --yes`           | Accept all defaults; never prompt         |
| `--from <file>`       | Read answers from a JSON config file      |
| `--dry-run`           | Resolve and print the plan; write nothing |
| `--no-git`            | Skip git initialisation                   |
| `--no-install`        | Skip dependency installation              |
| `--name <name>`       | Client / site name                        |
| `--url <url>`         | Production URL (omit if not decided yet)  |
| `-m, --mode <mode>`   | `coming-soon` or `full`                   |
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

Every run is scriptable. `--yes` never prompts, and a non-TTY stdin without
`--yes` fails immediately rather than hanging:

```sh
npm create clientkit@latest acme-website --yes --no-install
npm create clientkit@latest acme-website --yes --name "Acme Ltd" --mode full
npm create clientkit@latest --from ./agency-preset.json --dry-run
```

Every prompt has a matching flag, so a fully scripted run needs no config file.

### Config file (`--from`)

Strictly JSON — never executed, and never a way around validation. Unknown keys
and wrong types are errors. See [`example.preset.json`](./example.preset.json).

```json
{
  "dir": "acme-website",
  "site": {
    "name": "Acme Ltd",
    "url": "https://acme.example",
    "description": "Bespoke widgets since 1994.",
    "locale": "en-GB",
    "author": null
  },
  "template": { "id": "astro-tailwind", "version": null, "mode": "coming-soon" },
  "packageManager": "pnpm",
  "git": true,
  "install": false
}
```

### Configuration precedence

```
CLI flags  >  --from file  >  interactive answers  >  template defaults  >  built-in defaults
```

Prompts are only issued for values that no higher-precedence source supplied, so
the ordering is enforced structurally rather than by a final overwrite pass.
Everything resolves into one frozen `ProjectContext`, and nothing downstream
reads flags, prompts or environment variables directly.

## Architecture

```
bin/cli.js        Node version gate, then loads the bundle
  |
src/cli.ts        argv parsing, error boundary, exit codes
  |
src/commands/     create, list
  |
src/context/      resolve, prompts, defaults, validate, fromFile
  |
ProjectContext    frozen; the contract for every later stage
```

Generation itself is split into a pure planner and a separate apply step:

```
ProjectContext
  -> registry      discovers templates/ inside the package (never downloaded)
  -> compose       base/ then modes/<mode>/; later layers win
  -> tokens        {{siteName}} and friends; unknown tokens are an error
  -> plan()        FileOperation[] in memory - reads only, writes nothing
  -> apply()       stages in a sibling temp dir, then moves into place
```

`plan()` never mutates anything, which is what makes `--dry-run` exact rather
than a promise. `apply()` materialises the whole tree in a temporary sibling
directory first, so a failure part-way through leaves the target untouched.

### What gets generated

```
.client-site.json      how this project was scaffolded (no secrets)
.gitattributes
.gitignore
README.md
astro.config.mjs
package.json
public/favicon.svg
src/config/site.config.ts
src/layouts/BaseLayout.astro
src/pages/index.astro
src/styles/global.css
tsconfig.json
```

Pinned exactly: Astro 7.3.2, Tailwind CSS 4.3.3 via `@tailwindcss/vite`,
TypeScript 5.9.3. Tailwind v4 is configured in CSS (`@theme`) - there is no
`tailwind.config.js`. The generated project requires Node 22.12+, which is
Astro 7's own floor; the CLI itself still runs on Node 20.19.

### Writing into a directory that already has files

A missing or empty directory is generated straight into. A directory with
content is never overwritten silently: the CLI lists exactly which files would
be replaced and asks first, defaulting to no. Files the template does not name
are never touched or deleted. In non-interactive mode (`--yes`) a non-empty
directory is refused outright, because there is no way to confirm.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
node bin/cli.js --help
```

`npm run verify` runs all three and is wired to `prepublishOnly`.

## Design commitments

- **Zero runtime dependencies.** `@clack/prompts` and `picocolors` are bundled
  into a single ESM file at build time, so `npm create` is one tarball and no
  dependency resolution. See [THIRD-PARTY.md](./THIRD-PARTY.md).
- **Node >= 20.19**, checked in plain ES5 before the bundle is even loaded.
- **Nothing is invented.** An omitted production URL stays `null`; the author
  field stays empty until it can be read from your git config.
- **Generated projects will not be MIT-licensed.** They ship `"private": true`
  and `"license": "UNLICENSED"`, because a client site is normally proprietary
  work-for-hire. This CLI itself is MIT.

## Licence

MIT — see [LICENSE](./LICENSE).
