import { performance } from 'node:perf_hooks';
import { posts } from './collections.js';

// Runs in Meteor's actual server runtime; no mocks or DDP time in the samples.
export async function backendBench(adapter, config) {
  const { AsyncTracker, ReactiveVarAsync, ComputedField, DataLookup } = adapter;
  if (!AsyncTracker)
    throw new Error('Backend benchmarks require the reactive adapter');
  const count = config.profile.operations;
  const results = {};
  const measure = async (name, work) => {
    const samples = [];
    const cpu = process.cpuUsage();
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      await work(i);
      samples.push(performance.now() - start);
    }
    const used = process.cpuUsage(cpu);
    results[name] = {
      samples_ms: samples,
      cpu_ms: (used.user + used.system) / 1000,
    };
  };
  const signal = new ReactiveVarAsync(0);
  const seen = new Array(config.profile.clients).fill(-1);
  let runs = 0;
  const computations = seen.map((_, index) =>
    AsyncTracker.autorun(
      async (computation) => {
        const value = signal.get();
        await Promise.resolve();
        if (AsyncTracker.currentComputation() !== computation)
          throw new Error('Async context lost');
        seen[index] = value;
        runs++;
      },
      {
        onError(error) {
          throw error;
        },
      }
    )
  );
  await AsyncTracker.drainReactions();
  try {
    await measure('dependency-fanout', async (i) => {
      await signal.set(i + 1);
      if (seen.some((value) => value !== i + 1))
        throw new Error('Dependency propagation incomplete');
    });
    const previousRuns = runs;
    await measure('equal-value', () => signal.set(count));
    if (runs !== previousRuns)
      throw new Error('Equal primitive value caused recomputation');
  } finally {
    computations.forEach((comp) => comp.stop());
  }

  const selector = new ReactiveVarAsync(0);
  let cache;
  const initialized = async () => {
    const deadline = performance.now() + config.profile.timeout;
    while (computation._running || computation.invalidated) {
      if (performance.now() > deadline)
        throw new Error('Cursor computation did not settle');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await Promise.all(
      [...computation._cursorCache.values()].map(
        (entry) => entry.cursor._observer
      )
    );
  };
  const computation = AsyncTracker.autorun(async (comp) => {
    const value = selector.get();
    await posts
      .find({ _id: `post-${value % config.profile.parents}` })
      .fetchAsync();
    cache = comp._cursorCache.size;
  });
  await initialized();
  try {
    await measure('cursor-selector-churn', async (i) => {
      await selector.set(i + 1);
      await initialized();
    });
    results['cursor-selector-churn'].cache_entries = cache;
  } finally {
    computation.stop();
  }

  const value = new ReactiveVarAsync(1);
  const field = new ComputedField(
    async () => {
      await Promise.resolve();
      return value.get() * 2;
    },
    undefined,
    true
  );
  try {
    await field();
    await measure('computed-field', async (i) => {
      await value.set(i + 2);
      if ((await field()) !== (i + 2) * 2)
        throw new Error('ComputedField returned stale data');
    });
    await measure('data-lookup', async (i) => {
      if (
        (await DataLookup.get(
          async () => ({ nested: { value: i } }),
          'nested.value'
        )) !== i
      )
        throw new Error('DataLookup returned wrong data');
    });
  } finally {
    await field.stop();
  }
  await AsyncTracker.drainReactions();
  return results;
}
