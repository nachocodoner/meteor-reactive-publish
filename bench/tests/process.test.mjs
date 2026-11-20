import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { command, waitUntilScheduled } from '../runner/process.mjs';

test('fractional offered-load deadlines never dispatch early', async () => {
  for (let i = 0; i < 10; i++) {
    const scheduled = performance.now() + 1.7;
    await waitUntilScheduled(scheduled);
    assert.ok(performance.now() >= scheduled);
  }
});

test('a timed-out command terminates its owned process', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bench-process-test-')
  );
  const file = path.join(directory, 'pid');
  try {
    await assert.rejects(
      command(
        process.execPath,
        [
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
        { timeout: 1000 }
      ),
      /timed out/
    );
    const pid = Number(await fs.readFile(file, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('SIGTERM to the runner cleans up its detached child', async () => {
  const module = new URL('../runner/process.mjs', import.meta.url).href;
  const controller = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { launch, installSignalCleanup } from ${JSON.stringify(module)};
    installSignalCleanup();
    const child = launch(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    console.log(child.child.pid);
  `,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  let childPid;
  try {
    childPid = Number(
      (await once(controller.stdout, 'data'))[0].toString().trim()
    );
    const exited = once(controller, 'exit');
    controller.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 143);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally {
    controller.kill('SIGKILL');
    if (childPid) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        /* already reaped */
      }
    }
  }
});
