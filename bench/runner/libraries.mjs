import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { benchRoot, runtimeLock } from './build.mjs';
import { runBenchmark } from './run.mjs';
import {
  compareResults,
  comparisonMarkdown,
  validateResult,
} from '../reporting/results.mjs';
import {
  comparisonCases,
  excludedLibraryCases,
  libraryAdapters,
} from '../config/comparisons.mjs';

export function libraryReportMarkdown(report) {
  const lines = [
    '# Library comparison',
    '',
    `publish-composite ${report.compositeVersion} versus local reactive-publish; ${report.requestedPairs} requested pair(s) per case.`,
    '',
    `Meteor ${report.config.meteor}; seed ${report.config.seed}; ${report.config.profile?.clients ?? '?'} clients, ${report.config.profile?.parents ?? '?'} parents, ${report.config.profile?.children ?? '?'} children per parent, ${report.config.profile?.operations ?? '?'} measured operations per run.`,
    '',
    'The left column is publish-composite; the right is reactive-publish. Positive changes mean the metric increased: lower costs and higher throughput are preferable; utilization is contextual. Only cases where every attempted run is valid receive a comparison. This report does not select a universal winner.',
    '',
    '| Scenario | Composite valid/attempted | Reactive valid/attempted | Comparison |',
    '| --- | ---: | ---: | --- |',
    ...report.cases.map(
      (entry) =>
        `| ${entry.scenario} | ${entry.adapters.composite.valid}/${entry.adapters.composite.attempted} | ${entry.adapters.reactive.valid}/${entry.adapters.reactive.attempted} | ${entry.status} |`
    ),
    '',
  ];
  for (const entry of report.cases) {
    lines.push(`## ${entry.scenario}`, '', entry.contract, '');
    for (const adapter of libraryAdapters) {
      const summary = entry.adapters[adapter];
      lines.push(
        `${adapter}: ${summary.paths.map((file, i) => `[run ${i + 1}](${file})`).join(', ') || 'no runs'}.`,
        ''
      );
    }
    if (entry.comparison)
      lines.push(
        comparisonMarkdown(entry.comparison, {
          baselineLabel: `publish-composite ${report.compositeVersion}`,
          targetLabel: 'reactive-publish',
        })
      );
    for (const failure of entry.errors)
      lines.push(`- ${failure.replaceAll('\n', ' ').replaceAll('|', '\\|')}`);
    lines.push('');
  }
  lines.push(
    '## Excluded cases',
    '',
    ...report.excluded.map((entry) => `- ${entry.scenario}: ${entry.reason}`),
    ''
  );
  return lines.join('\n');
}

// An injectable executor allows policy tests without launching fake Meteor apps.
export async function runLibraryComparison(options, execute = runBenchmark) {
  const pairs = options.pairs ?? 1;
  if (!Number.isSafeInteger(pairs) || pairs < 1)
    throw new Error('pairs must be a positive integer');
  const cases = comparisonCases(options);
  const directory = path.resolve(
    options.output ||
      path.join(benchRoot, 'results', `libraries-${randomUUID()}`)
  );
  await fs.mkdir(directory, { recursive: true });
  const report = {
    schemaVersion: 1,
    kind: 'library-comparison',
    createdAt: new Date().toISOString(),
    compositeVersion: runtimeLock.composite,
    requestedPairs: pairs,
    suite: options.suite || 'smoke',
    config: {
      meteor:
        options.meteor || (options.meteorCli ? 'checkout' : runtimeLock.meteor),
      meteorCli: options.meteorCli || null,
      seed: options.seed ?? 1,
      profile: options.profile,
      instrumentation: options.instrumentation || 'observers',
      rate: options.rate || 0,
    },
    status: 'running',
    passed: false,
    cases: [],
    excluded: excludedLibraryCases,
  };
  const persist = async () => {
    await fs.writeFile(
      path.join(directory, 'comparison.json'),
      JSON.stringify(report, null, 2) + '\n'
    );
    await fs.writeFile(
      path.join(directory, 'comparison.md'),
      libraryReportMarkdown(report)
    );
  };
  for (const selected of cases) {
    const entry = {
      ...selected,
      status: 'running',
      errors: [],
      adapters: Object.fromEntries(
        libraryAdapters.map((name) => [
          name,
          { valid: 0, attempted: 0, paths: [] },
        ])
      ),
    };
    report.cases.push(entry);
    const runs = { composite: [], reactive: [] };
    const caseDirectory = path.join(directory, selected.scenario);
    await fs.mkdir(caseDirectory, { recursive: true });
    for (let pair = 0; pair < pairs; pair++) {
      for (const adapter of pair % 2
        ? [...libraryAdapters].reverse()
        : libraryAdapters) {
        const relative = `${selected.scenario}/${adapter}-${pair}.json`;
        const summary = entry.adapters[adapter];
        summary.attempted++;
        try {
          const { result } = await execute({
            ...options,
            ...selected,
            adapter,
            output: path.join(directory, relative),
            rebuild: options.rebuild && pair === 0 && selected === cases[0],
          });
          runs[adapter].push(result);
          if (result.metadata?.meteorRuntime) {
            report.config.meteor = result.metadata.meteor;
            report.config.meteorRuntime = result.metadata.meteorRuntime;
          }
          summary.paths.push(relative);
          const errors = validateResult(result);
          if (errors.length)
            entry.errors.push(
              `${adapter}, pair ${pair + 1}: ${(result.correctness?.errors?.length ? result.correctness.errors : errors).join('; ')}`
            );
          else summary.valid++;
        } catch (error) {
          entry.errors.push(`${adapter}, pair ${pair + 1}: ${error.message}`);
        }
      }
      // Keep both sides of the failed pair. Never discard it and retry to get
      // enough passing samples, and avoid repeated known-invalid timed runs.
      if (entry.errors.length) break;
    }
    for (const adapter of libraryAdapters) {
      await fs.writeFile(
        path.join(caseDirectory, `${adapter}.json`),
        JSON.stringify(
          {
            runs: entry.adapters[adapter].paths.map((file) =>
              path.basename(file)
            ),
          },
          null,
          2
        ) + '\n'
      );
    }
    if (!entry.errors.length) {
      try {
        entry.comparison = compareResults(runs.composite, runs.reactive, {
          mode: 'library',
        });
        entry.status = 'compared';
      } catch (error) {
        entry.errors.push(error.message);
      }
    }
    if (entry.errors.length) entry.status = 'blocked';
    await persist();
  }
  report.passed = report.cases.every((entry) => entry.status === 'compared');
  report.status = report.passed ? 'valid' : 'invalid';
  await persist();
  return { report, directory };
}
