import type { DocumentEmissionPlan, RealizationSupport } from '../domain/document-emission.js';
import { describeTarget } from '../domain/document-scope.js';
import type { AnyDocumentValue } from '../domain/document-value.js';
import { absolutePageUrl } from '../domain/document-value.js';
import type { ArchitectureDefinition } from '../domain/roles.js';
import { resolveRole } from '../domain/roles.js';
import type { FileOperation } from '../generate/files.js';
import { CliError } from '../errors.js';

/**
 * How Next says where a page's definitive address is.
 *
 * ## Why this is not Astro's realization with different words
 *
 * Astro spells a canonical as an *expression* the page evaluates:
 * `absoluteUrl(siteOrigin(SITE.url), Astro.url.pathname)`. Next does not work
 * that way. It takes a declaration - an origin and a relative address - and
 * resolves the route itself:
 *
 *     metadataBase: new URL(SITE.url)
 *     alternates: { canonical: './' }
 *
 * Stage 48 measured that this resolves per route with no route list anywhere,
 * including for a page added long after generation. So the same semantic value
 * lands as an expression on one architecture and as a declaration on the other,
 * which is the whole reason realization is a per-architecture concern rather
 * than a shared emitter.
 *
 * ## What it will spell, and nothing else
 *
 * One field and three shapes, all closed:
 *
 *     derived(absolute-page-url(site.url, page.path))  ->  metadataBase + './'
 *     literal('')                                      ->  canonical: null
 *     literal(url)                                     ->  canonical: <url>
 *
 * The derivation is matched *as a whole* rather than assembled from its parts.
 * Next is not being handed an expression to evaluate; it is being told which
 * relationship holds, and `absolute-page-url` is exactly the relationship
 * `metadataBase` plus a relative address expresses. A value this does not
 * recognise is refused by name rather than approximated.
 *
 * Every other document field is refused. Title, description and robots stay
 * with the framework by Stage 47's rule; Open Graph, Twitter and structured
 * data have inputs the vocabulary cannot name. Refusing is what keeps the
 * capability honest - a realization that quietly dropped them would let a
 * feature be accepted and then ignored.
 */

/** What Next can spell: enough for a canonical, and nothing more. */
export const NEXT_REALIZATION: RealizationSupport = {
  architecture: 'next-app',
  bindings: ['site.url', 'page.path'],
  derivations: ['absolute-page-url'],
};

/**
 * The anchor in the shipped root layout's metadata export.
 *
 * Matched exactly once, like Astro's head anchor. Next merges metadata down the
 * tree, so an origin and a relative address declared here reach every route -
 * which is why the site's document belongs in this file and needs no page to
 * be touched.
 */
const LAYOUT_ANCHOR = 'export const metadata: Metadata = {';

/** The anchor in the shipped not-found page, which declares no metadata yet. */
const NOT_FOUND_ANCHOR = "import { CONTACT, NAV } from '../lib/site.config';";

/**
 * One target's canonical, as the Next metadata it becomes.
 *
 * Returns the lines to place inside a `metadata` object. A suppression - the
 * page claiming no address - is `canonical: null`, which is Next's own way of
 * saying the same thing and is what keeps an unmatched route from inheriting
 * the layout's relative address as `/_not-found`.
 */
function canonicalMetadata(value: AnyDocumentValue, target: string): readonly string[] {
  if (value.kind === 'derived') {
    if (JSON.stringify(value) !== JSON.stringify(absolutePageUrl())) {
      throw new CliError(`"next-app" cannot realize this canonical for ${target}.`, {
        hint:
          'Next declares an origin and a relative address and resolves the route itself, so ' +
          'it realizes `absolute-page-url(site.url, page.path)` whole. A derivation over any ' +
          'other inputs has no declaration form here and is refused rather than approximated.',
      });
    }
    /*
     * Both halves are guarded on the configured URL, and the second guard is
     * the one that took measuring. With only `metadataBase` guarded, a project
     * with no production URL emitted relative canonicals - `href="/"`,
     * `href="/contact"` - because Next resolves a relative address with or
     * without a base. That is not a fabricated origin, but it is not this
     * project's rule either: Astro omits the tag entirely when no origin is
     * configured, and a URL-less project should say the same thing on both.
     */
    return [
      '  metadataBase: SITE.url ? new URL(SITE.url) : null,',
      "  alternates: { canonical: SITE.url ? './' : null },",
    ];
  }

  if (value.kind === 'literal') {
    if (typeof value.value !== 'string') {
      throw new CliError(`"next-app" cannot spell a ${value.type} literal for ${target}.`, {
        hint: 'A canonical is an address; only a textual value has one.',
      });
    }
    // An explicitly empty address means this target claims none. Distinct from
    // saying nothing, which produces no entry at all.
    return value.value === ''
      ? ['  alternates: { canonical: null },']
      : [`  alternates: { canonical: ${JSON.stringify(value.value)} },`];
  }

  throw new CliError(`"next-app" cannot realize a bound canonical for ${target}.`, {
    hint:
      'A canonical that refers to a single value has no declaration form in Next, which ' +
      'builds one from an origin and a route rather than from an address.',
  });
}

