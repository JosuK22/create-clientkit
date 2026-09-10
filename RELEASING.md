# Releasing

`create-clientkit` has **not been published**. This document records how it
will be, so the first release is a decision rather than an improvisation.

## Before anything else

Three things are still outstanding and block a first publish:

- [ ] Replace the `{{AUTHOR_NAME}}` placeholder in `package.json` and `LICENSE`
      — `npm run preflight` fails while either is unresolved, deliberately: a
      licence with no copyright holder is worse than no licence.
- [ ] Replace `{{GITHUB_HANDLE}}` in the `repository`, `bugs` and `homepage`
      fields.
- [ ] Create the npm account, enable 2FA, and confirm `create-clientkit` is
      still unclaimed.

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

The first public release is `1.0.0`. The version stays at `0.1.0` until then;
nothing is gained by bumping it while the package is unpublished.

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

Then publish from CI (see below), and write the release notes on the tag.

## Publishing with provenance

Publishing should happen from a GitHub Actions workflow using **trusted
publishing (OIDC)**, not a long-lived `NPM_TOKEN` stored as a secret. The
workflow does not exist yet — it is deliberately left until the account and
placeholders above are settled — but the shape is:

```yaml
permissions:
  contents: read
  id-token: write # required for provenance

steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 24
      registry-url: https://registry.npmjs.org
  - run: npm ci
  - run: npm run preflight
  - run: npm publish --access public --provenance
```

Requirements for that to work:

- npm must be new enough to support `--provenance` (npm 9.5+).
- The workflow must run on a public GitHub repository.
- Trusted publishing must be configured for the package on npmjs.com, linking
  it to this repository and workflow file.
- `prepublishOnly` already runs `preflight`, so a local `npm publish` is also
  gated — but a local publish cannot produce provenance.

## After publishing

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
