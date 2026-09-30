#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { profiles, resolveProfile } from './config/profiles.mjs';
import { scenarios, validateScenario } from './scenarios/index.mjs';
import {
  benchRoot,
  repoRoot,
  buildApp,
  lockVersions,
} from './runner/build.mjs';
import { command, installSignalCleanup } from './runner/process.mjs';
import {
  runtimeOptions,
  resolveMeteorRuntime,
  writeRuntimeRelease,
  runtimeNode,
} from './runner/runtime.mjs';
import { runBenchmark } from './runner/run.mjs';
import { runLibraryComparison } from './runner/libraries.mjs';
import { runSuite } from './runner/suite.mjs';
import { comprehensivePlan } from './config/comprehensive.mjs';
import {
  compareResults,
  comparisonMarkdown,
  validateResult,
} from './reporting/results.mjs';

const stringOptions = [
  'scenario',
  'adapter',
  'profile',
  'source',
  'meteor',
  'meteor-cli',
  'mongod',
  'output',
  'seed',
  'baseline',
  'target',
  'mode',
  'base',
  'pairs',
  'rate',
  'executable',
  'instrumentation',
  'suite',
  'preset',
  'stages',
  'duration',
  'rates',
  'retention-cycles',
  'retention-every',
  'latency-budget',
  ...Object.keys(profiles.smoke),
];
const { values, positionals } = parseArgs({
  options: {
    ...Object.fromEntries(
      stringOptions.map((name) => [name, { type: 'string' }])
    ),
    help: { type: 'boolean', short: 'h' },
    rebuild: { type: 'boolean' },
    gate: { type: 'boolean' },
    browser: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  },
  allowPositionals: true,
  strict: true,
});
installSignalCleanup();

const read = async (file) =>
  JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
async function runsFrom(file) {
  const data = await read(file);
  if (data.runs)
    return Promise.all(
      data.runs.map((name) => read(path.resolve(path.dirname(file), name)))
    );
  if (data.result) return [data.result];
  return [data];
}

let selectedRuntime;
function runOptions({ allowFanoutRate = false } = {}) {
  const seed = Number(values.seed ?? 1);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('seed must be an unsigned 32-bit integer');
  const rate = Number(values.rate || 0);
  if (!Number.isFinite(rate) || rate < 0)
    throw new Error('rate must be nonnegative writes per second');
  if (rate && values.scenario !== 'fanout' && !allowFanoutRate)
    throw new Error('--rate requires --scenario fanout');
  if (
    values.instrumentation &&
    !['basic', 'observers'].includes(values.instrumentation)
  )
    throw new Error('instrumentation must be basic or observers');
  return {
    scenario: values.scenario || 'plain-cursor',
    adapter: values.adapter || 'reactive',
    profile: resolveProfile(values.profile || 'smoke', values),
    source: path.resolve(values.source || repoRoot),
    seed,
    ...runtimeOptions({
      meteor: values.meteor,
      meteorCli: values['meteor-cli'],
    }),
    expectedRuntime: selectedRuntime?.identity,
    mongod: values.mongod,
    output: values.output,
    rebuild: values.rebuild,
    rate,
    executable: values.executable,
    instrumentation: values.instrumentation || 'observers',
  };
}

