import { canonical } from '../clients/document-store.mjs';

export function summarize(values) {
  if (!values.length)
    return { count: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error('Invalid timing sample');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    count: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: values.length >= 1000 ? percentile(0.99) : null,
    max: sorted.at(-1),
  };
}

export function validateResult(result) {
  const errors = [];
  if (result.schemaVersion !== 1) errors.push('Unsupported result schema');
  if (result.status !== 'valid' || result.correctness?.passed !== true)
    errors.push('Run did not pass correctness');
  for (const key of [
    'harness',
    'fixture',
    'meteor',
    'node',
    'mongo',
    'hardware',
    'packages',
  ]) {
    if (!result.metadata?.[key]) errors.push(`Missing metadata: ${key}`);
  }
  for (const key of [
    'app_cpu_ms',
    'app_rss_bytes',
    'completed_operations',
    'failed_operations',
  ]) {
    if (!Number.isFinite(result.metrics?.[key]) || result.metrics[key] < 0)
      errors.push(`Missing/invalid metric: ${key}`);
  }
  if (result.config?.metricsVersion >= 2) {
    for (const key of [
      'app_heap_used_bytes',
      'app_external_bytes',
      'app_array_buffers_bytes',
      'end_heap_used_bytes',
      'event_loop_samples',
      'event_loop_utilization',
      'gc_pause_ms',
      'gc_count',
      'gc_max_pause_ms',
    ]) {
      if (!Number.isFinite(result.metrics?.[key]) || result.metrics[key] < 0)
        errors.push(`Missing/invalid metric: ${key}`);
    }
    for (const key of ['event_loop_p95_ms', 'event_loop_p99_ms']) {
      if (
        result.metrics.event_loop_samples > 0 &&
        (!Number.isFinite(result.metrics[key]) || result.metrics[key] < 0)
      )
        errors.push(`Missing/invalid metric: ${key}`);
    }
    if (result.config.databaseMetrics || result.config.databaseProfile) {
      const support = result.phases?.database?.process;
      if (typeof support?.available !== 'boolean')
        errors.push('Missing database resource coverage');
      if (
        support?.available &&
        (!Number.isFinite(result.metrics.mongo_cpu_ms_per_operation) ||
          !Number.isFinite(result.metrics.mongo_rss_bytes))
      )
        errors.push('Missing Mongo process metrics');
    }
    if (
      result.config.databaseProfile &&
      result.phases?.database?.queries?.coverage_verified !== true
    )
      errors.push('Missing Mongo profiler coverage');
    if (result.config.databaseProfile) {
      for (const key of [
        'mongo_read_operations_per_operation',
        'mongo_docs_examined_per_operation',
        'mongo_keys_examined_per_operation',
        'mongo_collection_scans_per_operation',
      ]) {
        if (!Number.isFinite(result.metrics?.[key]) || result.metrics[key] < 0)
          errors.push(`Missing/invalid metric: ${key}`);
      }
    }
    if (result.config.retention) {
      const checkpoints = result.samples?.retention;
      const { every } = result.config.retention;
      const operations = result.config.profile.operations;
      if (
        !checkpoints?.length ||
        checkpoints[0].cycle !== 0 ||
        checkpoints.at(-1).cycle !== operations ||
        !Number.isSafeInteger(every) ||
        every < 1 ||
        checkpoints.length !== Math.ceil(operations / every) + 1 ||
        checkpoints.some(
          (sample, index) =>
            sample.cycle !== Math.min(index * every, operations) ||
            ['heapUsed', 'rss', 'external', 'arrayBuffers'].some(
              (key) => !Number.isFinite(sample[key]) || sample[key] < 0
            )
        )
      )
        errors.push('Incomplete retention checkpoints');
      if (!Number.isFinite(result.metrics.retained_heap_growth_bytes))
        errors.push('Missing retained heap measurement');
    }
    if (
      result.config.instrumentation === 'observers' &&
      result.phases?.cleanup?.verified !== true
    )
      errors.push('Resource cleanup was not verified');
  }
  const validSamples = (metric, count) =>
    metric?.count === count &&
    count > 0 &&
    ['mean', 'p50', 'p95', 'max'].every(
      (key) => Number.isFinite(metric[key]) && metric[key] >= 0
    );
  if (['backend', 'browser'].includes(result.config?.level)) {
    if (
      result.metrics?.completed_operations !== result.config.profile.operations
    )
      errors.push('Incomplete operations');
    if (result.metrics?.failed_operations !== 0)
      errors.push('Failed operations');
    if (
      result.config.level === 'backend' &&
      backendNames.some(
        (name) =>
          !validSamples(
            result.metrics?.backend?.[name],
            result.config.profile.operations
          )
      )
    )
      errors.push('Missing backend measurements');
    if (
      result.config.level === 'browser' &&
      !validSamples(
        result.metrics?.browser_data_ms,
        result.config.profile.operations
      )
    )
      errors.push('Missing browser measurements');
    return errors;
  }
  for (const key of [
    'ddp_payload_bytes',
    'ddp_messages',
    'cpu_ms_per_operation',
    'bytes_per_operation',
    'changed_operations',
  ]) {
    if (!Number.isFinite(result.metrics?.[key]) || result.metrics[key] < 0)
      errors.push(`Missing/invalid metric: ${key}`);
  }
  if (
    result.metrics?.completed_operations !== result.config?.profile?.operations
  )
    errors.push('Incomplete operation count');
  if (result.metrics?.failed_operations !== 0) errors.push('Failed operations');
  if (
    result.config?.metricsVersion >= 2 &&
    result.config.rate > 0 &&
    !validSamples(
      result.metrics?.scheduled_convergence_ms,
      result.config.profile.clients * result.config.profile.operations
    )
  )
    errors.push('Missing scheduled delivery latency/coverage');
  const readyCount =
    result.config?.profile?.clients *
    (result.config?.scenario === 'subscription-churn'
      ? result.config.profile.operations + 1
      : 1);
  if (!validSamples(result.metrics?.subscription_ready_ms, readyCount))
    errors.push('Missing subscription latency/coverage');
  if (result.metrics?.changed_operations > result.metrics?.completed_operations)
    errors.push('Invalid changed operation count');
  if (
    result.config?.scenario !== 'subscription-churn' &&
    result.metrics?.changed_operations > 0
  ) {
    if (
      !validSamples(
        result.metrics?.update_convergence_ms,
        result.metrics.changed_operations * result.config.profile.clients
      )
    )
      errors.push('Missing delivery latency/coverage');
    if (
      !validSamples(
        result.metrics?.fanout_completion_ms,
        result.metrics.changed_operations
      )
    )
      errors.push('Missing fanout latency/coverage');
  }
  return errors;
}