/**
 * Turns resolved plans into the Next project's metadata declarations.
 *
 * Pure: operations in, operations out, no filesystem. The target decides which
 * file is written - the site's document belongs to the root layout, a page's to
 * the file that page's role maps to - and the target is the one the semantic
 * pipeline chose, never re-derived from a path or a file name.
 */
export function applyNextDocument(
  architecture: ArchitectureDefinition,
  operations: readonly FileOperation[],
  plans: readonly DocumentEmissionPlan[],
): readonly FileOperation[] {
  if (plans.length === 0) return operations;

  const rewritten = new Map<string, FileOperation>();

  for (const plan of plans) {
    const described = describeTarget(plan.target);

    for (const item of plan.items) {
      if (item.state === 'suppressed') continue;
      if (item.field !== 'canonical') {
        throw new CliError(`"next-app" cannot realize ${item.field} for ${described}.`, {
          hint:
            'Next realizes the canonical address and nothing else. Title, description and ' +
            'robots belong to the framework; Open Graph, Twitter and structured data have ' +
            'inputs the document vocabulary cannot name. None of them is dropped quietly.',
        });
      }

      const path =
        plan.target.kind === 'site'
          ? resolveRole(architecture, 'app.layout')
          : resolveRole(architecture, plan.target.role);

      const planned = rewritten.get(path) ?? operations.find((entry) => entry.path === path);
      if (planned === undefined || planned.type !== 'write') {
        throw new CliError(`The document for ${described} has no file to be declared in.`, {
          hint: `Nothing planned produces "${path}".`,
        });
      }

      rewritten.set(path, {
        type: 'write',
        path,
        content: declare(planned.content, path, canonicalMetadata(item.value, described)),
        origin: `${planned.origin} + composed canonical`,
      });
    }
  }

  return [
    ...operations.filter((operation) => !rewritten.has(operation.path)),
    ...rewritten.values(),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Puts the declarations into a file's `metadata` export, creating one if the
 * file has none.
 *
 * Two shapes, because the two files this writes to genuinely differ: the root
 * layout ships a metadata export to extend, and the not-found page ships none.
 * Both anchors are matched exactly once and refused otherwise, so a template
 * that changed shape fails here rather than producing a declaration somewhere
 * nobody chose.
 */
function declare(content: string, path: string, lines: readonly string[]): string {
  const existing = content.split(LAYOUT_ANCHOR).length - 1;
  if (existing === 1) {
    return content.replace(LAYOUT_ANCHOR, [LAYOUT_ANCHOR, ...lines].join('\n'));
  }

  const fresh = content.split(NOT_FOUND_ANCHOR).length - 1;
  if (fresh === 1) {
    return content.replace(
      NOT_FOUND_ANCHOR,
      [
        "import type { Metadata } from 'next';",
        '',
        NOT_FOUND_ANCHOR,
        '',
        '/** Declared by the document pipeline; this page states nothing else. */',
        'export const metadata: Metadata = {',
        ...lines,
        '};',
      ].join('\n'),
    );
  }

  throw new CliError(`The composed canonical could not find its place in "${path}".`, {
    hint:
      `Expected either one metadata export to extend or one import to declare beside, ` +
      `found ${existing} and ${fresh}. The file this architecture ships has changed shape, ` +
      'and declaring blindly would put the address somewhere nobody chose.',
  });
}
