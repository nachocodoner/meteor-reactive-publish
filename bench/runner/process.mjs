import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const children = new Set();
let interrupted;
export const interruption = () => interrupted;

export async function waitUntilScheduled(deadline) {
  // Node timers round fractional delays down. Recheck the monotonic deadline so
  // offered work never starts early and scheduling lag remains nonnegative.
  while (performance.now() < deadline) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    await delay(Math.max(1, deadline - performance.now()));
  }
}
export function launch(command, args, { cwd, env = {}, log } = {}) {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  const stream = log ? fs.createWriteStream(log, { flags: 'a' }) : null;
  for (const source of [child.stdout, child.stderr])
    source.on('data', (data) => {
      output = (output + data.toString()).slice(-16000);
      stream?.write(data);
    });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      children.delete(child);
      stream?.end();
      resolve({ code, signal, output });
    });
  });
  completion.catch(() => {});
  return { child, completion, output: () => output };
}

export async function stop(handle) {
  if (!handle?.child?.pid) return;
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const kill = (signal) => {
    try {
      process.kill(
        process.platform === 'win32' ? child.pid : -child.pid,
        signal
      );
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  kill('SIGTERM');
  let timer;
  const closed = await Promise.race([
    handle.completion.then(
      () => true,
      () => true
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 3000);
    }),
  ]);
  clearTimeout(timer);
  if (!closed) {
    kill('SIGKILL');
    await handle.completion.catch(() => {});
  }
}

export async function command(commandName, args, options = {}) {
  const handle = launch(commandName, args, options);
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${commandName} timed out`)),
      options.timeout || 600000
    );
  });
  try {
    const result = await Promise.race([handle.completion, expired]);
    if (result.code !== 0)
      throw new Error(
        `${commandName} exited ${result.code}:\n${result.output}`
      );
    return result.output.trim();
  } finally {
    clearTimeout(timer);
    await stop(handle);
  }
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function until(
  fn,
  { timeout = 30000, interval = 50, label = 'condition' } = {}
) {
  const start = performance.now();
  let last;
  while (performance.now() - start < timeout) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      if (error.fatal) throw error;
      last = error;
    }
    await delay(interval);
  }
  throw new Error(
    `Timeout waiting for ${label}${last ? `: ${last.message}` : ''}`
  );
}

export function installSignalCleanup() {
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      interrupted = signal;
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
      await Promise.all(
        [...children].map((child) =>
          stop({
            child,
            completion: new Promise((resolve) => child.once('close', resolve)),
          })
        )
      );
    });
}
