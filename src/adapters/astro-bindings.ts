import type { BindingSupport, DocumentBinding } from '../domain/document-value.js';

/**
 * How Astro says each thing the document domain can refer to.
 *
 * This is the only place in the codebase where a semantic binding meets Astro
 * syntax, and the direction is one-way:
 *
 *     document domain  →  semantic binding  →  this table  →  Astro expression
 *
 * The domain never imports this module and never learns that `page.path` is
 * spelled `Astro.url.pathname`. Reverse the arrow and the domain becomes
 * Astro-shaped, which is the failure Stage 30 stopped for and Stage 34 stopped
 * for again.
 *
 * ## Why these are strings here and nowhere else
 *
 * An expression is source code, and source code in the domain would be an
 * expression language by another name - the thing Stage 35 exists to avoid. In
 * an architecture adapter it is just what this framework calls something, the
 * same way `templates/` holds framework source. Nothing evaluates these; a
 * future emitter writes them into generated files.
 *
 * ## Read against the shipped template, not invented
 *
 * Every expression below appears in `templates/astro-tailwind/base/src/` today:
 * `Seo.astro` reads `SITE.name`, `SITE.url`, `SITE.description`, `SITE.locale`,
 * `SEO.image`, `SEO.twitterCard`, `SEO.noindex` and `Astro.url.pathname`, and
 * `BaseLayout.astro` reads `Astro.generator`. The mapping records what the
 * generated project already does rather than proposing something new, which is
 * what keeps it checkable.
 */
export const ASTRO_BINDING_EXPRESSIONS = {
  'site.name': 'SITE.name',
  'site.url': 'SITE.url',
  'site.description': 'SITE.description',
  'site.language': 'SITE.locale',
  'document.socialImage': 'SEO.image',
  'document.twitterCardStyle': 'SEO.twitterCard',
  'document.indexingBlocked': 'SEO.noindex',
  'page.path': 'Astro.url.pathname',
  'generator.name': 'Astro.generator',
} as const satisfies Readonly<Record<DocumentBinding, string>>;

/**
 * Astro can supply every binding the vocabulary declares.
 *
 * True today, and stated as data rather than assumed: the moment a binding is
 * added that Astro cannot express, this list stops matching the vocabulary and
 * a test says so - rather than the gap surfacing as a generated document that
 * quietly states something untrue.
 */
export const ASTRO_BINDING_SUPPORT: BindingSupport = {
  architecture: 'astro-standard',
  supports: Object.keys(ASTRO_BINDING_EXPRESSIONS) as DocumentBinding[],
};

/** What Astro writes for one semantic binding. */
export function astroExpressionFor(binding: DocumentBinding): string {
  return ASTRO_BINDING_EXPRESSIONS[binding];
}
