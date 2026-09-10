import { CliError } from '../errors.js';
import { KNOWN_TOKENS, type TokenName } from '../templates/manifest.js';
import type { ProjectContext } from '../types.js';

export type TokenValues = Readonly<Record<TokenName, string>>;

/**
 * Tokens whose value may legitimately be empty.
 *
 * `siteUrl` and `author` are the two fields the CLI refuses to invent. When
 * absent they substitute to the empty string, and the generated source is
 * written to treat empty as "not set yet" (see astro.config.mjs, which omits
 * Astro's `site` option entirely when the URL is blank). Every other token is
 * required to be non-empty.
 */
export const NULLABLE_TOKENS: ReadonlySet<TokenName> = new Set<TokenName>(['siteUrl', 'author']);

const TOKEN_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function buildTokenValues(context: ProjectContext, now: Date): TokenValues {
  return Object.freeze({
    siteName: context.site.name,
    siteUrl: context.site.url ?? '',
    description: context.site.description,
    year: String(now.getUTCFullYear()),
    projectName: context.projectName,
    author: context.site.author ?? '',
    locale: context.site.locale,
    mode: context.template.mode,
  });
}

/**
 * Replaces `{{token}}` occurrences.
 *
 * Deliberately not a template language: no expressions, no conditionals, no
 * loops, no function calls. An unrecognised token is a hard error naming the
 * file, never a silent empty string.
 */
export function substituteTokens(
  content: string,
  values: TokenValues,
  sourceLabel: string,
): string {
  const unknown = new Set<string>();
  const empty = new Set<string>();

  const result = content.replace(TOKEN_PATTERN, (match, rawName: string) => {
    if (!(KNOWN_TOKENS as readonly string[]).includes(rawName)) {
      unknown.add(rawName);
      return match;
    }
    const name = rawName as TokenName;
    const value = values[name];
    if (value === '' && !NULLABLE_TOKENS.has(name)) {
      empty.add(name);
      return match;
    }
    return value;
  });

  if (unknown.size > 0) {
    throw new CliError(
      `Unknown token${unknown.size > 1 ? 's' : ''} ${[...unknown].map((t) => `{{${t}}}`).join(', ')} in ${sourceLabel}.`,
      { hint: `Known tokens: ${KNOWN_TOKENS.map((t) => `{{${t}}}`).join(', ')}.` },
    );
  }
  if (empty.size > 0) {
    throw new CliError(
      `Token${empty.size > 1 ? 's' : ''} ${[...empty].map((t) => `{{${t}}}`).join(', ')} resolved to an empty value in ${sourceLabel}.`,
      { hint: 'Only {{siteUrl}} and {{author}} may be empty.' },
    );
  }
  return result;
}

/** Collects the token names a piece of content references. Used by tests. */
export function findTokens(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(TOKEN_PATTERN)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}
