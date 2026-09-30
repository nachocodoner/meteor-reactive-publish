import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { command } from './process.mjs';
import {
  runtimeLock,
  resolveMeteorRuntime,
  writeRuntimeRelease,
  runtimeNode,
  assertRuntimeUnchanged,
} from './runtime.mjs';

export const benchRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = path.dirname(benchRoot.replace(/\/$/, ''));
export { runtimeLock };
export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

async function files(root, relative = '') {
  const entries = await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  const output = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      ['node_modules', '.git', '.meteor', '.npm', 'results', 'cache'].includes(
        entry.name
      )
    )
      continue;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...(await files(root, name)));
    else if (entry.isFile()) output.push(name);
  }
  return output;
}

export async function sourceInfo(source) {
  const names = [
    'package.js',
    'main.js',
    ...(await files(path.join(source, 'lib'))).map((name) => `lib/${name}`),
  ];
  for (const optional of ['index.d.ts', 'package-types.json'])
    if (await fs.stat(path.join(source, optional)).catch(() => null))
      names.push(optional);
  const digest = createHash('sha256');
  for (const name of names.sort()) {
    digest.update(name);
    digest.update('\0');
    digest.update(await fs.readFile(path.join(source, name)));
  }
  let revision = 'unversioned';
  try {
    revision = await command('git', ['rev-parse', 'HEAD'], { cwd: source });
  } catch {
    /* external snapshots can be unversioned */
  }
  try {
    revision = (
      await fs.readFile(path.join(source, '.bench-source-revision'), 'utf8')
    ).trim();
  } catch {
    /* regular checkout */
  }
  return { hash: digest.digest('hex'), revision, names };
}

export async function harnessHash() {
  const digest = createHash('sha256');
  for (const name of await files(benchRoot)) {
    if (
      name.endsWith('.md') ||
      name.startsWith('tests/') ||
      name.startsWith('baselines/')
    )
      continue;
    digest.update(name);
    digest.update(await fs.readFile(path.join(benchRoot, name)));
  }
  return digest.digest('hex');
}

export async function buildApp({
  adapter,
  source,
  meteor,
  meteorCli,
  expectedRuntime,
  log,
  rebuild = false,
}) {
  const runtime = await resolveMeteorRuntime({ meteor, meteorCli });
  if (
    expectedRuntime &&
    JSON.stringify(runtime.identity) !== JSON.stringify(expectedRuntime)
  )
    throw new Error(
      'Meteor runtime changed during this invocation; keep core source fixed and retry'
    );
  const info = await sourceInfo(source);
  const harness = await harnessHash();
  const inputs = [];
  for (const directory of ['app', 'adapters', 'fixtures', 'variants']) {
    for (const name of await files(path.join(benchRoot, directory)).catch(
      () => []
    ))
      inputs.push([
        `${directory}/${name}`,
        await fs.readFile(path.join(benchRoot, directory, name), 'utf8'),
      ]);
  }
  const key = hash({
    adapter,
    package: ['reactive', 'installed'].includes(adapter) ? info.hash : null,
    inputs,
    runtimeLock,
    runtime: runtime.identity,
    // Checkout Node paths are mutable and location-dependent; caches cannot
    // reuse an executable from another checkout with identical source.
    meteorCli: runtime.checkout ? runtime.cli : null,
    platform: os.platform(),
    arch: os.arch(),
  });
  const cache = path.join(
    os.tmpdir(),
    `reactive-publish-bench-${os.userInfo().uid}`,
    key
  );
  const complete = path.join(cache, 'complete.json');
  if (!rebuild) {
    try {
      return {
        ...JSON.parse(await fs.readFile(complete, 'utf8')),
        source: info,
        harness,
      };
    } catch {
      /* first build */
    }
  }
  // A per-build lock prevents two processes from mutating the same app/cache.
  await fs.mkdir(path.dirname(cache), { recursive: true });
  const lockPath = `${cache}.lock`;
  const lock = await fs.open(lockPath, 'wx').catch(() => {
    throw new Error(
      `Build already locked: ${lockPath}. Remove a stale lock only after its process exits.`
    );
  });
  await lock.writeFile(String(process.pid));
  try {
    await fs.rm(cache, { recursive: true, force: true });
    const app = path.join(cache, 'app');
    await fs.cp(path.join(benchRoot, 'app'), app, {
      recursive: true,
      filter: (name) => !name.split(path.sep).includes('node_modules'),
    });
    await writeRuntimeRelease(app, runtime);
    await fs.writeFile(
      path.join(app, '.meteor/platforms'),
      'server\nbrowser\n'
    );
    const basePackages = [
      'meteor-base',
      'mongo',
      'ecmascript',
      'webapp',
      'ddp-client',
      'standard-minifier-js',
    ];
    if (['reactive', 'installed'].includes(adapter)) {
      basePackages.push('nachocodoner:reactive-publish');
      const destination = path.join(app, 'packages/reactive-publish');
      for (const name of info.names) {
        await fs.mkdir(path.dirname(path.join(destination, name)), {
          recursive: true,
        });
        await fs.copyFile(
          path.join(source, name),
          path.join(destination, name)
        );
      }
      await fs.writeFile(
        path.join(destination, 'README.md'),
        'Local package snapshot for benchmarking.\n'
      );
    }
    if (adapter === 'composite')
      basePackages.push(`reywood:publish-composite@=${runtimeLock.composite}`);
    await fs.writeFile(
      path.join(app, '.meteor/packages'),
      `${basePackages.join('\n')}\n`
    );
    const versionsLock = path.join(
      benchRoot,
      'variants',
      adapter,
      `${runtime.lockName}.versions`
    );
    try {
      await fs.copyFile(versionsLock, path.join(app, '.meteor/versions'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.copyFile(
      path.join(benchRoot, 'fixtures/model.mjs'),
      path.join(app, 'imports/model.js')
    );
    await fs.copyFile(
      path.join(
        benchRoot,
        'adapters',
        `${adapter === 'installed' ? 'native' : adapter}.js`
      ),
      path.join(app, 'imports/adapter.js')
    );
    console.error(
      `Building ${adapter} with Meteor ${runtime.meteor} (log: ${log})`
    );
    const node = await runtimeNode(runtime, app, log);
    const npm = path.resolve(node, '../../lib/node_modules/npm/bin/npm-cli.js');
    await command(node, [npm, 'ci', '--no-audit', '--no-fund'], {
      cwd: app,
      log,
    });
    await command(
      runtime.cli,
      ['build', path.join(cache, 'build'), '--directory', '--server-only'],
      { cwd: app, log, timeout: 1200000 }
    );
    const bundle = path.join(cache, 'build/bundle');
    await command(
      node,
      [npm, 'install', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: path.join(bundle, 'programs/server'), log, timeout: 600000 }
    );
    const versions = await fs.readFile(
      path.join(app, '.meteor/versions'),
      'utf8'
    );
    const reactiveLoaded = versions.includes('nachocodoner:reactive-publish@');
    if (reactiveLoaded !== ['reactive', 'installed'].includes(adapter))
      throw new Error('Package isolation check failed');
    await assertRuntimeUnchanged(runtime);
    const result = {
      key,
      app,
      bundle,
      node,
      versions,
      meteor: runtime.meteor,
      runtime,
    };
    await fs.writeFile(complete, JSON.stringify(result));
    return { ...result, source: info, harness };
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

export async function lockVersions(build, adapter) {
  const target = path.join(
    benchRoot,
    'variants',
    adapter,
    `${build.runtime?.lockName || build.meteor}.versions`
  );
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, build.versions);
  return target;
}