export const metricRegistry = [
  {
    path: 'subscription_ready_ms.p95',
    unit: 'ms',
    direction: 'lower',
    absolute: 1,
    relative: 0.15,
  },
  {
    path: 'update_convergence_ms.p95',
    unit: 'ms',
    direction: 'lower',
    absolute: 1,
    relative: 0.15,
  },
  {
    path: 'fanout_completion_ms.p95',
    unit: 'ms',
    direction: 'lower',
    absolute: 1,
    relative: 0.15,
  },
  {
    path: 'cpu_ms_per_operation',
    unit: 'ms/op',
    direction: 'lower',
    absolute: 0.1,
    relative: 0.15,
  },
  {
    path: 'app_rss_bytes',
    unit: 'bytes',
    direction: 'lower',
    absolute: 5 * 1024 * 1024,
    relative: 0.15,
  },
  {
    path: 'bytes_per_operation',
    unit: 'bytes/op',
    direction: 'lower',
    absolute: 32,
    relative: 0.1,
  },
];

const cost = (path, unit, absolute, extra = {}) => ({
  path,
  unit,
  direction: 'lower',
  absolute,
  relative: 0.15,
  ...extra,
});
export const runtimeMetricRegistry = [
  cost('update_convergence_ms.p99', 'ms', 1, {
    samplePath: 'update_convergence_ms.count',
    minSamples: 1000,
  }),
  cost('method_roundtrip_ms.p95', 'ms', 1),
  cost('app_heap_used_bytes', 'bytes', 1024 * 1024),
  cost('app_external_bytes', 'bytes', 1024 * 1024),
  cost('app_array_buffers_bytes', 'bytes', 1024 * 1024),
  cost('event_loop_p95_ms', 'ms', 1, {
    samplePath: 'event_loop_samples',
    minSamples: 20,
  }),
  cost('event_loop_p99_ms', 'ms', 1, {
    samplePath: 'event_loop_samples',
    minSamples: 1000,
  }),
  cost('event_loop_utilization', 'ratio', 0.05, { direction: 'context' }),
  cost('completed_operations_per_second', 'ops/s', 1, { direction: 'higher' }),
  cost('gc_ms_per_operation', 'ms/op', 0.01),
  cost('gc_max_pause_ms', 'ms', 1),
  cost('observers_created_per_operation', 'handles/op', 0.1),
  cost('messages_per_operation', 'messages/op', 1),
];
const databaseRegistry = [
  cost('mongo_cpu_ms_per_operation', 'ms/op', 0.1),
  cost('mongo_rss_bytes', 'bytes', 5 * 1024 * 1024),
];
const queryRegistry = [
  cost('mongo_read_operations_per_operation', 'reads/op', 0.1),
  cost('mongo_docs_examined_per_operation', 'docs/op', 1),
  cost('mongo_keys_examined_per_operation', 'keys/op', 1),
  cost('mongo_collection_scans_per_operation', 'scans/op', 0.1),
];
const retentionRegistry = [
  cost('retained_heap_growth_bytes', 'bytes', 1024 * 1024, { signed: true }),
  cost(
    'retained_heap_slope_bytes_per_100_cycles',
    'bytes/100 cycles',
    128 * 1024,
    { signed: true, samplePath: 'retention_checkpoints', minSamples: 5 }
  ),
  cost('retained_rss_growth_bytes', 'bytes', 5 * 1024 * 1024, { signed: true }),
  cost('retained_external_growth_bytes', 'bytes', 1024 * 1024, {
    signed: true,
  }),
  cost('retained_array_buffers_growth_bytes', 'bytes', 1024 * 1024, {
    signed: true,
  }),
];

