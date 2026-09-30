import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSuite, suiteCases } from '../runner/suite.mjs';
import { scenarios } from '../scenarios/index.mjs';
import { summarize, backendNames } from '../reporting/results.mjs';

const profile = {
  clients: 1,
  parents: 2,
  children: 1,
  operations: 2,
  warmup: 0,
  timeout: 100,
  observation: 1,
};
function fakeResult(options) {
  const metrics = {
    app_cpu_ms: 2,
    app_rss_bytes: 1e8,
    ddp_payload_bytes: 100,
    ddp_messages: 10,
    completed_operations: 2,
    failed_operations: 0,
    changed_operations: 2,
    subscription_ready_ms: summarize(
      Array(options.scenario === 'subscription-churn' ? 3 : 1).fill(1)
    ),
    update_convergence_ms: summarize([1, 1]),
    fanout_completion_ms: summarize([1, 1]),
    cpu_ms_per_operation: 1,
    bytes_per_operation: 50,
  };
  if (options.level === 'backend')
    metrics.backend = Object.fromEntries(
      backendNames.map((name) => [name, summarize([1, 1])])
    );
  if (options.level === 'browser') metrics.browser_data_ms = summarize([1, 1]);
  return {
    schemaVersion: 1,
    status: 'valid',
    correctness: { passed: true, errors: [] },
    config: {
      scenario: options.scenario,
      adapter: options.adapter,
      profile,
      level: options.level || 'ddp',
      rate: options.rate || 0,
    },
    metadata: {
      harness: 'h',
      fixture: 'f',
      meteor: '3.3.2',
      node: 'v22',
      mongo: '7',
      hardware: 'same',
      source: { hash: 'source' },
      packages: `mongo@1\n${options.adapter === 'composite' ? 'reywood:publish-composite@1.9.0' : ['reactive', 'installed'].includes(options.adapter) ? 'nachocodoner:reactive-publish@1.1.1' : ''}`,
    },
    metrics,
  };
}
async function writeResult(options) {
  const result = fakeResult(options);
  await fs.writeFile(options.output, JSON.stringify(result));
  return { result };
}

test('full suite enumerates every declared scenario/adapter and explicit diagnostic coverage', () => {
  const plan = suiteCases();
  const ddp = plan.filter((entry) => entry.level === 'ddp');
  assert.deepEqual(
    ddp
      .flatMap((entry) =>
        entry.adapters.map((adapter) => `${entry.scenario}/${adapter}`)
      )
      .sort(),
    Object.entries(scenarios)
      .flatMap(([name, scenario]) =>
        scenario.adapters.map((adapter) => `${name}/${adapter}`)
      )
      .sort()
  );
  assert.equal(plan.find((entry) => entry.id === 'backend').enabled, true);
  assert.equal(plan.find((entry) => entry.id === 'browser').enabled, false);
  assert.equal(suiteCases({ browser: true }).at(-1).enabled, true);
});

test('full execution alternates all adapters, applies offered rate only to fanout, and saves usable reports', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-suite-test-'));
  const calls = [];
  try {
    const { report } = await runSuite(
      { profile, output, pairs: 2, rate: 20, browser: true },
      async (options) => {
        calls.push(options);
        return writeResult(options);
      }
    );
    assert.equal(report.status, 'complete');
    const expected =
      suiteCases({ browser: true }).reduce(
        (count, entry) => count + entry.adapters.length,
        0
      ) * 2;
    assert.equal(calls.length, expected);
    assert.deepEqual(
      calls
        .filter((call) => !call.level && call.scenario === 'plain-cursor')
        .map((call) => call.adapter),
      [
        'native',
        'installed',
        'reactive',
        'composite',
        'composite',
        'reactive',
        'installed',
        'native',
      ]
    );
    assert.ok(
      calls.every(
        (call) => (call.rate || 0) === (call.scenario === 'fanout' ? 20 : 0)
      )
    );
    assert.equal(report.totals.skippedVariants, 0);
    assert.ok(report.totals.compared > 9);
    assert.equal(report.totals.blocked, 0);
    for (const extension of ['json', 'md', 'html'])
      assert.ok(
        (await fs.stat(path.join(output, `report.${extension}`))).size > 0
      );
    const manifest = JSON.parse(
      await fs.readFile(path.join(output, 'plain-cursor/native.json'))
    );
    assert.deepEqual(manifest.runs, ['native-0.json', 'native-1.json']);
    const html = await fs.readFile(path.join(output, 'report.html'), 'utf8');
    assert.match(html, /href="plain-cursor\/native-0.json"/);
    assert.match(html, /backend.dependency-fanout/);
    assert.match(html, /browser_data_ms/);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('execution failure is retained, independent variants finish, and partial reports survive', async () => {
  const output = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bench-suite-invalid-')
  );
  const calls = [];
  try {
    const { report } = await runSuite(
      { profile, output, pairs: 2 },
      async (options) => {
        calls.push(options);
        const partial = JSON.parse(
          await fs.readFile(path.join(output, 'report.json'))
        );
        assert.equal(partial.status, 'running');
        if (
          options.scenario === 'plain-cursor' &&
          !options.level &&
          options.adapter === 'reactive'
        )
          throw new Error('<script>alert("failure")</script>');
        return writeResult(options);
      }
    );
    assert.equal(report.status, 'completed-with-failures');
    assert.equal(report.passed, false);
    const cursor = report.cases.find((entry) => entry.id === 'plain-cursor');
    assert.equal(cursor.adapters.reactive.runs.length, 1);
    assert.equal(cursor.adapters.native.runs.length, 2);
    assert.equal(
      cursor.comparisons.find((comparison) => comparison.target === 'installed')
        .status,
      'compared'
    );
    assert.equal(
      cursor.comparisons.find(
        (comparison) => comparison.baseline === 'composite'
      ).status,
      'blocked'
    );
    assert.equal(
      report.cases.find((entry) => entry.id === 'backend').status,
      'valid'
    );
    const html = await fs.readFile(path.join(output, 'report.html'), 'utf8');
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(report.totals.skippedVariants, 1);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('interruption preserves completed runs and marks unexecuted work without claiming completion', async () => {
  const output = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bench-suite-interrupted-')
  );
  let stopped = false;
  try {
    const { report } = await runSuite(
      { profile, output, pairs: 2 },
      async (options) => {
        const result = await writeResult(options);
        stopped = true;
        return result;
      },
      () => (stopped ? 'SIGTERM' : undefined)
    );
    assert.equal(report.status, 'interrupted');
    assert.equal(report.passed, false);
    assert.equal(report.totals.attemptedRuns, 1);
    assert.equal(
      report.cases.find((entry) => entry.id === 'backend').status,
      'not-run'
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(output, 'report.json')))
        .interruptedBy,
      'SIGTERM'
    );
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
