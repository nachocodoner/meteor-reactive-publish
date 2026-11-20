import fs from 'node:fs/promises';
import path from 'node:path';
import { runBenchmark } from '../bench/runner/run.mjs';
import { sourceInfo, harnessHash, repoRoot } from '../bench/runner/build.mjs';
import {
  installSignalCleanup,
  interruption,
} from '../bench/runner/process.mjs';
import {
  compareResults,
  comparisonMarkdown,
} from '../bench/reporting/results.mjs';
import { scenarios } from '../bench/scenarios/index.mjs';

installSignalCleanup();
const withoutLifecycle = process.argv.includes('--without-lifecycle');
const originalDirectory = path.join(
  repoRoot,
  'bench/results/exploration-2026-11-12'
);
const directory = withoutLifecycle
  ? `${originalDirectory}-without-lifecycle`
  : originalDirectory;
if (await fs.stat(path.join(directory, 'experiment.json')).catch(() => null)) {
  throw new Error(
    'Experiment already exists; preserve its results before choosing a new output directory.'
  );
}
await fs.mkdir(directory, { recursive: true });
const candidate = path.join(originalDirectory, 'candidate-source');
const baseline = path.join(originalDirectory, 'baseline-source');
const current = await sourceInfo(repoRoot);
if (!withoutLifecycle) {
  await fs.mkdir(candidate, { recursive: true });
  for (const file of [...current.names, '.meteorignore', 'README.md']) {
    await fs.mkdir(path.dirname(path.join(candidate, file)), {
      recursive: true,
    });
    await fs.copyFile(path.join(repoRoot, file), path.join(candidate, file));
  }
  await fs.writeFile(
    path.join(candidate, '.bench-source-revision'),
    current.revision + '\n'
  );
}
const harness = await harnessHash();
const report = {
  startedAt: new Date().toISOString(),
  status: 'running',
  source: current.hash,
  baseline: (await sourceInfo(baseline)).hash,
  harness,
  protocol:
    'Sequential fresh processes; six complete blocks with each of the six arm permutations once. Modes alter rerun semantics explicitly; adapter function bodies and document oracle remain fixed.',
  lifecycle: !withoutLifecycle,
  priorStudy: withoutLifecycle ? originalDirectory : null,
  reason: withoutLifecycle
    ? 'Separate complete series after an invalid upstream wall-clock duration. Original failed series is retained and excluded; optional lifecycle instrumentation is disabled for every arm. All data, observer cleanup and primary timing checks remain enabled.'
    : null,
  jobs: [],
  comparisons: {},
};
const save = () =>
  fs.writeFile(
    path.join(directory, 'experiment.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
const common = {
  meteor: '3.6',
  lifecycle: !withoutLifecycle,
  instrumentation: 'observers',
  source: candidate,
  seed: 1,
};
const smoke = {
  clients: 2,
  parents: 4,
  children: 2,
  operations: 12,
  warmup: 2,
  timeout: 15000,
  observation: 50,
};
const measured = {
  clients: 10,
  parents: 40,
  children: 5,
  operations: 200,
  warmup: 20,
  timeout: 15000,
  observation: 100,
};
async function run(id, options) {
  if (interruption()) throw new Error(`Interrupted: ${interruption()}`);
  if (
    (await sourceInfo(candidate)).hash !== current.hash ||
    (await harnessHash()) !== harness
  )
    throw new Error('Frozen source or harness changed');
  const job = { id, startedAt: new Date().toISOString(), status: 'running' };
  report.jobs.push(job);
  await save();
  console.log('START', id);
  const { result } = await runBenchmark({
    ...common,
    ...options,
    output: path.join(directory, 'runs', id + '.json'),
  });
  Object.assign(job, {
    status: result.status,
    finishedAt: new Date().toISOString(),
    errors: result.correctness.errors,
  });
  await save();
  console.log('END', id, result.status);
  if (result.status !== 'valid')
    throw new Error(
      `Invalid run ${id}: ${result.correctness.errors.join('; ')}`
    );
  return result;
}
try {
  if (!withoutLifecycle) {
    const oldDefault = await run('default-control/baseline', {
      source: baseline,
      adapter: 'reactive',
      cursorDependencies: 'onFind',
      scenario: 'one-to-many',
      profile: smoke,
    });
    const newDefault = await run('default-control/candidate', {
      adapter: 'reactive',
      cursorDependencies: 'onFind',
      scenario: 'one-to-many',
      profile: smoke,
    });
    report.defaultControl = compareResults([oldDefault], [newDefault]);
    for (const [scenario, definition] of Object.entries(scenarios)) {
      if (!definition.adapters.includes('reactive')) continue;
      await run(`read-mode-smoke/${scenario}`, {
        adapter: 'reactive',
        cursorDependencies: 'onRead',
        scenario,
        profile: smoke,
      });
    }
  }
  const arms = {
    composite: { adapter: 'composite', cursorDependencies: 'onFind' },
    default: { adapter: 'reactive', cursorDependencies: 'onFind' },
    reads: { adapter: 'reactive', cursorDependencies: 'onRead' },
  };
  const orders = [
    ['composite', 'default', 'reads'],
    ['reads', 'default', 'composite'],
    ['default', 'reads', 'composite'],
    ['composite', 'reads', 'default'],
    ['reads', 'composite', 'default'],
    ['default', 'composite', 'reads'],
  ];
  for (const scenario of withoutLifecycle
    ? ['deep-join', 'fanout']
    : ['one-to-many', 'deep-join', 'fanout']) {
    const results = { composite: [], default: [], reads: [] };
    for (const [block, order] of orders.entries()) {
      for (const arm of order)
        results[arm].push(
          await run(`measured/${scenario}/${arm}-${block}`, {
            ...arms[arm],
            scenario,
            profile: measured,
          })
        );
    }
    const comparisons = {
      defaultToReads: compareResults(results.default, results.reads, {
        mode: 'cursor-dependencies',
      }),
      compositeToDefault: compareResults(results.composite, results.default, {
        mode: 'library',
      }),
      compositeToReads: compareResults(results.composite, results.reads, {
        mode: 'library',
      }),
    };
    report.comparisons[scenario] = comparisons;
    await fs.writeFile(
      path.join(directory, `${scenario}-comparisons.md`),
      Object.entries(comparisons)
        .map(
          ([name, comparison]) =>
            `# ${scenario}: ${name}\n\n${comparisonMarkdown(comparison)}`
        )
        .join('\n\n')
    );
    await save();
  }
  for (const [arm, options] of Object.entries(arms)) {
    await run(`queries/one-to-many/${arm}`, {
      ...options,
      scenario: 'one-to-many',
      profile: { ...measured, operations: 60 },
      databaseMetrics: true,
      databaseProfile: true,
      measurement: 'queries',
    });
  }
  report.status = 'complete';
} catch (error) {
  report.status = interruption() ? 'interrupted' : 'failed';
  report.error = error.stack;
  process.exitCode = 2;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
}