export const backendNames = [
  'dependency-fanout',
  'equal-value',
  'cursor-selector-churn',
  'computed-field',
  'data-lookup',
];
function registryFor(result) {
  const level = result.config.level;
  const timing = (path) => ({
    path,
    unit: 'ms',
    direction: 'lower',
    absolute: 0.1,
    relative: 0.15,
  });
  if (level === 'backend')
    return [
      ...backendNames.map((name) => timing(`backend.${name}.mean`)),
      metricRegistry[4],
    ];
  if (level === 'browser')
    return [timing('browser_data_ms.p95'), metricRegistry[4]];
  if (result.config.retention) return retentionRegistry;
  return [
    ...metricRegistry,
    ...runtimeMetricRegistry,
    ...(result.config.databaseMetrics || result.config.databaseProfile
      ? databaseRegistry
      : []),
    ...(result.config.databaseProfile ? queryRegistry : []),
    ...(result.config.rate
      ? [
          cost('scheduled_convergence_ms.p95', 'ms', 1),
          cost('scheduled_convergence_ms.p99', 'ms', 1, {
            samplePath: 'scheduled_convergence_ms.count',
            minSamples: 1000,
          }),
          cost('load_drain_ms', 'ms', 1),
        ]
      : []),
  ];
}

export function compatibilityKey(result, mode = 'regression') {
  const { adapter, ...config } = result.config;
  const { source, packages, ...metadata } = result.metadata;
  const stable = { ...metadata };
  delete stable.buildKey;
  delete stable.createdAt;
  // A candidate may itself cause observer fallback; keep that evidence in the
  // result while comparing the same requested runtime/workload configuration.
  delete stable.observerDrivers;
  // Resolved package sets legitimately differ by library and local package version.
  const packageSet =
    mode === 'library'
      ? null
      : packages
          .split('\n')
          .filter((row) => !row.startsWith('nachocodoner:reactive-publish@'))
          .sort();
  return JSON.stringify(
    canonical({
      config,
      adapter: mode === 'library' ? null : adapter,
      metadata: stable,
      packageSet,
    })
  );
}

