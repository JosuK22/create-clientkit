# Templates

A **template** is the material a framework generates from: a `base/` layer, one
layer per starting mode (`modes/coming-soon/`, `modes/full/`), and a manifest
that says what it is. ClientKit ships three:

| Template         | Framework | Modes             | Offered by name (`--template`) |
| ---------------- | --------- | ----------------- | ------------------------------ |
| `astro-tailwind` | `astro`   | coming-soon, full | yes                            |
| `nextjs`         | `nextjs`  | coming-soon, full | no                             |
| `react-vite`     | `react`   | coming-soon, full | no                             |

Styling systems, component libraries and features are **not** templates. They
are adapters that add their own layers and files on top of a template, and the
compatibility engine decides which of them a stack may combine.

```text
Framework adapter ── declares ──► template manifest
                                         │
                                         ▼
Template catalog      createTemplateCatalog()   src/adapters/template-catalog.ts
  validate              defineTemplate()          src/templates/definition.ts
  resolve               catalog.resolve()
                                         │
                                         ▼
Template files        templateFiles()           src/templates/definition.ts
  enumerate + check                               (the planner's own walk and path rules)
                                         │
                                         ▼
Generation Plan       planManifest() / plan()   src/adapters/bridge.ts, src/generate/plan.ts
                                         │
                            ┌────────────┴────────────┐
                            ▼                         ▼
                        --dry-run                   apply()
```

A template never reaches the filesystem any other way. The definition describes
it and the Generation Plan decides every operation. Only the executor writes.

## The definition

`TemplateDefinition` (`src/templates/definition.ts`) is the one contract every
template is read through, however its manifest is stored:

| Part          | Field(s)                                         | From                                  |
| ------------- | ------------------------------------------------ | ------------------------------------- |
| Identity      | `id`, `version`                                  | manifest                              |
| Metadata      | `displayName`, `description`, `frameworkVersion` | manifest                              |
| Compatibility | `framework`, `modes`                             | manifest                              |
| Variables     | `variables`                                      | manifest `tokens`, typed from a table |
| Requirements  | `requirements.node`                              | manifest `minNode`                    |
| Behaviour     | `defaults`, `postSteps`, `nextSteps`             | manifest                              |
| Selection     | `discoverable`                                   | the framework adapter                 |
| Source        | `source`                                         | where the files are read from         |

Astro's manifest is `templates/astro-tailwind/template.json`. React's and
Next.js's are declared in code on their adapters, so they stay out of
`--list-templates`. Both kinds go through the same validator, `parseManifest`.
Before this, only `template.json` was checked.

### Identity

A lowercase kebab-case id (`react-vite`), unique across the catalog, and
independent of where the files live. A recorded project names its template by
this id in `.client-site.json`, and `upgrade` checks it against the stack (see
`src/adapters/template-identity.ts`).

### Compatibility

A template states one compatibility fact: the framework it is for. Everything
that framework fixes (build tool, language, file-based routing) follows from
the framework's adapter. Everything it leaves open, such as styling, component
library or router, is decided per stack by the compatibility engine. It is not
restated in the template. Resolving a template checks only what a template can
disagree with:

- it exists;
- it belongs to the stack's framework. Asking to plan a React stack from the
  Astro template is a `PlanningError` that names the React one. On the command
  line the flag checks refuse `--template` with `--framework` even earlier;
- it offers the requested starting mode.

The catalog also refuses to build if two templates share an id, or if a
template claims a framework other than the adapter that declares it.

### Variables

Variables are the `{{token}}` placeholders the substitution engine fills. The
set is fixed and CLI-owned, and every value comes from the resolved
configuration, never from the template:

| Variable      | Type   | Required | Value from          |
| ------------- | ------ | -------- | ------------------- |
| `siteName`    | text   | yes      | `site.name`         |
| `siteUrl`     | url    | no       | `site.url`          |
| `description` | text   | yes      | `site.description`  |
| `year`        | year   | yes      | the generation date |
| `projectName` | text   | yes      | `projectName`       |
| `author`      | text   | no       | `site.author`       |
| `locale`      | locale | yes      | `site.locale`       |
| `mode`        | mode   | yes      | the starting mode   |

A template declares the tokens it uses in its manifest. A declared token must be
known and listed once, and a template file may use only tokens it declares.
Before this, any known token was accepted anywhere. A required variable never
substitutes to an empty string, which the engine already enforced.

There are no template-supplied variables, such as a logo or brand colour, yet.
Adding one means a new entry in this table and in the engine. The contract is
typed so that a token cannot exist in one and not the other.

### Files

`templateFiles(definition, mode)` lists what a template contributes for one
mode: each destination, the file it comes from, whether it is text or binary,
and every layer that provides it. It uses the planner's own layer walk and
renames (`_gitignore` → `.gitignore`), so it describes the same files the plan
builds from. It refuses:

- a destination outside the target — `..` segments, absolute and drive paths,
  NUL — using the plan's own `normalisePlanPath`;
- two files in one layer landing on the same destination. The same destination
  in two layers is an override, which is what layers are for;
- a text file using an undeclared token;
- a template with no files, or a mode it does not offer.

## When validation runs

`planManifest` resolves the template through the catalog and checks its files
before planning anything, on every run, `--dry-run` included. A malformed
template fails there as a `PlanningError`, with nothing written. The plan then
goes through `assertValidPlan` and the executor's own path checks as before.

## Sources

`TemplateSource` names where a template's files are read from. There is one
kind today, `built-in`: the `templates/` directory shipped inside the npm
package, found next to the CLI. A definition carries its source rather than
every consumer assuming that location, and the planner only ever sees absolute
layer directories. A new kind of source would add a way to build a
definition; it would not need a new planner or executor. None exists: nothing
is fetched, and there is no remote or user-supplied template.

## Determinism

The catalog is ordered by id, and file lists by the plan's pinned `en`
collator. Nothing depends on directory-listing order, the machine's locale, the
clock, the network or randomness, and tests check the first two. The ordering
of template layers in `layersFrom` used a bare `localeCompare`; it now uses the
same pinned collator, which orders them identically on an `en` machine.

## Status

Internal architecture, not a public interface: the package exports none of
these types. The CLI is unchanged — the same templates, flags, prompts and
generated output.
