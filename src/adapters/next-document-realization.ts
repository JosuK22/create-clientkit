import { importSpecifier } from '../domain/app-composition.js';
import type { DocumentEmissionPlan, RealizationSupport } from '../domain/document-emission.js';
import { describeTarget } from '../domain/document-scope.js';
import type { AnyDocumentValue } from '../domain/document-value.js';
import { absolutePageUrl } from '../domain/document-value.js';
import type { ArchitectureDefinition, FileRole } from '../domain/roles.js';
import { resolveRole } from '../domain/roles.js';
import { comparePlanPaths, type FileOperation } from '../generate/files.js';
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
 * Every other metadata field is refused. Title, description and robots stay
 * with the framework by Stage 47's rule; Open Graph and Twitter have inputs the
 * vocabulary cannot name. Refusing is what keeps the capability honest - a
 * realization that quietly dropped them would let a feature be accepted and
 * then ignored.
 *
 * ## Structured data, per page
 *
 * Since SEO Stage 2 a stated Organization is realized too, and not where the
 * canonical goes. Next renders every route - the not-found page included -
 * inside the root layout, so a component there could not honour the 404's
 * suppression. It is placed instead on each page the architecture maps whose
 * own document states it: the home page, and never the not-found page. A page
 * the developer adds later renders the component itself, which the component
 * says.
 *
 * The contract's values are not written into source. The page renders the
 * contributed component, which reads the same configuration the contract was
 * derived from - so editing `lib/site.config.ts` after generation changes the
 * output, exactly as it does for the canonical.
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

/**
 * The root layout's last import, after which the origin it derives is declared.
 *
 * Not directly above the metadata export, which carries the layout's own
 * documentation; a declaration placed between the two would detach it.
 */
const LAYOUT_IMPORTS_ANCHOR = "import '../styles/globals.css';\n";

/**
 * The origin a derived canonical is declared against.
 *
 * The same rule `siteOrigin` applies in `lib/seo.ts` - trimmed, parsed without
 * throwing, http(s) only, origin alone - spelled where the layout can read it
 * without importing a module `seo` does not contribute. Before SEO Stage 3 the
 * layout passed `SITE.url` to `new URL` directly, so a whitespace-only or
 * malformed value failed `next build` and an `ftp:` one became a canonical,
 * where robots.txt, the sitemap and the JSON-LD all treated it as no URL.
 */
const ORIGIN_DECLARATION: readonly string[] = [
  '',
  '/**',
  ' * The origin of `SITE.url`, or null until it is an absolute http(s) address -',
  ' * the rule the rest of the site uses, so the canonical never disagrees with',
  ' * the sitemap, robots.txt or structured data.',
  ' */',
  "const siteBase = URL.canParse(SITE.url.trim()) ? new URL('/', SITE.url.trim()) : null;",
  'const metadataBase =',
  "  siteBase?.protocol === 'http:' || siteBase?.protocol === 'https:' ? siteBase : null;",
];

/** What a canonical becomes: declarations before the export, entries inside it. */
interface CanonicalDeclaration {
  readonly preamble: readonly string[];
  readonly entries: readonly string[];
}

/** The anchor in the shipped not-found page, which declares no metadata yet. */
const NOT_FOUND_ANCHOR = "import { CONTACT, NAV, SITE } from '../lib/site.config';";

/**
 * Where a page's structured data renders: first inside the page's outermost
 * element.
 *
 * Every page the starters ship opens with this element, matched exactly once
 * and refused otherwise. In the body rather than the head, which is where Next
 * puts a page's own markup and where JSON-LD is equally valid.
 */
const PAGE_ROOT_ANCHOR = '    <div className="app-shell">\n';

/** What the component exports, and what the page renders. */
const STRUCTURED_DATA_EXPORT = 'StructuredData';

/**
 * One target's canonical, as the Next metadata it becomes.
 *
 * Returns the lines to place inside a `metadata` object. A suppression - the
 * page claiming no address - is `canonical: null`, which is Next's own way of
 * saying the same thing and is what keeps an unmatched route from inheriting
 * the layout's relative address as `/_not-found`.
 */
