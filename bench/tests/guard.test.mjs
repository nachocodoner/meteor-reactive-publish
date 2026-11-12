import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  defaults,
  guard,
  ownedProcesses,
  pressureReasons,
  processTable,
} from '../../scripts/bench-guard.mjs';

test(
  'a shell launcher remains supervised after exec replaces its executable',
  { timeout: 5000 },
  async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-guard-exec-'));
    let result;
    try {
      result = await guard({
        command: [
          '/bin/sh',
          '-c',
          'sleep 0.15; exec "$1" -e \'setInterval(() => {}, 1000)\'',
          'guard-fixture',
          process.execPath,
        ],
        output,
        limits: {
          maxSeconds: 0.6,
          intervalMs: 50,
          graceMs: 50,
          minFreeGiB: 0.000001,
          maxLoad: 100,
        },
      });
      assert.equal(result.status, 'stopped');
      assert.equal(result.reason, 'Wall-time limit');
      assert.equal(
        (await processTable()).some((row) => row.pid === result.pid),
        false
      );
    } finally {
      if (result?.pid) {
        try {
          process.kill(result.pid, 'SIGKILL');
        } catch {
          /* already stopped */
        }
      }
      fs.rmSync(output, { recursive: true, force: true });
    }
  }
);

test('pressure budgets distinguish free memory, aggregate RSS, load and new swap', () => {
  const sample = {
    rssBytes: 1024,
    freeBytes: 8 * 2 ** 30,
    load1: 2,
    swapBytes: 1024 ** 3,
  };
  assert.deepEqual(pressureReasons(sample, defaults, sample.swapBytes), []);
  assert.deepEqual(
    pressureReasons(
      {
        ...sample,
        rssBytes: 7 * 2 ** 30,
        freeBytes: 1,
        load1: 9,
        swapBytes: 2 * 2 ** 30,
      },
      defaults,
      sample.swapBytes
    ),
    [
      'workload RSS limit',
      'host free-memory floor',
      'host load limit',
      'host swap-growth limit',
    ]
  );
});

test('ownership retains reparented descendants but rejects reused PIDs and unrelated processes', () => {
  const identities = new Map([[10, 'root']]);
  const first = ownedProcesses(
    [
      { pid: 10, ppid: 1, identity: 'root' },
      { pid: 11, ppid: 10, identity: 'child' },
      { pid: 12, ppid: 11, identity: 'grandchild' },
      { pid: 99, ppid: 1, identity: 'other' },
    ],
    identities
  );
  assert.deepEqual(
    first.map((p) => p.pid),
    [10, 11, 12]
  );
  const next = ownedProcesses(
    [
      { pid: 10, ppid: 1, identity: 'replacement' },
      { pid: 11, ppid: 1, identity: 'child' },
      { pid: 99, ppid: 1, identity: 'other' },
    ],
    identities
  );
  assert.deepEqual(
    next.map((p) => p.pid),
    [11]
  );
});

test(
  'deadline kills a stubborn detached descendant and leaves an unrelated process alive',
  { timeout: 15000 },
  async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-guard-test-'));
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' }
    );
    const stubborn =
      "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);";
    const program = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{detached:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(path.join(output, 'descendant'))},String(child.pid)); setInterval(()=>{},1000);`;
    try {
      const result = await guard({
        command: [process.execPath, '-e', program],
        output,
        limits: {
          maxSeconds: 0.7,
          intervalMs: 50,
          graceMs: 50,
          maxLoad: 100,
          minFreeGiB: 0.000001,
        },
      });
      assert.equal(result.status, 'stopped');
      assert.equal(result.reason, 'Wall-time limit');
      const pid = Number(
        fs.readFileSync(path.join(output, 'descendant'), 'utf8')
      );
      assert.equal(
        (await processTable()).some((row) => row.pid === pid),
        false
      );
      process.kill(unrelated.pid, 0);
    } finally {
      unrelated.kill('SIGKILL');
      const file = path.join(output, 'descendant');
      if (fs.existsSync(file)) {
        try {
          process.kill(Number(fs.readFileSync(file)), 'SIGKILL');
        } catch {
          /* already stopped */
        }
      }
      fs.rmSync(output, { recursive: true, force: true });
    }
  }
);

test(
  'a successful workload completes without being marked interrupted',
  { timeout: 5000 },
  async () => {
    const output = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bench-guard-success-')
    );
    try {
      const result = await guard({
        command: [
          process.execPath,
          '-e',
          "setTimeout(() => console.log('done'), 100)",
        ],
        output,
        limits: { intervalMs: 50, maxLoad: 100, minFreeGiB: 0.000001 },
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.exitCode, 0);
      assert.match(
        fs.readFileSync(path.join(output, 'workload.log'), 'utf8'),
        /done/
      );
      await assert.rejects(
        guard({ command: [process.execPath, '-e', ''], output }),
        /existing evidence/
      );
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  }
);

test(
  'attached workload stops after sustained pressure without allocating memory',
  { timeout: 5000 },
  async () => {
    const output = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bench-guard-attach-')
    );
    const target = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' }
    );
    await new Promise((resolve, reject) => {
      target.once('spawn', resolve);
      target.once('error', reject);
    });
    try {
      const result = await guard({
        pid: target.pid,
        output,
        limits: {
          intervalMs: 50,
          minFreeGiB: os.totalmem() / 2 ** 30 + 1,
          maxLoad: 100,
          graceMs: 50,
        },
      });
      assert.equal(result.attached, true);
      assert.equal(result.status, 'stopped');
      assert.equal(result.reason, 'host free-memory floor');
      const samples = fs
        .readFileSync(path.join(output, 'host.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(
        samples.filter((sample) => sample.pids.includes(target.pid)).length,
        defaults.consecutive
      );
      assert.equal(
        (await processTable()).some((row) => row.pid === target.pid),
        false
      );
    } finally {
      target.kill('SIGKILL');
      fs.rmSync(output, { recursive: true, force: true });
    }
  }
);
