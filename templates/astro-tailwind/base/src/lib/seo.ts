/**
 * Small URL helpers for the site's metadata.
 *
 * Deliberately not a general-purpose URL library: it solves exactly what
 * canonical tags, Open Graph and the sitemap need, and nothing more.
 */

/**
 * Returns the site's origin with any trailing slash removed, or '' when no
 * usable production URL is configured.
 *
 * An empty result is the signal used throughout the site to omit absolute
 * metadata entirely rather than invent a domain.
 */
export function siteOrigin(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') return '';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';

  // Origin only, so there is never a trailing slash to double up on. Astro
  // resolves absolute routes against the origin, so keeping a path here would
  // make the canonical tag and the sitemap disagree. Sites deployed under a
  // subpath need Astro's `base` option too - see the note on SITE.url in
  // src/config/site.config.ts.
  return parsed.origin;
}

/**
 * Joins a site-relative path onto the configured origin.
 * Returns '' when there is no origin, so callers can omit the tag entirely.
 */
export function absoluteUrl(origin: string, path: string): string {
  if (origin === '') return '';
  const suffix = path.startsWith('/') ? path : `/${path}`;
  // Collapse any accidental double slash in the path portion.
  return `${origin}${suffix}`.replace(/([^:]\/)\/+/g, '$1');
}

/**
 * Resolves a configured asset reference for use in metadata.
 * Absolute URLs pass through; a site-relative path needs an origin, because
 * social crawlers reject relative image URLs.
 */
export function assetUrl(origin: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return absoluteUrl(origin, trimmed);
}

/**
 * The three characters that can end a script element early or open a new tag,
 * mapped to their JSON unicode escapes.
 *
 * Each value must be a six-character sequence starting with a real backslash,
 * not the character itself. Writing the character instead turns the
 * replacement below into a silent no-op, which is why `jsonLdScript` is
 * covered by a test asserting the output contains no bare angle bracket.
 */
const JSON_LD_ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
};

/**
 * Serialises data for a <script type="application/ld+json"> block.
 *
 * JSON.stringify alone is not enough: the HTML parser ends a script element at
 * the first '</script', whatever the JSON quoting says. Escaping '<', '>' and
 * '&' keeps the payload valid JSON - the escapes decode back to the original
 * characters when parsed - while making it impossible to close the element or
 * open a new tag.
 *
 * HTML entity escaping must NOT be used here: script content is raw text, so
 * '&amp;' would survive into the parsed JSON as a literal five-character run.
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/[<>&]/g, (char) => JSON_LD_ESCAPES[char] ?? char);
}
