import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { comprehensivePlan } from '../config/comprehensive.mjs';
import { runSuite } from '../runner/suite.mjs';
import { summarize } from '../reporting/results.mjs';
import { retentionSummary } from '../reporting/retention.mjs';
import {
  aggregateQueries,
  parseProcStat,
} from '../runner/database-metrics.mjs';

test('comprehensive defaults use substantial independent repetitions and exactly matched contracts', () => {
  const plan = comprehensivePlan();
  assert.equal(plan.pairs, 5);
  assert.equal(plan.profile.operations, 1000);
  assert.equal(plan.profile.warmup, 100);
  assert.equal(plan.cases.filter((entry) => entry.stage === 'core').length, 9);
  for (const entry of plan.cases) {
    assert.deepEqual(entry.adapters, ['composite', 'reactive']);
    assert.equal(entry.run.databaseMetrics, true);
    assert.equal(!!entry.run.databaseProfile, entry.stage === 'queries');
    assert.equal(!!entry.run.retention, entry.stage === 'retention');
    if (entry.stage === 'load') {
      assert.ok(entry.run.profile.operations >= 1000);
      assert.ok(
        (entry.run.profile.operations - 1) / entry.run.rate >=
          entry.run.duration
      );
    }
  }
  assert.equal(comprehensivePlan({ preset: 'quick' }).pairs, 1);
});

test('presets support focused stages and reject empty or incomparable experiments', () => {
  assert.equal(
    comprehensivePlan({
      scenario: 'deep-join',
      stages: 'core',
      pairs: '7',
      operations: '3000',
    }).maximumRuns,
    14
  );
  for (const values of [
    { rates: '0' },
    { rates: '10,10' },
    { pairs: '0' },
    { duration: '-1' },
    { stages: 'typo' },
    { stages: 'core,core' },
    { scenario: 'derived-count' },
    { stages: 'retention', scenario: 'deep-join' },
    { 'retention-every': '10000' },
  ]) {
    assert.throws(() => comprehensivePlan(values));
  }
});

test('retention slope preserves negative growth and detects bounded versus linear retention', () => {
  const samples = (slope) =>
    Array.from({ length: 6 }, (_, i) => ({
      cycle: i * 100,
      heapUsed: 1e7 + slope * i * 100,
      rss: 2e7,
      external: 1e6,
      arrayBuffers: 1e5,
    }));
  assert.equal(
    retentionSummary(samples(0)).retained_heap_slope_bytes_per_100_cycles,
    0
  );
  assert.equal(
    retentionSummary(samples(100)).retained_heap_slope_bytes_per_100_cycles,
    10000
  );
  assert.equal(
    retentionSummary(samples(-10)).retained_heap_growth_bytes,
    -5000
  );
  assert.throws(() => retentionSummary([samples(1)[0]]), /baseline and final/);
});

test('Mongo process accounting parses comm safely and profiler excludes control namespaces', () => {
  const fields = Array(22).fill('0');
  fields[0] = 'S';
  fields[11] = '200';
  fields[12] = '50';
  fields[19] = '123';
  fields[21] = '100';
  assert.deepEqual(
    parseProcStat(`123 (mongo (db)) ${fields.join(' ')}`, 100, 4096),
    { cpu_ms: 2500, rss_bytes: 409600, start_ticks: 123 }
  );
  const queries = aggregateQueries([
    {
      ns: 'bench.bench_posts',
      op: 'query',
      docsExamined: 100,
      keysExamined: 0,
      planSummary: 'COLLSCAN',
      millis: 2,
    },
    {
      ns: 'bench.bench_comments',
      op: 'command',
      command: { find: 'bench_comments' },
      docsExamined: 2,
      keysExamined: 2,
      nreturned: 2,
    },
    { ns: 'bench.__profile_marker', op: 'insert', docsExamined: 10000 },
    { ns: 'local.oplog.rs', op: 'getmore', docsExamined: 10000 },
  ]);
  assert.equal(queries.operations, 2);
  assert.equal(queries.read_operations, 2);
  assert.equal(queries.docs_examined, 102);
  assert.equal(queries.collection_scans, 1);
});