function canonicalMetadata(value: AnyDocumentValue, target: string): CanonicalDeclaration {
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
    /*
     * The base is the origin, not `SITE.url` as written. Next joins a
     * metadata base's path onto every relative address, so a configured
     * `https://acme.example/en?ref=x` would otherwise put `/en` in front of
     * every canonical - where the sitemap, robots.txt and JSON-LD all use the
     * origin alone. See `ORIGIN_DECLARATION` for how it is derived.
     */
    return {
      preamble: ORIGIN_DECLARATION,
      entries: ['  metadataBase,', "  alternates: { canonical: metadataBase ? './' : null },"],
    };
  }

  if (value.kind === 'literal') {
    if (typeof value.value !== 'string') {
      throw new CliError(`"next-app" cannot spell a ${value.type} literal for ${target}.`, {
        hint: 'A canonical is an address; only a textual value has one.',
      });
    }
    // An explicitly empty address means this target claims none. Distinct from
    // saying nothing, which produces no entry at all.
    return {
      preamble: [],
      entries:
        value.value === ''
          ? ['  alternates: { canonical: null },']
          : [`  alternates: { canonical: ${JSON.stringify(value.value)} },`],
    };
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
      // Realized per page below, from every plan at once.
      if (item.field === 'structured-data') continue;
      if (item.field !== 'canonical') {
        throw new CliError(`"next-app" cannot realize ${item.field} for ${described}.`, {
          hint:
            'Next realizes the canonical address and structured data, and nothing else. ' +
            'Title, description and robots belong to the framework; Open Graph and Twitter ' +
            'have inputs the document vocabulary cannot name. None of them is dropped quietly.',
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

  const pages = structuredDataPages(architecture, plans);
  if (pages.length > 0) {
    const componentPath = resolveRole(architecture, 'app.document.structuredData');
    if (!operations.some((entry) => entry.path === componentPath)) {
      throw new CliError('Structured data is stated, but nothing produces its component.', {
        hint: `Nothing planned produces "${componentPath}", which the pages would import.`,
      });
    }

    for (const role of pages) {
      const path = resolveRole(architecture, role);
      const planned = rewritten.get(path) ?? operations.find((entry) => entry.path === path);
      if (planned === undefined || planned.type !== 'write') {
        throw new CliError(`The structured data for the "${role}" page has no file to render in.`, {
          hint: `Nothing planned produces "${path}".`,
        });
      }

      rewritten.set(path, {
        type: 'write',
        path,
        content: renderStructuredData(planned.content, path, importSpecifier(path, componentPath)),
        origin: `${planned.origin} + composed structured data`,
      });
    }
  }

  return [
    ...operations.filter((operation) => !rewritten.has(operation.path)),
    ...rewritten.values(),
  ].sort((a, b) => comparePlanPaths(a.path, b.path));
}

/**
 * The pages whose own document states structured data, sorted by role.
 *
 * A page with a plan of its own answers for itself - that is how the
 * not-found page's suppression is honoured. A page with none inherits the
 * site's statement, the same rule scope composition applies everywhere else.
 * Only pages the architecture maps are candidates, so this is never a list of
 * routes: it is the pages this project was generated with.
 */
function structuredDataPages(
  architecture: ArchitectureDefinition,
  plans: readonly DocumentEmissionPlan[],
): readonly FileRole[] {
  const states = (plan: DocumentEmissionPlan | undefined): boolean =>
    plan?.items.some((item) => item.field === 'structured-data' && item.state === 'stated') ??
    false;

  const site = plans.find((plan) => plan.target.kind === 'site');
  const pageRoles = (Object.keys(architecture.roles) as FileRole[])
    .filter((role) => role.startsWith('page.'))
    .sort();

  return pageRoles.filter((role) => {
    const own = plans.find((plan) => plan.target.kind === 'page' && plan.target.role === role);
    return own === undefined ? states(site) : states(own);
  });
}

/**
 * Renders the component first inside the page's outermost element, and
 * imports it above the page's own imports.
 *
 * Both anchors are matched exactly once and refused otherwise: a page that
 * changed shape fails here rather than rendering the data somewhere nobody
 * chose.
 */
function renderStructuredData(content: string, path: string, specifier: string): string {
  const roots = content.split(PAGE_ROOT_ANCHOR).length - 1;
  const imports = content.startsWith('import ');
  if (roots !== 1 || !imports) {
    throw new CliError(`The structured data could not find its place in "${path}".`, {
      hint:
        `Expected one outermost app-shell element and a leading import, found ${roots} and ` +
        `${imports ? 'one' : 'none'}. The page this architecture ships has changed shape, ` +
        'and rendering blindly would put the data somewhere nobody chose.',
    });
  }

  return [
    `import { ${STRUCTURED_DATA_EXPORT} } from '${specifier}';`,
    content.replace(PAGE_ROOT_ANCHOR, `${PAGE_ROOT_ANCHOR}      <${STRUCTURED_DATA_EXPORT} />\n`),
  ].join('\n');
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
function declare(content: string, path: string, declaration: CanonicalDeclaration): string {
  const { preamble, entries: lines } = declaration;
  const existing = content.split(LAYOUT_ANCHOR).length - 1;
  if (existing === 1) {
    const declared = content.replace(LAYOUT_ANCHOR, [LAYOUT_ANCHOR, ...lines].join('\n'));
    if (preamble.length === 0) return declared;

    const imports = declared.split(LAYOUT_IMPORTS_ANCHOR).length - 1;
    if (imports !== 1) {
      throw new CliError(`The canonical's origin could not find its place in "${path}".`, {
        hint:
          `Expected the layout's stylesheet import once, found ${imports}. The file this ` +
          'architecture ships has changed shape.',
      });
    }
    return declared.replace(
      LAYOUT_IMPORTS_ANCHOR,
      `${LAYOUT_IMPORTS_ANCHOR}${preamble.join('\n')}\n`,
    );
  }

  const fresh = content.split(NOT_FOUND_ANCHOR).length - 1;
  if (fresh === 1) {
    return content.replace(
      NOT_FOUND_ANCHOR,
      [
        "import type { Metadata } from 'next';",
        '',
        NOT_FOUND_ANCHOR,
        ...preamble,
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
