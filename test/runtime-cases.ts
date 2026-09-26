import type { AdapterRegistry } from '../src/adapters/registry.js';
import { enumerateCombinations, type Combination } from './accepted-combinations.js';

/**
 * Which generated projects get served and poked at, and why each one is there.
 *
 * ## The reduction, and what justifies it
 *
 * Stage 53 built all 104 accepted configurations. Serving 104 of them and
 * driving a browser at each would be slower and would prove nothing the first
 * twenty do not: a runtime contract is a property of an *architecture plus a
 * feature*, not of a particular styling system, and building the same contract
 * twenty more times measures the same thing twenty more times.
 *
 * So the set is reduced, but the reduction is computed rather than chosen. Each
 * accepted configuration covers a number of `dimension:value` tuples - its
 * framework's starters, styling systems, component libraries, routers and
 * features - and a greedy set cover keeps picking whichever configuration still
 * covers the most uncovered tuples until none are left. What that guarantees is
 * the thing worth guaranteeing: **every runtime dimension appears in at least
 * one served application, in every architecture where it is supported.**
 *
 * Two things the cover cannot express are added afterwards, because they are
 * states rather than selections:
 *
 *   - a URL-less variant per framework, since "no production URL" changes what
 *     the document may claim and is exactly where a generator is tempted to
 *     invent `http://localhost`;
 *   - a hand-added route per file-routed framework, since "a page ClientKit
 *     never saw still resolves" cannot be observed on a route it generated.
 */

export type UrlState = 'configured' | 'url-less';

/** One observable promise, named so the artifact can say what was exercised. */
export type Contract =
  | 'home-200'
  | 'not-found-404'
  | 'added-route-200'
  | 'canonical-present'
  | 'canonical-added-route'
  | 'canonical-absent-on-404'
  | 'canonical-absent-url-less'
  | 'json-ld-present'
  | 'json-ld-absent-on-404'
  | 'accessibility-structure'
  | 'stylesheet-loads'
  | 'mui-renders'
  | 'chakra-renders'
  | 'router-route-loads'
  | 'client-fallback-200'
  | 'no-runtime-errors';

export interface RuntimeCase {
  readonly id: string;
  readonly combination: Combination;
  readonly url: UrlState;
  /** Routes to create by hand after generation, as path -> file contents key. */
  readonly addedRoutes: readonly string[];
  readonly contracts: readonly Contract[];
  /** Why this case is in the matrix at all. */
  readonly covers: readonly string[];
}

/** The tuples a runtime matrix has to touch, read from the accepted set. */
function requiredTuples(accepted: readonly Combination[]): Set<string> {
  const tuples = new Set<string>();
  for (const entry of accepted) for (const tuple of tuplesOf(entry)) tuples.add(tuple);
  return tuples;
}

/**
 * What one configuration covers.
 *
 * Two tiers. The first is each dimension on its own, which is what "every
 * supported thing was served at least once" means. The second pairs the things
 * whose *runtime* behaviour genuinely differs with the starter - a feature, a
 * component library, a router - because the two starters render different
 * pages, and a contract observed only on the launch page has been observed on
 * half the product. Styling is deliberately not paired: a stylesheet either
 * loads or does not, and which page requested it is not interesting.
 */
function tuplesOf(entry: Combination): string[] {
  const scope = `${entry.framework}`;
  const tuples = [
    `${scope}:starter=${entry.starter}`,
    `${scope}:styling=${entry.styling}`,
    `${scope}:uiLibrary=${entry.uiLibrary}`,
    `${scope}:router=${entry.router}`,
    ...entry.features.map((feature) => `${scope}:feature=${feature}`),
    ...entry.features.map((feature) => `${scope}:feature=${feature}@${entry.starter}`),
  ];
  if (entry.uiLibrary !== 'none')
    tuples.push(`${scope}:uiLibrary=${entry.uiLibrary}@${entry.starter}`);
  if (entry.router === 'react-router')
    tuples.push(`${scope}:router=${entry.router}@${entry.starter}`);
  /*
   * A third tier: each feature alone, at least once.
   *
   * Observing a canonical on a project that also selected structured data and
   * the accessibility baseline shows the canonical is there; it does not show
   * which feature put it there. A case where a feature is the only one selected
   * is what makes a contract attributable, and it is also the case that would
   * expose a feature quietly depending on another one being present.
   */
  if (entry.features.length === 1) tuples.push(`${scope}:only-feature=${entry.features[0]}`);
  return tuples;
}

/**
 * What a served project of this shape is expected to do.
 *
 * Derived from the configuration rather than attached by hand, so a case cannot
 * quietly claim a contract its stack does not have - and so the artifact's list
 * of exercised contracts is a consequence of the matrix rather than a label on
 * it.
 */
