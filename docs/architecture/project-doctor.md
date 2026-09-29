# Project doctor

`create-clientkit doctor [directory]` reports whether anything about an
existing project needs attention before ClientKit works with it, why, and what
might be done. It reads; it never changes anything.

**detect = discover. doctor = diagnose.** `detect` answers "what is this
project?". `doctor` answers "is there anything ClientKit needs me to know?".

```text
Existing project
  ↓
Detection          detectProject()          src/detect/detect.ts
  ↓                ProjectDetection
Resolution         resolveDetectedStack()   src/detect/stack.ts
  ↓                DetectedStack
Diagnosis          diagnoseProject()        src/doctor/diagnose.ts
  ↓                DoctorReport
Rendering          renderDoctorReport()     src/ui/doctor.ts
```

**Detect once. Diagnose from the detected result.** There is one detection
pass and one resolution, and they are the ones `detect` uses. The diagnosis is a
pure function of their two results. It does not touch the filesystem, does not
read `package.json` again, and keeps no list of what ClientKit supports. A test
holds `diagnose.ts` to that.

## Who decides what

- A **dimension check** (framework, build tool, language, styling, UI library,
  router, package manager) judges the detector's evidence. It uses the
  detector's own statuses: `detected`, `unsupported`, `ambiguous`, `absent` and
  `unknown`.
- The **compatibility check** carries the resolver's verdict, and it is the
  only check that does. A value ClientKit names but has no adapter for, such
  as `angular`, is found cleanly, so its dimension passes. It is then refused
  under compatibility in the resolver's own words, as `detect` reports it. So
  `doctor` cannot call a stack supported that `detect` calls unsupported.

## Checks and severity

| Check            | pass                           | info                            | warning                                                        | error                                         |
| ---------------- | ------------------------------ | ------------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| Project metadata | `package.json` read cleanly    |                                 | empty directory; no `package.json`; a block had to be ignored  | `package.json` unusable (invalid, too big, …) |
| Framework        | detected                       |                                 | none found                                                     | unsupported (Vue, …); ambiguous               |
| Build tool       | detected; fixed by framework   |                                 | none found, so ClientKit would assume its default              | unsupported; ambiguous                        |
| Language         | detected                       |                                 |                                                                |                                               |
| Styling          | detected                       | none found (resolves to `none`) |                                                                | unsupported; ambiguous                        |
| UI library       | detected                       | none found (resolves to `none`) |                                                                | unsupported; ambiguous                        |
| Router           | detected; fixed by framework   | none found (resolves to `none`) |                                                                | unsupported; ambiguous                        |
| Package manager  | detected                       | no lockfile or field yet        | two lockfiles; field and lockfile disagree; unsupported (deno) |                                               |
| Compatibility    | the resolver accepts the stack |                                 | the stack could not be determined                              | the resolver refuses the stack                |
| ClientKit record |                                | `.client-site.json` present     |                                                                |                                               |

- **Unknown is never unsupported.** A missing answer is at most a warning. Only
  a value ClientKit recognises and refuses, or the resolver's refusal, is an
  error.
- **Ambiguity is never resolved.** Two lockfiles, two styling systems or two
  owning frameworks are reported with every candidate's evidence. None is
  picked, whatever the machine, `PATH`, shell or locale.
- **A default is never evidence.** When the resolver fills a dimension the
  project did not state, the check says so and carries no evidence.
- The package manager does not feed the resolver, so its problems are warnings.
- With no usable `package.json`, dimensions that would all be "unknown" for
  that one reason are left out. Anything still found, such as `tsconfig.json`
  or a lockfile, is shown.

The overall status is `error` if any check is an error, `warning` if any is a
warning, and `healthy` otherwise.

## Exit codes

| Code | When                                                                              |
| ---- | --------------------------------------------------------------------------------- |
| `0`  | No errors: healthy, or warnings only                                              |
| `2`  | At least one error; or the directory is missing or a file; or a generation option |

`2` is the CLI's existing code for problems with the user's input.
Diagnosis never uses `1`, which still means the CLI itself failed.

## What it does not do

It does not install, build, test or lint anything, run a package manager or a
project script, or use the network. It does not search parent directories or
workspaces, and it does not need `node_modules`. It reads exactly what
[detection](./project-detection.md) reads. It has no `--fix` and no
machine-readable output. A test snapshots a project's files, contents and
timestamps before and after `doctor` and requires them to match.
