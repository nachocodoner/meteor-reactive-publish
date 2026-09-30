import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarize,
  validateResult,
  compareResults,
  backendNames,
} from '../reporting/results.mjs';

function run(latency = 10) {
  return {
    schemaVersion: 1,
    status: 'valid',
    correctness: { passed: true },
    config: {
      adapter: 'reactive',
      scenario: 'plain-cursor',
      profile: { clients: 20, operations: 20 },
    },
    metadata: {
      harness: 'h',
      fixture: 'f',
      meteor: '3.3.2',
      node: 'v22',
      mongo: '7',
      hardware: 'same',
      packages: 'mongo@1\nnachocodoner:reactive-publish@1',
      source: { hash: 'a' },
    },
    metrics: {
      app_cpu_ms: 2,
      app_rss_bytes: 1e8,
      ddp_payload_bytes: 1000,
      ddp_messages: 10,
      completed_operations: 20,
      failed_operations: 0,
      changed_operations: 20,
      subscription_ready_ms: summarize(Array(20).fill(latency)),
      update_convergence_ms: summarize(Array(400).fill(latency)),
      fanout_completion_ms: summarize(Array(20).fill(latency)),
      cpu_ms_per_operation: 0.1,
      bytes_per_operation: 50,
    },
  };
}

test('checkout revisions and dirty-source identities cannot be mixed in library comparisons', () => {
  const baseline = run();
  baseline.config.adapter = 'composite';
  baseline.metadata.meteorRuntime = {
    kind: 'checkout',
    revision: 'same',
    hash: 'before',
  };
  const target = run();
  target.metadata.meteorRuntime = {
    kind: 'checkout',
    revision: 'same',
    hash: 'after',
  };
  assert.throws(
    () => compareResults([baseline], [target], { mode: 'library' }),
    /Incompatible.*runtime/
  );
  target.metadata.meteorRuntime.hash = 'before';
  assert.doesNotThrow(() =>
    compareResults([baseline], [target], { mode: 'library' })
  );
});

test('missing delivery metrics, missing required metrics, and invalid runs are rejected', () => {
  for (const mutation of [
    (r) => delete r.metrics.app_cpu_ms,
    (r) => delete r.metrics.update_convergence_ms,
    (r) => delete r.metrics.fanout_completion_ms,
    (r) => delete r.metrics.bytes_per_operation,
    (r) => {
      r.metrics.subscription_ready_ms.count = 1;
    },
    (r) => {
      r.metrics.failed_operations = 1;
    },
    (r) => {
      r.status = 'invalid';
    },
    (r) => {
      r.metrics.completed_operations = 1;
    },
  ]) {
    const target = run();
    mutation(target);
    assert.ok(validateResult(target).length);
    assert.throws(
      () => compareResults([run()], [target]),
      /Invalid comparison/
    );
  }
});

test('backend and browser timing regressions use their own metric registries', () => {
  for (const level of ['backend', 'browser']) {
    const create = (latency) => {
      const result = run();
      result.config.level = level;
      if (level === 'backend')
        result.metrics.backend = Object.fromEntries(
          backendNames.map((name) => [name, summarize(Array(20).fill(latency))])
        );
      else result.metrics.browser_data_ms = summarize(Array(20).fill(latency));
      return result;
    };
    const left = Array.from({ length: 5 }, () => create(1));
    const right = Array.from({ length: 5 }, () => create(100));
    assert.equal(compareResults(left, right, { gate: true }).passed, false);
    if (level === 'backend') delete right[0].metrics.backend['data-lookup'];
    else right[0].metrics.browser_data_ms.p95 = null;
    assert.throws(
      () => compareResults(left, right),
      /Missing (backend|browser) measurements/
    );
  }
});

