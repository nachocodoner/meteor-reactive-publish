#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { benchRoot } from './runner/build.mjs';
import {
  experimentPlan,
  experimentJobs,
  runExperiments,
} from './runner/experiments.mjs';
import { writeExperimentReport } from './reporting/experiments.mjs';

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      meteor: { type: 'string' },
      'meteor-cli': { type: 'string' },
      output: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  const action = positionals[0] || 'run';
  if (values.help) {
    console.log(`Focused benchmark experiments (Node only)

  npm run bench:experiments -- --meteor 3.5.2 --dry-run
  npm run bench:experiments -- --meteor 3.5.2 --output bench/results/meteor-3.5.2-idle
  npm run bench:experiments -- --meteor-cli /path/to/meteor/meteor --output bench/results/checkout
  npm run bench:experiments -- report --output bench/results/meteor-3.5.2-idle

Four shared cases x five alternating pairs; seven reactive-only cases and backend x one run.
1,000 measured operations, 100 DDP warmup operations, 25 clients. Reports are automatic.
Use a quiet machine and a fresh output directory. No measurements run with --dry-run or report.`);
    return;
  }
  if (positionals.length > 1 || !['run', 'report'].includes(action))
    throw new Error('Expected run or report');
  if (action === 'report') {
    if (
      !values.output ||
      values.meteor ||
      values['meteor-cli'] ||
      values['dry-run']
    )
      throw new Error(
        'report requires only --output <existing-results-directory>'
      );
    const summary = await writeExperimentReport(path.resolve(values.output));
    console.log(
      `${summary.execution.status}: ${summary.validRuns}/${summary.totalRuns} recorded runs valid`
    );
    console.log(`Report: ${path.resolve(values.output, 'index.html')}`);
    return;
  }
  const plan = experimentPlan({
    meteor: values.meteor,
    meteorCli: values['meteor-cli'],
  });
  const directory = path.resolve(
    values.output ||
      path.join(benchRoot, 'results', `experiments-${randomUUID()}`)
  );
  if (values['dry-run']) {
    console.log(
      JSON.stringify(
        {
          plan,
          maximumRuns:
            plan.comparisonScenarios.length * plan.pairs * 2 +
            plan.reactiveSpecificScenarios.length +
            1,
          jobs: experimentJobs(plan, directory),
        },
        null,
        2
      )
    );
    return;
  }
  const controller = new AbortController();
  const interrupt = (signal) => controller.abort(signal);
  const handlers = ['SIGINT', 'SIGTERM'].map((signal) => [
    signal,
    () => interrupt(signal),
  ]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const state = await runExperiments(plan, directory, {
      signal: controller.signal,
    });
    console.log(
      `Experiments: ${state.status}\nReport: ${path.join(directory, 'index.html')}`
    );
    if (state.reason) console.error(state.reason);
    if (state.reportError) console.error(`Report error: ${state.reportError}`);
    process.exitCode = controller.signal.aborted
      ? controller.signal.reason === 'SIGINT'
        ? 130
        : 143
      : state.status === 'complete'
        ? 0
        : 2;
  } finally {
    for (const [signal, handler] of handlers)
      process.removeListener(signal, handler);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
