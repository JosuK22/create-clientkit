# Releasing

This document records how `create-clientkit` is released, so each release is a
decision rather than an improvisation.

## Before anything else

- [x] Author and repository metadata resolved (`JosuK22`, `josephkanoj@gmail.com`).
- [x] `create-clientkit` confirmed unclaimed on npm.
- [x] npm account created with 2FA enabled.
- [x] CI green on GitHub-hosted runners (17/17, three platforms).
- [x] Bootstrap publish of `0.1.0` — see below.
- [ ] Configure trusted publishing (OIDC) on npmjs.com, which is only possible
      after that first publish.
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

It publishes nothing and needs no credentials. If it passes:

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

## If a release is bad

`npm deprecate create-clientkit@<version> "<reason>"` and publish a fix.
Unpublishing is only possible within 72 hours and breaks anyone who already
installed it — deprecate instead, except for a genuine secret leak.
