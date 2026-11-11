import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  comparisonCases,
  libraryAdapters,
  excludedLibraryCases,
} from '../config/comparisons.mjs';
import { scenarios } from '../scenarios/index.mjs';
import { runLibraryComparison } from '../runner/libraries.mjs';
import { summarize } from '../reporting/results.mjs';

function resultFor(options) {
  return {
    schemaVersion: 1,
    status: 'valid',
    correctness: { passed: true, errors: [] },
    config: {
      scenario: options.scenario,
      adapter: options.adapter,
      profile: { clients: 20, operations: 20 },
    },
    metadata: {
      harness: 'h',
      fixture: 'f',
      meteor: '3.3.2',
      node: 'v22',
      mongo: '7',
      hardware: 'same',
      source: { hash: 'source' },
      packages: `mongo@2.1.4\n${options.adapter === 'composite' ? 'reywood:publish-composite@1.9.0' : 'nachocodoner:reactive-publish@1.1.1'}`,
    },
    metrics: {
      app_cpu_ms: 2,
      app_rss_bytes: 1e8,
      ddp_payload_bytes: 1000,
      ddp_messages: 10,
      completed_operations: 20,
      failed_operations: 0,
      changed_operations: 20,
      subscription_ready_ms: summarize(
        Array(options.scenario === 'subscription-churn' ? 420 : 20).fill(1)
      ),
      update_convergence_ms: summarize(Array(400).fill(1)),
      fanout_completion_ms: summarize(Array(20).fill(1)),
      cpu_ms_per_operation: 0.1,
      bytes_per_operation: 50,
    },
  };
}

test('compatible suite exactly covers shared adapters and excludes package-specific APIs', () => {
  const expected = Object.entries(scenarios)
    .filter(([, value]) =>
      libraryAdapters.every((adapter) => value.adapters.includes(adapter))
    )
    .map(([name]) => name)
    .sort();
  assert.deepEqual(
    comparisonCases({ suite: 'compatible' })
      .map((entry) => entry.scenario)
      .sort(),
    expected
  );
  assert.ok(
    excludedLibraryCases.some((entry) => entry.scenario === 'subscription-data')
  );
  assert.throws(
    () => comparisonCases({ scenario: 'derived-count' }),
    /does not support/
  );
  assert.throws(
    () => comparisonCases({ suite: 'typo' }),
    /Unknown comparison suite/
  );
});

test('library pairs alternate order and write comparable manifests and labeled reports', async () => {
  const output = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bench-libraries-test-')
  );
  const order = [];
  try {
    const { report } = await runLibraryComparison(
      { scenario: 'sorted-window', pairs: 2, output },
      async (options) => {
        order.push(options.adapter);
        const result = resultFor(options);
        await fs.writeFile(options.output, JSON.stringify(result));
        return { result };
      }
    );
    assert.deepEqual(order, ['composite', 'reactive', 'reactive', 'composite']);
    assert.equal(report.passed, true);
    assert.equal(report.cases[0].comparison.pairs, 2);
    const manifest = JSON.parse(
      await fs.readFile(path.join(output, 'sorted-window/composite.json'))
    );
    assert.deepEqual(manifest.runs, ['composite-0.json', 'composite-1.json']);
    const markdown = await fs.readFile(
      path.join(output, 'comparison.md'),
      'utf8'
    );
    assert.match(markdown, /publish-composite 1.9.0 \| reactive-publish/);
    assert.match(markdown, /inconclusive/);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('failed pairs block timing comparison without retrying or dropping other cases', async () => {
  const output = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bench-libraries-invalid-')
  );
  const calls = [];
  try {
    const { report } = await runLibraryComparison(
      { suite: 'smoke', pairs: 3, output },
      async (options) => {
        calls.push(`${options.scenario}/${options.adapter}`);
        const result = resultFor(options);
        if (
          options.scenario === 'sorted-window' &&
          options.adapter === 'reactive'
        ) {
          result.status = 'invalid';
          result.correctness = {
            passed: false,
            errors: ['Missing child document'],
          };
        }
        return { result };
      }
    );
    assert.equal(report.passed, false);
    assert.equal(report.status, 'invalid');
    assert.equal(
      calls.filter((name) => name.startsWith('sorted-window/')).length,
      2
    );
    assert.equal(report.cases[0].status, 'blocked');
    assert.equal(report.cases[0].comparison, undefined);
    assert.equal(report.cases[1].status, 'compared');
    assert.equal(report.cases[2].status, 'compared');
    assert.match(
      await fs.readFile(path.join(output, 'comparison.md'), 'utf8'),
      /Missing child document/
    );
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
