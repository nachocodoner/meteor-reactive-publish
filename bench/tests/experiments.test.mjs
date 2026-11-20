import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  experimentPlan,
  experimentJobs,
  runExperiments,
} from '../runner/experiments.mjs';
import {
  collectExperiment,
  writeExperimentReport,
} from '../reporting/experiments.mjs';

const identities = {
  source: { hash: 'source', revision: 'revision' },
  harness: 'harness',
  runtime: { kind: 'release', release: '3.5.2' },
};
async function temporary(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bench-experiments-test-')
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const dependencies = {
  getIdentity: async () => identities,
  sampleHost: async () => ({ time: 'sample' }),
  log() {},
};
const save = async (root, file, value) => {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value));
};

test('focused jobs pin both libraries to one runtime/workload and keep backend warmup separate', () => {
  const plan = experimentPlan({ meteor: '3.5.2' });
  const jobs = experimentJobs(plan, '/tmp/results with spaces');
  assert.equal(jobs.length, 12);
  assert.equal(jobs.filter((job) => job.kind === 'comparison').length, 4);
  for (const job of jobs) {
    const value = (key) => job.args[job.args.indexOf(key) + 1];
    assert.equal(value('--meteor'), '3.5.2');
    assert.equal(value('--operations'), '1000');
    assert.equal(value('--clients'), '25');
    assert.equal(job.args.includes('--warmup'), job.kind !== 'backend');
    if (job.kind === 'comparison') assert.equal(value('--pairs'), '5');
  }
  const checkout = experimentJobs(
    experimentPlan({ meteorCli: '/tmp/meteor checkout/meteor' }),
    '/tmp/results'
  );
  assert.ok(
    checkout.every(
      (job) =>
        !job.args.includes('--meteor') &&
        job.args.includes('/tmp/meteor checkout/meteor')
    )
  );
  assert.throws(
    () => experimentPlan({ meteor: '3.5.2', meteorCli: '/tmp/meteor' }),
    /not both/
  );
});

test('batch continues after individual failures, runs serially and refuses to overwrite evidence', async (t) => {
  const directory = path.join(await temporary(t), 'fresh');
  let calls = 0,
    active = false;
  const state = await runExperiments(
    experimentPlan({ meteor: '3.5.2' }),
    directory,
    {
      ...dependencies,
      report: async () => {},
      execute: async () => {
        assert.equal(active, false);
        active = true;
        await new Promise((resolve) => setImmediate(resolve));
        active = false;
        calls++;
        if (calls === 2) throw new Error('child failed to start');
        return { code: calls === 1 ? 2 : 0 };
      },
    }
  );
  assert.equal(calls, 12);
  assert.equal(state.status, 'completed-with-failures');
  assert.equal(state.jobs[1].error, 'child failed to start');
  assert.equal(state.jobs.at(-1).status, 'complete');
  const before = await fs.readFile(path.join(directory, 'execution.json'));
  await assert.rejects(
    runExperiments(experimentPlan(), directory),
    /fresh output/
  );
  assert.deepEqual(
    await fs.readFile(path.join(directory, 'execution.json')),
    before
  );
});

test('interruption retains state and produces a partial report without starting further jobs', async (t) => {
  const directory = path.join(await temporary(t), 'interrupted');
  const controller = new AbortController();
  let calls = 0;
  const state = await runExperiments(
    experimentPlan({ meteor: '3.5.2' }),
    directory,
    {
      ...dependencies,
      signal: controller.signal,
      execute: async (_job, { signal }) => {
        calls++;
        assert.equal(signal, controller.signal);
        controller.abort('SIGINT');
        return { code: 130 };
      },
    }
  );
  assert.equal(calls, 1);
  assert.equal(state.status, 'interrupted');
  assert.equal(state.jobs[0].status, 'interrupted');
  assert.ok(state.jobs.slice(1).every((job) => job.status === 'not-run'));
  const report = JSON.parse(
    await fs.readFile(path.join(directory, 'summary.json'))
  );
  assert.equal(report.execution.status, 'interrupted');
  assert.equal(report.execution.completedJobs, 0);
  assert.ok(
    (await fs.readFile(path.join(directory, 'index.html'), 'utf8')).includes(
      'Stopped by SIGINT'
    )
  );
});

