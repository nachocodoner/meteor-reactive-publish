#!/usr/bin/env node
// Outside bench/: a safety supervisor must not change the measurement hash.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const GiB = 2 ** 30;
export const defaults = {
  maxRssGiB: 6,
  minFreeGiB: 2,
  maxLoad: 8,
  maxSwapGrowthMiB: 256,
  maxSeconds: 1800,
  intervalMs: 5000,
  consecutive: 3,
  graceMs: 10000,
};

export function pressureReasons(sample, limits, initialSwap) {
  return [
    sample.rssBytes > limits.maxRssGiB * GiB && 'workload RSS limit',
    sample.freeBytes < limits.minFreeGiB * GiB && 'host free-memory floor',
    sample.load1 > limits.maxLoad && 'host load limit',
    sample.swapBytes !== null &&
      initialSwap !== null &&
      sample.swapBytes - initialSwap > limits.maxSwapGrowthMiB * 2 ** 20 &&
      'host swap-growth limit',
  ].filter(Boolean);
}

export async function processTable() {
  const { stdout } = await exec(
    'ps',
    ['-axo', 'pid=,ppid=,rss=,stat=,lstart=,comm='],
    {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }
  );
  return stdout.split('\n').flatMap((line) => {
    const match = line
      .trim()
      .match(
        /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/
      );
    if (!match || match[4].includes('Z')) return [];
    return [
      {
        pid: +match[1],
        ppid: +match[2],
        rss: +match[3] * 1024,
        // A launcher can exec Node under the same PID. Its start time remains
        // stable; including the executable would falsely report that it exited.
        identity: match[5],
      },
    ];
  });
}

async function swapBytes() {
  if (process.platform === 'darwin') {
    const { stdout } = await exec('sysctl', ['-n', 'vm.swapusage'], {
      timeout: 3000,
    });
    const match = stdout.match(/used\s*=\s*([\d.]+)([MGT])/);
    if (!match) throw new Error('Cannot read host swap usage');
    return Number(match[1]) * 1024 ** { M: 2, G: 3, T: 4 }[match[2]];
  }
  const memory = fs.readFileSync('/proc/meminfo', 'utf8');
  return (
    (Number(memory.match(/^SwapTotal:\s+(\d+)/m)[1]) -
      Number(memory.match(/^SwapFree:\s+(\d+)/m)[1])) *
    1024
  );
}

export function ownedProcesses(rows, identities) {
  const owned = new Set(
    rows
      .filter((row) => identities.get(row.pid) === row.identity)
      .map((row) => row.pid)
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!owned.has(row.pid) && owned.has(row.ppid)) {
        owned.add(row.pid);
        identities.set(row.pid, row.identity);
        changed = true;
      }
    }
  }
  return rows.filter((row) => owned.has(row.pid));
}

