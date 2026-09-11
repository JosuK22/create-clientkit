# Releasing

This document records how `create-clientkit` is released, so each release is a
decision rather than an improvisation.

## Before anything else

- [x] Author and repository metadata resolved (`JosuK22`, `josephkanoj@gmail.com`).
- [x] `create-clientkit` confirmed unclaimed on npm.
- [x] npm account created with 2FA enabled.
- [x] CI green on GitHub-hosted runners (17/17, three platforms).
- [x] Bootstrap publish of `0.1.0` — see below.
- [x] Configure trusted publishing (OIDC) on npmjs.com, which is only possible
      after that first publish. Configured for **staged publishing only** —
      see the table below.
- [x] A generated site deployed and validated against a real domain.

## The bootstrap publish

npm's trusted publishing cannot be configured until the package exists: the
setting lives on the package's own settings page, which does not exist until
something has been published. The first release therefore has to be published
locally, and only later releases can carry provenance.

See <https://github.com/npm/cli/issues/8544>.

That constraint decides the release order. `0.1.0` is published locally to
claim the name and create the settings page; trusted publishing is configured;
then `1.0.0` — the release that matters — is published from CI **with
provenance**.

```sh
npm login          # interactive, with your 2FA code
npm run preflight  # must pass 11/11
npm publish --access public
```

A local `npm publish` authenticates interactively against your 2FA. That is not
a long-lived token and nothing is written to the repository. Do **not** create a
granular access token for this; it is not needed, and a stored token is exactly
what trusted publishing exists to avoid.

Then, on npmjs.com → the package → Settings → **Trusted Publisher** →
GitHub Actions:

| Field                | Value               |
| -------------------- | ------------------- |
| Organization or user | `JosuK22`           |
| Repository           | `create-clientkit`  |
| Workflow filename    | `release.yml`       |
| Environment          | leave empty         |
| Allowed actions      | leave **unchecked** |

That last row is the important one. `npm stage publish` is always allowed for
a trusted publisher; the checkbox grants the _additional_ right to publish
directly with `npm publish`, and npm marks it "Not recommended".

Leaving it unchecked means CI can prepare a release but cannot make one live.
That is the only step in the whole pipeline where an automated system would
otherwise make an irreversible public change with no human in the loop —
unpublishing is possible for 72 hours and breaks anyone who already installed.
The cost of the stricter setting is one `npm stage approve` command.

## Versioning

Semantic versioning, with the generated template treated as part of the public
surface:

| Change                                                                                       | Bump  |
| -------------------------------------------------------------------------------------------- | ----- |
| CLI bug fix, docs, internal refactor                                                         | patch |
| Template fix that does not change the generated file set                                     | patch |
| New flag, new template, new mode, new generated file                                         | minor |
| Removing a flag, renaming a config export, changing a default that alters existing behaviour | major |
| Raising the Node floor for the CLI or the template                                           | major |

The first _stable_ release is `1.0.0`. `0.1.0` is published first only to
bootstrap trusted publishing, and is labelled a pre-release in the changelog.

Changesets is **not** used. For a single package with one maintainer it adds a
workflow without removing one — the version is edited in `package.json` and the
change is described in the release notes.

## The release process

```sh
git switch main && git pull
npm ci
npm run preflight
```

`npm run preflight` is the gate. It runs, in order:

1. working tree clean
2. version is valid semver, name and licence unchanged
3. author placeholders resolved
4. `typecheck`
5. `lint`
6. `format:check`
7. `third-party:check` — notices match the dependency graph
8. `test`
9. `build`
10. `check:package` — tarball contents, dependency guards, hygiene
11. `smoke:audit` — clean-room install, generate, check, build, axe, Lighthouse

It publishes nothing and needs no credentials.

A complete pass records a stamp under `node_modules/.cache/clientkit/`
containing the shasum of the tarball `npm publish` would upload.
`prepublishOnly` runs `preflight --skip-if-verified`, which skips the gates
**only** when the tarball npm would produce right now has that exact shasum.
That is what stops the release workflow running every gate twice.

It is not a bypass, and it cannot be used as one. A source edit, a
hand-modified `dist/`, a version bump, a different machine or a missing stamp
all change or invalidate the comparison and the gates run in full. `--fast` and
`--allow-dirty` runs never write a stamp at all, because each skips a real gate
and must not stand in for a complete verdict. To force a full run, delete the
stamp or pass `npm run preflight` directly.

