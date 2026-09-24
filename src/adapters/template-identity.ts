import type { FrameworkId } from '../domain/dimensions.js';
import { FRAMEWORK_IDS } from '../domain/dimensions.js';
import type { AdapterRegistry } from './registry.js';

/**
 * Template identity, and checking a recorded project's against it.
 *
 * ## The three things that are not the same
 *
 * Stage 61 found them conflated and Stage 62 separates them:
 *
 * - **identity** - which template a framework generates, and at what version.
 *   A property of the adapter, answerable without touching a project.
 * - **content** - where the template's files live, `templates/<id>/`, the same
 *   for all three frameworks.
 * - **discoverability** - whether a user can select the template by name.
 *   Declared, not inferred from a `template.json` happening to exist on disk.
 *
 * Before this, identity and discoverability were one bit. React and Next stayed
 * out of `--list-templates` by having no manifest on disk, which is also what
 * made them unidentifiable through the registry; Astro was identified through a
 * constant named `TEMPLATE_ID_PLACEHOLDER`. So the map from a recorded
 * `stack.framework` to a template identity had a hole in it precisely where a
 * recorded project most needed one.
 *
 * ## What this does not do
 *
 * It does not look at a project. Identity is established from the recorded
 * document and the adapters this build ships, never from `package.json`, a
 * directory listing or a generated file - the rule Stage 56 set and Stage 59
 * was built to keep. A mismatch is reported, never repaired, and never
 * substituted with whatever this CLI would pick today.
 */

/** What a template is, reduced to what a recorded project can be checked against. */
export interface TemplateIdentity {
  readonly id: string;
  readonly version: string;
  readonly framework: string;
}

/** Identity plus whether the template is offered to the user by name. */
export interface TemplateDescriptor {
  readonly identity: TemplateIdentity;
  readonly discoverable: boolean;
}

/**
 * What a recorded template identity was found to be.
 *
 * A discriminated union rather than a boolean, following `ProvenanceRead`: the
 * caller needs to say *which* thing disagreed, and "the framework is not one
 * this build implements" is a different sentence from "the template belongs to
 * a different framework".
 */
export type IdentityCheck =
  | { readonly status: 'ok'; readonly identity: TemplateIdentity }
  /** A framework id this build has no adapter for. */
  | { readonly status: 'unknown-framework'; readonly because: string }
  /** The id is not the template that framework generates. */
  | { readonly status: 'unknown-template'; readonly because: string }
  /** The recorded template belongs to a different framework than the stack. */
  | { readonly status: 'framework-mismatch'; readonly because: string }
  /** Absent or non-string where a string was required. */
  | { readonly status: 'malformed'; readonly because: string };

/** The identity and discoverability a framework adapter declares. */
export function describeTemplate(
  framework: FrameworkId,
  adapters: AdapterRegistry,
): TemplateDescriptor {
  const adapter = adapters.framework(framework);
  const manifest = adapter.templateManifest;
  return {
    identity: {
      id: manifest.id,
      version: manifest.version,
      framework: manifest.framework,
    },
    discoverable: adapter.templateDiscoverable,
  };
}

/** Every framework whose template a user may select by name. */
export function discoverableTemplates(adapters: AdapterRegistry): readonly TemplateIdentity[] {
  return FRAMEWORK_IDS.filter((id) => isImplemented(id, adapters))
    .map((id) => describeTemplate(id, adapters))
    .filter((descriptor) => descriptor.discoverable)
    .map((descriptor) => descriptor.identity);
}

/**
 * Whether an id has an adapter in this build.
 *
 * `FRAMEWORK_IDS` is the vocabulary, not the implemented set - `angular` is a
 * known identifier with no adapter - so asking has to be done by asking rather
 * than by listing the implemented ones somewhere else.
 */
function isImplemented(framework: FrameworkId, adapters: AdapterRegistry): boolean {
  try {
    adapters.framework(framework);
    return true;
  } catch {
    return false;
  }
}

/** What a provenance document claims about the template it was generated from. */
export interface RecordedTemplate {
  readonly framework: unknown;
  readonly id: unknown;
  readonly templateFramework: unknown;
}

/**
 * Checks a recorded template identity against the adapter for its stack.
 *
 * The question a future upgrade has to answer before it trusts a document:
 * *does this project's recorded template belong to the framework it says it
 * was built with?* A document can pass Stage 59's reader - every field the
 * right type, every value in vocabulary - and still be internally
 * contradictory, because that reader deliberately validates fields and not
 * relationships.
 *
 * Deterministic failure in every disagreeing case. No fallback to the template
 * this CLI would choose now, because a project generated from one template is
 * not upgraded by quietly generating a different one.
 *
 * The version is not compared. A recorded version that differs from the shipped
 * one is the ordinary case - it is what an upgrade *is* - and Stage 61 settled
 * that ClientKit keeps no historical template bytes to compare against anyway.
 */
export function checkRecordedTemplate(
  recorded: RecordedTemplate,
  adapters: AdapterRegistry,
): IdentityCheck {
  const { framework, id, templateFramework } = recorded;

  if (typeof framework !== 'string' || framework === '') {
    return { status: 'malformed', because: 'The recorded stack has no framework.' };
  }
  if (typeof id !== 'string' || id === '') {
    return { status: 'malformed', because: 'The recorded template has no id.' };
  }
  if (typeof templateFramework !== 'string' || templateFramework === '') {
    return { status: 'malformed', because: 'The recorded template has no framework.' };
  }

  if (!(FRAMEWORK_IDS as readonly string[]).includes(framework)) {
    return {
      status: 'unknown-framework',
      because: `"${framework}" is not a framework ClientKit knows.`,
    };
  }
  if (!isImplemented(framework as FrameworkId, adapters)) {
    return {
      status: 'unknown-framework',
      because: `"${framework}" is a known framework, but this ClientKit has no adapter for it.`,
    };
  }

  const expected = describeTemplate(framework as FrameworkId, adapters).identity;

  if (id !== expected.id) {
    return {
      status: 'unknown-template',
      because:
        `The project records template "${id}", but ClientKit generates "${expected.id}" ` +
        `for ${framework}. ClientKit will not substitute one template for another.`,
    };
  }
  if (templateFramework !== expected.framework) {
    return {
      status: 'framework-mismatch',
      because:
        `The recorded template says it is for "${templateFramework}", while the recorded ` +
        `stack says "${framework}". One of the two is wrong and ClientKit cannot tell which.`,
    };
  }

  return { status: 'ok', identity: expected };
}
