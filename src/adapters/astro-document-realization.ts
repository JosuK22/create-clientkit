import type { DocumentEmissionPlan } from '../domain/document-emission.js';
import type { EMISSION_FIELDS } from '../domain/document-emission.js';
import { describeTarget } from '../domain/document-scope.js';
import type {
  AnyDocumentValue,
  DocumentBinding,
  DocumentDerivation,
} from '../domain/document-value.js';
import { bindingsUsedBy, derivationParameters } from '../domain/document-value.js';
import type { ArchitectureDefinition, FileRole } from '../domain/roles.js';
import { CliError } from '../errors.js';
import type { AstroImport } from './astro-bindings.js';
import { ASTRO_BINDING_REALIZATIONS } from './astro-bindings.js';
import type { AstroDocumentComposition, AstroHeadEntry } from './astro-document-surface.js';

/**
 * How Astro spells a document the semantic pipeline resolved.
 *
 * ## The boundary this is
 *
 *     DocumentEmissionPlan  ->  here  ->  Astro source
 *
 * Everything to the left is semantics: which fields the document states, what
 * each one says, which scope won. Everything to the right is one framework's
 * spelling. Stage 38 drew the line and left this side empty; Stages 40 to 43
 * built the place the output goes. This is the translation itself.
 *
 * ## What keeps it from being a code generator
 *
 * Three closed tables and nothing else. A field maps to one markup shape, a
 * binding to one expression that `astro-bindings.ts` already declared, and a
 * derivation to one template with holes for its own typed arguments. There is
 * no concatenation of caller input, no expression parser, no `eval`, no
 * `Function`, and no way to reach a spelling that is not written here.
 *
 * A value this cannot spell is refused by name. Substituting something close
 * enough would emit a document that states something untrue and builds without
 * complaint, which is the failure every stage since 34 has been arranged to
 * prevent.
 *
 * ## What it deliberately does not evaluate
 *
 * Nothing. A binding stays an expression the generated project evaluates at
 * *its* build, and a derivation stays an operation over such expressions. The
 * canonical address of a page is not computed here even though ClientKit knows
 * the site URL and could: the project owns that value the moment generation
 * ends, and freezing it is Stage 34's failure by a shorter route.
 */

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * One derivation's Astro spelling, as a shape with holes for its arguments.
 *
 * `render` receives the already-realized arguments, in the order the derivation
 * declares them, and returns source. It never sees a caller's string: every
 * argument has been through `realizeValue` and is itself either a quoted
 * literal, a declared binding expression, or another derivation's shape.
 *
 * `imports` is what the shape needs in scope, named by role exactly as a
 * binding's are - so a realized derivation carries its own context and no
 * caller has to know that an absolute URL is built with the project's own
 * helpers.
 */
interface AstroDerivationRealization {
  readonly render: (args: readonly string[]) => string;
  readonly imports: readonly AstroImport[];
}

const URL_HELPERS: FileRole = 'lib.urls';

export const ASTRO_DERIVATION_REALIZATIONS = {
  /**
   * The project's own helpers, not arithmetic repeated here.
   *
   * `siteOrigin` normalises a configured URL and answers `''` when there is
   * none; `absoluteUrl` returns `''` for an empty origin. So a project with no
   * production URL realizes to an empty string and the tag is omitted, which is
   * exactly what the shipped template does - because it is the same two
   * functions doing it.
   */
  'absolute-page-url': {
    render: ([origin, path]) => `absoluteUrl(siteOrigin(${origin}), ${path})`,
    imports: [
      { role: URL_HELPERS, named: 'absoluteUrl' },
      { role: URL_HELPERS, named: 'siteOrigin' },
    ],
  },
  /**
   * `title ? \`${title} - ${SITE.name}\` : SITE.name`, which is what the shipped
   * component computes. The ternary is part of the derivation's meaning - the
   * template treats an empty page title as "no page part" - and not a
   * conditional this layer invented.
   */
  'page-title-with-site-name': {
    render: ([pageTitle, siteName]) =>
      `${pageTitle} === '' ? ${siteName} : \`\${${pageTitle}} - \${${siteName}}\``,
    imports: [],
  },
  /** `blocked ? 'noindex, nofollow' : 'index, follow'`, from the same source. */
  'indexing-directive': {
    render: ([blocked]) => `${blocked} ? 'noindex, nofollow' : 'index, follow'`,
    imports: [],
  },
} as const satisfies Readonly<Record<DocumentDerivation, AstroDerivationRealization>>;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * The markup each field becomes, given one expression for its value.
 *
 * Guarded where the shipped template guards. A canonical whose value is empty
 * means the page claims no canonical address - Stage 38 keeps that distinct
 * from claiming none at all - so the tag is omitted rather than emitted with an
 * empty `href`, which is what `Seo.astro` has always done.
 */
const ASTRO_FIELD_MARKUP: Readonly<Partial<Record<(typeof EMISSION_FIELDS)[number], string>>> = {
  title: '<title>{__value__}</title>',
  description: '{__value__ !== \'\' && <meta name="description" content={__value__} />}',
  robots: '<meta name="robots" content={__value__} />',
  canonical: '{__value__ !== \'\' && <link rel="canonical" href={__value__} />}',
};

/**
 * Why a field the composed surface owns still has no spelling here.
 *
 * Stated rather than omitted, so a refusal says which abstraction is missing
 * instead of that something went wrong.
 */
