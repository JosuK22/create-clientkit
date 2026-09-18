import type { BindingSupport, DocumentBinding } from '../domain/document-value.js';
import type { FileRole } from '../domain/roles.js';
import { CliError } from '../errors.js';

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

// ---------------------------------------------------------------------------
// What makes an expression resolvable
// ---------------------------------------------------------------------------

/**
 * One import a generated Astro file needs, named semantically.
 *
 * The module is a **file role**, not a path. `config.site` is where the site's
 * configuration lives; which directory that is belongs to the architecture, and
 * a second copy of that decision here would drift the first time the folder
 * shape changed. The specifier is computed relative to whichever file is doing
 * the importing, so the same descriptor serves a component and a layout.
 *
 * No alias, and deliberately so. The local name is the exported name, which
 * means two bindings needing `SITE` from the same role produce one import and
 * never two spellings of it. Adding aliasing would need a rule for which name
 * wins, and nothing has asked for one.
 */
export interface AstroImport {
  readonly role: FileRole;
  readonly named: string;
}

/**
 * How Astro spells a binding, and what has to be in scope for that to work.
 *
 * Stage 41 tried to use `ASTRO_BINDING_EXPRESSIONS` to generate a component and
 * the build failed with `ReferenceError: SITE is not defined`. The table said
 * `site.name` is written `SITE.name` and stopped there - true, and not enough
 * to write a file with. An expression is only half of a realization; the other
 * half is the context that makes the symbols in it mean something.
 *
 * Still closed, and closed in the same way. Every entry below is a constant in
 * this file, keyed by a binding from the domain's vocabulary. Nothing is
 * assembled from input, nothing is concatenated with a caller's string, and
 * there is no entry for a binding the vocabulary does not declare.
 */
export interface AstroBindingRealization {
  readonly expression: string;
  readonly imports: readonly AstroImport[];
}

const SITE_CONFIG: FileRole = 'config.site';

/** The site's own configuration object, which most bindings read. */
const FROM_SITE: readonly AstroImport[] = [{ role: SITE_CONFIG, named: 'SITE' }];
/** The SEO block of that same configuration. */
const FROM_SEO: readonly AstroImport[] = [{ role: SITE_CONFIG, named: 'SEO' }];
/** Astro's own globals need nothing imported; they are ambient in a component. */
const AMBIENT: readonly AstroImport[] = [];

export const ASTRO_BINDING_REALIZATIONS = {
  'site.name': { expression: ASTRO_BINDING_EXPRESSIONS['site.name'], imports: FROM_SITE },
  'site.url': { expression: ASTRO_BINDING_EXPRESSIONS['site.url'], imports: FROM_SITE },
  'site.description': {
    expression: ASTRO_BINDING_EXPRESSIONS['site.description'],
    imports: FROM_SITE,
  },
  'site.language': { expression: ASTRO_BINDING_EXPRESSIONS['site.language'], imports: FROM_SITE },
  'document.socialImage': {
    expression: ASTRO_BINDING_EXPRESSIONS['document.socialImage'],
    imports: FROM_SEO,
  },
  'document.twitterCardStyle': {
    expression: ASTRO_BINDING_EXPRESSIONS['document.twitterCardStyle'],
    imports: FROM_SEO,
  },
  'document.indexingBlocked': {
    expression: ASTRO_BINDING_EXPRESSIONS['document.indexingBlocked'],
    imports: FROM_SEO,
  },
  'page.path': { expression: ASTRO_BINDING_EXPRESSIONS['page.path'], imports: AMBIENT },
  'generator.name': { expression: ASTRO_BINDING_EXPRESSIONS['generator.name'], imports: AMBIENT },
} as const satisfies Readonly<Record<DocumentBinding, AstroBindingRealization>>;

/** What has to be in scope for one binding's expression to resolve. */
export function astroImportsFor(binding: DocumentBinding): readonly AstroImport[] {
  return ASTRO_BINDING_REALIZATIONS[binding].imports;
}

/**
 * Every import a set of bindings needs, de-duplicated and ordered.
 *
 * Ordered by role then symbol, which is a property of what is being imported
 * rather than of the order the bindings were collected in. Source-generation
 * ordering, not precedence: two identical import sets produce identical source
 * no matter how either was assembled.
 *
 * Two bindings wanting the same symbol from the same role produce one import.
 * Two wanting the same symbol from *different* roles is refused rather than
 * silently resolved, because one of them would then be reading the wrong
 * module and the generated file would still compile.
 */
export function collectAstroImports(bindings: readonly DocumentBinding[]): readonly AstroImport[] {
  return dedupeAstroImports(bindings.flatMap((binding) => astroImportsFor(binding)));
}

/**
 * The same de-duplication, over imports rather than bindings.
 *
 * Separate so the conflict below is reachable. Nothing in today's vocabulary
 * imports two different modules, so a guard buried inside `collectAstroImports`
 * could never be exercised - and a guard nobody can reach is one nobody can
 * prove. Taking imports directly makes it testable now, and it becomes
 * load-bearing the moment a second module appears in the table.
 */
export function dedupeAstroImports(imports: readonly AstroImport[]): readonly AstroImport[] {
  const byName = new Map<string, AstroImport>();
  for (const entry of imports) {
    const existing = byName.get(entry.named);
    if (existing !== undefined && existing.role !== entry.role) {
      throw new CliError(
        `"${entry.named}" would be imported from both ${existing.role} and ${entry.role}.`,
        {
          hint:
            'Two bindings disagree about where a symbol comes from. Keeping either one ' +
            'silently would leave the generated file reading the wrong module while still ' +
            'compiling, so neither is chosen.',
        },
      );
    }
    byName.set(entry.named, entry);
  }

  return [...byName.values()].sort(
    (a, b) => a.role.localeCompare(b.role) || a.named.localeCompare(b.named),
  );
}

/**
 * The import statements, as Astro source, relative to the file that needs them.
 *
 * Symbols from one module are gathered into a single statement, in the order
 * `collectAstroImports` established, so the output is a function of the set
 * alone.
 */
export function renderAstroImports(
  imports: readonly AstroImport[],
  specifierFor: (role: FileRole) => string,
): readonly string[] {
  const byRole = new Map<FileRole, string[]>();
  for (const entry of imports) {
    const names = byRole.get(entry.role);
    if (names === undefined) byRole.set(entry.role, [entry.named]);
    else names.push(entry.named);
  }

  return [...byRole.entries()].map(
    ([role, names]) => `import { ${names.join(', ')} } from '${specifierFor(role)}';`,
  );
}