If it passes:

```sh
npm version <patch|minor|major>
git push --follow-tags
```

The tag triggers CI, which stages the release. Approve it (see below), then
write the release notes on the tag.

## Publishing with provenance

Publishing happens in two halves: CI stages, a human approves.

`.github/workflows/release.yml` uses **trusted publishing (OIDC)**, not a
long-lived `NPM_TOKEN`. It triggers on a `v*.*.*` tag, verifies the tag matches
`package.json`, runs the full preflight, packs, uploads the artifact, and only
then stages:

```yaml
permissions:
  contents: read
  id-token: write # required for provenance

steps:
  - uses: actions/checkout@v7
  - uses: actions/setup-node@v7
    with:
      node-version: 24
      registry-url: https://registry.npmjs.org
  - run: npm ci
  - run: npm run preflight
  - run: npm stage publish --access public --provenance
```

Nothing is public at that point. To make it live:

```sh
npm stage list create-clientkit
npm stage view <stage-id>        # inspect before approving
npm stage approve <stage-id>     # prompts for 2FA
```

`npm stage reject <stage-id>` discards it instead. Approval is only possible
once npm's malware scan has finished.

**The `npm stage` subcommand needs npm 11.15.0+ locally**, which is newer than
the npm bundled with Node 22. CI is unaffected — it runs Node 24 — but the
machine doing the approving may not have it, and the failure is an unhelpful
`Unknown command: "stage"`. Either approve on npmjs.com under the package's
**Staged Packages** tab, which needs no CLI at all, or run a newer npm without
touching the global install:

```sh
npx npm@11 stage approve <stage-id>
```

Requirements for that to work:

- Staging needs npm 11.15.0+ and Node 22.14+. Node 24 ships npm 11.19.0, so
  the workflow's `node-version: 24` already satisfies both.
- The workflow must run on a public GitHub repository.
- Trusted publishing must be configured for the package on npmjs.com, linking
  it to this repository and workflow file.
- Approval cannot be automated. `npm stage approve` requires proof of presence
  and does not accept an OIDC token — which is the entire point.
- `--provenance` is redundant under trusted publishing, which attaches
  attestations automatically. It is kept explicit so that npm **fails** rather
  than quietly staging a build with no provenance.
- `prepublishOnly` already runs `preflight`, so a local publish is also gated —
  but a local publish cannot produce provenance.

## After approving

Verify the published artifact behaves like the tested one:

```sh
cd $(mktemp -d)
npm create clientkit@latest verify-site --yes --no-install --no-git
```

Then check the npm page shows the provenance badge, and that
`npm view create-clientkit dependencies` is empty.

## When a release goes wrong

Staged publishing means most failures happen before anything is public. Work
out which of these you are in before doing anything.

### Preflight failed in CI

Nothing was staged and nothing is public. Fix the cause, commit, and move the
tag:

```sh
git tag -d v<version>
git push origin :refs/tags/v<version>   # delete the remote tag
# ... fix, commit ...
git tag -a v<version> -m "..." && git push --follow-tags
```

Moving a tag is only acceptable because the version was never published. Once
a version is live its tag is immutable — ship a new version instead.

### Staged, but the artifact is wrong

The version exists in the staging area and is not installable by anyone.
Reject it:

```sh
npm stage list create-clientkit
npm stage reject <stage-id>
```

Then fix, and re-tag as above. Inspect first with `npm stage view <stage-id>`,
or `npm stage download <stage-id>` to examine the tarball itself.

### The tag and package.json disagree

The workflow refuses to publish and says so. This means the tag was created
without the version bump being committed. Delete the tag, commit the bump,
re-tag.

### Published, and it is bad

This is the only genuinely expensive case, which is the reason for every gate
before it.

```sh
npm deprecate create-clientkit@<version> "<reason>; use <good-version>"
```

Then publish a fix as a new patch version. **Do not unpublish.** It is only
possible within 72 hours, it breaks anyone who already installed, and npm
blocks re-using the version number afterwards. The sole exception is a genuine
secret leak, where the leaked credential must be rotated regardless — removing
the package does not un-leak it.

### The published artifact does not match the repository

Check the provenance before assuming the worst:

```sh
npm view create-clientkit@<version> dist.attestations
```

Every release from CI carries a SLSA attestation naming the workflow, the tag
and the runner. If it is absent on a version that should have it, or names
something unexpected, treat it as a security incident rather than a build
problem.
