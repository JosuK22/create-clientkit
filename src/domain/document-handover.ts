import type { EmissionField } from './document-emission.js';
import { EMISSION_FIELDS } from './document-emission.js';
import type { DocumentTarget } from './document-scope.js';
import { describeTarget } from './document-scope.js';
import type { DocumentSurfaceOwnership } from './document-surface.js';
import { ownerOfField } from './document-surface.js';
import { CliError } from '../errors.js';

/**
 * How a field stops being the template's and becomes the composition's.
 *
 * ## The contradiction this closes
 *
 * Stage 40 let an architecture declare a field composition-owned. Stage 41
 * found that the declaration did nothing: `Seo.astro` went on emitting all
 * seven fields, and realizing two of them produced two `<title>` elements, two
 * canonicals disagreeing with each other, and a canonical on a `noindex` page.
 * It built without complaint.
 *
 * The gap was that ownership was a statement about intent with no counterpart
 * in the generated source. A declaration nobody can act on is worse than no
 * declaration, because the next reader believes it.
 *
 * ## The two halves
 *
 * Ownership answers *who should emit this*. Handover answers *can the template
 * stop*. Both have to be true before a field moves, and they are separate
 * questions: an architecture may reasonably want to compose a field its
 * template physically cannot give up, and that is a fact to refuse rather than
 * a preference to honour.
 *
 *     ownership     (Stage 40)  the composed surface may emit this
 *     surrenderable (here)      the template can stop emitting it
 *
 * A field is handed over only when both hold. When neither the declaration nor
 * the capability changes, nothing happens at all - which is what keeps the
 * default path byte-identical.
 *
 * ## What this is not
 *
 * Not a renderer. Nothing here knows what a template looks like, which file it
 * lives in or how a field is spelled; an architecture reports which fields its
 * own template can release and this checks the two declarations against each
 * other. Not arbitration - the fields were decided long before, and nothing
 * below reads a value, a scope or a contributor.
 */

/**
 * What one architecture's template can physically stop emitting.
 *
 * Declared by the architecture, from the structure of the component that emits
 * the fields. `surrenderable` is not a wish: a field belongs here only when
 * removing it leaves source that still compiles, which for Astro means the
 * frontmatter it needs goes with it.
 */
export interface HandoverCapability {
  /** Identifies the architecture in a diagnostic. Never branched on. */
  readonly architecture: string;
  readonly surrenderable: readonly EmissionField[];
}

/**
 * Refuses an ownership declaration the template cannot actually honour.
 *
 * This is Stage 41's finding turned into a check that runs. A field the
 * composed surface claims, and the template cannot release, is exactly the
 * configuration that emitted the document twice - so it is refused where the
 * two declarations meet rather than discovered in built HTML.
 *
 * Note the direction. Composition ownership is the demanding side: every field
 * it claims must be surrenderable. The reverse is fine and common - a template
 * may be able to release a field nobody has claimed yet, which is simply a
 * capability waiting for a decision.
 */
export function assertHandoverIsPossible(
  ownership: DocumentSurfaceOwnership,
  capability: HandoverCapability,
): void {
  const available = new Set(capability.surrenderable);
  const impossible = EMISSION_FIELDS.filter(
    (field) => ownership.composed.includes(field) && !available.has(field),
  );
  if (impossible.length === 0) return;

  throw new CliError(
    `"${ownership.architecture}" claims ${impossible.join(', ')} for its composed surface, ` +
      'but its template cannot stop emitting them.',
    {
      hint:
        'Ownership has to be physical, not declared. A field the composition owns while the ' +
        'template still emits it produces two of that field in the document - valid source ' +
        'that builds cleanly and contradicts itself. Either the template gains a way to ' +
        'release the field, or the field is not composed.',
    },
  );
}