function fake(options) {
  const profile = options.profile;
  return {
    schemaVersion: 1,
    status: 'valid',
    correctness: { passed: true, errors: [] },
    config: {
      scenario: options.scenario,
      adapter: options.adapter,
      profile,
      measurement: options.measurement,
      rate: options.rate,
      databaseProfile: options.databaseProfile || false,
    },
    metadata: {
      harness: 'h',
      fixture: 'f',
      meteor: '3',
      node: '22',
      mongo: '7',
      hardware: 'same',
      source: { hash: 'source' },
      packages: `mongo@1\n${options.adapter === 'composite' ? 'reywood:publish-composite@1.9.0' : 'nachocodoner:reactive-publish@1'}`,
    },
    metrics: {
      app_cpu_ms: 10,
      app_rss_bytes: 1e8,
      completed_operations: profile.operations,
      failed_operations: 0,
      changed_operations: profile.operations,
      ddp_payload_bytes: 100,
      ddp_messages: 5,
      cpu_ms_per_operation: 1,
      bytes_per_operation: 10,
      subscription_ready_ms: summarize(Array(profile.clients).fill(1)),
      update_convergence_ms: summarize(
        Array(profile.clients * profile.operations).fill(1)
      ),
      fanout_completion_ms: summarize(Array(profile.operations).fill(1)),
    },
  };
}

test('comprehensive execution preserves paired settings, alternates order, and stops both sides after a failure', async () => {
  const output = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bench-comprehensive-')
  );
  const plan = comprehensivePlan({
    preset: 'quick',
    scenario: 'sorted-window',
    stages: 'core,queries',
    pairs: '2',
  });
  const calls = [];
  try {
    const { report } = await runSuite(
      {
        profile: plan.profile,
        pairs: plan.pairs,
        output,
        comprehensive: {
          preset: plan.preset,
          stages: plan.stages,
          note: plan.note,
        },
        caseDefinitions: plan.cases,
      },
      async (options) => {
        calls.push(options);
        const result = fake(options);
        if (
          options.measurement === 'queries' &&
          options.adapter === 'composite'
        ) {
          result.status = 'invalid';
          result.correctness.passed = false;
          result.correctness.errors.push('Profiler coverage lost');
          result.phases = {
            failureProgress: {
              completed: 10,
              requested: 20,
              phase: 'operations',
            },
            failure: {
              app_cpu_ms: 500,
              app_rss_bytes: 128 * 1024 * 1024,
              event_loop_p99_ms: 30,
            },
            generator: { utilization: 0.1, scheduling_lag_ms: { p95: 0.5 } },
          };
        }
        await fs.writeFile(options.output, JSON.stringify(result));
        return { result };
      }
    );
    assert.deepEqual(
      calls.map((call) => `${call.measurement}/${call.adapter}`),
      [
        'core/composite',
        'core/reactive',
        'core/reactive',
        'core/composite',
        'queries/composite',
        'queries/reactive',
      ]
    );
    assert.deepEqual(calls[0].profile, calls[1].profile);
    assert.deepEqual(calls[4].profile, calls[5].profile);
    assert.equal(report.cases[0].comparisons[0].status, 'compared');
    assert.equal(report.cases[1].comparisons[0].status, 'blocked');
    assert.equal(report.passed, false);
    const html = await fs.readFile(path.join(output, 'report.html'), 'utf8');
    assert.match(html, /Mongo profiling enabled/);
    assert.match(html, /Profiler coverage lost/);
    assert.match(html, /Partial failed-run diagnostics/);
    assert.equal(
      report.cases[1].adapters.composite.runs[0].failureProgress.completed,
      10
    );
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
