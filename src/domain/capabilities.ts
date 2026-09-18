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
  /**
   * The application has a document head that per-page metadata can be rendered
   * into *before the response is sent*.
   *
   * The timing is the whole content of the claim. A single-page application
   * that sets `document.title` after hydration has a head, and does not have
   * this: a crawler reading the initial response sees the entry HTML and
   * nothing else. Declaring it there would produce metadata that looks correct
   * in a browser and is invisible to the machines it exists for.
   */
  'document-metadata',
  'spa-routing',
  /**
   * A router is present: routes can be declared and matched in the client.
   *
   * Deliberately distinct from the two capabilities around it, because
   * collapsing them is the mistake that would let a generator claim something
   * untrue:
   *
   *   - `file-based-routing` - the framework turns files into routes, and a
   *     path nothing matches reaches a real not-found *document* in the
   *     response.
   *   - `spa-routing` - navigation happens without a full page load. A shape
   *     of application, which React has with or without a router.
   *   - `client-side-routing` - this. Routes exist and are matched, in the
   *     browser, after the response has already been sent.
   *
   * A client-side catch-all renders a component; it does not produce an HTTP
   * 404. So a router providing this does not, and must not, satisfy a
   * requirement for `file-based-routing`.
   */
  'client-side-routing',

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

  /**
   * The architecture's document shell already satisfies the metadata contracts
   * this generator's features describe, and that agreement is verified against
   * real built HTML.
   *
   * ## Read this before trusting the name
   *
   * The name says "composed" and Stage 29 established that **nothing composes**.
   * A metadata feature contributes a `ConfigContribution` at `app.layout`; the
   * planner collects those claims, refuses two that disagree, and records them -
   * and then no code anywhere turns a claim into file content. `AdapterPlanResult`
   * exposes `metadata`, `structuredData` and `accessibility`, and the CLI reads
   * none of them.
   *
   * The consequence is measurable: generating an Astro project with
   * `--features seo --features structured-data --features accessibility`
   * produces a tree byte-identical to one generated without them, apart from the
   * feature list recorded in `.client-site.json`. Astro's template ships
   * `Seo.astro`, `StructuredData.astro` and `BaseLayout.astro` unconditionally
   * and drives them from `site.config.ts`.
   *
   * The previous wording here - "Astro's layout is built from contributed
   * metadata" - was therefore false, and had been since the feature was written.
   * Stage 22 reasoned from "`--features seo` on Next produced a byte-identical
   * project" to "Next lacks this capability", without noticing that the same
   * sentence is true of Astro. The conclusion happened to be right; the reason
   * given for it was not.
   *
   * ## What it does distinguish, truthfully
   *
   * Astro's shipped head expresses the whole contract - title, description,
   * robots, canonical, Open Graph, Twitter, JSON-LD, document language - and
   * `test/seo-feature.test.ts` and `scripts/smoke.mjs` check the feature's
   * computed contract against the HTML a real `astro build` emitted. Next's
   * `app/layout.tsx` states a title, a description and a language, and nothing
   * verifies anything. So the capability is a claim about **coverage that has
   * been checked**.
   *
   * Since Stage 44 it is also the gate on a real composition mechanism, which
   * the wording above outlived: a document contribution reaches an architecture
   * realizer and becomes file content. Stage 51 is what makes the sentence
   * separable again. `composed-canonical` now names the mechanism-shaped half -
   * there is a surface, and a contribution reaches it - leaving this one to
   * mean what it always measured: the shell covers the rest of the contract,
   * and that coverage has been verified against built HTML.
   *
   * Withheld from Next because that coverage genuinely is not there, which an
   * experiment confirmed rather than assumed: granting the capability makes all
   * three features resolve, plan and generate - to a byte-identical project.
   * Accepted and ignored is exactly the failure the requirement exists to
   * prevent.
   *
   * Distinct from `document-metadata`, which is a claim about *when* the head
   * reaches the client. Next genuinely has a server-rendered head; what it does
   * not have is one whose contents this generator has any say in.
   */
  'composed-metadata',

  /**
   * This generator can write the document's canonical address, and the
   * architecture resolves it per route.
   *
   * Narrower than `composed-metadata` on purpose, and the narrowness is the
   * point. That capability asserts the shell covers what the metadata features
   * describe - title, description, Open Graph, Twitter, a knowledge-graph
   * block - which Stage 48 measured Next does not do. This asserts one thing:
   * there is somewhere to declare a canonical, and the framework works out
   * which route it belongs to.
   *
   * Two architectures provide it for genuinely different reasons. Astro
   * evaluates an expression per page; Next declares an origin and a relative
   * address and resolves the route itself. Neither needs a list of routes, and
   * a capability that described the mechanism rather than the surface would
   * have been true of only one of them.
   *
   * Separate from `composed-metadata` rather than implied by it: a framework
   * can have a canonical surface without its shell covering the rest, which is
   * exactly Next's position and was exactly what the broader capability could
   * not express.
   */
  'composed-canonical',

  /**
   * The application has a client-rendered root that React context can be
   * mounted above.
   *
   * Distinct from `react-runtime`, and the distinction only became visible when
   * a third framework arrived. React + Vite provides both: `main.tsx` renders
   * the tree in the browser, so a provider can wrap it. Next's App Router
   * provides the runtime and *not* this - its root is a server component, and
   * putting a context provider above it needs a client boundary that ClientKit
   * does not generate.
   *
   * Two adapters said they needed this all along, in prose: MUI "mounts React
   * context above them", React Router "mounts React context above them". Both
   * only asked for `react-runtime`, which was sufficient while React was the
   * only thing providing either. It is the capability, not the runtime, that
   * they actually depend on.
   */
  'client-app-root',

  /**
   * Markup collected while rendering on the server can be flushed into the
   * document head before the response is sent.
   *
   * Next's `useServerInsertedHTML`, and nothing else has one today. A
   * client-only framework needs no such thing - there is no server render to
   * collect from - so its absence is not a deficiency, it is a different shape
   * of application.
   *
   * It exists because a CSS-in-JS runtime has nowhere to put the styles it
   * generates during a server render. Stage 26 found the consequence by loading
   * a generated page rather than by reading code: the styles were emitted into
   * `<body>`, React 19 hoists `<style>` into `<head>` while hydrating, and the
   * two disagreed - a recoverable hydration error on every page load that the
   * production build reported as successful.
   *
   * Requiring this would be wrong: a library that needs it on a server-rendered
   * framework needs nothing on a client-only one. It is a fact to *branch on*,
   * which is why nothing requires it and one adapter reads it.
   */
  'server-inserted-head',

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
