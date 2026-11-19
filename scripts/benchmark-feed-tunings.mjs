import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from '../bench/runner/build.mjs';
import { installSignalCleanup } from '../bench/runner/process.mjs';
import { runBenchmark } from '../bench/runner/run.mjs';
import { runtimeOptions } from '../bench/runner/runtime.mjs';
import { summarize } from '../bench/reporting/results.mjs';

const { values } = parseArgs({
  options: {
    pairs: { type: 'string', default: '5' },
    meteor: { type: 'string', default: '3.6' },
    output: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(
    'node scripts/benchmark-feed-tunings.mjs [--pairs 5] [--meteor 3.6] [--output bench/results/feed-tunings]'
  );
  process.exit(0);
}
const pairs = Number(values.pairs);
if (!Number.isSafeInteger(pairs) || pairs < 1)
  throw new Error('--pairs must be a positive integer');
const runtime = runtimeOptions({ meteor: values.meteor });
const directory = path.resolve(
  values.output ?? path.join(repoRoot, 'bench', 'results', 'feed-tunings')
);
// Exclusive creation keeps completed and interrupted series available.
await fs.mkdir(path.dirname(directory), { recursive: true });
await fs.mkdir(directory);
installSignalCleanup();

const profile = {
  clients: 4,
  parents: 200,
  children: 4,
  warmup: 12,
  operations: 120,
  observation: 40,
  timeout: 30000,
};
const variants = [
  { name: 'none', parentProjection: false, filterEquality: false },
  { name: 'parent-ids', parentProjection: true, filterEquality: false },
  { name: 'filter-equality', parentProjection: false, filterEquality: true },
  { name: 'both', parentProjection: true, filterEquality: true },
];
const runs = [];
let reference;
for (let round = 0; round < pairs; round++) {
  const first = round % variants.length;
  const order = [...variants.slice(first), ...variants.slice(0, first)];
  for (const { name, parentProjection, filterEquality } of order) {
    const file = `round-${round + 1}-${name}.json`;
    const { result } = await runBenchmark({
      ...runtime,
      source: repoRoot,
      scenario: 'filtered-comments',
      adapter: 'reactive',
      seed: 1,
      instrumentation: 'observers',
      profile,
      parentProjection,
      filterEquality,
      output: path.join(directory, file),
    });
    if (
      result.status !== 'valid' ||
      !result.correctness.passed ||
      !result.phases.cleanup?.verified
    )
      throw new Error(
        `Run failed data or cleanup checks. See ${path.join(directory, file)}`
      );
    assert.equal(result.config.parentProjection, parentProjection);
    assert.equal(result.config.filterEquality, filterEquality);
    const { metadata, metrics } = result;
    const common = {
      source: metadata.source.hash,
      harness: metadata.harness,
      build: metadata.buildKey,
      fixture: metadata.fixture,
      ddpMessages: metrics.ddp_messages,
      ddpBytes: metrics.ddp_payload_bytes,
      changedOperations: metrics.changed_operations,
    };
    reference ??= common;
    assert.deepEqual(
      common,
      reference,
      `Different source, build, fixture or client traffic in ${file}`
    );
    assert.equal(metrics.completed_operations, profile.operations);
    assert.equal(
      metrics.update_convergence_ms.count,
      metrics.changed_operations * profile.clients
    );
    assert.equal(
      result.samples.noOutputObservation.length,
      profile.operations - metrics.changed_operations
    );
    runs.push({
      name,
      file,
      cpuMs: metrics.cpu_ms_per_operation,
      autoruns: metrics.computation_runs,
      changedUpdateP95Ms:
        metrics.update_convergence_ms.count >= 20
          ? metrics.update_convergence_ms.p95
          : null,
    });
  }
}
const summary = variants.map(({ name }) => {
  const mode = runs.filter((run) => run.name === name);
  return {
    mode: name,
    meanCpuMsPerWrite: summarize(mode.map((run) => run.cpuMs)).mean,
    meanAutorunsPerRun: summarize(mode.map((run) => run.autoruns)).mean,
    meanChangedUpdateP95Ms: mode.every((run) => run.changedUpdateP95Ms !== null)
      ? summarize(mode.map((run) => run.changedUpdateP95Ms)).mean
      : null,
  };
});
const note =
  (pairs === 1
    ? 'One run per mode. Timing differences are exploratory. '
    : '') +
  'Means are across fresh runs. Update p95 includes only changes to client-visible documents. Writes with identical client output are verified separately.';
const report = {
  meteor: values.meteor,
  seed: 1,
  pairs,
  profile,
  ...reference,
  note,
  summary,
  runs,
};
await fs.writeFile(
  path.join(directory, 'comparison.json'),
  JSON.stringify(report, null, 2) + '\n'
);
console.table(summary);
console.log(note, path.join(directory, 'comparison.json'));
