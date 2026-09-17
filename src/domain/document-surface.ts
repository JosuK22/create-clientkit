import type { EmissionField } from './document-emission.js';
import { EMISSION_FIELDS } from './document-emission.js';
import { CliError } from '../errors.js';

/**
 * Who owns each part of a generated document.
 *
 * ## The blocker this answers
 *
 * Stage 39 tried to realize the emission plan into Astro source and found there
 * was nowhere to put it. Every file that owns the document - `BaseLayout.astro`,
 * `Seo.astro`, the pages - has its content byte-captured by the V1 goldens, and
 * V1 selects no features, so there is no variant path. A realization had to
 * either change V1 bytes or generate a component nothing renders.
 *
 * It also found a second problem, which this file is mostly about: the existing
 * template is *more capable* than the semantic contract for some fields.
 * `Seo.astro` upgrades `twitter:card` to `summary_large_image` once a social
 * image is configured, and emits `og:image` and `twitter:image`; the semantic
 * `TwitterContract` hard-codes `'summary'` and models no image at all. So
 * "replace the template's head with the composed one" is not a refactor, it is
 * a regression.
 *
 * ## Ownership is per field, and declared
 *
 * The answer is that ownership is neither all-template nor all-composition. An
 * architecture declares, field by field, which side of its document owns what:
 *
 *     composition-owned   the composed surface may emit this
 *     template-owned      the architecture's own template emits it, untouched
 *
 * A field claimed by both is the failure mode that produces two `<title>`
 * elements in one document, so it is refused here rather than discovered in a
 * browser.
 *
 * ## What this is not
 *
 * Not arbitration. Which *value* a field ends up with was settled by Stages
 * 31-33; this says only who renders it. Nothing here reads a scope, a
 * contributor, a conflict or a precedence rule.
 *
 * Not Astro. The fields are the emission vocabulary; which of them an
 * architecture can own is that architecture's declaration to make.
 */

export const DOCUMENT_SURFACE_OWNERS = ['template', 'composition'] as const;

export type DocumentSurfaceOwner = (typeof DOCUMENT_SURFACE_OWNERS)[number];

/**
 * One architecture's answer to "who renders what".
 *
 * `composed` lists the fields the composed surface may emit. Everything else in
 * `EMISSION_FIELDS` is template-owned by omission, which is the safe default:
 * a field nobody thought about stays with the implementation that already
 * works.
 */
export interface DocumentSurfaceOwnership {
  /** Identifies the architecture in a diagnostic. Never branched on. */
  readonly architecture: string;
  readonly composed: readonly EmissionField[];
  /** Why each omitted field stays with the template, for the ones that matter. */
  readonly templateOwnedBecause: Readonly<Partial<Record<EmissionField, string>>>;
}

/** Whether the composed surface may emit this field. */
export function ownerOfField(
  ownership: DocumentSurfaceOwnership,
  field: EmissionField,
): DocumentSurfaceOwner {
  return ownership.composed.includes(field) ? 'composition' : 'template';
}

/** Every field the template keeps, in vocabulary order. */
export function templateOwnedFields(ownership: DocumentSurfaceOwnership): readonly EmissionField[] {
  return EMISSION_FIELDS.filter((field) => !ownership.composed.includes(field));
}

/**
 * Refuses an ownership declaration that claims a field twice.
 *
 * A field in `composed` that also carries a `templateOwnedBecause` reason is a
 * declaration contradicting itself, and the document it would produce has two
 * of whatever that field renders. Structurally detectable, so it is detected.
 */
export function assertOwnershipIsUnambiguous(ownership: DocumentSurfaceOwnership): void {
  const claimedTwice = ownership.composed.filter(
    (field) => ownership.templateOwnedBecause[field] !== undefined,
  );
  if (claimedTwice.length > 0) {
    throw new CliError(
      `"${ownership.architecture}" claims ${claimedTwice.join(', ')} for both its template and its composed surface.`,
      {
        hint:
          'One side renders a field or the other does. A field owned twice produces two of it ' +
          'in the document, which is valid source, builds cleanly, and is wrong.',
      },
    );
  }

  const unknown = ownership.composed.filter((field) => !EMISSION_FIELDS.includes(field));
  if (unknown.length > 0) {
    throw new CliError(
      `"${ownership.architecture}" claims unknown field(s): ${unknown.join(', ')}.`,
      {
        hint: `The document vocabulary is: ${EMISSION_FIELDS.join(', ')}.`,
      },
    );
  }
}

/**
 * Refuses a contribution aimed at a field the composed surface does not own.
 *
 * The other half of the guarantee. A declaration that is internally consistent
 * still has to be honoured: a contributor asking the composed surface to emit
 * `twitter` on an architecture whose template already emits it would produce
 * the duplicate this model exists to prevent.
 */
export function assertFieldsAreComposable(
  ownership: DocumentSurfaceOwnership,
  fields: readonly EmissionField[],
): void {
  const refused = EMISSION_FIELDS.filter(
    (field) => fields.includes(field) && ownerOfField(ownership, field) === 'template',
  );
  if (refused.length === 0) return;

  const lines = refused.map((field) => {
    const because = ownership.templateOwnedBecause[field];
    return `  - ${field}${because === undefined ? '' : `: ${because}`}`;
  });

  throw new CliError(
    `"${ownership.architecture}" renders ${refused.join(', ')} from its own template.`,
    {
      hint: [
        ...lines,
        '',
        'The composed surface cannot also emit these, because a document that stated',
        'them twice would build without complaint. Either the template gives the field',
        'up, or the contribution does.',
      ].join('\n'),
    },
  );
}
