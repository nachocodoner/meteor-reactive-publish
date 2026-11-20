import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import {
  benchRoot,
  repoRoot,
  runtimeLock,
  sourceInfo,
  harnessHash,
} from './build.mjs';
import { runtimeOptions, resolveMeteorRuntime } from './runtime.mjs';
import { resolveProfile } from '../config/profiles.mjs';
import { writeExperimentReport } from '../reporting/experiments.mjs';

// The focused experiment used for the first Meteor 3.5.2 investigation.
// Keep execution in the existing CLI so validation/comparison rules stay shared.
export function experimentPlan(options = {}) {
  const runtime = runtimeOptions(options);
  return {
    meteor: runtime.meteor || 'checkout',
    ...runtime,
    composite: runtimeLock.composite,
    profile: 'standard',
    ...resolveProfile('standard', { operations: 1000, warmup: 100 }),
    pairs: 5,
    seed: 1,
    comparisonScenarios: [
      'plain-cursor',
      'one-to-many',
      'deep-join',
      'sorted-window',
    ],
    reactiveSpecificScenarios: [
      'multiple-autoruns',
      'subscription-data',
      'infinite-scroll',
      'derived-count',
      'derived-aggregate',
      'external-source',
      'async-pressure',
    ],
    reactiveSpecificRepetitions: 1,
    backendRepetitions: 1,
    note: 'Sequential execution; alternating isolated pairs. Reactive-only and backend runs are descriptive. No offered-load, retention, query-profile or browser stages.',
  };
}

export function experimentJobs(plan, directory) {
  const runtime = plan.meteorCli
    ? ['--meteor-cli', plan.meteorCli]
    : ['--meteor', plan.meteor];
  const common = [...runtime, '--profile', plan.profile];
  for (const key of [
    'clients',
    'parents',
    'children',
    'operations',
    'timeout',
    'observation',
    'seed',
  ])
    common.push(`--${key}`, String(plan[key]));
  const job = (id, kind, scenario, args, output) => ({
    id,
    kind,
    scenario,
    output,
    status: 'pending',
    args: [...args, ...common, '--output', path.join(directory, output)],
  });
  return [
    ...plan.comparisonScenarios.map((scenario) =>
      job(
        `compare-${scenario}`,
        'comparison',
        scenario,
        [
          'comprehensive',
          '--stages',
          'core',
          '--scenario',
          scenario,
          '--pairs',
          String(plan.pairs),
          '--warmup',
          String(plan.warmup),
        ],
        `comparisons/${scenario}`
      )
    ),
    ...plan.reactiveSpecificScenarios.map((scenario) =>
      job(
        `reactive-${scenario}`,
        'reactive-only',
        scenario,
        [
          'run',
          '--adapter',
          'reactive',
          '--scenario',
          scenario,
          '--warmup',
          String(plan.warmup),
        ],
        `reactive-only/${scenario}.json`
      )
    ),
    job(
      'reactive-backend',
      'backend',
      'backend',
      ['backend'],
      'reactive-only/backend.json'
    ),
  ];
}

async function identity(plan) {
  const source = await sourceInfo(repoRoot);
  const runtime = await resolveMeteorRuntime(
    plan.meteorCli ? { meteorCli: plan.meteorCli } : { meteor: plan.meteor }
  );
  return {
    source: { hash: source.hash, revision: source.revision },
    harness: await harnessHash(),
    runtime: runtime.identity,
  };
}

// Pressure and available-memory data are Linux diagnostics, never an idle gate.
export async function hostObservation() {
  const sample = {
    time: new Date().toISOString(),
    loadavg: os.loadavg(),
    freeMemoryBytes: os.freemem(),
    totalMemoryBytes: os.totalmem(),
  };
  if (process.platform !== 'linux') return { ...sample, proc: null };
  const read = (file) =>
    fs
      .readFile(file, 'utf8')
      .then((text) => text.trim())
      .catch(() => null);
  const [memory, cpu, ...pressure] = await Promise.all([
    read('/proc/meminfo'),
    read('/proc/stat'),
    ...['cpu', 'memory', 'io'].map((name) => read(`/proc/pressure/${name}`)),
  ]);
  sample.memory = Object.fromEntries(
    (memory || '')
      .split('\n')
      .map((line) => line.split(/:\s*/, 2))
      .filter(([key]) =>
        ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'].includes(key)
      )
  );
  sample.cpu = cpu?.split('\n')[0] || null;
  sample.pressure = Object.fromEntries(
    ['cpu', 'memory', 'io'].map((name, i) => [name, pressure[i]])
  );
  return sample;
}

