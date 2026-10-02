# Troubleshooting

If none of these fit, open an
[issue](https://github.com/JosuK22/create-clientkit/issues/new/choose) — the
templates ask for the command, versions and OS, which is usually enough.
`--debug` prints full stack traces and where each value came from.

## My options were ignored

With `npm create`, options must come after a `--`:

```sh
npm create clientkit@latest acme-website -- --yes --framework react
```

Without it, npm treats them as its own options. `--yes` and `--dry-run` are
real npm options, so npm quietly takes them; others can end up as extra
arguments, giving _"Expected at most one target directory"_. `npx` does not
need the separator:

```sh
npx create-clientkit@latest acme-website --yes --framework react
```

## An old version runs

npm caches initializers, and `npm create clientkit@latest` can still run a
cached older version. Check what ran with:

```sh
npm create clientkit@latest -- --version
```

If it is behind [the latest release](https://www.npmjs.com/package/create-clientkit),
run a specific version, or clear npm's cache with `npm cache clean --force`:

```sh
npx create-clientkit@<version> acme-website   # e.g. the version npm lists as latest
```

## "requires Node.js 20.19 or newer"

The CLI refuses to run on older Node. Upgrade Node, or use a version manager
such as `nvm` or `fnm`.

## The generated project will not install

Each framework has its own Node minimum, which can be higher than the CLI's:

| Project | Node.js          |
| ------- | ---------------- |
| Astro   | 22.12+           |
| React   | ^20.19 or 22.12+ |
| Next.js | 20.9+            |

The CLI warns before generating when your Node version is too old for the
project you chose.

## "That combination will not work"

The stack you asked for cannot be built — for example React with
`--features seo`. The message says which part is missing. See
[Supported stacks](./stacks.md) for what each framework accepts.

## "Cannot prompt because stdin is not an interactive terminal"

You ran it from a script or CI without `--yes`. Add `--yes` and pass a
directory, or supply everything in a [config file](./cli.md#config-file---from).

## "Directory … already exists and is not empty"

The CLI never writes into a directory it does not recognise without asking.
Choose an empty directory, or run interactively to confirm a merge. To change a
project ClientKit generated, use [`upgrade`](./upgrading.md).

A project ClientKit generated is recognised by its `.client-site.json`, and
re-running the same command on it just reports it is already up to date. If
this message appears for such a project, the hint says why its record could
not be used.

## "… generated file(s) … differ from what ClientKit would write now"

You re-ran ClientKit on a project it generated, and some generated files no
longer match the plan: your edits, or files from another configuration or
release. Nothing was changed. Run interactively to review the list and confirm,
or use `--dry-run` to see the whole plan. See
[upgrading.md](./upgrading.md#re-running-create-over-an-existing-project).

## "… file(s) changed after ClientKit checked them, so nothing was written"

Something modified the project between ClientKit looking at it and writing to
it, usually while the confirmation question was open: an editor saving, a
formatter, a `git checkout`. ClientKit does not overwrite a file whose state
changed after it decided to write it, so it wrote nothing. Run the command
again to review the project as it is now. See
[architecture/planning-execution.md](./architecture/planning-execution.md#between-deciding-and-writing).

## Nothing was written after an error

By design. Generation writes into a temporary sibling directory and moves it
into place only once every file succeeded, so a failure leaves the target
untouched.

On Windows, a synced folder (OneDrive) or an antivirus scan can briefly hold
files open; the CLI retries the final move, but if it still fails, run it again
or generate outside the synced folder.
