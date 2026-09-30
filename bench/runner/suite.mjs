import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scenarios } from '../scenarios/index.mjs';
import { benchRoot, runtimeLock } from './build.mjs';
import { interruption } from './process.mjs';
import { runBenchmark } from './run.mjs';
import { compareResults, validateResult } from '../reporting/results.mjs';
import { suiteMarkdown, suiteHtml, suiteTotals } from '../reporting/suite.mjs';

export function suiteCases({ browser = false } = {}) {
  return [
    ...Object.entries(scenarios).map(([id, scenario]) => ({
      id,
      scenario: id,
      level: 'ddp',
      description: scenario.description,
      adapters: scenario.adapters,
      enabled: true,
    })),
    {
      id: 'backend',
      scenario: 'plain-cursor',
      level: 'backend',
      description:
        'AsyncTracker, ReactiveVarAsync, cursor churn, ComputedField, and DataLookup inside Meteor.',
      adapters: ['reactive'],
      enabled: true,
    },
    {
      id: 'browser',
      scenario: 'subscription-data',
      level: 'browser',
      description: 'Actual Meteor browser client subscription-data validation.',
      adapters: ['reactive'],
      enabled: browser,
      skipReason: 'Enable with --browser; Chrome is required.',
    },
  ];
}

function comparisonPairs(adapters) {
  const pairs = [];
  if (adapters.includes('composite') && adapters.includes('reactive'))
    pairs.push(['composite', 'reactive']);
  if (adapters.includes('native')) {
    for (const adapter of adapters.filter((name) => name !== 'native'))
      pairs.push(['native', adapter]);
  }
  return pairs;
}

