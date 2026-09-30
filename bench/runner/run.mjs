import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import EJSON from 'ejson';
import { DDPClient } from '../clients/ddp-client.mjs';
import { statesEqual, prepareState } from '../clients/document-store.mjs';
import {
  fixture,
  collectionNames,
  applyOperation,
} from '../fixtures/model.mjs';
import {
  expectedState,
  expectedData,
  operationFor,
  validateScenario,
  scenarioVersion,
} from '../scenarios/index.mjs';
import { buildApp, benchRoot, hash } from './build.mjs';
import { startMongo } from './mongo.mjs';
import { createDatabaseMetrics } from './database-metrics.mjs';
import { retentionSummary } from '../reporting/retention.mjs';
import {
  freePort,
  launch,
  stop,
  until,
  waitUntilScheduled,
} from './process.mjs';
import {
  summarize,
  validateResult,
  resultMarkdown,
} from '../reporting/results.mjs';

const resourcesReleased = (end, baseline) =>
  [
    'observer_active',
    'computations_active',
    'cursor_cache_entries',
    'sampled_mongo_handles',
    'multiplexer_active',
  ].every((key) => end[key] <= baseline[key]);

export async function runBenchmark(options) {
  const { scenario, adapter, profile, seed = 1 } = options;
  validateScenario(scenario, adapter);
  if (options.rate && scenario !== 'fanout')
    throw new Error('Offered load requires fanout');
  if (options.retention && scenario !== 'subscription-churn')
    throw new Error('Retention requires subscription-churn');
  const id = randomUUID();
  const directory = options.output
    ? path.dirname(path.resolve(options.output))
    : path.join(benchRoot, 'results', id);
  await fs.mkdir(directory, { recursive: true });
  const output = options.output
    ? path.resolve(options.output)
    : path.join(directory, 'result.json');
  const log = (name) => path.join(directory, `${id}-${name}.log`);
  const result = {
    schemaVersion: 1,
    id,
    status: 'invalid',
    correctness: { passed: false, errors: [] },
    config: {
      scenario,
      adapter,
      profile,
      seed,
      scenarioVersion,
      level: options.level || 'ddp',
      rate: options.rate || 0,
      metricsVersion: 2,
      measurement: options.measurement || 'core',
      databaseMetrics: !!options.databaseMetrics,
      databaseProfile: !!options.databaseProfile,
      retention: options.retention || null,
      duration: options.duration || 0,
      loadSloMs: options.loadSloMs || null,
      buildMode: 'production',
      transport: 'sockjs-websocket',
      instrumentation: options.cpuProfile
        ? `cpu-profile-v1:${options.instrumentation || 'observers'}`
        : options.instrumentation || 'observers',
    },
    metadata: { createdAt: new Date().toISOString() },
    metrics: {},
    phases: {},
    samples: {
      ready: [],
      convergence: [],
      fanout: [],
      noOutputObservation: [],
    },
  };
  let mongo;
  let app;
  const clients = [];
  let writer;
  let control;
  let databaseMetrics;
  let databaseStarted = false;
  let databaseFinalized = false;
  let captureGenerator;
  try {
    const build = await buildApp({ ...options, log: log('build') });
    mongo = await startMongo({
      node: build.node,
      mongod: options.mongod,
      log: log('mongo'),
    });
    const model = fixture(profile, seed);
    Object.assign(result.metadata, {
      harness: build.harness,
      fixture: hash(model),
      source: { hash: build.source.hash, revision: build.source.revision },
      meteor: build.meteor,
      meteorRuntime: build.runtime.identity,
      mongo: mongo.version,
      packages: build.versions,
      buildKey: build.key,
      hardware: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpu: os.cpus()[0]?.model,
        cores: os.cpus().length,
        memory: os.totalmem(),
      },
      harnessNode: process.version,
      limits: {
        cpu: await fs
          .readFile('/sys/fs/cgroup/cpu.max', 'utf8')
          .catch(() => null),
        memory: await fs
          .readFile('/sys/fs/cgroup/memory.max', 'utf8')
          .catch(() => null),
      },
    });
    const token = randomBytes(24).toString('hex');
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const flags = options.cpuProfile
      ? ['--cpu-prof', `--cpu-prof-dir=${directory}`]
      : [];
    if (options.retention) flags.push('--expose-gc');
    app = launch(build.node, [...flags, path.join(build.bundle, 'main.js')], {
      cwd: build.bundle,
      log: log('app'),
      env: {
        NODE_ENV: 'production',
        PORT: String(port),
        BIND_IP: '127.0.0.1',
        ROOT_URL: url,
        MONGO_URL: mongo.url,
        MONGO_OPLOG_URL: mongo.oplog,
        BENCH_TOKEN: token,
        BENCH_CONFIG: JSON.stringify({
          scenario,
          adapter,
          profile,
          seed,
          sourceHash: build.source.hash,
          instrumentation: options.instrumentation,
          retention: options.retention,
        }),
        METEOR_SETTINGS: '{}',
        DDP_TRANSPORT: 'sockjs',
        METEOR_REACTIVITY_ORDER: 'oplog',
      },
    });
    control = async (action) => {
      if (app.child.exitCode !== null || app.child.signalCode !== null)
        throw Object.assign(new Error(`App exited: ${app.output()}`), {
          fatal: true,
        });
      const response = await fetch(`${url}/__bench/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(
          action === 'backend' ? profile.timeout : 3000
        ),
      });
      if (!response.ok)
        throw new Error(
          `Control ${action}: HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`
        );
      return response.json();
    };
    const status = await until(() => control('status'), {
      timeout: 90000,
      label: 'seeded benchmark app',
    });
    if (
      status.metadata.reactiveLoaded !==
        ['reactive', 'installed'].includes(adapter) ||
      status.metadata.compositeLoaded !== (adapter === 'composite')
    )
      throw new Error('Runtime package isolation failed');
    if (status.metadata.sourceHash !== build.source.hash)
      throw new Error('Loaded source hash mismatch');
    result.metadata.node = status.metadata.node;
    if (options.level) {
      const baseline = (await control('status')).resources;
      await control('start');
      if (options.level === 'backend') {
        result.samples.backend = await control('backend');
        result.metrics.backend = Object.fromEntries(
          Object.entries(result.samples.backend).map(([name, value]) => [
            name,
            { ...summarize(value.samples_ms), cpu_ms: value.cpu_ms },
          ])
        );
      } else {
        const { browserCheck } = await import('../clients/browser.mjs');
        result.samples.browser = await browserCheck({
          url,
          token,
          profile,
          executable: options.executable,
        });
        result.metadata.browser = result.samples.browser.client;
        result.metrics.browser_data_ms = summarize(
          result.samples.browser.samples_ms
        );
      }
      const server = await control('snapshot');
      Object.assign(result.metrics, server, {
        completed_operations: profile.operations,
        failed_operations: 0,
      });
      result.metadata.observerDrivers = Object.keys(server.drivers).sort();
      result.phases.cleanup = {
        verified: options.instrumentation !== 'basic',
        baseline,
        end: await until(
          async () => {
            const snapshot = await control('snapshot');
            return resourcesReleased(snapshot, baseline) ? snapshot : false;
          },
          { timeout: profile.timeout, label: `${options.level} cleanup` }
        ),
      };
      result.status = 'valid';
      result.correctness.passed = true;
      const invalid = validateResult(result);
      if (invalid.length) throw new Error(invalid.join('; '));
      return { result, output };
    }
    writer = new DDPClient(url, { timeout: profile.timeout });
    await writer.connect();
    for (let i = 0; i < profile.clients; i++) {
      const client = new DDPClient(url, { timeout: profile.timeout });
      clients.push(client);
      await client.connect();
    }
    const context = {};
    let subscriptions = [];
    let operationIndex = 0;
    let expected;
    let expectedSubscriptionData;
    const refreshExpected = () => {
      expected = prepareState(
        expectedState(scenario, model, context),
        collectionNames
      );
      expectedSubscriptionData = expectedData(scenario, model, context);
    };
    refreshExpected();
    const stateMatches = (client, index) =>
      client.store.matches(expected) &&
      (expectedSubscriptionData === null ||
        EJSON.equals(
          client.store.data(subscriptions[index]?.id),
          expectedSubscriptionData
        ));
    const verify = () => {
      refreshExpected();
      clients.forEach((client, index) => {
        if (client.failure) throw client.failure;
        if (!stateMatches(client, index))
          throw new Error(
            `Client ${index} state mismatch: ${JSON.stringify({ expected: expectedState(scenario, model, context), actual: client.store.snapshot(collectionNames), expectedData: expectedData(scenario, model, context), actualData: client.store.data(subscriptions[index]?.id) }).slice(0, 3000)}`
          );
      });
    };
    const subscribe = async (measured) => {
      subscriptions = [];
      for (const client of clients) {
        const sub = await client.subscribe('bench', [token]);
        subscriptions.push(sub);
        if (measured) result.samples.ready.push(sub.readyMs);
      }
      verify();
    };
    const unsubscribe = async () => {
      await Promise.all(
        clients.map((client, index) =>
          client.unsubscribe(subscriptions[index].id)
        )
      );
      await Promise.all(
        clients.map((client) =>
          client.waitFor(
            () => statesEqual(client.store.snapshot(collectionNames), {}),
            'empty publication after unsubscribe'
          )
        )
      );
    };
    // Wait for anonymous publications to exist before the lifecycle baseline.
    await delay(50);
    const baseline = (await control('status')).resources;
    const exercise = async (measured) => {
      const operation = operationFor(scenario, operationIndex++, model);
      const previous = expectedState(scenario, model, context);
      const previousData = expectedData(scenario, model, context);
      applyOperation(model, operation);
      if (operation.kind === 'data') context.data = { value: operation.value };
      if (operation.kind === 'limit') context.limit = operation.value;
      if (operation.kind === 'external') context.external = operation.value;
      refreshExpected();
      const changed =
        !statesEqual(previous, expectedState(scenario, model, context)) ||
        !EJSON.equals(previousData, expectedData(scenario, model, context));
      const received = changed
        ? clients.map((client, index) =>
            client.waitFor(
              () => stateMatches(client, index),
              `operation ${operationIndex} delivery to client ${index}`
            )
          )
        : [];
      const start = performance.now();
      if (['data', 'limit'].includes(operation.kind)) {
        await Promise.all(
          clients.map((client, index) =>
            client.call('_subscriptionDataSet', [
              subscriptions[index].id,
              operation.kind === 'data' ? 'value' : 'limit',
              operation.value,
            ])
          )
        );
      } else await writer.call('bench.mutate', [token, operation]);
      if (changed) {
        const times = await Promise.all(received);
        if (measured) {
          result.samples.convergence.push(...times.map((time) => time - start));
          result.samples.fanout.push(Math.max(...times) - start);
          result.metrics.changed_operations++;
        }
      } else {
        // This is an observation period, never reported as propagation latency.
        await delay(profile.observation);
        if (measured)
          result.samples.noOutputObservation.push(performance.now() - start);
      }
      verify();
      if (measured) result.metrics.completed_operations++;
    };
    if (profile.warmup) {
      await subscribe(false);
      for (let i = 0; i < profile.warmup; i++) {
        if (scenario === 'subscription-churn') {
          await unsubscribe();
          await subscribe(false);
        } else await exercise(false);
      }
      await unsubscribe();
      // Subscription data is scoped to each subscription and resets on resubscribe.
      if (scenario === 'subscription-data') context.data = undefined;
      if (scenario === 'infinite-scroll') context.limit = undefined;
    }
    const cleanedResources = () =>
      until(
        async () => {
          const value = await control('snapshot');
          return resourcesReleased(value, baseline) ? value : false;
        },
        { timeout: profile.timeout, label: 'observer/computation cleanup' }
      );
    const retentionCheckpoint = async (cycle) => {
      await cleanedResources();
      await delay(options.retention.settleMs);
      const sample = await control('retention');
      if (!resourcesReleased(sample, baseline))
        throw new Error('Resources retained at memory checkpoint');
      (result.samples.retention ||= []).push({ cycle, ...sample });
    };
    if (options.retention) await retentionCheckpoint(0);
    for (const client of [...clients, writer]) client.resetMetrics();
    await control('start');
    await subscribe(true);
    result.phases.initial = {
      server: await control('snapshot'),
      traffic: clients.map((client) => client.traffic),
    };
    for (const client of [...clients, writer]) client.resetMetrics();
    if (options.databaseMetrics || options.databaseProfile) {
      databaseMetrics = await createDatabaseMetrics(mongo, {
        profile: !!options.databaseProfile,
      });
      await databaseMetrics.start();
      databaseStarted = true;
    }
    await control('start');
    result.metrics.completed_operations = 0;
    result.metrics.failed_operations = 0;
    result.metrics.changed_operations = 0;
    const generatorCpu = process.cpuUsage();
    const generatorElu = performance.eventLoopUtilization();
    const generatorStart = performance.now();
    captureGenerator = () => {
      const used = process.cpuUsage(generatorCpu);
      return {
        cpu_ms: (used.user + used.system) / 1000,
        elapsed_ms: performance.now() - generatorStart,
        utilization: performance.eventLoopUtilization(generatorElu).utilization,
        memory: process.memoryUsage(),
        scheduling_lag_ms: summarize(result.samples.schedulingLag || []),
      };
    };
    let inflight = 0;
    let maxInflight = 0;
    if (options.rate) {
      result.samples.schedulingLag = [];
      result.samples.scheduledConvergence = [];
      const pending = [];
      for (let i = 0; i < profile.operations; i++) {
        const scheduled = generatorStart + (i * 1000) / options.rate;
        await waitUntilScheduled(scheduled);
        const operation = operationFor(scenario, operationIndex++, model);
        applyOperation(model, operation);
        const received = clients.map((client) =>
          client.waitFor(
            () =>
              client.store.collections.get('bench_posts')?.get(operation.id)
                ?.revision === operation.doc.revision,
            `fanout ${operation.id}`
          )
        );
        const dispatched = performance.now();
        result.samples.schedulingLag.push(dispatched - scheduled);
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        const work = (async () => {
          await writer.call('bench.mutate', [token, operation]);
          const times = await Promise.all(received);
          result.samples.convergence.push(
            ...times.map((time) => time - dispatched)
          );
          result.samples.scheduledConvergence.push(
            ...times.map((time) => time - scheduled)
          );
          result.samples.fanout.push(Math.max(...times) - dispatched);
          result.metrics.changed_operations++;
          result.metrics.completed_operations++;
          inflight--;
        })();
        work.catch(() => {});
        pending.push(work);
        if (clients.some((client) => client.failure) || writer.failure)
          throw new Error('Client failed during offered load');
      }
      await Promise.all(pending);
    } else
      for (let i = 0; i < profile.operations; i++) {
        if (scenario === 'subscription-churn') {
          await unsubscribe();
          if (
            options.retention &&
            (i + 1) % options.retention.every === 0 &&
            i + 1 < profile.operations
          )
            await retentionCheckpoint(i + 1);
          await subscribe(true);
          result.metrics.completed_operations++;
        } else await exercise(true);
      }
    result.phases.generator = captureGenerator();
    if (
      options.rate &&
      result.phases.generator.scheduling_lag_ms.p95 >
        Math.max(10, 1000 / options.rate)
    )
      throw new Error('Load generator missed its offered-rate schedule');
    verify();
    const server = await control('snapshot');
    if (server.drivers.unknown)
      throw new Error('Actual observer driver could not be identified');
    result.metadata.observerDrivers = Object.keys(server.drivers).sort();
    result.phases.measurement = {
      server,
      traffic: [...clients, writer].map((client) => client.traffic),
    };
    Object.assign(result.metrics, server, {
      subscription_ready_ms: summarize(result.samples.ready),
      update_convergence_ms: summarize(result.samples.convergence),
      fanout_completion_ms: summarize(result.samples.fanout),
      scheduled_convergence_ms: summarize(
        result.samples.scheduledConvergence || []
      ),
      method_roundtrip_ms: summarize(
        [...clients, writer].flatMap((client) => client.methodLatencies)
      ),
      ddp_payload_bytes: [...clients, writer].reduce(
        (sum, client) => sum + client.traffic.payload_bytes,
        0
      ),
      ddp_messages: [...clients, writer].reduce(
        (sum, client) => sum + client.traffic.messages,
        0
      ),
    });
    result.metrics.cpu_ms_per_operation =
      result.metrics.app_cpu_ms / profile.operations;
    result.metrics.bytes_per_operation =
      result.metrics.ddp_payload_bytes / profile.operations;
    result.metrics.messages_per_operation =
      result.metrics.ddp_messages / profile.operations;
    result.metrics.gc_ms_per_operation =
      result.metrics.gc_pause_ms / profile.operations;
    result.metrics.observers_created_per_operation =
      result.metrics.observer_created / profile.operations;
    result.metrics.observers_stopped_per_operation =
      result.metrics.observer_stopped / profile.operations;
    result.metrics.completed_operations_per_second =
      (profile.operations * 1000) / result.phases.generator.elapsed_ms;
    if (databaseMetrics) {
      databaseFinalized = true;
      const database = await databaseMetrics.finish(profile.operations);
      Object.assign(result.metrics, database.metrics);
      result.phases.database = database.diagnostics;
    }
    if (options.rate) {
      result.metrics.load_max_inflight = maxInflight;
      result.metrics.load_drain_ms = Math.max(
        0,
        result.phases.generator.elapsed_ms -
          ((profile.operations - 1) * 1000) / options.rate
      );
      result.load = {
        offered_rate: options.rate,
        duration_seconds: (profile.operations - 1) / options.rate,
        latency_budget_ms: options.loadSloMs || null,
        generator_limited: result.phases.generator.utilization >= 0.9,
        within_latency_budget: options.loadSloMs
          ? result.metrics.scheduled_convergence_ms.p95 <= options.loadSloMs
          : null,
      };
    }
    await unsubscribe();
    const cleaned = await cleanedResources();
    result.phases.cleanup = {
      verified: options.instrumentation !== 'basic',
      baseline,
      end: cleaned,
    };
    if (options.retention) {
      await retentionCheckpoint(profile.operations);
      Object.assign(result.metrics, retentionSummary(result.samples.retention));
    }
    result.status = 'valid';
    result.correctness.passed = true;
    const invalid = validateResult(result);
    if (invalid.length) throw new Error(invalid.join('; '));
  } catch (error) {
    result.status = 'invalid';
    result.correctness.passed = false;
    result.correctness.errors.push(error.message);
    result.metrics.failed_operations =
      (result.metrics.failed_operations || 0) + 1;
    if (captureGenerator) result.phases.generator = captureGenerator();
    result.phases.failureProgress = {
      phase: captureGenerator ? 'operations' : 'setup/initialization',
      completed: result.metrics.completed_operations ?? null,
      requested: profile.operations,
    };
    if (control) {
      try {
        result.phases.failure = await control('snapshot');
      } catch {
        /* app may have exited */
      }
    }
    if (databaseStarted && !databaseFinalized) {
      databaseFinalized = true;
      try {
        const partial = await databaseMetrics.finish(
          Math.max(1, result.metrics.completed_operations || 0)
        );
        // In-flight work makes per-completed-operation costs misleading on a
        // failed attempt. Keep raw diagnostics only, outside comparison metrics.
        result.phases.failureDatabase = partial.diagnostics;
      } catch (diagnosticError) {
        result.phases.failureDatabase = { error: diagnosticError.message };
      }
    }
    // Keep a post-failure diagnostic snapshot; it is never used to turn a failure into a pass.
    await delay(100);
    result.diagnostics = {
      clientStates: clients.map((client) => client.store.snapshot()),
      appTail: app?.output(),
    };
  } finally {
    await Promise.allSettled(
      [...clients, writer].filter(Boolean).map((client) => client.disconnect())
    );
    for (const close of [
      () => databaseMetrics?.close(),
      () => stop(app),
      () => mongo?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        result.status = 'invalid';
        result.correctness.passed = false;
        result.correctness.errors.push(`Teardown: ${error.message}`);
      }
    }
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    await fs.writeFile(
      output.replace(/\.json$/, '') + '.md',
      resultMarkdown(result)
    );
    console.error(
      `${result.status}: ${options.level || scenario}/${adapter} → ${output}`
    );
  }
  return { result, output };
}