test('sparse tail statistics remain inconclusive across repeated runs', () => {
  const result = run();
  result.config.profile.clients = 1;
  result.metrics.subscription_ready_ms = summarize([100]);
  result.metrics.update_convergence_ms = summarize(Array(20).fill(10));
  const left = Array.from({ length: 5 }, () => structuredClone(result));
  const right = Array.from({ length: 5 }, () => structuredClone(result));
  assert.equal(compareResults(left, right).details[0].status, 'inconclusive');
});

test('tenfold nested latency regression is found, with advisory and explicit gating', () => {
  const left = Array.from({ length: 5 }, () => run());
  const right = Array.from({ length: 5 }, () => run(100));
  const advisory = compareResults(left, right);
  assert.equal(advisory.passed, true);
  assert.equal(
    advisory.details.find((row) => row.metric === 'subscription_ready_ms.p95')
      .status,
    'regression'
  );
  assert.equal(compareResults(left, right, { gate: true }).passed, false);
  assert.equal(
    compareResults([run()], [run(100)], { gate: true }).details[0].status,
    'inconclusive'
  );
});

test('runtime mismatches fail; library mode explicitly permits adapter and package differences', () => {
  const target = run();
  target.metadata.mongo = 'other';
  assert.throws(() => compareResults([run()], [target]), /Incompatible/);
  const composite = run();
  composite.config.adapter = 'composite';
  composite.metadata.packages = 'mongo@1\nreywood:publish-composite@1';
  assert.throws(() => compareResults([run()], [composite]), /Incompatible/);
  assert.equal(
    compareResults([run()], [composite], { mode: 'library' }).passed,
    true
  );
});

test('zero baseline uses an absolute budget and sparse samples suppress p99', () => {
  assert.equal(summarize([1, 2, 3]).p99, null);
  const left = Array.from({ length: 5 }, () => run(0));
  const right = Array.from({ length: 5 }, () => run(3));
  const report = compareResults(left, right, { gate: true });
  assert.equal(report.details[0].percent, null);
  assert.equal(report.passed, false);
});

test('library comparisons reject mixed repetitions and different shared Meteor package versions', () => {
  const baseline = run();
  const composite = run();
  composite.config.adapter = 'composite';
  composite.metadata.packages = 'mongo@2\nreywood:publish-composite@1.9.0';
  assert.throws(
    () => compareResults([baseline], [composite], { mode: 'library' }),
    /shared Meteor package version/
  );
  composite.metadata.packages = 'mongo@1\nreywood:publish-composite@1.9.0';
  const changed = structuredClone(composite);
  changed.metadata.packages = 'mongo@1\nreywood:publish-composite@1.8.12';
  assert.throws(
    () =>
      compareResults([baseline, baseline], [composite, changed], {
        mode: 'library',
      }),
    /identities within repeated runs/
  );
  const edited = structuredClone(baseline);
  edited.metadata.source.hash = 'edit';
  assert.throws(
    () =>
      compareResults([baseline, edited], [composite, composite], {
        mode: 'library',
      }),
    /identities within repeated runs/
  );
});

test('library reports identify lower and higher costs without calling either library a universal winner', () => {
  const left = Array.from({ length: 5 }, () => run(10));
  const higher = Array.from({ length: 5 }, () => run(100));
  const lower = Array.from({ length: 5 }, () => run(1));
  assert.equal(
    compareResults(left, higher, { mode: 'library' }).details[0].effect,
    'higher-cost'
  );
  assert.equal(
    compareResults(left, lower, { mode: 'library' }).details[0].effect,
    'lower-cost'
  );
});

test('heap, GC and event-loop regressions are compared independently of unchanged latency', () => {
  const create = (factor) => {
    const result = run();
    Object.assign(result.metrics, {
      app_heap_used_bytes: 1e7 * factor,
      gc_ms_per_operation: factor,
      event_loop_p95_ms: 10 * factor,
      event_loop_samples: 50,
    });
    return result;
  };
  const report = compareResults(
    Array.from({ length: 5 }, () => create(1)),
    Array.from({ length: 5 }, () => create(10)),
    { mode: 'library' }
  );
  for (const metric of [
    'app_heap_used_bytes',
    'gc_ms_per_operation',
    'event_loop_p95_ms',
  ])
    assert.equal(
      report.details.find((row) => row.metric === metric).effect,
      'higher-cost'
    );
  assert.equal(report.details[0].effect, 'no-clear-difference');
});

