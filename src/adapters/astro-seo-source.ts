import type { EmissionField } from '../domain/document-emission.js';

/**
 * Astro's metadata component, as a structure rather than a file.
 *
 * ## The blocker this answers
 *
 * Stage 40 declared five fields composition-owned. Stage 41 found that
 * `Seo.astro` emits all seven anyway, and measured the result: realizing two of
 * them produced two `<title>` elements, two canonicals with different values,
 * and a canonical on the 404 where the template deliberately emits none. It
 * built cleanly. Ownership was declared and had no effect on the source.
 *
 * The missing piece was a **handover**: a way for the shipped component to stop
 * emitting a field, one field at a time, without editing the file that V1
 * ships.
 *
 * ## Why segments
 *
 * The component cannot be split into per-field files, because V1's file list is
 * frozen. It cannot be edited, because V1's bytes are frozen. And it must not
 * be rewritten by string surgery, because a regex that deletes a `<title>` is a
 * guess about source it does not understand.
 *
 * So the component is modelled as an ordered list of segments, each optionally
 * declaring which fields it serves. A segment stays if it serves nothing in
 * particular, or if any field it serves is still the template's. Rendering with
 * nothing handed over concatenates every segment and reproduces the shipped
 * file **byte for byte**, which a test asserts - so the model cannot drift from
 * the template, and the V1 path never uses it at all.
 *
 * ## Why segments and not lines
 *
 * Because handover reaches into the frontmatter. `noUnusedLocals` is on in the
 * generated project, so a component that stops emitting `<meta name="robots">`
 * while still computing `robots` does not type-check - measured, not assumed:
 * stripping the five composition-owned tags left `ogLocale`, `canonical`,
 * `robots` and the `type` prop unused, and `astro check` reported four errors.
 *
 * Two of those live inside a line shared with something that stays: the
 * `absoluteUrl` helper sits in an import beside two helpers Twitter needs, and
 * `noindex` and `type` sit in one destructure beside props every field reads.
 * A line-granular model could not express either, so segments are sub-line
 * where the source is.
 *
 * ## What this is not
 *
 * Not a parser. Nothing here inspects Astro syntax, resolves a symbol or walks
 * a tree; the dependencies are **declared**, in the `serves` lists, and proven
 * by building the result. Not a template. The shipped file remains the source
 * of truth and this is checked against it.
 */

/**
 * One piece of the component, and the fields whose emission needs it.
 *
 * `serves` lists the fields this segment exists for - the tag itself, or
 * something in the frontmatter that only that tag reads. Absent means the
 * segment is structural or serves a field that is never handed over, and it
 * always stays.
 */
export interface AstroSeoSegment {
  readonly source: string;
  readonly serves?: readonly EmissionField[];
}