function contractsFor(entry: Combination, url: UrlState, added: readonly string[]): Contract[] {
  const contracts: Contract[] = ['home-200', 'no-runtime-errors'];
  const has = (feature: string): boolean => entry.features.includes(feature);
  const fileRouted = entry.router === 'file-based';

  if (fileRouted) contracts.push('not-found-404');
  if (added.length > 0) contracts.push('added-route-200');

  // SEO writes a canonical wherever the architecture can realize one.
  if (has('seo')) {
    if (url === 'configured') {
      contracts.push('canonical-present');
      if (added.length > 0) contracts.push('canonical-added-route');
      if (fileRouted) contracts.push('canonical-absent-on-404');
    } else {
      contracts.push('canonical-absent-url-less');
    }
  }

  if (has('structured-data')) {
    contracts.push('json-ld-present');
    if (fileRouted) contracts.push('json-ld-absent-on-404');
  }
  if (has('accessibility')) contracts.push('accessibility-structure');
  if (has('client-route-fallback')) contracts.push('client-fallback-200');

  if (entry.styling !== 'none') contracts.push('stylesheet-loads');
  if (entry.uiLibrary === 'mui') contracts.push('mui-renders');
  if (entry.uiLibrary === 'chakra') contracts.push('chakra-renders');
  if (entry.router === 'react-router') contracts.push('router-route-loads');

  return contracts;
}

/** A page a developer might add later, per architecture. */
function addedRoutesFor(entry: Combination): string[] {
  // Only where the framework resolves routes from files. A client-side router
  // needs no new file for `/contact` to be a route it can be asked about.
  return entry.router === 'file-based' ? ['/contact'] : [];
}

export interface RuntimeMatrix {
  readonly cases: readonly RuntimeCase[];
  /** Every tuple the accepted set contains, all of which must be covered. */
  readonly required: readonly string[];
  readonly covered: readonly string[];
}

/**
 * The representative runtime matrix, computed from the accepted set.
 *
 * Deterministic: the accepted set arrives already ordered, ties in the greedy
 * step are broken by that order, and the URL-less and added-route variants are
 * appended in framework order.
 */
export function runtimeMatrix(adapters: AdapterRegistry): RuntimeMatrix {
  const accepted = enumerateCombinations(adapters).accepted;
  const required = requiredTuples(accepted);
  const remaining = new Set(required);
  const chosen: Combination[] = [];

  while (remaining.size > 0) {
    let best: Combination | undefined;
    let bestGain = 0;
    for (const entry of accepted) {
      if (chosen.includes(entry)) continue;
      const gain = tuplesOf(entry).filter((tuple) => remaining.has(tuple)).length;
      if (gain > bestGain) {
        best = entry;
        bestGain = gain;
      }
    }
    if (best === undefined) break;
    chosen.push(best);
    for (const tuple of tuplesOf(best)) remaining.delete(tuple);
  }

  const cases: RuntimeCase[] = chosen.map((entry) => {
    const added = addedRoutesFor(entry);
    return {
      id: `${entry.id}__configured`,
      combination: entry,
      url: 'configured' as const,
      addedRoutes: added,
      contracts: contractsFor(entry, 'configured', added),
      covers: tuplesOf(entry),
    };
  });

  /*
   * One URL-less variant per framework, on that framework's most feature-rich
   * chosen case - the one with the most to get wrong when there is no origin to
   * put in front of a path.
   */
  for (const framework of [...new Set(chosen.map((entry) => entry.framework))].sort()) {
    const candidates = chosen.filter((entry) => entry.framework === framework);
    const richest = candidates.reduce((a, b) => (b.features.length > a.features.length ? b : a));
    const added = addedRoutesFor(richest);
    cases.push({
      id: `${richest.id}__url-less`,
      combination: richest,
      url: 'url-less',
      addedRoutes: added,
      contracts: contractsFor(richest, 'url-less', added),
      covers: [`${framework}:url=url-less`],
    });
  }

  const covered = new Set<string>();
  for (const entry of cases) for (const tuple of entry.covers) covered.add(tuple);
  for (const framework of [...new Set(chosen.map((entry) => entry.framework))]) {
    covered.add(`${framework}:url=configured`);
  }

  return {
    cases,
    required: [
      ...[...required].sort(),
      ...[...new Set(chosen.map((e) => e.framework))]
        .flatMap((f) => [`${f}:url=configured`, `${f}:url=url-less`])
        .sort(),
    ],
    covered: [...covered].sort(),
  };
}