test('event-loop p99 needs enough observations in every independent run', () => {
  const left = Array.from({ length: 5 }, () => run());
  const right = Array.from({ length: 5 }, () => run());
  for (const result of [...left, ...right])
    Object.assign(result.metrics, {
      event_loop_p99_ms: 10,
      event_loop_samples: 1000,
    });
  right[0].metrics.event_loop_samples = 100;
  const row = compareResults(left, right).details.find(
    (entry) => entry.metric === 'event_loop_p99_ms'
  );
  assert.equal(row.status, 'inconclusive');
  assert.match(row.reason, /1?000 observations/);
});

test('forced-GC and Mongo profiling settings cannot be mixed with normal measurements', () => {
  for (const config of [
    { retention: { every: 100 } },
    { databaseProfile: true },
    { measurement: 'load', rate: 100 },
  ]) {
    const target = run();
    Object.assign(target.config, config);
    assert.throws(
      () => compareResults([run()], [target], { mode: 'library' }),
      /Incompatible/
    );
  }
});

test('retention permits negative deltas without inventing percentage improvements', () => {
  const create = (growth) => {
    const result = run();
    result.config.retention = { every: 100 };
    result.metrics.retained_heap_growth_bytes = growth;
    return result;
  };
  const report = compareResults(
    Array.from({ length: 5 }, () => create(-2e6)),
    Array.from({ length: 5 }, () => create(5e6)),
    { mode: 'library' }
  );
  assert.equal(report.details[0].effect, 'higher-cost');
  assert.equal(report.details[0].percent, null);
});

test('new collector coverage is mandatory, including cleanup and profiler completeness', () => {
  const result = run();
  result.config.metricsVersion = 2;
  result.config.databaseProfile = true;
  result.config.instrumentation = 'observers';
  const errors = validateResult(result);
  assert.ok(errors.includes('Missing/invalid metric: gc_pause_ms'));
  assert.ok(errors.includes('Missing Mongo profiler coverage'));
  assert.ok(errors.includes('Resource cleanup was not verified'));
});

test('a saturated generator makes client timings inconclusive without suppressing server CPU evidence', () => {
  const left = Array.from({ length: 5 }, () => run());
  const right = Array.from({ length: 5 }, () => run(100));
  for (const value of right) {
    value.phases = { generator: { utilization: 0.95 } };
    value.metrics.cpu_ms_per_operation = 10;
  }
  const report = compareResults(left, right, { mode: 'library' });
  const latency = report.details.find(
    (row) => row.metric === 'update_convergence_ms.p95'
  );
  assert.equal(latency.effect, 'inconclusive');
  assert.match(latency.reason, /harness-limited/);
  assert.equal(
    report.details.find((row) => row.metric === 'cpu_ms_per_operation').effect,
    'higher-cost'
  );
});

test('throughput prefers higher values; event-loop utilization is context rather than a cost ranking', () => {
  const create = (throughput, utilization) => {
    const result = run();
    Object.assign(result.metrics, {
      completed_operations_per_second: throughput,
      event_loop_utilization: utilization,
    });
    return result;
  };
  const left = Array.from({ length: 5 }, () => create(100, 0.8));
  const right = Array.from({ length: 5 }, () => create(10, 0.1));
  const report = compareResults(left, right, { mode: 'library' });
  const throughput = report.details.find(
    (row) => row.metric === 'completed_operations_per_second'
  );
  assert.equal(throughput.effect, 'lower-throughput');
  assert.deepEqual(throughput.interval, [-90, -90]);
  assert.equal(
    report.details.find((row) => row.metric === 'event_loop_utilization')
      .effect,
    'context-only'
  );
});
