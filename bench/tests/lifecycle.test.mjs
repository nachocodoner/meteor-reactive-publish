import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLifecycleCollector,
  lifecycleEvents,
} from '../app/imports/lifecycle.js';
import { lifecycleErrors, lifecycleMarkdown } from '../reporting/lifecycle.mjs';
import { compatibilityKey } from '../reporting/results.mjs';

function harness(options) {
  const listeners = new Map();
  let config;
  const collector = createLifecycleCollector(
    {
      configure(value) {
        config = value;
      },
      on(type, fn) {
        listeners.set(type, fn);
        return {
          stop() {
            listeners.delete(type);
          },
        };
      },
    },
    options
  );
  const emit = (type, event) => {
    try {
      listeners.get(type)?.(event);
    } catch (error) {
      config.onListenerError(error);
    }
  };
  const method = (id, durationMs, failed = false, name = 'bench.mutate') => {
    emit('method.start', { traceId: id, name });
    emit(failed ? 'method.error' : 'method.end', {
      traceId: id,
      name,
      durationMs,
    });
  };
  return { collector, emit, method, listeners, config };
}

test('instrumentation mode is part of both revision and library comparison identity', () => {
  const enabled = validResult();
  const disabled = structuredClone(enabled);
  disabled.config.lifecycle = false;
  for (const mode of ['regression', 'library'])
    assert.notEqual(
      compatibilityKey(enabled, mode),
      compatibilityKey(disabled, mode)
    );
});

test('capped timings preserve all totals and late errors without publishing biased percentiles', () => {
  const { collector, method, config } = harness({ sampleLimit: 2000 });
  for (let i = 0; i < 2100; i++) method(String(i), i, i >= 2000);
  const snapshot = collector.snapshot();
  const stat = snapshot.methods['bench.mutate'];
  assert.equal(stat.started, 2100);
  assert.equal(stat.succeeded, 2000);
  assert.equal(stat.failed, 100);
  assert.equal(stat.duration.mean, 1049.5);
  assert.equal(stat.duration.max, 2099);
  assert.equal(stat.duration.count, 2100);
  assert.equal(stat.duration.sample_count, 2000);
  assert.equal(stat.duration.truncated, true);
  assert.equal(stat.duration.p95, null);
  assert.equal(stat.duration.p99, null);
  assert.equal(snapshot.pendingMethods, 0);
  assert.equal(config.captureMethodArgs, false);
  assert.equal(config.captureMethodResult, false);
  assert.equal(config.captureClientAddress, false);
});

test('phase resets keep live identities but exclude warmup-spanning durations', () => {
  const { collector, emit, method } = harness();
  emit('ddp.connection.open', { connectionId: 'c' });
  emit('publication.start', { name: 'bench', traceId: 'p' });
  emit('method.start', { name: 'bench.mutate', traceId: 'm' });
  collector.reset();
  emit('method.end', { name: 'bench.mutate', traceId: 'm', durationMs: 9999 });
  emit('publication.ready', { name: 'bench', traceId: 'p', durationMs: 9999 });
  method('new', 3);
  let snapshot = collector.snapshot();
  assert.equal(snapshot.methodDuration.count, 1);
  assert.equal(snapshot.methodDuration.mean, 3);
  assert.equal(snapshot.publication.readiness.count, 0);
  assert.equal(snapshot.publication.active, 1);
  assert.equal(snapshot.connections.active, 1);
  emit('publication.stop', { name: 'bench', traceId: 'p' });
  emit('ddp.connection.close', { connectionId: 'c' });
  snapshot = collector.snapshot();
  assert.equal(snapshot.publication.active, 0);
  assert.equal(snapshot.connections.active, 0);
  assert.ok(Object.values(snapshot.faults).every((value) => value === 0));
});

test('percentiles require sufficient observations and snapshots cannot mutate the collector', () => {
  const { collector, method } = harness();
  for (let i = 0; i < 19; i++) method(String(i), i);
  assert.equal(collector.snapshot().methodDuration.p95, null);
  method('20', 19);
  const snapshot = collector.snapshot();
  assert.equal(snapshot.methodDuration.p95, 18);
  assert.equal(snapshot.methodDuration.p99, null);
  snapshot.methods['bench.mutate'].started = 0;
  snapshot.faults.unmatched = 100;
  assert.equal(collector.snapshot().methods['bench.mutate'].started, 20);
  for (let i = 20; i < 1000; i++) method(String(i), i);
  assert.equal(collector.snapshot().methodDuration.p99, 989);
});

