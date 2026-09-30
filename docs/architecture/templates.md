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

## Validation

One validator reports every problem with a template at once, each with a stable
code, in a fixed order: errors before warnings, then by mode, file and code
through the plan's pinned collator. The result is plain data:

```ts
interface TemplateValidationResult {
  templateId: string;
  valid: boolean; // no errors; warnings never make a template invalid
  errors: TemplateIssue[];
  warnings: TemplateIssue[];
}
// TemplateIssue: code, severity, templateId, message, hint,
//                and where relevant mode, source, destination, variable
```

It checks at three levels, each built on the one below:

| Level      | What it answers                                 | Where                                                         |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Structural | Is the manifest well-formed?                    | `parseManifest`, via `defineTemplate`                         |
| Semantic   | Does the template agree with itself?            | `validateTemplate`, `src/templates/validation.ts`             |
| Catalog    | Does the set of templates agree with the build? | `validateTemplateCatalog`, `src/adapters/template-catalog.ts` |
| Plan       | Does each template produce a valid plan?        | `verifyTemplatePlans`, `src/verify/templates.ts`              |
| Package    | Does the installed package serve the same ones? | `scripts/smoke.mjs`, against the packed tarball               |

Structural problems stop a manifest from becoming a definition at all. The
catalog reports them as `manifest-invalid` and still validates the other
templates.

### Issue codes

| Code                    | Level    | Severity | Means                                                                   |
| ----------------------- | -------- | -------- | ----------------------------------------------------------------------- |
| `manifest-invalid`      | catalog  | error    | The manifest validator refuses the manifest; the message says why.      |
| `framework-owner`       | catalog  | error    | A template claims a framework other than the adapter declaring it.      |
| `id-duplicate`          | catalog  | error    | Two templates share an id.                                              |
| `catalog-orphan`        | catalog  | error    | A directory with a `base/` layer that no framework declares.            |
| `source-missing`        | semantic | error    | The template directory, or its `base/` layer, does not exist.           |
| `source-outside-root`   | semantic | error    | A file resolves, through a link, outside the template directory.        |
| `source-unreadable`     | semantic | error    | An entry cannot be resolved or read as a file.                          |
| `destination-unsafe`    | semantic | error    | A destination leaves the target: `..`, absolute or drive paths, NUL.    |
| `destination-name`      | semantic | error    | A name Windows cannot create: `CON`, `aux.txt`, `a<b`, a trailing dot.  |
| `destination-reserved`  | semantic | error    | The template provides `.client-site.json`, which the CLI writes itself. |
| `layer-duplicate`       | semantic | error    | One layer provides a destination twice (`_gitignore` and `.gitignore`). |
| `layer-file-directory`  | semantic | error    | A path is a file in one layer and a directory in another.               |
| `token-undeclared`      | semantic | error    | A file uses a token the manifest does not declare.                      |
| `mode-unsupported`      | semantic | error    | The requested mode is not one the template declares.                    |
| `mode-incomplete`       | semantic | error    | A declared mode has no files under `modes/<mode>/`.                     |
| `template-empty`        | semantic | error    | The template has no files at all.                                       |
| `requirement-node`      | semantic | error    | `minNode` is not `>=MAJOR.MINOR.PATCH`, the only form the CLI checks.   |
| `default-locale`        | semantic | error    | `defaults.locale` is not a BCP-47 tag.                                  |
| `token-unused`          | semantic | warning  | A declared token no file uses, judged only when every file was read.    |
| `plan-invalid`          | plan     | error    | The framework's default stack cannot be planned; the reason follows.    |
| `plan-nondeterministic` | plan     | error    | Planning the same input twice gives two plans.                          |
| `plan-source-outside`   | plan     | error    | A planned copy reads from outside the shipped templates.                |
| `framework-version`     | plan     | error    | `frameworkVersion` is not the version the plan installs.                |

The same destination in two layers is not an issue. It is an override, which
is what layers are for. A mode always has files of its own: every starter
provides at least its page, so an empty mode is incomplete, never intentional.

### When it runs

- **Every generation, and `--dry-run`.** `planManifest` resolves the template
  and runs `validateTemplate` for the mode being planned before planning
  anything. Any error stops the run as a `PlanningError`, with the first
  problem as the message and the rest in the hint. Nothing is written. The plan
  then goes through `assertValidPlan` and the executor's path checks, as before.
- **The test suite** validates the whole catalog and every template's plans,
  and requires every shipped template to be VALID with no warnings.
- **The release preflight** runs the smoke test, which installs the packed
  tarball and requires each Start from preset to plan the same template and
  files from the installed package as from the source tree.

### Reading an error

```text
x Template "react-vite" uses {{year}} in base/README.md, which its manifest does not declare.
  Declare every token a template uses in its manifest "tokens" list.
```

The message names the template, the file (by layer and path) or the variable,
and what is wrong; the indented hint says what to change. A validation error is
a problem in ClientKit's own templates, never in your configuration.

## Sources

`TemplateSource` names where a template's files are read from. There is one
kind today, `built-in`: the `templates/` directory shipped inside the npm
package, found next to the CLI. A definition carries its source rather than
every consumer assuming that location, and the planner only ever sees absolute
layer directories. A new kind of source would add a way to build a
definition; it would not need a new planner or executor. None exists: nothing
is fetched, and there is no remote or user-supplied template.

## Determinism

The catalog is ordered by id, file lists and validation issues by the plan's
pinned `en` collator. Nothing depends on directory-listing order, the machine's
locale, the clock, the network or randomness. See
[deterministic-generation.md](./deterministic-generation.md) for the whole
contract and how it is tested.

## Status

Internal architecture, not a public interface: the package exports none of
these types. The CLI is unchanged — the same templates, flags, prompts and
generated output.

There is no `templates validate` command. Every template a user can reach ships
inside the package and is validated by the test suite before release and again
on every run, so a command would validate what is already validated. It becomes
worth adding when there is a template a user supplies, and the validator is
shaped so that command would only format its result.
