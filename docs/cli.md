# CLI reference

```text
npm create clientkit@latest [directory] -- [options]
npm create clientkit@latest upgrade <directory> -- [options]
npm create clientkit@latest detect [directory] -- [--debug]
```

**The `--` matters.** With `npm create`, npm reads any option before a `--` as
its own. Options such as `--yes` and `--dry-run` are npm options too, so without
the separator npm takes them and ClientKit never sees them. A directory name
needs no separator; options do:

```sh
npm create clientkit@latest acme-website                  # fine
npm create clientkit@latest acme-website -- --yes         # fine
npm create clientkit@latest acme-website --yes            # --yes goes to npm, not ClientKit
```

`npx` passes everything through, so it needs no `--`:

```sh
npx create-clientkit@latest acme-website --yes --framework react
```

npm also caches initializers, so `npm create clientkit@latest` can run an older
cached version. The first line of interactive output, or `--version`, shows the
version that actually ran — see
[Troubleshooting](./troubleshooting.md#an-old-version-runs).

`--help` prints the values your installed version supports, read from the code
rather than from this page.

## Contents

- [Project options](#project-options)
- [Stack options](#stack-options)
- [Run options](#run-options)
- [Interactive mode](#interactive-mode)
- [Non-interactive mode](#non-interactive-mode)
- [Presets](#presets)
- [Config file (`--from`)](#config-file---from)
- [Configuration precedence](#configuration-precedence)
- [Seeing where a value came from](#seeing-where-a-value-came-from)
- [`detect`](#detect)
- [`--template` (legacy)](#--template-legacy)

## Project options

| Option              | Purpose                     | Accepted values            | Default                                                           | Example                      |
| ------------------- | --------------------------- | -------------------------- | ----------------------------------------------------------------- | ---------------------------- |
| `[directory]`       | Where to generate           | a path                     | asked (`my-client-site`); required with `--yes`                   | `acme-website`               |
| `--name <name>`     | Client / site name          | any non-empty text         | title-cased directory name                                        | `--name "Acme Ltd"`          |
| `--url <url>`       | Production URL              | an `http:` or `https:` URL | unset — see [URL-less](./generated-project.md#the-production-url) | `--url https://acme.example` |
| `-m, --mode <mode>` | Which starter page to write | `coming-soon`, `full`      | `coming-soon`                                                     | `--mode full`                |

- **`coming-soon`** — a single launch page you can put live today.
- **`full`** — a small multi-section home page, on the same styling.

## Stack options

Each flag sets one part of the stack. Anything you leave out is asked for, or —
when only one answer is possible — filled in from the framework.

| Option                | Purpose                  | Accepted values                                                                 | Default                        | Example                         |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------- | ------------------------------ | ------------------------------- |
| `--preset <id>`       | Start from a named stack | `astro-tailwind`, `react-tailwind`, `react-bootstrap`, `react-mui`              | none                           | `--preset react-mui`            |
| `--framework <id>`    | Framework                | `astro`, `react`, `nextjs`                                                      | `astro`                        | `--framework nextjs`            |
| `--styling <id>`      | How CSS is built         | `tailwind`, `bootstrap`, `none`                                                 | `tailwind` (`none` on Next.js) | `--styling bootstrap`           |
| `--ui-library <id>`   | Component library        | `mui`, `chakra`, `none`                                                         | `none`                         | `--ui-library chakra`           |
| `--router <id>`       | Routing                  | `react-router`, `none`, `file-based`                                            | the framework's                | `--router react-router`         |
| `--features <a,b>`    | Optional site features   | `seo`, `structured-data`, `accessibility`, `not-found`, `client-route-fallback` | none                           | `--features seo,not-found`      |
| `--build-tool <id>`   | Bundler                  | `vite` (Astro and Next.js use their own)                                        | the framework's                | `--build-tool vite`             |
| `--language <id>`     | Language                 | `ts` (or `typescript`)                                                          | `ts`                           | `--language ts`                 |
| `--architecture <id>` | Folder layout            | defined by the framework                                                        | the framework's                | `--architecture react-standard` |

Which values each framework accepts is in [stacks.md](./stacks.md). In short:

| Framework | `--styling`                     | `--ui-library`          | `--router`             | `--features`                                           |
| --------- | ------------------------------- | ----------------------- | ---------------------- | ------------------------------------------------------ |
| `astro`   | `tailwind`                      | `none`                  | `file-based`           | `seo`, `structured-data`, `accessibility`, `not-found` |
| `react`   | `tailwind`, `bootstrap`         | `none`, `mui`, `chakra` | `none`, `react-router` | `client-route-fallback` (with `react-router`)          |
| `nextjs`  | `tailwind`, `bootstrap`, `none` | `none`, `mui`, `chakra` | `file-based`           | `seo`, `not-found`                                     |

Notes:

- `--features` takes a comma-separated list and can be repeated. An unknown id
  is an error, and so is the same id twice.
- `--build-tool`, `--language` and `--architecture` currently have only one
  valid value per framework, so they are never asked and rarely worth passing.
  Passing a value the framework does not offer is refused rather than ignored:
  `--framework astro --build-tool vite` is an error.
- Values ClientKit recognises but has not implemented — for example `angular`
  or `angular-material` — are refused with "no adapter implements it". Values it
  has never heard of are refused as unknown. Neither falls back to a default.

## Run options

| Option           | Purpose                                                       | Default                               |
| ---------------- | ------------------------------------------------------------- | ------------------------------------- |
| `-y, --yes`      | Accept defaults for anything not given; never prompt          | off                                   |
| `--from <file>`  | Read answers from a JSON file                                 | —                                     |
| `--dry-run`      | Resolve and print the plan and file list; write nothing       | off                                   |
| `--no-install`   | Skip installing dependencies                                  | install                               |
| `--no-git`       | Skip initialising a git repository                            | git init                              |
| `--pm <manager>` | Package manager for the install: `npm`, `pnpm`, `yarn`, `bun` | detected from the one running the CLI |
| `--debug`        | Show each value's source and full stack traces                | off                                   |
| `-h, --help`     | Show help                                                     |                                       |
| `-v, --version`  | Show the version                                              |                                       |

## Interactive mode

Run with no options in a terminal and it asks:

1. **Project directory**
2. **Client / site name** — defaults to the title-cased directory name
3. **Production URL** — optional; Enter skips it
4. **Start from** — a preset, or **Custom** (the default) to answer each question
5. **Framework**
6. **Styling** — only when the framework offers more than one
7. **Component library** — only when the framework can mount one
8. **Routing** — only when the framework offers a choice
9. **Features** — any number, or none
10. **Starting mode** — Coming Soon or Full Starter
11. **Setup** — install dependencies, initialise git (both on by default)

Only questions worth asking are asked:

- A question with one possible answer is skipped. Astro is not asked about
  styling (only Tailwind works there), and no framework is asked about build
  tool, language or architecture.
- Choices that cannot work with what you already picked are not shown.
  Bootstrap does not appear under Astro; the client-route fallback appears only
  once React Router is chosen.
- A flag you pass is a question you are not asked, so partial configuration
  works:

  ```sh
  # asks for styling, component library, routing and features — not the framework
  npm create clientkit@latest acme-app -- --framework react
  ```

The menus come from the same compatibility rules that validate flags, so the
prompts and the flags can never disagree.

## Non-interactive mode

Every question has a flag. With `--yes`, anything not given takes its default
and nothing is asked:

```sh
npm create clientkit@latest acme-website -- --yes --name "Acme Ltd" --mode full
npm create clientkit@latest acme-app -- --yes --preset react-tailwind --no-git
```

`--yes` on its own gives Astro + Tailwind, Coming Soon mode, no URL.

Without a terminal (CI, scripts) and without `--yes`, the CLI fails immediately
rather than hanging on a prompt.

## Presets

A preset is a named set of stack choices:

| Preset            | Framework | Styling   | Component library |
| ----------------- | --------- | --------- | ----------------- |
| `astro-tailwind`  | astro     | tailwind  | —                 |
| `react-tailwind`  | react     | tailwind  | —                 |
| `react-bootstrap` | react     | bootstrap | —                 |
| `react-mui`       | react     | tailwind  | mui               |

How they behave:

- **Partial.** A preset only sets what is listed above. Routing, features and
  anything else are asked for or defaulted as usual.
- **Overridable.** Any flag beats the preset:
  `--preset react-tailwind --ui-library mui`.
- **Equivalent to the flags.** `--preset react-mui` and
  `--framework react --styling tailwind --ui-library mui` produce the same
  project.
- **Checked the same way.** `--preset react-mui --framework astro` is refused by
  the compatibility rules, with the same message as the equivalent flags.
- **Never a default.** A bare run and `--yes` still give Astro + Tailwind. In
  the interactive menu, **Custom** is always the default, and a preset is only
  listed while it can still set something you have not already decided.
- **Unknown presets are refused**, with the list of valid ones.

A preset can also be named in a config file (`"stack": { "preset": "..." }`).

For a stack of your own that you reuse across clients, use a
[config file](#config-file---from) — that is what it is for.

## Config file (`--from`)

A JSON file with the same answers the flags and prompts give. It is parsed as
strict JSON — never executed — and unknown keys and wrong types are errors, so
a typo fails loudly.

```sh
npm create clientkit@latest acme-app -- --from clientkit.json
npm create clientkit@latest -- --from clientkit.json --yes --dry-run
```

Every field is optional. Anything the file leaves out is asked for, or filled
from the normal defaults.

```json
{
  "dir": "acme-app",
  "site": {
    "name": "Acme Ltd",
    "url": "https://acme.example",
    "description": "Bespoke widgets since 1994.",
    "locale": "en-GB",
    "author": null
  },
  "stack": {
    "preset": "react-tailwind",
    "framework": "react",
    "buildTool": "vite",
    "language": "typescript",
    "styling": "tailwind",
    "uiLibrary": "mui",
    "router": "react-router",
    "architecture": "react-standard",
    "features": ["client-route-fallback"]
  },
  "template": {
    "mode": "full"
  },
  "packageManager": "pnpm",
  "git": true,
  "install": true
}
```

| Key              | Takes                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `dir`            | Target directory                                                                                     |
| `site`           | `name`, `url`, `description`, `locale`, `author` — `description` and `locale` have no flag           |
| `stack`          | The stack options, camel-cased without dashes (`uiLibrary`, `buildTool`); `features` is a JSON array |
| `template`       | `mode` (`coming-soon` or `full`); or `id` and `version` for the [legacy form](#--template-legacy)    |
| `packageManager` | `npm`, `pnpm`, `yarn`, `bun`                                                                         |
| `git`, `install` | `true` or `false`                                                                                    |

Rules:

- `stack` and `template.id` are alternatives — a file naming both is refused.
  `template.mode` on its own is fine alongside `stack`.
- Stack values are validated exactly like flags. A file asking for React with
  `seo` fails with the same message as `--framework react --features seo`.

Two complete examples ship in the repository:
[`example.stack.json`](../example.stack.json) and
[`example.preset.json`](../example.preset.json) (the template-based form).

### Reusing one file across clients

The most useful pattern for an agency: keep your standard stack in one file,
and pass what changes per client as flags.

```json
{
  "stack": { "preset": "react-tailwind", "router": "react-router" },
  "site": { "locale": "en-GB" },
  "packageManager": "pnpm"
}
```

```sh
npm create clientkit@latest northwind-bakery -- --from agency.json \
  --name "Northwind Bakery" --url https://northwind.example --yes
```

## Configuration precedence

```text
CLI flags  >  --from file  >  --preset  >  interactive answers  >  template defaults  >  built-in defaults
```

This applies per value, not per source: a file that sets `framework` and
`styling`, run with `--styling bootstrap`, contributes its framework and loses
its styling.

Prompts are only shown for values nothing higher up supplied, so a complete
config file needs no terminal.

## Seeing where a value came from

`--dry-run` prints the resolved stack and every file it would write. Add
`--debug` and each value is labelled with its source:

```sh
npm create clientkit@latest acme-app -- --preset react-mui --router react-router --dry-run --debug
```

```text
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

Sources are `flag`, `file`, `preset`, `prompt`, `adapter` and `default`.
`adapter` means the framework decided it (React needs Vite); `default` is a
built-in preference no framework owns.

## `detect`

```sh
npm create clientkit@latest detect ./acme-site
npx create-clientkit@latest detect --debug          # the current directory
```

Reports what an existing project is built with — framework, build tool,
language, styling, UI library, router and package manager — with the evidence
for each. It then says whether that is a stack ClientKit supports, as the flags
you would pass for it:

```text
ClientKit project detection

  Directory         acme-site
  Project           acme-site

  Framework         react         dependencies.react
  Build tool        vite          devDependencies.vite, vite.config.ts
  Language          ts            devDependencies.typescript, tsconfig.json
  Styling           tailwind      devDependencies.tailwindcss
  UI library        mui           dependencies.@mui/material
  Router            react-router  dependencies.react-router-dom
  Package manager   pnpm          pnpm-lock.yaml

  ClientKit stack   supported
    --framework react --build-tool vite --language ts --styling tailwind --ui-library mui --router react-router
    architecture react-standard: set by the react framework

  .client-site.json is present: ClientKit generated this project. Detection does not read it; `upgrade` does.
```

It reads `package.json` and the names of files in that one directory. It never
writes, prompts, installs or runs anything, and works on a fresh clone without
`node_modules`. A framework ClientKit does not support is named rather than
guessed at. Two lockfiles, or two styling systems, are reported as ambiguous
rather than resolved by picking one.

It exits `0` whenever detection completes, including for an unsupported or
half-configured project. It exits `2` if the directory does not exist, or if
given an option that configures generation (`--framework`, `--yes`, …).
`--debug` also lists what was looked for when nothing was found. See
[architecture/project-detection.md](./architecture/project-detection.md) for
the evidence rules.

## `--template` (legacy)

| Option                | Purpose                           |
| --------------------- | --------------------------------- |
| `-t, --template <id>` | Scaffold from a named template    |
| `--list-templates`    | List available templates and exit |

Before 1.1, ClientKit had one template, `astro-tailwind`, chosen with
`--template`. It still works, but the stack options above are the way to choose
a stack now. `--template` names a whole stack, so it cannot be combined with
any stack option — including `--preset` — even when they agree. `--mode` works
with either.