async function executeJob(job, { directory, signal }) {
  if (signal?.aborted) return { code: null, signal: signal.reason };
  const log = await fs.open(path.join(directory, `${job.id}.log`), 'w');
  let child;
  const interrupt = () => {
    if (child?.exitCode === null && child.signalCode === null)
      child.kill(signal.reason);
  };
  try {
    if (signal?.aborted) return { code: null, signal: signal.reason };
    child = spawn(
      process.execPath,
      [path.join(benchRoot, 'cli.mjs'), ...job.args],
      {
        cwd: repoRoot,
        stdio: ['ignore', log.fd, log.fd],
      }
    );
    signal?.addEventListener('abort', interrupt, { once: true });
    // The CLI owns app/Mongo process groups and handles graceful signal cleanup.
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, stoppedBy) =>
        resolve({ code, signal: stoppedBy })
      );
    });
  } finally {
    signal?.removeEventListener('abort', interrupt);
    await log.close();
  }
}

export async function runExperiments(
  plan,
  directory,
  {
    signal,
    execute = executeJob,
    getIdentity = identity,
    sampleHost = hostObservation,
    report = writeExperimentReport,
    log = console.log,
  } = {}
) {
  directory = path.resolve(directory);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  // Atomically refuse existing output, including a concurrent invocation.
  await fs.mkdir(directory).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error(`Choose a fresh output directory: ${directory}`);
    throw error;
  });
  const state = { status: 'running', jobs: experimentJobs(plan, directory) };
  const persist = async () => {
    const target = path.join(directory, 'execution.json');
    await fs.writeFile(`${target}.tmp`, JSON.stringify(state, null, 2) + '\n');
    await fs.rename(`${target}.tmp`, target);
  };
  let timer;
  let observation = Promise.resolve();
  const sample = () => {
    observation = observation
      .then(async () => {
        const value = await sampleHost();
        await fs.appendFile(
          path.join(directory, 'host-observations.jsonl'),
          JSON.stringify(value) + '\n'
        );
      })
      .catch((error) => {
        state.hostSamplingError = error.message;
      });
    return observation;
  };
  try {
    const identities = await getIdentity(plan);
    plan = { ...plan, createdAt: new Date().toISOString(), identities };
    state.identities = identities;
    await fs.writeFile(
      path.join(directory, 'plan.json'),
      JSON.stringify(plan, null, 2) + '\n'
    );
    await persist();
    await sample();
    timer = setInterval(sample, 5000);
    const checkIdentity = async () => {
      if (!isDeepStrictEqual(await getIdentity(plan), identities))
        throw new Error(
          'Source, harness or Meteor runtime changed; stopping to preserve comparability'
        );
    };
    for (const [i, job] of state.jobs.entries()) {
      if (signal?.aborted) break;
      await checkIdentity();
      if (signal?.aborted) break;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      job.hostLoadBefore = os.loadavg();
      const started = performance.now();
      await persist();
      log(`START ${i + 1}/${state.jobs.length} ${job.id}`);
      try {
        const result = await execute(job, { directory, signal });
        job.exitCode = result.code;
        job.signal = result.signal;
        job.status = signal?.aborted
          ? 'interrupted'
          : result.code === 0
            ? 'complete'
            : 'completed-with-failures';
      } catch (error) {
        job.status = signal?.aborted
          ? 'interrupted'
          : 'completed-with-failures';
        job.error = error.message;
      }
      job.seconds = (performance.now() - started) / 1000;
      job.hostLoadAfter = os.loadavg();
      await persist();
      log(`END ${job.id}: ${job.status}`);
      if (signal?.aborted) break;
      await checkIdentity();
      await report(directory);
    }
    state.status = signal?.aborted
      ? 'interrupted'
      : state.jobs.every((job) => job.status === 'complete')
        ? 'complete'
        : 'completed-with-failures';
    if (signal?.aborted)
      state.reason = `Stopped by ${signal.reason}; remaining jobs were not run.`;
  } catch (error) {
    state.status = signal?.aborted ? 'interrupted' : 'failed';
    state.reason = error.message;
  } finally {
    clearInterval(timer);
    await observation;
    for (const job of state.jobs)
      if (job.status === 'pending') job.status = 'not-run';
    state.finishedAt = new Date().toISOString();
    await persist();
    try {
      await report(directory);
    } catch (error) {
      state.reportError = error.message;
      if (state.status === 'complete') state.status = 'failed';
      await persist();
    }
  }
  return state;
}
