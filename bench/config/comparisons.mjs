import { scenarios, validateScenario } from '../scenarios/index.mjs';

export const libraryAdapters = ['composite', 'reactive'];

// The contract concerns observable data, not the number/shape of Mongo queries.
// Adapters may use their idiomatic consolidated-cursor or per-parent tree APIs.
export const libraryContracts = {
  'plain-cursor':
    'Identical projected active posts through insert, update, field clearing, removal, and membership changes.',
  'dependent-posts':
    'The reader document and exactly its referenced posts after replacing the post-ID relationship.',
  'one-to-many':
    'Active parent posts and exactly their comments after child moves, parent membership changes, and child edits.',
  'deep-join':
    'Active posts, their comments, and deduplicated comment authors after relationship and membership changes.',
  'shared-children':
    'Active posts and deduplicated authors; an author remains while any published post references it.',
  'projection-sensitivity':
    'The same reader/post projection after excluded-field writes, equal-value writes, and relationship replacement.',
  'sorted-window':
    'The first two posts sorted by score descending and ID ascending while score updates change membership.',
  'subscription-churn':
    'The same projected active posts on every subscribe/ready/unsubscribe cycle, with resource cleanup.',
  fanout:
    'The same uniquely identified inserted posts delivered to every persistent subscriber, optionally at an offered write rate.',
};

export const comparisonSuites = {
  smoke: ['sorted-window', 'subscription-churn', 'shared-children'],
  compatible: Object.keys(libraryContracts),
};

export function comparisonCases({ suite = 'smoke', scenario } = {}) {
  if (!comparisonSuites[suite])
    throw new Error(`Unknown comparison suite: ${suite}`);
  const names = scenario ? [scenario] : comparisonSuites[suite];
  for (const name of names) {
    for (const adapter of libraryAdapters) validateScenario(name, adapter);
    if (!libraryContracts[name])
      throw new Error(`No equivalent library contract for ${name}`);
  }
  return names.map((name) => ({
    scenario: name,
    contract: libraryContracts[name],
  }));
}

export const excludedLibraryCases = Object.entries(scenarios)
  .filter(
    ([, value]) =>
      !libraryAdapters.every((adapter) => value.adapters.includes(adapter))
  )
  .map(([scenario]) => ({
    scenario,
    reason:
      'No equivalent composite adapter is defined; application emulations must be separate workloads.',
  }));