const NOT_REALIZABLE: Readonly<Partial<Record<(typeof EMISSION_FIELDS)[number], string>>> = {
  'open-graph':
    'Open Graph resolves as one block of six fields and would be realized as six tags, ' +
    'one of which (og:image) the template owns and the contract does not model. Composing ' +
    'the block means answering that first.',
  twitter:
    'Twitter is template-owned: Seo.astro upgrades twitter:card once a social image exists ' +
    'and emits twitter:image, neither of which TwitterContract represents.',
  'structured-data':
    'Structured data is template-owned: StructuredData.astro emits email, telephone, sameAs ' +
    'and location, which OrganizationContract does not carry.',
};

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A realized value: the Astro expression, and what it needs in scope. */
interface RealizedValue {
  readonly expression: string;
  readonly imports: readonly AstroImport[];
}

/**
 * Turns one semantic value into an Astro expression.
 *
 * Total over the three kinds and closed within each. A literal is quoted by
 * `JSON.stringify`, so no value a contributor states can end an expression
 * early or start a tag. A binding is looked up, never constructed. A derivation
 * realizes its arguments first and hands them to its declared shape, so nesting
 * works without any of it becoming a general evaluator.
 */
function realizeValue(value: AnyDocumentValue, field: string): RealizedValue {
  switch (value.kind) {
    case 'literal': {
      if (typeof value.value !== 'string') {
        throw new CliError(`"astro-standard" cannot spell a ${value.type} literal for ${field}.`, {
          hint:
            'Only textual values have an expression form today. A block value - Open Graph ' +
            'or a Twitter card - is several tags rather than one, and realizing it needs the ' +
            'field to say how they are laid out.',
        });
      }
      return { expression: JSON.stringify(value.value), imports: [] };
    }

    case 'binding': {
      const realization = ASTRO_BINDING_REALIZATIONS[value.binding as DocumentBinding];
      if (realization === undefined) {
        throw new CliError(`"astro-standard" has no expression for ${value.binding}.`, {
          hint: `Found in the value for ${field}.`,
        });
      }
      return { expression: realization.expression, imports: realization.imports };
    }

    case 'derived': {
      const realization =
        ASTRO_DERIVATION_REALIZATIONS[
          value.derivation as keyof typeof ASTRO_DERIVATION_REALIZATIONS
        ];
      if (realization === undefined) {
        throw new CliError(`"astro-standard" cannot perform ${value.derivation}.`, {
          hint:
            `It is declared over (${derivationParameters(value.derivation).join(', ')}). An ` +
            'architecture that cannot perform an operation says so rather than approximating it.',
        });
      }

      const args = value.inputs.map((input) => realizeValue(input, field));
      return {
        // Parenthesised, so a derivation used inside another cannot change how
        // the outer one groups. Nothing here parses source; the brackets are
        // part of the shape rather than a fix for one.
        expression: `(${realization.render(args.map((arg) => arg.expression))})`,
        imports: [...realization.imports, ...args.flatMap((arg) => arg.imports)],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Turns one page's emission plan into the composition Stage 43 renders.
 *
 * The target is carried through untouched. It was decided by scope composition
 * long before this ran, and re-deriving it here - from a component name, from a
 * path, from anything - is how a page's document becomes everyone's.
 *
 * Suppression produces no entry, which is not the same as dropping one: a
 * suppressed field was refused on purpose, and emitting nothing is what
 * honouring that refusal looks like. A field this cannot spell is refused
 * outright rather than skipped, because a document silently missing what it was
 * asked to state is the defect nothing downstream can see.
 */
export function realizeAstroDocument(plan: DocumentEmissionPlan): AstroDocumentComposition {
  const entries: AstroHeadEntry[] = [];

  for (const item of plan.items) {
    if (item.state === 'suppressed') continue;

    const markup = ASTRO_FIELD_MARKUP[item.field];
    if (markup === undefined) {
      throw new CliError(
        `"astro-standard" cannot realize ${item.field} for ${describeTarget(plan.target)}.`,
        {
          hint:
            NOT_REALIZABLE[item.field] ??
            `${item.field} has no markup shape declared for this architecture.`,
        },
      );
    }

    const value = item.field === 'structured-data' ? undefined : item.value;
    if (value === undefined) {
      throw new CliError(`${item.field} reached realization without a value.`, {
        hint: `While preparing ${describeTarget(plan.target)}.`,
      });
    }

    const realized = realizeValue(value, item.field);

    /*
     * A guarded field whose value is a literal empty string renders nothing,
     * and the guard is decided here rather than shipped.
     *
     * Not premature evaluation: a literal is a generation-time fact by
     * definition - it is the one value kind that says so - and `{"" !== '' &&
     * ...}` is dead source that would sit in the project forever. A binding or
     * a derivation keeps its guard, because what those evaluate to is the
     * project's business and not knowable here.
     *
     * The entry stays, with nothing to render. It is what the field was
     * stated as, and dropping it would leave the handover uncovered - the
     * field would come off the template with no document claiming it.
     */
    const empty = value.kind === 'literal' && value.value === '' && markup.includes('!==');

    entries.push({
      field: item.field,
      source: empty ? '' : markup.split('__value__').join(realized.expression),
      owner: item.provenance.owners.join(', ') || 'document',
      bindings: empty ? [] : bindingsUsedBy(value),
      imports: empty ? [] : realized.imports,
    });
  }

  return { target: plan.target, entries };
}

/** Whether this architecture can spell every stated field in a plan. */
export function astroCanRealize(plan: DocumentEmissionPlan): boolean {
  return plan.items.every(
    (item) => item.state === 'suppressed' || ASTRO_FIELD_MARKUP[item.field] !== undefined,
  );
}

/** Kept for diagnostics: the architecture this module speaks for. */
export const ASTRO_REALIZATION_ARCHITECTURE: ArchitectureDefinition['id'] = 'astro-standard';
