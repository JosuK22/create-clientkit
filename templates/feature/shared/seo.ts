/**
 * The URL rules every search file in this project shares.
 *
 * `app/robots.ts`, `app/sitemap.ts` and the structured data all build absolute
 * addresses from `SITE.url`, and they have to agree: a sitemap listing one
 * domain while robots.txt advertises another is worse than either alone. So
 * the arithmetic lives here once.
 */

/**
 * The site's origin - scheme, host and port - or '' when no usable production
 * URL is configured.
 *
 * Origin only, on purpose: a path, query or fragment in `SITE.url` is dropped
 * rather than repeated in front of every address. Anything that is not an
 * absolute http(s) URL counts as not configured, so nothing absolute is
 * emitted until there is a real domain to point at.
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

  return parsed.origin;
}

/**
 * Joins a site-relative path onto an origin, or '' when there is no origin -
 * so a caller can omit the address entirely rather than invent one.
 */
export function absoluteUrl(origin: string, path: string): string {
  if (origin === '') return '';
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${suffix}`.replace(/([^:]\/)\/+/g, '$1');
}

/**
 * The three characters that can end a script element early or open a new tag,
 * mapped to their JSON unicode escapes.
 *
 * Each value is six characters starting with a real backslash. Writing the
 * character itself would make the replacement below a silent no-op.
 */
const JSON_LD_ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
};

/**
 * Serialises data for a `<script type="application/ld+json">` element.
 *
 * `JSON.stringify` alone is not enough: the HTML parser ends a script element
 * at the first `</script`, whatever the JSON quoting says. Escaping `<`, `>`
 * and `&` keeps the payload valid JSON - the escapes decode back to the
 * original characters - while making it impossible to close the element.
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/[<>&]/g, (char) => JSON_LD_ESCAPES[char] ?? char);
}
