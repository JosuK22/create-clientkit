# Contributing

Thanks for looking. This is a small, deliberately narrow project maintained by
one person, so the most useful thing you can do is report something concrete.

## Reporting a problem

Use an [issue template](https://github.com/JosuK22/create-clientkit/issues/new/choose).
They exist to collect the things needed to reproduce a report — the exact
command, versions, operating system, and whether `SITE.url` was set. A report
with those details usually gets fixed; one without them usually turns into a
conversation about details first.

If you hit a **security** problem, do not open a public issue. Email
josephkanoj@gmail.com instead.

### Questions

Issues are the channel for those too, for now.

> **Decision: GitHub Discussions stays disabled.**
> Issues provide a sufficient public feedback channel at the current project
> stage — there is not yet enough usage for a discussion forum to have anyone
> in it, and an empty Discussions tab reads as an abandoned one. Revisit when
> community usage increases.

A question asked in an issue is a perfectly good issue. If it turns out the
answer should have been in the docs, that is a documentation bug worth having.

## What this project is, and is not

`create-clientkit` scaffolds the foundation of a client website and then gets
out of the way. The generated source belongs to whoever generated it.

These are **non-goals**, not missing features: a CMS, authentication, forms,
analytics, deployment or DNS automation, payments, a plugin marketplace,
telemetry, and a visual builder.

Proposals that make the existing scaffolds better are genuinely welcome. So is
a request for a stack that is not supported yet — open an
[idea issue](https://github.com/JosuK22/create-clientkit/issues/new/choose) and
say what you would use it for, before writing an adapter.

## Ways to help

- **Report a bug** — in the CLI, or in a project it generated. There is a
  separate issue template for each.
- **Fix the docs** — if something in the README, the [guides](./docs/) or
  `--help` was wrong or missing, that is a bug worth reporting, and a docs PR is
  welcome.
- **Improve a generated project** — templates live in `templates/` (see
  [docs/architecture/templates.md](./docs/architecture/templates.md)), and the
  code that composes them in `src/adapters/`. Changes to generated output
  usually need a golden snapshot update; see
  [docs/golden-snapshots.md](./docs/golden-snapshots.md).
- **Suggest a preset or stack** — presets are defined in
  `src/context/presets.ts`. A new framework or library means a new adapter; the
  design is in [docs/v2-architecture.md](./docs/v2-architecture.md).

## Working on the code

```sh
npm ci
npm run verify      # typecheck, lint, format:check, test, build
```

Before opening a pull request:

```sh
npm run smoke       # pack, install into a clean dir, generate, check, build
```

`npm run smoke:audit` additionally runs axe and Lighthouse against the
generated sites. It is slower, and it is what CI runs.

Validation that cannot be automated — real-device mobile passes, and what was
and was not covered — is recorded in [TESTING.md](./TESTING.md).

| Script                  | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `npm test`              | Unit and integration tests                                  |
| `npm run verify`        | The quick local gate                                        |
| `npm run smoke`         | Clean-room generation and build                             |
| `npm run smoke:audit`   | The above, plus axe and Lighthouse                          |
| `npm run check:package` | Tarball contents and dependency guards                      |
| `npm run cancel-check`  | Ctrl+C cancellation (Linux and macOS only — see the script) |
| `npm run drift:report`  | Template pins vs the latest published versions              |
| `npm run preflight`     | Every release gate, in order                                |

## Things that will be asked in review

Not rules for their own sake — each one exists because of a specific bug:

- **Nothing is invented.** If a value is unknown, the generated site omits the
  tag rather than pointing it at a guess. No placeholder domains, no default
  `og:image`, no fabricated contact details.
- **The template manifest stays declarative.** `template.json` is data. It
  cannot carry shell commands, and post-steps are a fixed allow-list.
- **Generated projects stay `"private": true` and `"license": "UNLICENSED"`.**
  The CLI itself is MIT; client work normally is not.
- **The CLI ships zero runtime dependencies.** They are bundled at build time.
- **Tests are not weakened to go green.** Neither are CI platforms removed or
  audit thresholds raised. If a gate fails, the gate is usually right.

## Releasing

Maintainer-only, documented separately in [RELEASING.md](./RELEASING.md).
Releases are staged from CI with provenance and approved by a human — there is
no long-lived npm token anywhere in this repository.