export async function runSuite(
  options,
  execute = runBenchmark,
  getInterruption = interruption
) {
  const pairs = options.pairs ?? 1;
  if (!Number.isSafeInteger(pairs) || pairs < 1)
    throw new Error('pairs must be a positive integer');
  const directory = path.resolve(
    options.output || path.join(benchRoot, 'results', `all-${randomUUID()}`)
  );
  await fs.mkdir(directory, { recursive: true });
  const report = {
    schemaVersion: 1,
    kind: options.comprehensive ? 'comprehensive-comparison' : 'full-suite',
    status: 'running',
    passed: false,
    createdAt: new Date().toISOString(),
    requestedPairs: pairs,
    compositeVersion: runtimeLock.composite,
    config: {
      meteor:
        options.meteor || (options.meteorCli ? 'checkout' : runtimeLock.meteor),
      meteorCli: options.meteorCli || null,
      seed: options.seed ?? 1,
      profile: options.profile,
      instrumentation: options.instrumentation || 'observers',
      fanoutRate: options.rate || 0,
      browser: !!options.browser,
      comprehensive: options.comprehensive || null,
    },
    cases: (options.caseDefinitions || suiteCases(options)).map((entry) => ({
      ...entry,
      status: entry.enabled ? 'pending' : 'skipped',
      comparisons: [],
      adapters: Object.fromEntries(
        entry.adapters.map((name) => [
          name,
          {
            status: entry.enabled ? 'pending' : 'skipped',
            runs: [],
            errors: [],
          },
        ])
      ),
    })),
  };
  const persist = async () => {
    report.totals = suiteTotals(report);
    const outputs = {
      'report.json': JSON.stringify(report, null, 2) + '\n',
      'report.md': suiteMarkdown(report),
      'report.html': suiteHtml(report),
    };
    for (const [file, content] of Object.entries(outputs)) {
      const temporary = path.join(directory, `${file}.tmp`);
      await fs.writeFile(temporary, content);
      await fs.rename(temporary, path.join(directory, file));
    }
  };
  const rebuilt = new Set();
  const identities = new Map();
  await persist();
  for (const entry of report.cases) {
    if (!entry.enabled) continue;
    if (getInterruption()) break;
    entry.status = 'running';
    const adapters = Object.keys(entry.adapters);
    const results = Object.fromEntries(adapters.map((name) => [name, []]));
    const caseDirectory = path.join(directory, entry.id);
    await fs.mkdir(caseDirectory, { recursive: true });
    for (let pair = 0; pair < pairs; pair++) {
      for (const adapter of pair % 2 ? [...adapters].reverse() : adapters) {
        if (getInterruption()) break;
        const variant = entry.adapters[adapter];
        // A failed repetition is retained and disqualifies this variant. Other
        // variants continue, so a failure cannot suppress independent controls.
        if (variant.status === 'invalid') continue;
        variant.status = 'running';
        const relative = `${entry.id}/${adapter}-${pair}.json`;
        const record = {
          pair,
          status: 'invalid',
          path: null,
          errors: [],
          metrics: {},
        };
        const rebuild = options.rebuild && !rebuilt.has(adapter);
        rebuilt.add(adapter);
        try {
          const { result } = await execute({
            ...options,
            ...entry.run,
            scenario: entry.scenario,
            adapter,
            level: entry.level === 'ddp' ? undefined : entry.level,
            rate: entry.run?.rate ?? (entry.id === 'fanout' ? options.rate : 0),
            output: path.join(directory, relative),
            rebuild,
          });
          results[adapter].push(result);
          if (result.metadata?.meteorRuntime) {
            report.config.meteor = result.metadata.meteor;
            report.config.meteorRuntime = result.metadata.meteorRuntime;
          }
          record.path = relative;
          record.metrics = result.metrics;
          record.load = result.load;
          record.retention = result.samples?.retention;
          record.generator = result.phases?.generator;
          record.failure = result.phases?.failure;
          record.failureProgress = result.phases?.failureProgress;
          const errors = validateResult(result);
          if (options.comprehensive && !errors.length) {
            const identity = JSON.stringify({
              harness: result.metadata.harness,
              packages: result.metadata.packages,
              runtime: result.metadata.meteorRuntime,
              source:
                adapter === 'reactive' ? result.metadata.source?.hash : null,
            });
            if (identities.has(adapter) && identities.get(adapter) !== identity)
              errors.push(
                'Source, runtime, packages or harness changed during the comprehensive suite'
              );
            else identities.set(adapter, identity);
          }
          record.errors = errors.length
            ? result.correctness?.errors?.length
              ? result.correctness.errors
              : errors
            : [];
          record.status = errors.length ? 'invalid' : 'valid';
        } catch (error) {
          record.errors.push(error.message);
        }
        variant.runs.push(record);
        variant.errors.push(
          ...record.errors.map((message) => `Run ${pair + 1}: ${message}`)
        );
        variant.status =
          record.status === 'invalid'
            ? 'invalid'
            : pair === pairs - 1
              ? 'valid'
              : 'running';
        await persist();
      }
      if (getInterruption()) break;
      // In the library-only mode keep both sides of a failed pair, then move
      // to the next case. Never collect a cherry-picked set of passing pairs.
      if (
        options.comprehensive &&
        Object.values(entry.adapters).some(
          (variant) => variant.status === 'invalid'
        )
      )
        break;
    }
    for (const [adapter, variant] of Object.entries(entry.adapters)) {
      if (['pending', 'running'].includes(variant.status))
        variant.status = 'not-run';
      await fs.writeFile(
        path.join(caseDirectory, `${adapter}.json`),
        JSON.stringify(
          {
            runs: variant.runs
              .filter((run) => run.path)
              .map((run) => path.basename(run.path)),
          },
          null,
          2
        ) + '\n'
      );
    }
    if (entry.level === 'ddp')
      for (const [baseline, target] of comparisonPairs(adapters)) {
        const comparison = { baseline, target, status: 'blocked' };
        if (
          entry.adapters[baseline].status === 'valid' &&
          entry.adapters[target].status === 'valid'
        ) {
          try {
            comparison.report = compareResults(
              results[baseline],
              results[target],
              { mode: 'library' }
            );
            comparison.status = 'compared';
          } catch (error) {
            comparison.reason = error.message;
          }
        } else
          comparison.reason =
            'Both variants must complete every requested repetition with valid data.';
        entry.comparisons.push(comparison);
      }
    entry.status =
      Object.values(entry.adapters).every(
        (variant) => variant.status === 'valid'
      ) &&
      entry.comparisons.every((comparison) => comparison.status === 'compared')
        ? 'valid'
        : 'invalid';
    await persist();
    console.error(`[all] ${entry.id}: ${entry.status}`);
  }
  const signal = getInterruption();
  for (const entry of report.cases) {
    if (['pending', 'running'].includes(entry.status)) entry.status = 'not-run';
    for (const variant of Object.values(entry.adapters))
      if (['pending', 'running'].includes(variant.status))
        variant.status = 'not-run';
  }
  report.passed =
    !signal &&
    report.cases.every((entry) => ['valid', 'skipped'].includes(entry.status));
  report.status = signal
    ? 'interrupted'
    : report.passed
      ? 'complete'
      : 'completed-with-failures';
  if (signal) report.interruptedBy = signal;
  report.finishedAt = new Date().toISOString();
  await persist();
  return { report, directory };
}