const getMetric = (result, key) =>
  key.split('.').reduce((obj, part) => obj?.[part], result.metrics);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

export function compareResults(
  baselines,
  targets,
  { mode = 'regression', gate = false } = {}
) {
  if (!['regression', 'library'].includes(mode))
    throw new Error('Comparison mode must be regression or library');
  if (!baselines.length || baselines.length !== targets.length)
    throw new Error('Comparison requires equal nonzero counts of paired runs');
  let reference;
  for (const run of [...baselines, ...targets]) {
    const errors = validateResult(run);
    if (errors.length)
      throw new Error(`Invalid comparison input: ${errors.join('; ')}`);
    reference ??= compatibilityKey(run, mode);
    if (compatibilityKey(run, mode) !== reference)
      throw new Error(
        'Incompatible workload, harness, runtime, or hardware metadata'
      );
  }
  // A side may change relative to its counterpart, but repetitions on that
  // side must not silently mix library versions or source edits.
  const identity = (run) =>
    JSON.stringify(
      canonical({
        adapter: run.config.adapter,
        packages: run.metadata.packages,
        source: ['reactive', 'installed'].includes(run.config.adapter)
          ? run.metadata.source?.hash
          : null,
      })
    );
  for (const runs of [baselines, targets]) {
    if (runs.some((run) => identity(run) !== identity(runs[0])))
      throw new Error(
        'Incompatible library/source identities within repeated runs'
      );
  }
  if (mode === 'library') {
    const packages = (run) =>
      new Map(
        run.metadata.packages
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('@'))
      );
    const left = packages(baselines[0]);
    const right = packages(targets[0]);
    for (const [name, version] of left) {
      if (
        ['nachocodoner:reactive-publish', 'reywood:publish-composite'].includes(
          name
        )
      )
        continue;
      if (right.has(name) && right.get(name) !== version)
        throw new Error(`Incompatible shared Meteor package version: ${name}`);
    }
  }
  const details = registryFor(baselines[0]).map((metric) => {
    const left = baselines.map((run) => getMetric(run, metric.path));
    const right = targets.map((run) => getMetric(run, metric.path));
    if ([...left, ...right].some((value) => value == null))
      return {
        metric: metric.path,
        status: 'unavailable',
        reason:
          'No observations or collector unavailable; never treated as zero',
      };
    if (
      [...left, ...right].some(
        (value) => !Number.isFinite(value) || (!metric.signed && value < 0)
      )
    )
      throw new Error(`Invalid ${metric.path}`);
    const base = mean(left);
    const target = mean(right);
    const deltas = right.map((value, i) => value - left[i]);
    let lower = null;
    let upper = null;
    const samplePath =
      metric.samplePath ||
      (metric.path.endsWith('.p95')
        ? metric.path.replace(/\.p95$/, '.count')
        : null);
    const minimumSamples = metric.minSamples || 20;
    const generatorLimited =
      (/^(update_convergence_ms|fanout_completion_ms|scheduled_convergence_ms|method_roundtrip_ms)\./.test(
        metric.path
      ) ||
        metric.path === 'completed_operations_per_second') &&
      [...baselines, ...targets].some(
        (run) => run.phases?.generator?.utilization >= 0.9
      );
    const enoughSamples =
      !samplePath ||
      [...baselines, ...targets].every(
        (run) => getMetric(run, samplePath) >= minimumSamples
      );
    if (left.length >= 5 && enoughSamples && !generatorLimited) {
      // Deterministic paired bootstrap of independent run summaries.
      let state = 12345;
      const bootstrap = Array.from({ length: 2000 }, () =>
        mean(
          deltas.map(() => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return deltas[Math.floor((state / 4294967296) * deltas.length)];
          })
        )
      ).sort((a, b) => a - b);
      lower = bootstrap[50];
      upper = bootstrap[1949];
    }
    const budget = Math.max(metric.absolute, Math.abs(base) * metric.relative);
    const contextual = metric.direction === 'context';
    const regression =
      !contextual &&
      lower !== null &&
      (metric.direction === 'higher' ? upper < -budget : lower > budget);
    const improvement =
      !contextual &&
      lower !== null &&
      (metric.direction === 'higher' ? lower > budget : upper < -budget);
    return {
      metric: metric.path,
      unit: metric.unit,
      direction: metric.direction,
      baseline: base,
      target,
      delta: target - base,
      percent:
        base > 0 && !metric.signed ? ((target - base) / base) * 100 : null,
      interval: [lower, upper],
      budget,
      effect:
        mode === 'library'
          ? contextual
            ? 'context-only'
            : lower === null
              ? 'inconclusive'
              : regression
                ? metric.direction === 'higher'
                  ? 'lower-throughput'
                  : 'higher-cost'
                : improvement
                  ? metric.direction === 'higher'
                    ? 'higher-throughput'
                    : 'lower-cost'
                  : 'no-clear-difference'
          : undefined,
      reason: contextual
        ? 'Utilization depends on throughput and waiting; lower alone is not better'
        : generatorLimited
          ? 'Load-generator utilization reached 90%; client timing is potentially harness-limited'
          : !enoughSamples
            ? `Fewer than ${minimumSamples} observations per run (${samplePath})`
            : left.length < 5
              ? 'Fewer than five independent run pairs'
              : undefined,
      status: contextual
        ? 'diagnostic'
        : lower === null
          ? 'inconclusive'
          : regression
            ? 'regression'
            : 'within-budget',
    };
  });
  return {
    mode,
    pairs: baselines.length,
    advisory: !gate,
    passed: !gate || !details.some((row) => row.status === 'regression'),
    details,
  };
}

