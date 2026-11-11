import { MongoInternals } from 'meteor/mongo';
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  constants,
} from 'node:perf_hooks';
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8';

export function createMetrics(asyncTracker, instrument = true) {
  let active = 0;
  let created = 0;
  let stopped = 0;
  let runs = 0;
  const computations = new Set();
  const drivers = {};
  const connection = MongoInternals.defaultRemoteCollectionDriver().mongo;
  const valuesOf = (value) =>
    value instanceof Map ? [...value.values()] : Object.values(value || {});
  const originalObserve = connection._observeChanges;
  if (typeof originalObserve !== 'function')
    throw new Error(
      'Observer instrumentation unsupported by this Meteor version'
    );
  if (instrument)
    connection._observeChanges = function (...args) {
      const promise = originalObserve.apply(this, args);
      promise
        .then((handle) => {
          active++;
          created++;
          const driver =
            handle._multiplexer?._observeDriver?.constructor?.name || 'unknown';
          drivers[driver] = (drivers[driver] || 0) + 1;
          const originalStop = handle.stop;
          let done = false;
          handle.stop = function (...stopArgs) {
            const result = originalStop.apply(this, stopArgs);
            const finish = () => {
              if (!done) {
                done = true;
                active--;
                stopped++;
              }
            };
            if (result?.then) {
              result.then(finish, () => {});
              return result;
            }
            finish();
            return result;
          };
        })
        .catch(() => {});
      return promise;
    };
  if (asyncTracker && instrument) {
    const original = asyncTracker.autorun;
    asyncTracker.autorun = function (fn, ...args) {
      const computation = original.call(
        this,
        function (...values) {
          runs++;
          return fn.apply(this, values);
        },
        ...args
      );
      computations.add(computation);
      computation.onStop(() => computations.delete(computation));
      return computation;
    };
  }
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const blankGc = () => ({ total: 0, count: 0, max: 0, major: 0, minor: 0 });
  let gc = blankGc();
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime >= start) {
        gc.total += entry.duration;
        gc.count++;
        gc.max = Math.max(gc.max, entry.duration);
        if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR)
          gc.major += entry.duration;
        if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR)
          gc.minor += entry.duration;
      }
    }
  });
  gcObserver.observe({ entryTypes: ['gc'] });
  let start = performance.now();
  let cpu = process.cpuUsage();
  let elu = performance.eventLoopUtilization();
  let baseline = { created: 0, stopped: 0, runs: 0 };
  let peak = process.memoryUsage();
  let memorySamples = 0;
  let series = [];
  let seriesTruncated = false;
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    for (const key of Object.keys(memory))
      peak[key] = Math.max(peak[key], memory[key]);
    memorySamples++;
    if (memorySamples % 20 === 0) {
      if (series.length < 600)
        series.push({
          elapsed_ms: performance.now() - start,
          ...memory,
          ...resources(),
        });
      else seriesTruncated = true;
    }
  }, 50);
  timer.unref();
  const resources = () => ({
    observer_active: active,
    computations_active: computations.size,
    multiplexer_active: valuesOf(connection._observeMultiplexers).length,
    sampled_mongo_handles: valuesOf(connection._observeMultiplexers).reduce(
      (sum, mux) => sum + valuesOf(mux._handles).length,
      0
    ),
    cursor_cache_entries: [...computations].reduce(
      (sum, comp) => sum + (comp._cursorCache?.size || 0),
      0
    ),
  });
  return {
    resources,
    reset() {
      start = performance.now();
      cpu = process.cpuUsage();
      elu = performance.eventLoopUtilization();
      histogram.reset();
      gc = blankGc();
      peak = process.memoryUsage();
      memorySamples = 0;
      series = [];
      seriesTruncated = false;
      baseline = { created, stopped, runs };
      return resources();
    },
    snapshot() {
      const used = process.cpuUsage(cpu);
      const memory = process.memoryUsage();
      const elapsed = performance.now() - start;
      const actualDrivers = {};
      for (const mux of valuesOf(connection._observeMultiplexers)) {
        const name = mux._observeDriver?.constructor?.name || 'unknown';
        actualDrivers[name] = (actualDrivers[name] || 0) + 1;
      }
      return {
        elapsed_ms: elapsed,
        app_cpu_ms: (used.user + used.system) / 1000,
        app_cpu_user_ms: used.user / 1000,
        app_cpu_system_ms: used.system / 1000,
        app_cpu_percent: ((used.user + used.system) / 1000 / elapsed) * 100,
        app_rss_bytes: Math.max(peak.rss, memory.rss),
        app_heap_used_bytes: Math.max(peak.heapUsed, memory.heapUsed),
        app_heap_total_bytes: Math.max(peak.heapTotal, memory.heapTotal),
        app_external_bytes: Math.max(peak.external, memory.external),
        app_array_buffers_bytes: Math.max(
          peak.arrayBuffers,
          memory.arrayBuffers
        ),
        end_rss_bytes: memory.rss,
        end_heap_used_bytes: memory.heapUsed,
        memory_samples: memorySamples + 1,
        event_loop_samples: histogram.count,
        event_loop_p95_ms: histogram.count
          ? histogram.percentile(95) / 1e6
          : null,
        event_loop_p99_ms: histogram.count
          ? histogram.percentile(99) / 1e6
          : null,
        event_loop_utilization:
          performance.eventLoopUtilization(elu).utilization,
        gc_pause_ms: gc.total,
        gc_count: gc.count,
        gc_max_pause_ms: gc.max,
        gc_major_pause_ms: gc.major,
        gc_minor_pause_ms: gc.minor,
        observer_created: created - baseline.created,
        observer_stopped: stopped - baseline.stopped,
        computation_runs: instrument ? runs - baseline.runs : null,
        drivers: instrument ? { ...drivers } : actualDrivers,
        instrumentation_enabled: instrument,
        memory_series: series,
        memory_series_truncated: seriesTruncated,
        v8_heap: getHeapStatistics(),
        v8_spaces: getHeapSpaceStatistics(),
        ...resources(),
      };
    },
  };
}
