// Bounded, in-memory consumer of Meteor's public instrumentation events.
// No event payloads, arguments, results, user IDs, or I/O are retained here.
export const lifecycleVersion = 1;
export const lifecycleEvents = [
  'method.start',
  'method.end',
  'method.error',
  'publication.start',
  'publication.ready',
  'publication.stop',
  'publication.error',
  'ddp.connection.open',
  'ddp.connection.close',
];
const methodNames = [
  'bench.mutate',
  '_subscriptionDataSet',
  'bench.lifecycleProbe',
];
const timing = () => ({ count: 0, total: 0, max: 0, samples: [], invalid: 0 });
function addTiming(stat, value, limit) {
  if (!Number.isFinite(value) || value < 0) {
    stat.invalid++;
    return;
  }
  stat.count++;
  stat.total += value;
  stat.max = Math.max(stat.max, value);
  if (stat.samples.length < limit) stat.samples.push(value);
}
function summary(stat) {
  const values = [...stat.samples].sort((a, b) => a - b);
  const truncated = values.length < stat.count;
  const percentile = (p, minimum) =>
    !truncated && values.length >= minimum
      ? values[Math.ceil(values.length * p) - 1]
      : null;
  return {
    count: stat.count,
    sample_count: values.length,
    truncated,
    mean: stat.count ? stat.total / stat.count : null,
    max: stat.count ? stat.max : null,
    p50: percentile(0.5, 1),
    p95: percentile(0.95, 20),
    p99: percentile(0.99, 1000),
    invalid: stat.invalid,
  };
}
const blankMethod = () => ({
  started: 0,
  succeeded: 0,
  failed: 0,
  duration: timing(),
});
const blankPublication = () => ({
  started: 0,
  ready: 0,
  stopped: 0,
  failed: 0,
  readiness: timing(),
});

export function createLifecycleCollector(
  api,
  { sampleLimit = 10000, activeLimit = 10000 } = {}
) {
  if (
    !api ||
    typeof api.on !== 'function' ||
    typeof api.configure !== 'function'
  )
    throw new Error(
      'Meteor instrumentation API unavailable; use Meteor 3.6 or newer'
    );
  for (const limit of [sampleLimit, activeLimit])
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Invalid lifecycle bound');
  let epoch = 0;
  let methods;
  let publication;
  let methodDuration;
  let connections;
  // Live IDs survive phase resets; a stop after a reset can belong to an earlier start.
  const liveMethods = new Map();
  const livePublications = new Map();
  const liveConnections = new Map();
  const faults = {
    listenerErrors: 0,
    overflow: 0,
    unmatched: 0,
    invalidDurations: 0,
  };
  const reset = () => {
    epoch++;
    methods = Object.fromEntries(
      methodNames.map((name) => [name, blankMethod()])
    );
    publication = blankPublication();
    methodDuration = timing();
    connections = { opened: 0, closed: 0 };
  };
  reset();
  const begin = (map, id) => {
    if (typeof id !== 'string' || map.has(id)) {
      faults.unmatched++;
      return;
    }
    if (map.size >= activeLimit) {
      faults.overflow++;
      return;
    }
    map.set(id, epoch);
  };
  const finish = (map, id) => {
    const generation = map.get(id);
    if (!map.delete(id)) faults.unmatched++;
    return generation;
  };
  const observe = (type, event) => {
    if (type.startsWith('method.')) {
      if (!Object.hasOwn(methods, event.name)) return;
      const stat = methods[event.name];
      if (type === 'method.start') {
        stat.started++;
        begin(liveMethods, event.traceId);
      } else {
        stat[type === 'method.end' ? 'succeeded' : 'failed']++;
        const generation = finish(liveMethods, event.traceId);
        // Never mix warmup-spanning durations into a measured phase.
        if (generation === epoch) {
          addTiming(stat.duration, event.durationMs, sampleLimit);
          addTiming(methodDuration, event.durationMs, sampleLimit);
          if (!Number.isFinite(event.durationMs) || event.durationMs < 0)
            faults.invalidDurations++;
        }
      }
    } else if (type.startsWith('publication.')) {
      if (event.name !== 'bench') return;
      if (type === 'publication.start') {
        publication.started++;
        begin(livePublications, event.traceId);
      } else if (type === 'publication.ready') {
        publication.ready++;
        if (!livePublications.has(event.traceId)) faults.unmatched++;
        if (livePublications.get(event.traceId) === epoch) {
          addTiming(publication.readiness, event.durationMs, sampleLimit);
          if (!Number.isFinite(event.durationMs) || event.durationMs < 0)
            faults.invalidDurations++;
        }
      } else {
        publication[type === 'publication.stop' ? 'stopped' : 'failed']++;
        finish(livePublications, event.traceId);
      }
    } else if (type === 'ddp.connection.open') {
      connections.opened++;
      begin(liveConnections, event.connectionId);
    } else {
      connections.closed++;
      finish(liveConnections, event.connectionId);
    }
  };
  api.configure({
    enabled: true,
    captureMethodArgs: false,
    captureMethodResult: false,
    captureClientAddress: false,
    onListenerError: () => {
      faults.listenerErrors++;
    },
  });
  const handles = lifecycleEvents.map((type) =>
    api.on(type, (event) => observe(type, event))
  );
  return {
    reset,
    stop() {
      for (const handle of handles) handle.stop();
    },
    snapshot() {
      return {
        version: lifecycleVersion,
        sampleLimit,
        activeLimit,
        faults: { ...faults },
        methods: Object.fromEntries(
          Object.entries(methods).map(([name, stat]) => [
            name,
            {
              ...stat,
              duration: summary(stat.duration),
            },
          ])
        ),
        methodDuration: summary(methodDuration),
        publication: {
          ...publication,
          readiness: summary(publication.readiness),
          active: livePublications.size,
        },
        connections: { ...connections, active: liveConnections.size },
        pendingMethods: liveMethods.size,
      };
    },
  };
}
