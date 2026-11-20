// npm ci --prefix bench && npm run test:observers -- native|redis
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, sourceInfo } from '../bench/runner/build.mjs';
import { startMongo } from '../bench/runner/mongo.mjs';
import {
  command,
  freePort,
  installSignalCleanup,
  launch,
  stop,
  until,
} from '../bench/runner/process.mjs';
import {
  resolveMeteorRuntime,
  runtimeNode,
  writeRuntimeRelease,
} from '../bench/runner/runtime.mjs';
import { exercise } from './observers/cases.mjs';

const [driver = 'native', source = repoRoot] = process.argv.slice(2);
if (!['native', 'redis'].includes(driver))
  throw new Error(
    'Expected native or redis and an optional local package path'
  );
const runtime = await resolveMeteorRuntime({ meteor: '3.6' });
const app = await fs.mkdtemp(path.join(os.tmpdir(), 'observer-regression-'));
let server, mongo, redis, redisCli;
installSignalCleanup();
try {
  await writeRuntimeRelease(app, runtime);
  const local = path.join(app, 'packages/reactive-publish');
  const info = await sourceInfo(source);
  for (const name of [...info.names, 'README.md']) {
    await fs.mkdir(path.dirname(path.join(local, name)), { recursive: true });
    await fs.copyFile(path.join(source, name), path.join(local, name));
  }
  const packages = [
    'meteor-base',
    'mongo',
    'ecmascript',
    'nachocodoner:reactive-publish',
  ];
  if (driver === 'redis')
    packages.push('disable-oplog', 'cultofcoders:redis-oplog@=3.0.1');
  await fs.writeFile(
    path.join(app, '.meteor/packages'),
    packages.join('\n') + '\n'
  );
  await fs.writeFile(path.join(app, '.meteor/platforms'), 'server\nbrowser\n');
  // Reuse the locked Meteor app npm dependencies and entry-point convention.
  for (const file of ['package.json', 'package-lock.json'])
    await fs.copyFile(
      path.join(repoRoot, 'bench/app', file),
      path.join(app, file)
    );
  for (const dir of ['client', 'server']) await fs.mkdir(path.join(app, dir));
  await fs.writeFile(path.join(app, 'client/main.js'), '');
  await fs.copyFile(
    new URL('./observers/server.js', import.meta.url),
    path.join(app, 'server/main.js')
  );
  const node = await runtimeNode(runtime, app);
  await command('npm', ['ci', '--no-audit', '--no-fund'], { cwd: app });
  mongo = await startMongo({ node });

  const settings = {};
  if (driver === 'redis') {
    const port = await freePort();
    redis = launch('redis-server', [
      '--bind',
      '127.0.0.1',
      '--port',
      String(port),
      '--dir',
      app,
      '--save',
      '',
      '--appendonly',
      'no',
    ]);
    redisCli = (...args) =>
      command('redis-cli', [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '--raw',
        ...args,
      ]);
    await until(async () => (await redisCli('PING')) === 'PONG', {
      label: 'private Redis',
    });
    settings.manualRedisOplog = {
      redis: { host: '127.0.0.1', port, url: `redis://127.0.0.1:${port}` },
      mutationDefaults: { optimistic: false, pushToRedis: true },
    };
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  console.log(
    `Testing ${info.hash} on Meteor ${runtime.meteor}, ${driver}, Mongo ${mongo.version}`
  );
  server = launch(
    runtime.cli,
    [
      'run',
      '--once',
      '--port',
      `127.0.0.1:${port}`,
      '--exclude-archs',
      'web.browser.legacy,web.cordova',
    ],
    {
      cwd: app,
      env: {
        ROOT_URL: url,
        BIND_IP: '127.0.0.1',
        METEOR_LOCAL_DIR: path.join(app, '.meteor/local'),
        MONGO_URL: mongo.url,
        MONGO_OPLOG_URL: redis ? '' : mongo.oplog,
        METEOR_REACTIVITY_ORDER: redis ? undefined : 'oplog',
        METEOR_SETTINGS: JSON.stringify(settings),
        REDIS_OPLOG_SETTINGS: undefined,
        METEOR_PACKAGE_DIRS: '',
      },
    }
  );
  await until(
    async () => {
      if (server.child.exitCode !== null || server.child.signalCode)
        throw Object.assign(new Error(server.output()), { fatal: true });
      return (
        server.output().includes('Observer fixtures ready') &&
        (await fetch(`${url}/sockjs/info`)).ok
      );
    },
    { timeout: 600000, label: 'Meteor app startup' }
  );
  const versions = await fs.readFile(
    path.join(app, '.meteor/versions'),
    'utf8'
  );
  const resolved = versions.match(/^cultofcoders:redis-oplog@(.+)$/m)?.[1];
  assert.equal(resolved, driver === 'redis' ? '3.0.1' : undefined);
  await exercise(url, redisCli);
} finally {
  if (process.exitCode) console.error(server?.output());
  await stop(server);
  await stop(redis);
  await mongo?.close();
  await fs.rm(app, { recursive: true, force: true });
}