function signalProcess(row, signal) {
  try {
    process.kill(row.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export async function guard({
  pid,
  command,
  output,
  limits = {},
  cwd = process.cwd(),
}) {
  if (process.platform === 'win32')
    throw new Error('bench-guard requires macOS or Linux');
  const config = { ...defaults, ...limits };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(config.consecutive))
    throw new Error('consecutive must be an integer');
  if (Boolean(pid) === Boolean(command?.length))
    throw new Error('Select --pid or a command after --');
  fs.mkdirSync(output, { recursive: true });
  const summaryPath = path.join(output, 'guard.json');
  if (fs.existsSync(summaryPath))
    throw new Error(
      'Use a new guard output directory; existing evidence is preserved'
    );
  const initialSwap = await swapBytes();
  const identities = new Map();
  const summary = {
    startedAt: new Date().toISOString(),
    limits: config,
    status: 'running',
    attached: Boolean(pid),
    initialSwapBytes: initialSwap,
  };
  const save = () =>
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  let child;
  if (command?.length) {
    const fd = fs.openSync(path.join(output, 'workload.log'), 'wx');
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      pid = child.pid;
    } finally {
      fs.closeSync(fd);
    }
  }
  summary.pid = pid;
  const started = performance.now();
  let requestedSignal;
  const onInt = () => {
    requestedSignal = 'SIGINT';
  };
  const onTerm = () => {
    requestedSignal = 'SIGTERM';
  };
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  let pressureCount = 0;
  let stopAt = null;
  let rootIdentity;
  try {
    const root = (await processTable()).find((row) => row.pid === pid);
    if (!root) {
      if (!child) throw new Error(`PID ${pid} is not running`);
    } else {
      rootIdentity = root.identity;
      identities.set(pid, rootIdentity);
    }
    summary.rootIdentity = rootIdentity;
    save();
    while (true) {
      const rows = await processTable();
      const owned = ownedProcesses(rows, identities);
      const root = owned.find(
        (row) => row.pid === pid && row.identity === rootIdentity
      );
      const sample = {
        at: new Date().toISOString(),
        elapsedSeconds: (performance.now() - started) / 1000,
        rssBytes: owned.reduce((sum, row) => sum + row.rss, 0),
        freeBytes: os.freemem(),
        load1: os.loadavg()[0],
        swapBytes: await swapBytes(),
        pids: owned.map((row) => row.pid),
      };
      sample.pressure = pressureReasons(sample, config, initialSwap);
      pressureCount = sample.pressure.length ? pressureCount + 1 : 0;
      fs.appendFileSync(
        path.join(output, 'host.ndjson'),
        JSON.stringify(sample) + '\n'
      );
      if (!owned.length) {
        summary.status =
          stopAt !== null
            ? 'stopped'
            : child
              ? child.exitCode === 0
                ? 'completed'
                : 'workload-failed'
              : 'target-exited';
        summary.exitCode = child?.exitCode ?? null;
        summary.signal = child?.signalCode ?? null;
        break;
      }
      if (stopAt === null) {
        const reason = requestedSignal
          ? `Supervisor received ${requestedSignal}`
          : !root
            ? 'Root exited with surviving descendants'
            : sample.elapsedSeconds >= config.maxSeconds
              ? 'Wall-time limit'
              : pressureCount >= config.consecutive
                ? sample.pressure.join(', ')
                : null;
        if (reason) {
          summary.reason = reason;
          summary.status = 'stopping';
          stopAt = performance.now();
          save();
          // Let the benchmark's own handler save results and stop app/Mongo groups.
          if (root) signalProcess(root, 'SIGINT');
        }
      } else if (performance.now() - stopAt >= config.graceMs) {
        // Recheck identities every time, including children reparented after exit.
        const signal =
          performance.now() - stopAt >= config.graceMs + 3000
            ? 'SIGKILL'
            : 'SIGTERM';
        for (const row of owned.reverse()) signalProcess(row, signal);
        if (performance.now() - stopAt > config.graceMs + 10000)
          throw new Error('Owned processes did not exit after SIGKILL');
      }
      await delay(
        Math.min(config.intervalMs, stopAt === null ? config.intervalMs : 200)
      );
    }
  } catch (error) {
    summary.status = 'monitor-error';
    summary.reason = error.message;
    // A monitoring failure is not permission to leave an unguarded workload running.
    const owned = ownedProcesses(await processTable(), identities);
    for (const row of owned) signalProcess(row, 'SIGTERM');
    await delay(1000);
    for (const row of ownedProcesses(await processTable(), identities))
      signalProcess(row, 'SIGKILL');
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    summary.finishedAt = new Date().toISOString();
    save();
  }
  return summary;
}

async function main() {
  const split = process.argv.indexOf('--', 2);
  const { values } = parseArgs({
    args: process.argv.slice(2, split === -1 ? undefined : split),
    options: Object.fromEntries(
      [
        'pid',
        'output',
        'max-seconds',
        'max-rss-gib',
        'min-free-gib',
        'max-load',
        'max-swap-growth-mib',
      ].map((name) => [name, { type: 'string' }])
    ),
  });
  if (!values.output)
    throw new Error(
      'Provide --output <new-directory> and --pid <PID> or -- <command>'
    );
  const limits = {};
  for (const [flag, name] of Object.entries({
    'max-seconds': 'maxSeconds',
    'max-rss-gib': 'maxRssGiB',
    'min-free-gib': 'minFreeGiB',
    'max-load': 'maxLoad',
    'max-swap-growth-mib': 'maxSwapGrowthMiB',
  })) {
    if (values[flag] !== undefined) limits[name] = Number(values[flag]);
  }
  const pid = values.pid === undefined ? undefined : Number(values.pid);
  if (
    pid !== undefined &&
    (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
  )
    throw new Error('Invalid target PID');
  const result = await guard({
    pid,
    command: split === -1 ? undefined : process.argv.slice(split + 1),
    output: path.resolve(values.output),
    limits,
  });
  console.log(JSON.stringify(result));
  process.exitCode = ['completed', 'target-exited'].includes(result.status)
    ? 0
    : 2;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
