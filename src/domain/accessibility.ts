import type { SiteContext } from '../types.js';

/**
 * The accessibility contract, as data.
 *
 * ## What this is, and what it deliberately is not
 *
 * A framework-independent statement of the accessibility properties ClientKit
 * can actually guarantee about the shell it generates - and, just as
 * importantly, an explicit record of the ones it cannot.
 *
 * It is **not** a WCAG conformance claim. A generator produces a shell; a
 * finished site is that shell plus content, colours, components and copy that
 * someone else writes afterwards. Claiming conformance for the result would be
 * claiming something about work that has not happened yet, and an accessibility
 * claim that is not true is worse than no claim: it tells a team they can stop
 * checking.
 *
 * So the contract is split in two. `guarantees` are properties of the generated
 * document that hold on every page ClientKit emits, each verifiable in real
 * built HTML. `outOfScope` names what remains the developer's, so the boundary
 * is written down rather than implied.
 *
 * ## Nothing is invented
 *
 * Accessibility is the area where a generator is most tempted to manufacture
 * semantics, and where doing so does the most damage: a fabricated alt text, a
 * guessed language or an invented accessible name is worse than an absent one,
 * because assistive technology presents it as fact. Nothing here is derived
 * from anything but the project's own configuration.
 *
 * ## Native semantics over ARIA
 *
 * The contract describes landmarks in terms of the elements that provide them -
 * `main`, `nav`, `footer` - rather than `role` attributes, because the elements
 * carry the semantics natively and a redundant role is a maintenance burden
 * that can only go wrong.
 */

/**
 * A property of the generated document that holds on every page.
 *
 * Each is phrased so it can be checked against real built HTML, because a
 * guarantee nobody can verify is a slogan.
 */
export const ACCESSIBILITY_GUARANTEES = [
  /** `<html lang>` carries the project's configured language tag. */
  'document-language',
  /** Exactly one non-empty `<title>`. */
  'document-title',
  /** Exactly one `<main>`, carrying an id that can be targeted. */
  'main-landmark',
  /** A link to the main landmark, before the rest of the body, revealed on focus. */
  'skip-link',
  /** A `<footer>` providing the contentinfo landmark. */
  'contentinfo-landmark',
  /** Exactly one `<h1>` per page. */
  'primary-heading',
  /**
   * Where the shell renders navigation it is a `<nav>` with an accessible name.
   *
   * Phrased conditionally on purpose. Not every generated page has navigation -
   * the coming-soon page deliberately has none - so "every page has a nav
   * landmark" would be false. What is unconditionally true is that navigation,
   * when present, is marked up as one.
   */
  'navigation-landmark-when-present',
  /** The viewport meta does not prevent zooming. */
  'scalable-viewport',
] as const;

export type AccessibilityGuarantee = (typeof ACCESSIBILITY_GUARANTEES)[number];

/**
 * What ClientKit does not guarantee, recorded rather than left implied.
 *
 * This list is the honest half of the contract. Every entry is something a
 * reader might otherwise assume a generated project has already handled.
 */
export const ACCESSIBILITY_OUT_OF_SCOPE = [
  /** Conformance is a property of a finished site, not of a shell. */
  'wcag-conformance',
  /** The accent colour is the developer's; so is every pairing it produces. */
  'colour-contrast',
  /** Headings, labels and copy written after generation. */
  'authored-content',
  /** Alt text: the generator ships no content images and invents no descriptions. */
  'image-alternative-text',
  /** Components and libraries added after generation. */
  'third-party-components',
  /** Keyboard behaviour of interactive elements the generator did not create. */
  'authored-interaction',
] as const;

export type AccessibilityOutOfScope = (typeof ACCESSIBILITY_OUT_OF_SCOPE)[number];

export interface AccessibilityContract {
  /** The language tag the generated document declares. */
  readonly documentLanguage: string;
  /** Whether that tag is well-formed; false means the shell cannot claim a language. */
  readonly documentLanguageValid: boolean;
  readonly guarantees: readonly AccessibilityGuarantee[];
  readonly outOfScope: readonly AccessibilityOutOfScope[];
}

/**
 * Whether a string is a well-formed BCP-47 language tag for `<html lang>`.
 *
 * Deliberately a copy of the rule the configuration resolver already applies,
 * not an import of it: that module reads the filesystem, and this one must stay
 * pure. A test asserts the two agree on a shared set of inputs, so the
 * duplication is guarded rather than silent.
 *
 * A bare primary subtag is valid here. `lang="en"` is correct HTML - unlike
 * `og:locale`, which needs `language_TERRITORY` and is a different rule in a
 * different place for a different consumer.
 */
export function isValidLanguageTag(value: string): boolean {
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value);
}

/**
 * Derives the contract from the project's own metadata.
 *
 * Pure and total. The language comes from the site configuration and nothing
 * else - there is no fallback to a guessed default here, because the resolver
 * has already applied the project's default and substituting another one at
 * this layer would hide a misconfiguration behind a plausible-looking `en`.
 *
 * An invalid tag is reported rather than repaired: `documentLanguageValid` goes
 * false and the caller can refuse. Silently rewriting someone's language tag is
 * exactly the kind of invention this contract exists to prevent.
 */
export function resolveAccessibilityContract(site: SiteContext): AccessibilityContract {
  const documentLanguage = site.locale.trim();

  return {
    documentLanguage,
    documentLanguageValid: isValidLanguageTag(documentLanguage),
    guarantees: [...ACCESSIBILITY_GUARANTEES],
    outOfScope: [...ACCESSIBILITY_OUT_OF_SCOPE],
  };
}

/**
 * Serialises the contract in a fixed field order.
 *
 * Fixed rather than derived from `Object.keys`, for the same reason the other
 * contracts are: insertion order is a property of how an object happened to be
 * built, and golden snapshots compare bytes.
 */
export function serialiseAccessibilityContract(contract: AccessibilityContract): string {
  return JSON.stringify({
    documentLanguage: contract.documentLanguage,
    documentLanguageValid: contract.documentLanguageValid,
    guarantees: contract.guarantees,
    outOfScope: contract.outOfScope,
  });
}
