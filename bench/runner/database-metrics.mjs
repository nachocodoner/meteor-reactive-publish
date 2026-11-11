import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { command } from './process.mjs';

export function parseProcStat(text, ticksPerSecond, pageSize) {
  // comm can contain spaces and parentheses; fields after the final ')' have
  // fixed offsets. Read the process (all threads), not individual task stats.
  const fields = text
    .slice(text.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  const result = {
    cpu_ms: ((Number(fields[11]) + Number(fields[12])) / ticksPerSecond) * 1000,
    rss_bytes: Number(fields[21]) * pageSize,
    start_ticks: Number(fields[19]),
  };
  if (
    Object.values(result).some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error('Invalid Mongo process resource sample');
  return result;
}

export function aggregateQueries(rows) {
  const result = {
    operations: 0,
    read_operations: 0,
    docs_examined: 0,
    keys_examined: 0,
    returned: 0,
    collection_scans: 0,
    duration_ms: 0,
    by_namespace: {},
  };
  for (const row of rows) {
    if (!row.ns?.startsWith('bench.bench_')) continue;
    result.operations++;
    const read =
      row.op === 'query' ||
      row.op === 'getmore' ||
      row.command?.find ||
      row.command?.aggregate ||
      row.command?.getMore;
    if (read) result.read_operations++;
    result.docs_examined += Number(row.docsExamined || 0);
    result.keys_examined += Number(row.keysExamined || 0);
    result.returned += Number(row.nreturned || 0);
    result.collection_scans += /COLLSCAN/.test(row.planSummary || '') ? 1 : 0;
    result.duration_ms += Number(row.millis || 0);
    const group = `${row.ns}/${row.op}`;
    result.by_namespace[group] = (result.by_namespace[group] || 0) + 1;
  }
  return result;
}

// The runner owns this mongod and database. No production Mongo URI is accepted.
// Query profiling is enabled only in the separate queries stage.
export async function createDatabaseMetrics(mongo, { profile = false } = {}) {
  const db = mongo.connection.db('bench');
  let before;
  let peakRss = 0;
  let count = 0;
  let timer;
  let pending;
  let sampleError;
  let started;
  let statusBefore;
  let profiling = false;
  let readProcess;
  const processSupport = process.platform === 'linux';
  if (processSupport) {
    const ticks = Number(await command('getconf', ['CLK_TCK']));
    const page = Number(await command('getconf', ['PAGESIZE']));
    if (!ticks || !page)
      throw new Error('Cannot resolve OS process accounting units');
    readProcess = async () =>
      parseProcStat(
        await fs.readFile(`/proc/${mongo.pid}/stat`, 'utf8'),
        ticks,
        page
      );
  }
  const sample = async () => {
    const value = await readProcess();
    if (before && value.start_ticks !== before.start_ticks)
      throw new Error('Mongo process identity changed');
    peakRss = Math.max(peakRss, value.rss_bytes);
    count++;
    return value;
  };
  const stopSampling = async () => {
    clearInterval(timer);
    await pending;
  };
  const marker = async (name) =>
    db.command({
      insert: '__profile_marker',
      documents: [{ _id: name }],
      comment: `bench-${name}`,
    });
  return {
    async start() {
      if (profile) {
        await db.createCollection('system.profile', {
          capped: true,
          size: 64 * 1024 * 1024,
        });
        await db.createCollection('__profile_marker');
        await db.command({
          profile: 1,
          filter: { ns: { $regex: '^bench\\.(bench_|__profile_marker)' } },
        });
        profiling = true;
        await marker('start');
      }
      statusBefore = await mongo.connection
        .db('admin')
        .command({ serverStatus: 1 });
      started = performance.now();
      if (readProcess) {
        before = await sample();
        timer = setInterval(() => {
          if (pending) return;
          pending = sample()
            .catch((error) => {
              sampleError = error;
            })
            .finally(() => {
              pending = null;
            });
        }, 250);
        timer.unref();
      }
    },
    async finish(operations) {
      await stopSampling();
      if (sampleError) throw sampleError;
      const after = readProcess ? await sample() : null;
      const elapsed = performance.now() - started;
      const statusAfter = await mongo.connection
        .db('admin')
        .command({ serverStatus: 1 });
      const metrics = {
        mongo_cpu_ms_per_operation: after
          ? (after.cpu_ms - before.cpu_ms) / operations
          : null,
        mongo_rss_bytes: after ? peakRss : null,
      };
      const diagnostics = {
        process: {
          available: processSupport,
          reason: processSupport
            ? null
            : 'Mongo process CPU/RSS sampling requires Linux /proc',
          samples: count,
          elapsed_ms: elapsed,
          cpu_ms: after ? after.cpu_ms - before.cpu_ms : null,
          peak_rss_bytes: after ? peakRss : null,
        },
        // These are instance-wide deltas, including replica-set housekeeping.
        // They are diagnostics, not application query counts.
        opcounters: Object.fromEntries(
          Object.entries(statusAfter.opcounters).map(([key, value]) => [
            key,
            Number(value) - Number(statusBefore.opcounters[key]),
          ])
        ),
        connections: statusAfter.connections,
      };
      if (profile) {
        await marker('end');
        await db.command({ profile: 0 });
        profiling = false;
        const collection = db.collection('system.profile');
        const markers = await collection.countDocuments({
          ns: 'bench.__profile_marker',
          'command.comment': { $in: ['bench-start', 'bench-end'] },
        });
        if (markers !== 2)
          throw new Error(
            'Mongo profiler coverage incomplete or capped history overwritten'
          );
        const rows = await collection
          .find(
            { ns: { $regex: '^bench\\.bench_' } },
            {
              projection: {
                ns: 1,
                op: 1,
                command: 1,
                docsExamined: 1,
                keysExamined: 1,
                nreturned: 1,
                millis: 1,
                planSummary: 1,
              },
            }
          )
          .toArray();
        diagnostics.queries = {
          ...aggregateQueries(rows),
          coverage_verified: true,
        };
        for (const [name, value] of Object.entries(diagnostics.queries)) {
          if (typeof value === 'number')
            metrics[`mongo_${name}_per_operation`] = value / operations;
        }
      }
      return { metrics, diagnostics };
    },
    async close() {
      await stopSampling();
      if (profiling) await db.command({ profile: 0 });
    },
  };
}