test('coverage faults persist across resets and active identity storage is bounded', () => {
  const { collector, emit, method, listeners } = harness({ activeLimit: 1 });
  assert.equal(listeners.size, lifecycleEvents.length);
  emit('ddp.connection.open', { connectionId: 'c1' });
  emit('ddp.connection.open', { connectionId: 'c2' });
  emit('publication.stop', { name: 'bench', traceId: 'unknown' });
  emit('publication.start', { name: 'bench', traceId: 'p' });
  emit('publication.error', { name: 'bench', traceId: 'p' });
  method('bad', -1);
  emit('method.start', null);
  assert.equal(collector.snapshot().publication.failed, 1);
  assert.equal(collector.snapshot().publication.active, 0);
  collector.reset();
  assert.equal(collector.snapshot().connections.active, 1);
  assert.deepEqual(collector.snapshot().faults, {
    listenerErrors: 1,
    overflow: 1,
    unmatched: 1,
    invalidDurations: 1,
  });
  collector.stop();
  assert.equal(listeners.size, 0);
});

function validResult() {
  const { collector, emit, method } = harness();
  method('probe-ok', 1, false, 'bench.lifecycleProbe');
  method('probe-fail', 2, true, 'bench.lifecycleProbe');
  const probe = collector.snapshot();
  collector.reset();
  for (let i = 0; i < 3; i++)
    emit('ddp.connection.open', { connectionId: String(i) });
  for (let i = 0; i < 2; i++) {
    emit('publication.start', { name: 'bench', traceId: String(i) });
    emit('publication.ready', {
      name: 'bench',
      traceId: String(i),
      durationMs: 2,
    });
  }
  const initial = collector.snapshot();
  collector.reset();
  for (let i = 0; i < 20; i++) method(String(i), i);
  const measured = collector.snapshot();
  for (let i = 0; i < 2; i++)
    emit('publication.stop', { name: 'bench', traceId: String(i) });
  return {
    config: {
      lifecycle: true,
      level: 'ddp',
      scenario: 'plain-cursor',
      profile: { clients: 2, operations: 20 },
    },
    metadata: { packages: 'meteor@3.6.0\ninstrumentation@0.0.1\nmongo@2.6.0' },
    metrics: { lifecycle: measured, method_roundtrip_ms: { count: 20 } },
    phases: {
      lifecycleProbe: probe,
      initial: { server: { lifecycle: initial } },
      cleanup: { end: { lifecycle: collector.snapshot() } },
    },
  };
}

test('report validation rejects missing events, faults, and incomplete cleanup', () => {
  const good = validResult();
  assert.deepEqual(lifecycleErrors(good), []);
  for (const mutate of [
    (r) => {
      delete r.phases.lifecycleProbe;
    },
    (r) => {
      delete r.phases.initial;
    },
    (r) => {
      r.metrics.lifecycle.faults.listenerErrors++;
    },
    (r) => {
      r.metrics.lifecycle.methods['bench.mutate'].succeeded--;
    },
    (r) => {
      r.metrics.lifecycle.pendingMethods++;
    },
    (r) => {
      r.phases.cleanup.end.lifecycle.publication.active++;
    },
    (r) => {
      r.phases.cleanup.end.lifecycle.publication.stopped--;
    },
    (r) => {
      r.phases.initial.server.lifecycle.connections.active--;
    },
    (r) => {
      r.metadata.packages = 'meteor@3.6.0';
    },
  ]) {
    const broken = structuredClone(good);
    mutate(broken);
    assert.ok(lifecycleErrors(broken).length);
  }
  assert.match(lifecycleMarkdown(good), /bench.mutate.*20.*20.*0/);
  assert.match(lifecycleMarkdown(good), /active after unsubscribe: 0/);
  assert.deepEqual(lifecycleErrors({ config: { lifecycle: false } }), []);
  assert.equal(lifecycleMarkdown({}), '');
});