const number = (value) =>
  value == null ? 'n/a' : Number(value.toFixed(3)).toLocaleString('en-US');
export function comparisonMarkdown(
  report,
  { baselineLabel = 'Baseline', targetLabel = 'Candidate' } = {}
) {
  return (
    `Benchmark comparison (${report.advisory ? 'advisory' : 'gated'}; ${report.pairs} independent pair(s))\n\n` +
    `| Metric | ${baselineLabel} | ${targetLabel} | Change | Status | Evidence |\n| --- | ---: | ---: | ---: | --- | --- |\n` +
    report.details
      .map(
        (row) =>
          `| ${row.metric}${row.unit ? ` (${row.unit})` : ''} | ${number(row.baseline)} | ${number(row.target)} | ${row.percent == null ? 'n/a' : `${number(row.percent)}%`} | ${row.effect || row.status} | ${row.reason || `Paired delta interval: ${row.interval.map(number).join(' to ')}`} |`
      )
      .join('\n') +
    '\n'
  );
}

export function resultMarkdown(result) {
  const names =
    result.config.level === 'backend'
      ? backendNames.map((name) => `backend.${name}`)
      : result.config.level === 'browser'
        ? ['browser_data_ms']
        : [
            'subscription_ready_ms',
            'update_convergence_ms',
            'fanout_completion_ms',
          ];
  const rows = names.map((key) => {
    const metric = getMetric(result, key);
    return `| ${key} | ${number(metric?.p50)} | ${number(metric?.p95)} | ${metric?.count || 0} |`;
  });
  return (
    `Benchmark ${result.config.level || 'ddp'} / ${result.config.scenario} / ${result.config.adapter}: **${result.status}**\n\n` +
    '| Latency | p50 ms | p95 ms | Samples |\n| --- | ---: | ---: | ---: |\n' +
    rows.join('\n') +
    `\n\nCompleted operations: ${result.metrics?.completed_operations || 0}. CPU: ${number(result.metrics?.app_cpu_ms)} ms. DDP payload: ${number(result.metrics?.ddp_payload_bytes)} bytes.\n\n` +
    (result.correctness.errors.length
      ? result.correctness.errors.map((error) => `- ${error}`).join('\n') + '\n'
      : `Correctness passed. Resource cleanup ${result.phases.cleanup?.verified ? 'verified' : 'not instrumented'}.\n`)
  );
}