export const ASTRO_SEO_SEGMENTS: readonly AstroSeoSegment[] = [
  {
    // the frontmatter opening and the site configuration import
    source: "---\nimport { SEO, SITE } from '../config/site.config.ts';\n",
  },
  {
    // the opening of the seo helper import
    source: 'import { ',
  },
  {
    // the absolute-URL helper, which the canonical address needs
    source: 'absoluteUrl, ',
    serves: ['canonical', 'open-graph'],
  },
  {
    // the rest of the seo helper import
    source: "assetUrl, siteOrigin } from '../lib/seo.ts';\n",
  },
  {
    // the component documentation, props interface and the start of the destructure
    source:
      "\n/**\n * Every <head> tag that describes the page lives here, so there is exactly one\n * place that decides titles, canonical URLs and social metadata - and exactly\n * one of each tag in the output.\n *\n * Everything defaults from src/config/site.config.ts. A page only passes what\n * it genuinely needs to override.\n */\ninterface Props {\n  /** Page name. Omit on the home page so the title is just the site name. */\n  title?: string;\n  /** Overrides SITE.description for this page. */\n  description?: string;\n  /** Force this page out of the index regardless of the site setting. */\n  noindex?: boolean;\n  /** Open Graph type. 'website' suits every page this template ships. */\n  type?: 'website' | 'article';\n  /** Overrides SEO.image for this page. */\n  image?: string;\n}\n\nconst { title, description",
  },
  {
    // the page's own indexing opt-out
    source: ', noindex = false',
    serves: ['robots', 'canonical', 'open-graph'],
  },
  {
    // the Open Graph type prop
    source: ", type = 'website'",
    serves: ['open-graph'],
  },
  {
    // the rest of the destructure, the origin, the page title and the description
    source:
      ", image } = Astro.props;\n\n// '' means no production URL is configured. Every absolute tag below is then\n// skipped rather than pointed at a domain nobody has bought yet.\nconst origin = siteOrigin(SITE.url);\n\nconst pageTitle = title ? `${title} - ${SITE.name}` : SITE.name;\n\n// page description -> site description -> no tag at all. Nothing invented.\nconst metaDescription = (description ?? SITE.description).trim();\n\n",
  },
  {
    // whether this page is blocked from the index
    source:
      '// A page may opt out on its own (the 404 does); the site setting covers the rest.\nconst blocked = noindex || SEO.noindex;\n',
    serves: ['robots', 'canonical', 'open-graph'],
  },
  {
    // the robots directive itself
    source: "const robots = blocked ? 'noindex, nofollow' : 'index, follow';\n",
    serves: ['robots'],
  },
  {
    // the separator after the indexing paragraph
    source: '\n',
    serves: ['robots', 'canonical', 'open-graph'],
  },
  {
    // the canonical address, which og:url also reads
    source:
      '// A canonical tag says "this is the definitive URL for this content" while\n// noindex says "do not index it". Emitting both is contradictory, so a blocked\n// page gets no canonical at all.\nconst canonical = origin === \'\' || blocked ? \'\' : absoluteUrl(origin, Astro.url.pathname);\n\n',
    serves: ['canonical', 'open-graph'],
  },
  {
    // the social image, which Twitter also reads
    source: 'const socialImage = assetUrl(origin, image ?? SEO.image);\n',
  },
  {
    // the Open Graph locale
    source:
      "\n// og:locale wants language_TERRITORY. A bare 'en' is not valid, so it is\n// omitted rather than emitted in a form crawlers will discard.\nconst ogLocale = /^[a-z]{2,3}-[A-Za-z0-9]{2,8}$/.test(SITE.locale)\n  ? SITE.locale.replace('-', '_')\n  : '';\n",
    serves: ['open-graph'],
  },
  {
    // the end of the frontmatter
    source: '---\n\n',
  },
  {
    // the title tag
    source: '<title>{pageTitle}</title>\n',
    serves: ['title'],
  },
  {
    // the description tag
    source: '{metaDescription !== \'\' && <meta name="description" content={metaDescription} />}\n',
    serves: ['description'],
  },
  {
    // the robots tag
    source: '<meta name="robots" content={robots} />\n',
    serves: ['robots'],
  },
  {
    // the canonical link
    source: '{canonical !== \'\' && <link rel="canonical" href={canonical} />}\n',
    serves: ['canonical'],
  },
  {
    // the Open Graph block
    source:
      '\n{/* Open Graph. Only tags whose value actually exists are emitted. */}\n<meta property="og:type" content={type} />\n<meta property="og:title" content={pageTitle} />\n<meta property="og:site_name" content={SITE.name} />\n{metaDescription !== \'\' && <meta property="og:description" content={metaDescription} />}\n{canonical !== \'\' && <meta property="og:url" content={canonical} />}\n{ogLocale !== \'\' && <meta property="og:locale" content={ogLocale} />}\n{socialImage !== \'\' && <meta property="og:image" content={socialImage} />}\n',
    serves: ['open-graph'],
  },
  {
    // the separator before Twitter, which goes when nothing precedes it
    source: '\n',
    serves: ['title', 'description', 'robots', 'canonical', 'open-graph'],
  },
  {
    // the Twitter block, which stays with the template
    source:
      '{/* Twitter/X. No handle is required and none is invented. */}\n<meta name="twitter:card" content={socialImage !== \'\' ? SEO.twitterCard : \'summary\'} />\n<meta name="twitter:title" content={pageTitle} />\n{metaDescription !== \'\' && <meta name="twitter:description" content={metaDescription} />}\n{socialImage !== \'\' && <meta name="twitter:image" content={socialImage} />}\n',
  },
];

/** Every field the component is willing to hand over, in vocabulary order. */
export const ASTRO_SEO_HANDOVER_FIELDS: readonly EmissionField[] = [
  ...new Set(ASTRO_SEO_SEGMENTS.flatMap((segment) => segment.serves ?? [])),
];

/**
 * The component's source, with the handed-over fields no longer emitted.
 *
 * Pure: segments in, string out. With nothing handed over this is the shipped
 * file byte for byte, which is what lets the V1 path ignore this module
 * entirely rather than trust it.
 *
 * A segment survives when any field it serves is still the template's, so a
 * const two retained tags share outlives the one tag that left.
 */
export function renderAstroSeoSource(handedOver: readonly EmissionField[]): string {
  const gone = new Set(handedOver);
  return ASTRO_SEO_SEGMENTS.filter(
    (segment) => segment.serves === undefined || segment.serves.some((field) => !gone.has(field)),
  )
    .map((segment) => segment.source)
    .join('');
}