test('identity changes during a job stop the batch and remain explicit in its report', async (t) => {
  const directory = path.join(await temporary(t), 'changed');
  let changed = false,
    calls = 0;
  const state = await runExperiments(
    experimentPlan({ meteor: '3.5.2' }),
    directory,
    {
      ...dependencies,
      getIdentity: async () => ({
        ...identities,
        harness: changed ? 'changed' : 'harness',
      }),
      execute: async () => {
        calls++;
        changed = true;
        return { code: 0 };
      },
    }
  );
  assert.equal(calls, 1);
  assert.equal(state.status, 'failed');
  assert.match(state.reason, /changed/);
  assert.ok(state.jobs.slice(1).every((job) => job.status === 'not-run'));
});

async function reportFixture(root) {
  const plan = {
    ...experimentPlan({ meteor: '3.5.2' }),
    pairs: 2,
    comparisonScenarios: ['plain-cursor'],
    reactiveSpecificScenarios: [],
    identities,
  };
  await save(root, 'plan.json', plan);
  await save(root, 'execution.json', {
    status: 'interrupted',
    reason: '<script>unsafe</script>',
    jobs: [{ id: 'compare-plain-cursor', status: 'interrupted' }],
  });
  const raw = (cpu) => ({
    status: 'valid',
    correctness: { errors: [] },
    metadata: {
      meteor: '3.5.2',
      node: 'node',
      mongo: 'mongo',
      harness: 'harness',
      source: identities.source,
    },
    metrics: { completed_operations: 1000, cpu_ms_per_operation: cpu },
    phases: { cleanup: { verified: true } },
  });
  for (const [adapter, count] of [
    ['composite', 2],
    ['reactive', 1],
  ])
    for (let i = 0; i < count; i++)
      await save(
        root,
        `comparisons/plain-cursor/${adapter}-${i}.json`,
        raw(i * 2 + 1)
      );
  await save(root, 'comparisons/plain-cursor/report.json', {
    status: 'interrupted',
    cases: [
      {
        comparisons: [{ status: 'blocked', reason: 'incomplete' }],
        adapters: {
          composite: {
            status: 'valid',
            runs: [{ path: 'composite-0.json' }, { path: 'composite-1.json' }],
          },
          reactive: { status: 'not-run', runs: [{ path: 'reactive-0.json' }] },
        },
      },
    ],
  });
  return raw;
}

test('report excludes incomplete variants and invalid backend timings, retains failures and escapes HTML', async (t) => {
  const root = await temporary(t);
  const raw = await reportFixture(root);
  await save(root, 'reactive-only/backend.json', {
    ...raw(1),
    status: 'invalid',
    correctness: { errors: ['Timeout'] },
    metrics: { backend: { bogus: { count: 1000, mean: 1, p95: 1 } } },
  });
  const summary = await writeExperimentReport(root);
  assert.equal(summary.totalRuns, 4);
  assert.equal(summary.validRuns, 3);
  assert.equal(summary.comparisonRows[0].metrics.cpu_ms_per_operation.mean, 2);
  assert.equal(
    summary.comparisonRows[0].metrics.cpu_ms_per_operation.sd,
    Math.sqrt(2)
  );
  assert.deepEqual(summary.comparisonRows[1].metrics, {});
  assert.equal(summary.errors[0].errors[0], 'Timeout');
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /&lt;script&gt;unsafe/);
  assert.doesNotMatch(html, /<script>|bogus/);
});

test('report refuses mixed recorded runtime or harness evidence', async (t) => {
  const root = await temporary(t);
  const raw = await reportFixture(root);
  for (const [key, value, message] of [
    ['meteor', '3.3.2', 'Meteor release differs'],
    ['harness', 'changed', 'Harness differs'],
  ]) {
    const run = raw(1);
    run.metadata[key] = value;
    await save(root, 'comparisons/plain-cursor/reactive-0.json', run);
    await assert.rejects(collectExperiment(root), new RegExp(message));
  }
});