async function main() {
  const action = positionals[0] || 'help';
  if (values.help || action === 'help') {
    console.log(`Reactive publish benchmarks

  npm run bench -- doctor
  npm run bench -- doctor --meteor 3.5.2
  npm run bench -- doctor --meteor-cli /path/to/meteor/meteor
  npm run bench -- list
  npm run bench -- run --scenario plain-cursor --adapter reactive --profile smoke
  npm run bench -- matrix --profile smoke
  npm run bench -- all --profile smoke --pairs 1 --output bench/results/full
  npm run bench -- all --profile standard --pairs 5 --browser
  npm run bench -- libraries --suite smoke --pairs 1
  npm run bench -- libraries --suite compatible --pairs 5
  npm run bench -- comprehensive --dry-run
  npm run bench -- comprehensive --output bench/results/comprehensive
  npm run bench -- comprehensive --preset quick
  npm run bench -- comprehensive --stages load --rates 10,50,100 --duration 60
  npm run bench -- paired --base HEAD --pairs 5 --scenario dependent-posts
  npm run bench -- compare --baseline base.json --target target.json
  npm run bench -- profile --scenario dependent-posts
  npm run bench -- backend --profile smoke
  npm run bench -- browser --executable /usr/bin/google-chrome
  npm run bench -- lock --adapter composite
  npm run bench -- promote --target result.json --output bench/baselines/reference.json
  npm run bench -- export --target result.json --output performance.json

Adapters: native, installed, reactive, composite. Profiles: ${Object.keys(profiles).join(', ')}.
Override --clients, --parents, --children, --operations, --warmup, --timeout (ms), --observation (ms).
Use --source for another reactive-publish checkout. --meteor selects a released Meteor version.
Use --meteor-cli /path/to/meteor/meteor for a Meteor Git checkout, including worktrees and local changes.
--meteor and --meteor-cli are mutually exclusive; every execution mode supports either choice.
Comparisons are advisory; --gate explicitly enables provisional timing budgets after local calibration.
Comprehensive defaults: five pairs, 100 warmup + 1,000 operations, all nine common cases.
Stages: core, load, retention, queries. --preset quick validates setup with sparse samples.
Load uses at least --duration seconds AND the operation minimum; --latency-budget is in ms.
`);
    return;
  }
  if (action === 'list') {
    for (const [name, scenario] of Object.entries(scenarios))
      console.log(
        `${name.padEnd(24)} ${scenario.adapters.join(', ').padEnd(40)} ${scenario.description}`
      );
    return;
  }
  if (
    [
      'doctor',
      'run',
      'profile',
      'backend',
      'browser',
      'matrix',
      'libraries',
      'all',
      'comprehensive',
      'paired',
      'lock',
    ].includes(action) &&
    !(action === 'comprehensive' && values['dry-run'])
  ) {
    selectedRuntime = await resolveMeteorRuntime(
      runtimeOptions({ meteor: values.meteor, meteorCli: values['meteor-cli'] })
    );
  }
  if (action === 'doctor') {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 12))
      throw new Error('The harness requires Node 22.12 or newer');
    const runtime = selectedRuntime;
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'reactive-publish-bench-doctor-')
    );
    try {
      await writeRuntimeRelease(directory, runtime);
      const node = await runtimeNode(runtime, directory);
      const version = runtime.checkout
        ? runtime.meteor
        : await command(
            runtime.cli,
            ['--release', runtime.meteor, '--version'],
            { cwd: directory }
          );
      const mongo = await command(
        values.mongod || path.resolve(node, '../../mongodb/bin/mongod'),
        ['--version']
      );
      console.log(
        JSON.stringify(
          {
            node: process.version,
            meteor: version,
            appNode: node,
            appNodeVersion: await command(node, ['--version']),
            runtime,
            mongo: mongo.match(/db version v([^\s]+)/)?.[1],
            source: runOptions().source,
            infrastructure:
              'Owned loopback Mongo replica set; no Docker required',
          },
          null,
          2
        )
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
    return;
  }
  if (action === 'compare') {
    if (!values.baseline || !values.target)
      throw new Error('compare requires --baseline and --target');
    const report = compareResults(
      await runsFrom(values.baseline),
      await runsFrom(values.target),
      { mode: values.mode || 'regression', gate: !!values.gate }
    );
    console.log(comparisonMarkdown(report));
    if (values.output)
      await fs.writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (action === 'promote' || action === 'export') {
    if (!values.target || !values.output)
      throw new Error(`${action} requires --target and --output`);
    const result = await read(values.target);
    const errors = validateResult(result);
    if (errors.length) throw new Error(`Invalid result: ${errors.join('; ')}`);
    const data =
      action === 'promote'
        ? { schemaVersion: 1, promotedAt: new Date().toISOString(), result }
        : {
            timestamp: result.metadata.createdAt,
            tag: `${result.config.adapter}-${result.metadata.source.revision.slice(0, 12)}`,
            meteor: {
              version: result.metadata.meteor,
              sha:
                result.metadata.meteorRuntime?.revision ||
                `release-${result.metadata.meteor}`,
            },
            scenario: `${result.config.scenario}/${result.config.adapter}/${result.metadata.harness.slice(0, 12)}`,
            app: 'reactive-publish-bench',
            wall_clock_ms: result.metrics.elapsed_ms,
            runtime: {
              observer_driver_actual: result.metadata.observerDrivers.join(','),
              transport: result.config.transport,
            },
            metrics: {
              reactive_publish: {
                metric: 'reactive_publish',
                ...result.metrics,
              },
            },
            benchmark: result,
          };
    await fs.mkdir(path.dirname(path.resolve(values.output)), {
      recursive: true,
    });
    await fs.writeFile(values.output, JSON.stringify(data, null, 2) + '\n');
    console.log(`Wrote ${values.output}`);
    return;
  }
  if (action === 'lock') {
    const options = runOptions();
    if (
      !['native', 'installed', 'reactive', 'composite'].includes(
        options.adapter
      )
    )
      throw new Error('Unknown adapter');
    const build = await buildApp({
      ...options,
      log: path.join(os.tmpdir(), `bench-lock-${randomUUID()}.log`),
    });
    console.log(await lockVersions(build, options.adapter));
    return;
  }
  if (['run', 'profile', 'backend', 'browser'].includes(action)) {
    const options = runOptions();
    if (['backend', 'browser'].includes(action)) {
      options.adapter = 'reactive';
      options.level = action;
      options.scenario =
        action === 'browser' ? 'subscription-data' : 'plain-cursor';
    }
    const { result } = await runBenchmark({
      ...options,
      cpuProfile: action === 'profile',
    });
    if (result.status !== 'valid') {
      console.error(result.correctness.errors.join('\n'));
      process.exitCode = 2;
    }
    return;
  }
  if (action === 'matrix') {
    const options = runOptions();
    const chosen = values.scenario
      ? [values.scenario]
      : [
          'plain-cursor',
          'dependent-posts',
          'one-to-many',
          'projection-sensitivity',
          'subscription-churn',
        ];
    const directory = path.resolve(
      values.output || path.join(benchRoot, 'results', `matrix-${randomUUID()}`)
    );
    await fs.mkdir(directory, { recursive: true });
    const runs = [];
    for (const scenario of chosen) {
      if (!scenarios[scenario])
        throw new Error(`Unknown scenario: ${scenario}`);
      const adapters = values.adapter
        ? [values.adapter]
        : scenarios[scenario].adapters;
      for (const adapter of adapters) {
        validateScenario(scenario, adapter);
        const output = path.join(directory, `${scenario}-${adapter}.json`);
        const { result } = await runBenchmark({
          ...options,
          scenario,
          adapter,
          output,
        });
        runs.push(path.basename(output));
        if (result.status !== 'valid') process.exitCode = 2;
      }
    }
    await fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify({ runs }, null, 2) + '\n'
    );
    return;
  }
  if (action === 'libraries') {
    if (values.adapter || values.gate)
      throw new Error(
        'libraries selects composite/reactive and produces advisory comparisons; omit --adapter and --gate'
      );
    const { report, directory } = await runLibraryComparison({
      ...runOptions(),
      scenario: values.scenario,
      suite: values.suite || 'smoke',
      pairs: Number(values.pairs ?? 1),
    });
    console.log(
      `Library comparison: ${report.status} → ${path.join(directory, 'comparison.md')}`
    );
    for (const entry of report.cases)
      console.log(`${entry.scenario}: ${entry.status}`);
    if (!report.passed) process.exitCode = 2;
    return;
  }
  if (action === 'all') {
    if (values.scenario || values.adapter || values.suite || values.gate)
      throw new Error(
        'all selects every supported case and produces advisory comparisons; omit --scenario, --adapter, --suite, and --gate'
      );
    const { report, directory } = await runSuite({
      ...runOptions({ allowFanoutRate: true }),
      pairs: Number(values.pairs ?? 1),
      browser: !!values.browser,
    });
    console.log(
      `Full benchmark: ${report.status}\nHTML: ${path.join(directory, 'report.html')}\nMarkdown: ${path.join(directory, 'report.md')}\nJSON: ${path.join(directory, 'report.json')}`
    );
    console.log(
      `${report.totals.validRuns}/${report.totals.attemptedRuns} runs valid; ${report.totals.compared} comparisons available; ${report.totals.blocked} comparisons blocked.`
    );
    if (!report.passed && report.status !== 'interrupted') process.exitCode = 2;
    return;
  }
  if (action === 'comprehensive') {
    if (
      values.adapter ||
      values.gate ||
      values.browser ||
      values.rate ||
      values.suite ||
      values.instrumentation === 'basic'
    )
      throw new Error(
        'comprehensive uses both libraries and identical observer instrumentation; omit --adapter, --gate, --browser, --rate, --suite, and basic instrumentation'
      );
    const plan = comprehensivePlan(values);
    const options = runOptions();
    if (values['dry-run']) {
      console.log(
        JSON.stringify(
          {
            ...plan,
            runtime: { meteor: options.meteor, meteorCli: options.meteorCli },
          },
          null,
          2
        )
      );
      return;
    }
    console.log(
      `Comprehensive ${plan.preset}: ${plan.cases.length} cases, up to ${plan.maximumRuns} fresh runs. Minimum load-stage duration: ${(plan.minimumLoadSeconds / 60).toFixed(1)} minutes, plus builds, warmup and other stages.`
    );
    const { report, directory } = await runSuite({
      ...options,
      profile: plan.profile,
      pairs: plan.pairs,
      caseDefinitions: plan.cases,
      comprehensive: {
        preset: plan.preset,
        stages: plan.stages,
        maximumRuns: plan.maximumRuns,
        minimumLoadSeconds: plan.minimumLoadSeconds,
        note: plan.note,
      },
    });
    console.log(
      `Comprehensive comparison: ${report.status}\nHTML: ${path.join(directory, 'report.html')}\nMarkdown: ${path.join(directory, 'report.md')}\nJSON: ${path.join(directory, 'report.json')}`
    );
    if (!report.passed && report.status !== 'interrupted') process.exitCode = 2;
    return;
  }
  if (action === 'paired') {
    const options = runOptions();
    validateScenario(options.scenario, options.adapter);
    const pairs = Number(values.pairs || 5);
    if (!Number.isSafeInteger(pairs) || pairs < 1)
      throw new Error('pairs must be a positive integer');
    const directory = path.resolve(
      values.output || path.join(benchRoot, 'results', `paired-${randomUUID()}`)
    );
    await fs.mkdir(directory, { recursive: true });
    const snapshot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'reactive-publish-bench-base-')
    );
    try {
      const revision = await command(
        'git',
        [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${values.base || 'HEAD'}^{commit}`,
        ],
        { cwd: options.source }
      );
      const archive = path.join(snapshot, 'source.tar');
      await command(
        'git',
        ['archive', '--format=tar', `--output=${archive}`, revision],
        { cwd: options.source }
      );
      await command('tar', ['-xf', archive, '-C', snapshot]);
      await fs.writeFile(
        path.join(snapshot, '.bench-source-revision'),
        revision
      );
      const left = [];
      const right = [];
      const paths = { baseline: [], target: [] };
      for (let pair = 0; pair < pairs; pair++) {
        for (const side of pair % 2
          ? ['target', 'baseline']
          : ['baseline', 'target']) {
          const output = path.join(directory, `${side}-${pair}.json`);
          const { result } = await runBenchmark({
            ...options,
            source: side === 'baseline' ? snapshot : options.source,
            output,
          });
          (side === 'baseline' ? left : right).push(result);
          paths[side].push(path.basename(output));
          if (result.status !== 'valid')
            throw new Error(
              `Invalid ${side} run: ${result.correctness.errors.join('; ')}`
            );
        }
      }
      for (const side of ['baseline', 'target'])
        await fs.writeFile(
          path.join(directory, `${side}.json`),
          JSON.stringify({ runs: paths[side] }, null, 2)
        );
      const report = compareResults(left, right, { gate: !!values.gate });
      await fs.writeFile(
        path.join(directory, 'comparison.json'),
        JSON.stringify(report, null, 2) + '\n'
      );
      await fs.writeFile(
        path.join(directory, 'comparison.md'),
        comparisonMarkdown(report)
      );
      console.log(comparisonMarkdown(report));
      if (!report.passed) process.exitCode = 1;
    } finally {
      await fs.rm(snapshot, { recursive: true, force: true });
    }
    return;
  }
  throw new Error(`Unknown command: ${action}`);
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 2;
});
