/**
 * Capability-based compatibility.
 *
 * The alternative - a table of which selections work together - is quadratic
 * in the number of adapters and, worse, spreads knowledge of each adapter
 * across every other one. Adding Vue would mean editing every React-only
 * component library's row to say "no".
 *
 * Here, an adapter declares only what it offers and what it needs. It never
 * names another adapter. Compatibility falls out of set membership:
 *
 *     Angular provides  ['angular-runtime', 'spa-routing', 'typescript']
 *     Chakra  requires  'react-runtime'    because "Chakra UI is built on React"
 *
 *     'react-runtime' is not in the selected set  ->  Chakra is unavailable.
 *
 * No rule mentions both Angular and Chakra, and adding a framework changes
 * nothing here: a new framework declares its own capabilities, and every
 * library that asked for `react-runtime` stays correctly excluded.
 *
 * The engine that evaluates these is a later stage. This file is the
 * vocabulary it will read.
 */

/**
 * A fact about the selected stack that another adapter can depend on.
 *
 * Capabilities describe *what is true of the project*, never *what was
 * selected*. `react-runtime` rather than `framework-is-react`, because Next.js
 * provides it too and a library that needs React should not have to enumerate
 * every framework that supplies one.
 */
export const CAPABILITIES = [
  // runtimes
  'react-runtime',
  'angular-runtime',

  // authoring
  'jsx',
  'typescript',

  // rendering and routing
  'ssr',
  'static-output',
  'file-based-routing',
  'spa-routing',

  /**
   * The global stylesheet is composed from contributions rather than shipped
   * by the framework's template.
   *
   * An architecture property, not a framework one: any framework whose template
   * leaves styles.global to be contributed provides it. A styling system that
   * has no legacy template arrangement anywhere requires it, which is what
   * keeps such a system away from architectures that would silently ignore its
   * stylesheet.
   */
  'composed-stylesheet',

  // styling pipeline
  'postcss',
  'sass',
  'css-framework',
  'css-in-js',

  // build integration
  'vite-plugins',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * A requirement an adapter places on the rest of the stack.
 *
 * `because` is mandatory and is not documentation: it is the sentence the user
 * is shown when the constraint rejects their selection. Making it part of the
 * type means a constraint cannot be added without someone having written a
 * human-readable reason for it.
 */
export type Constraint =
  | {
      readonly kind: 'requires';
      readonly capability: Capability;
      readonly because: string;
    }
  | {
      readonly kind: 'conflicts';
      readonly capability: Capability;
      readonly because: string;
    }
  | {
      readonly kind: 'requiresOneOf';
      readonly capabilities: readonly Capability[];
      readonly because: string;
    };

/**
 * Renders a constraint as the phrase shown to a user.
 *
 * One renderer rather than a string built at each call site, so the wording
 * cannot drift between the interactive path and the flag path.
 */
export function describeConstraint(constraint: Constraint): string {
  switch (constraint.kind) {
    case 'requires':
      return `requires ${constraint.capability} (${constraint.because})`;
    case 'conflicts':
      return `cannot be combined with ${constraint.capability} (${constraint.because})`;
    case 'requiresOneOf':
      return `requires one of ${constraint.capabilities.join(', ')} (${constraint.because})`;
  }
}