/**
 * The fields to take off the template, given what the composition will emit.
 *
 * De-duplicated and returned in vocabulary order, so the set never depends on
 * the order entries arrived in. Deterministic ordering, not precedence: nothing
 * downstream may read a position here as authority.
 *
 * Refuses a field the composition does not own, because handing over a field
 * the composed surface will not emit does not move it - it deletes it. A
 * document quietly missing its title is the mirror image of one stating it
 * twice, and neither is detectable by building.
 */
export function fieldsToHandOver(
  ownership: DocumentSurfaceOwnership,
  capability: HandoverCapability,
  emitted: readonly EmissionField[],
): readonly EmissionField[] {
  const wanted = new Set(emitted);
  const unowned = EMISSION_FIELDS.filter(
    (field) => wanted.has(field) && ownerOfField(ownership, field) !== 'composition',
  );
  if (unowned.length > 0) {
    throw new CliError(`"${ownership.architecture}" cannot hand over ${unowned.join(', ')}.`, {
      hint:
        'Only a field the composed surface owns may leave the template. Taking one away ' +
        'from a template that would not be replaced leaves the document silently missing ' +
        'it, which is as wrong as stating it twice and harder to notice.',
    });
  }

  const impossible = EMISSION_FIELDS.filter(
    (field) => wanted.has(field) && !capability.surrenderable.includes(field),
  );
  if (impossible.length > 0) {
    throw new CliError(
      `"${capability.architecture}" has no way to stop emitting ${impossible.join(', ')}.`,
      {
        hint:
          'The architecture reports which fields its template can release. This one is not ' +
          'among them, so composing it would add a second copy rather than replace the first.',
      },
    );
  }

  return EMISSION_FIELDS.filter((field) => wanted.has(field));
}

/**
 * What one target's document actually states, for the coverage check below.
 */
export interface DocumentCoverage {
  readonly target: DocumentTarget;
  readonly fields: readonly EmissionField[];
}

/**
 * Refuses a handover no composition covers.
 *
 * The mirror of the duplicate Stage 41 measured, and just as invisible. A field
 * leaves the template once, for the whole project, because the component that
 * emitted it is shared. If some target then fails to state that field, every
 * page resolving to that target renders a document quietly missing it - valid
 * HTML, a clean build, and a canonical that silently stopped existing.
 *
 * Measured rather than reasoned: a first run composed `description` for the site
 * and `description` plus `canonical` for the not-found page. Both pages looked
 * right; the home page and a user-added page lost their canonical entirely.
 *
 * Two conditions, and both follow from how the pieces render:
 *
 *   - a site-wide document must exist, because it is what every page that
 *     states nothing of its own falls back to - including pages added after
 *     generation, which nothing here can enumerate;
 *   - every target must state every field handed over, because a target's
 *     document replaces the site's wholesale rather than merging with it.
 *
 * The second is not a restriction on what a page may say. Scope composition
 * already resolves each page to a *complete* document - inherited fields
 * included - so a target that omits one is not a page saying less, it is a
 * caller that skipped the resolution.
 */
export function assertHandoverIsCovered(
  handedOver: readonly EmissionField[],
  coverage: readonly DocumentCoverage[],
): void {
  if (handedOver.length === 0) return;

  if (!coverage.some((entry) => entry.target.kind === 'site')) {
    throw new CliError(
      `${handedOver.join(', ')} would leave the template with no site-wide document to replace them.`,
      {
        hint:
          'Every page that states nothing of its own falls back to the site-wide document, ' +
          'and pages added after generation always will. Without one, those pages render a ' +
          'document missing these fields - which builds cleanly and is wrong.',
      },
    );
  }

  for (const entry of coverage) {
    const missing = EMISSION_FIELDS.filter(
      (field) => handedOver.includes(field) && !entry.fields.includes(field),
    );
    if (missing.length > 0) {
      throw new CliError(
        `The document for ${describeTarget(entry.target)} does not state ${missing.join(', ')}.`,
        {
          hint:
            'A target’s document replaces the site-wide one rather than merging with it, ' +
            'so a field it leaves out is a field that page no longer has. Scope composition ' +
            'resolves every page to a complete document; this one arrived incomplete.',
        },
      );
    }
  }
}
