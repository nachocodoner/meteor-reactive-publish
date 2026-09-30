import { resolveProfile } from './profiles.mjs';
import { comparisonCases, libraryAdapters } from './comparisons.mjs';

export const comprehensivePresets = {
  full: {
    pairs: 5,
    profile: 'standard',
    operations: 1000,
    warmup: 100,
    duration: 30,
    rates: [10, 50, 100],
    retentionCycles: 1000,
    retentionEvery: 100,
    queryOperations: 100,
  },
  quick: {
    pairs: 1,
    profile: 'smoke',
    operations: 30,
    warmup: 5,
    duration: 2,
    rates: [10, 50],
    retentionCycles: 20,
    retentionEvery: 5,
    queryOperations: 20,
  },
};

const positive = (value, label, integer = true) => {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error(
      `${label} must be a positive ${integer ? 'integer' : 'number'}`
    );
  return value;
};

// Resolve once, before starting either adapter. Each case carries the exact
// shared workload, including instrumentation that changes measurement costs.
export function comprehensivePlan(values = {}) {
  const preset = values.preset || 'full';
  const defaults = comprehensivePresets[preset];
  if (!defaults) throw new Error(`Unknown comprehensive preset: ${preset}`);
  const pairs = positive(Number(values.pairs ?? defaults.pairs), 'pairs');
  const profile = resolveProfile(values.profile || defaults.profile, {
    operations: defaults.operations,
    warmup: defaults.warmup,
    ...values,
  });
  const duration = positive(
    Number(values.duration ?? defaults.duration),
    'duration',
    false
  );
  const rates =
    values.rates === undefined
      ? defaults.rates
      : String(values.rates).split(',').map(Number);
  if (!rates.length || new Set(rates).size !== rates.length)
    throw new Error(
      'rates must be a nonempty list of distinct positive numbers'
    );
  rates.forEach((rate) => positive(rate, 'rate', false));
  rates.sort((a, b) => a - b);
  const retentionCycles = positive(
    Number(values['retention-cycles'] ?? defaults.retentionCycles),
    'retention-cycles'
  );
  const retentionEvery = positive(
    Number(values['retention-every'] ?? defaults.retentionEvery),
    'retention-every'
  );
  if (retentionEvery > retentionCycles)
    throw new Error('retention-every must not exceed retention-cycles');
  const stages =
    values.stages === undefined
      ? ['core', 'load', 'retention', 'queries']
      : String(values.stages).split(',');
  if (
    !stages.length ||
    new Set(stages).size !== stages.length ||
    stages.some(
      (stage) => !['core', 'load', 'retention', 'queries'].includes(stage)
    )
  )
    throw new Error(
      'stages must select distinct core, load, retention, or queries stages'
    );
  const contracts = comparisonCases({
    suite: 'compatible',
    scenario: values.scenario,
  });
  const make = (stage, contract, overrides = {}) => ({
    id: `${stage}/${contract.scenario}`,
    scenario: contract.scenario,
    description: contract.contract,
    stage,
    level: 'ddp',
    adapters: [...libraryAdapters],
    enabled: true,
    run: {
      profile: { ...profile },
      rate: 0,
      databaseMetrics: true,
      measurement: stage,
      ...overrides,
    },
  });
  const cases = [];
  if (stages.includes('core'))
    cases.push(...contracts.map((contract) => make('core', contract)));
  if (
    stages.includes('load') &&
    (!values.scenario || values.scenario === 'fanout')
  ) {
    const contract = comparisonCases({ scenario: 'fanout' })[0];
    for (const rate of rates)
      cases.push({
        ...make('load', contract, {
          // +1 makes the last scheduled dispatch occur at/after duration, instead
          // of stopping one interval short. The same count is used on both sides.
          profile: {
            ...profile,
            operations: positive(
              Math.max(profile.operations, Math.ceil(duration * rate) + 1),
              'load operation count'
            ),
          },
          rate,
          duration,
          loadSloMs: positive(
            Number(values['latency-budget'] ?? 100),
            'latency-budget',
            false
          ),
        }),
        id: `load/fanout-${rate}`,
        description: `${contract.contract} Offered load ${rate} writes/s for at least ${duration}s; minimum ${profile.operations} measured writes.`,
      });
  }
  if (
    stages.includes('retention') &&
    (!values.scenario || values.scenario === 'subscription-churn')
  ) {
    cases.push(
      make(
        'retention',
        comparisonCases({ scenario: 'subscription-churn' })[0],
        {
          profile: { ...profile, operations: retentionCycles },
          retention: { every: retentionEvery, settleMs: 50, forcedGcPasses: 2 },
        }
      )
    );
  }
  if (stages.includes('queries'))
    cases.push(
      ...contracts.map((contract) =>
        make('queries', contract, {
          profile: {
            ...profile,
            operations: Math.min(profile.operations, defaults.queryOperations),
          },
          databaseProfile: true,
        })
      )
    );
  if (!cases.length)
    throw new Error('The selected scenario and stages have no common cases');
  return {
    preset,
    pairs,
    profile,
    stages,
    cases,
    maximumRuns: cases.length * libraryAdapters.length * pairs,
    minimumLoadSeconds:
      cases
        .filter((entry) => entry.stage === 'load')
        .reduce(
          (sum, entry) =>
            sum + (entry.run.profile.operations - 1) / entry.run.rate,
          0
        ) *
      libraryAdapters.length *
      pairs,
    note: 'Independent fresh processes/databases; alternating paired order. Quick is descriptive. No universal score. Profiling and forced GC are isolated stages. Durations exclude builds, warmup, drains and other stages.',
  };
}
