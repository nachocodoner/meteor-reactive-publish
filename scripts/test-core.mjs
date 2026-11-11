import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  command,
  freePort,
  installSignalCleanup,
  interruption,
  launch,
  stop,
  until,
} from '../bench/runner/process.mjs';
import { sourceInfo } from '../bench/runner/build.mjs';
import { resolveMeteorRuntime } from '../bench/runner/runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageName = 'nachocodoner:reactive-publish';
const exec = promisify(execFile);
const git = async (cwd, args) =>
  (
    await exec('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;

async function verifyCore(directory, identity) {
  const changed = (
    await git(directory, [
      'diff',
      '--name-only',
      '--ignore-submodules=all',
      'HEAD',
      '--',
    ])
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const unknown = (
    await git(directory, ['ls-files', '--others', '--exclude-standard'])
  ).trim();
  if (unknown)
    throw new Error(
      'Use an isolated checkout without untracked files: ' + directory
    );
  const generatedLocks = [];
  for (const name of changed) {
    if (!/\/\.npm\/(?:package|plugin\/[^/]+)\/npm-shrinkwrap\.json$/.test(name))
      throw new Error(
        'Core source has local changes: ' + path.join(directory, name)
      );
    const before = JSON.parse(await git(directory, ['show', 'HEAD:' + name]));
    const after = JSON.parse(
      await fs.readFile(path.join(directory, name), 'utf8')
    );
    const {
      lockfileVersion: oldFormat,
      meteorNpmDependencies: oldMetadata,
      ...oldGraph
    } = before;
    const {
      lockfileVersion: newFormat,
      meteorNpmDependencies: newMetadata,
      ...newGraph
    } = after;
    if (
      oldFormat !== 4 ||
      newFormat !== 5 ||
      oldMetadata !== undefined ||
      !newMetadata ||
      !isDeepStrictEqual(oldGraph, newGraph)
    )
      throw new Error(
        'Core dependency graph changed: ' + path.join(directory, name)
      );
    // The checkout's npm tooling upgrades these generated lock metadata fields.
    // Resolved dependencies, integrity data, production source and tests must match.
    generatedLocks.push(path.join(directory, name));
  }
  for (const submodule of identity.submodules) {
    if (
      !submodule.identity ||
      submodule.identity.revision !== submodule.pinnedRevision
    )
      throw new Error(
        'Initialize the pinned core submodule: ' + submodule.path
      );
    generatedLocks.push(
      ...(await verifyCore(
        path.join(directory, submodule.path),
        submodule.identity
      ))
    );
  }
  return generatedLocks;
}

const { values } = parseArgs({
  options: {
    checkout: { type: 'string' },
    mode: { type: 'string', default: 'package' },
    reactivity: { type: 'string', default: 'changeStreams,polling' },
    output: { type: 'string' },
    source: { type: 'string' },
    packages: { type: 'string' },
    filter: { type: 'string' },
    exclude: { type: 'string', default: '' },
    executable: { type: 'string' },
    timeout: { type: 'string', default: '5400000' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(`Run Meteor's unmodified package tests in an isolated checkout.

npm run test:core -- --checkout /path/to/meteor --mode baseline
npm run test:core -- --checkout /path/to/meteor --mode package

--reactivity changeStreams,polling|oplog,polling matches Meteor's CI modes.
--packages mongo,ddp-server and --filter select focused diagnostics; omit both for the full suite.
--exclude stylus reproduces Meteor CI's explicit exclusion; default excludes no core packages.
--source selects another reactive-publish snapshot. --output preserves logs, versions,
source identities, completed test names, failures, and summary.json.
The runner never edits or restores core source or test expectations.`);
  process.exit(0);
}
const checkout = values.checkout || process.env.METEOR_CORE_DIR;
if (!checkout)
  throw new Error('Pass --checkout /path/to/an/isolated/meteor/checkout');
if (!['baseline', 'package'].includes(values.mode))
  throw new Error('--mode must be baseline or package');
if (!['changeStreams,polling', 'oplog,polling'].includes(values.reactivity))
  throw new Error(
    '--reactivity must be changeStreams,polling or oplog,polling'
  );
const timeout = Number(values.timeout);
if (!Number.isSafeInteger(timeout) || timeout <= 0)
  throw new Error('--timeout must be a positive number of milliseconds');

installSignalCleanup();
const output = path.resolve(
  values.output ||
    path.join(root, 'bench/results', `core-${values.mode}-${Date.now()}`)
);
await fs.mkdir(output, { recursive: true });
try {
  await fs.access(path.join(output, 'summary.json'));
  throw new Error(`Results already exist in ${output}; choose a new --output`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const source = path.resolve(values.source || root);
const result = {
  status: 'incomplete',
  startedAt: new Date().toISOString(),
  mode: values.mode,
  reactivity: values.reactivity,
  scope: values.packages ? values.packages.split(',') : 'all-core-packages',
  filter: values.filter || null,
  excludedCorePackages: values.exclude.split(',').filter(Boolean),
};
let app;
let browser;
let runtime;
let sourceIdentity;
let packageDirectory;
let browserText = '';
const deadline = Date.now() + timeout;
const remaining = () => Math.max(1, deadline - Date.now());
const log = path.join(output, 'server.log');
const write = () =>
  fs.writeFile(
    path.join(output, 'summary.json'),
    JSON.stringify(result, null, 2) + '\n'
  );
try {
  runtime = await resolveMeteorRuntime({
    meteorCli: path.join(path.resolve(checkout), 'meteor'),
  });
  result.generatedLockMetadata = await verifyCore(
    runtime.checkout,
    runtime.identity
  );
  result.core = runtime.identity;
  sourceIdentity = await sourceInfo(source);
  result.source = sourceIdentity;
  // METEOR_PACKAGE_DIRS contains directories of packages, not package roots.
  // An isolated link prevents registry fallback and sibling-checkout ambiguity.
  // Keep the source link outside artifacts: following it from the results tree
  // would recurse back through the repository and its results/cache directories.
  packageDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'core-package-path-')
  );
  result.packageDirectory = packageDirectory;
  await fs.symlink(
    source,
    path.join(packageDirectory, 'reactive-publish'),
    'dir'
  );
  let executable =
    values.executable ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_BIN;
  if (!executable) {
    // The benchmark-only installation has no root Puppeteer dependency. An
    // explicit/system browser is sufficient: core owns its browser runner.
    let cachedBrowser;
    try {
      cachedBrowser = (await import('puppeteer')).default.executablePath();
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    executable = (
      await Promise.all(
        [
          cachedBrowser,
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
        ]
          .filter(Boolean)
          .map(
            async (file) =>
              await fs.access(file).then(
                () => file,
                () => null
              )
          )
      )
    ).find(Boolean);
  }
  if (!executable) throw new Error('Install Chrome or pass --executable');
  const env = {
    PUPPETEER_EXECUTABLE_PATH: executable,
    PUPPETEER_SKIP_DOWNLOAD: 'true',
    MONGO_URL: undefined,
    MONGO_OPLOG_URL: undefined,
    ROOT_URL: undefined,
    METEOR_SETTINGS: undefined,
    NODE_OPTIONS: '--max-old-space-size=4096',
    METEOR_MODERN: 'true',
    METEOR_HEADLESS: 'true',
    METEOR_NO_DEPRECATION: 'true',
    NODE_ENV: 'CI',
    METEOR_REACTIVITY_ORDER: values.reactivity,
    TIMEOUT_SCALE_FACTOR: '20',
    npm_config_audit: 'false',
    TOOL_NODE_FLAGS: '--max-old-space-size=4096',
    SERVER_NODE_OPTIONS: '--max-old-space-size=4096',
    TINYTEST_FILTER: '',
    METEOR_PACKAGE_DIRS: [
      path.join(runtime.checkout, 'packages/deprecated'),
      packageDirectory,
    ].join(path.delimiter),
  };
  console.log(
    `[core] ${values.mode}, ${values.reactivity}, ${runtime.identity.revision}`
  );
  console.log(`[core] Server log: ${log}`);
  await command(runtime.cli, ['--help'], {
    cwd: runtime.checkout,
    env,
    log,
    timeout: remaining(),
  });
  const node = path.join(runtime.checkout, 'dev_bundle/bin/node');
  result.node = await command(node, ['--version'], {
    cwd: runtime.checkout,
    env,
  });
  result.devBundle = (
    await fs.readFile(
      path.join(runtime.checkout, 'dev_bundle/.bundle_version.txt'),
      'utf8'
    )
  ).trim();
  const installed = await command(
    node,
    [
      '-e',
      "console.log(require('./dev_bundle/lib/node_modules/puppeteer/package.json').version)",
    ],
    { cwd: runtime.checkout, env }
  ).catch(() => '');
  if (installed !== '25.9.0')
    await command(
      runtime.cli,
      [
        'npm',
        'install',
        '-g',
        '--prefix',
        path.join(runtime.checkout, 'dev_bundle'),
        'puppeteer@25.9.0',
      ],
      { cwd: runtime.checkout, env, log, timeout: remaining() }
    );
  // npm run can inherit a prefix for the host Node installation. Install in
  // the core bundle explicitly and fail before building if it cannot be loaded.
  await command(
    node,
    [
      '-e',
      "require('./dev_bundle/lib/node_modules/puppeteer'); if (require('./dev_bundle/lib/node_modules/puppeteer/package.json').version !== '25.9.0') process.exit(1)",
    ],
    { cwd: runtime.checkout, env, log, timeout: remaining() }
  );
  // Keep the generated app outside this repository's ESM package scopes.
  result.app = await fs.mkdtemp(
    path.join(os.tmpdir(), 'reactive-publish-core-')
  );
  let port;
  // Meteor also owns the adjacent MongoDB port.
  for (let attempt = 0; attempt < 20; attempt++) {
    port = await freePort();
    if (port >= 65535) {
      port = null;
      continue;
    }
    const net = await import('node:net');
    if (
      await new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port + 1, '127.0.0.1', () =>
          server.close(() => resolve(true))
        );
      })
    )
      break;
    port = null;
  }
  if (!port) throw new Error('Could not reserve an HTTP/MongoDB port pair');
  const excluded = [packageName, ...result.excludedCorePackages];
  const args = [
    'test-packages',
    '--driver-package',
    'test-in-console',
    '--once',
    '--port',
    String(port),
    '--test-app-path',
    result.app,
    '--exclude',
    excluded.join(','),
  ];
  if (values.mode === 'package') args.push('--extra-packages', packageName);
  if (values.filter) args.push('--filter', values.filter);
  if (values.packages) args.push(...result.scope);
  result.args = args;
  result.url = `http://127.0.0.1:${port}/`;
  await write();
  app = launch(runtime.cli, args, { cwd: runtime.checkout, env, log });
  await until(
    async () => {
      if (app.child.exitCode !== null || app.child.signalCode !== null)
        throw Object.assign(
          new Error(`Meteor exited before readiness:\n${app.output()}`),
          { fatal: true }
        );
      if (!app.output().includes('test-in-console listening')) return false;
      return fetch(result.url, { signal: AbortSignal.timeout(3000) }).then(
        (r) => r.ok,
        () => false
      );
    },
    { timeout: remaining(), interval: 500, label: 'core test app readiness' }
  );
  const versions = await fs.readFile(
    path.join(result.app, '.meteor/versions'),
    'utf8'
  );
  await fs.writeFile(path.join(output, 'versions.txt'), versions);
  const containsPackage = versions
    .split('\n')
    .some((line) => line.startsWith(packageName + '@'));
  if (containsPackage !== (values.mode === 'package'))
    throw new Error(
      'Resolved package graph does not match the selected test mode'
    );
  if (versions.includes('local-test:' + packageName + '@'))
    throw new Error(
      'The package under comparison must not add its own tests to the core inventory'
    );
  if (values.mode === 'package') {
    const buildInfoPath = path.join(
      result.app,
      '.meteor/local/isopacks/nachocodoner_reactive-publish/isopack-buildinfo.json'
    );
    const buildInfo = JSON.parse(await fs.readFile(buildInfoPath, 'utf8'));
    const watched = new Map();
    for (const dependencies of Object.values(buildInfo.unibuildDependencies)) {
      for (const [file, hash] of Object.entries(dependencies.files)) {
        const real = await fs.realpath(file).catch(() => file);
        watched.set(real, hash);
      }
    }
    const productionFiles = sourceIdentity.names.filter(
      (name) =>
        name === 'package.js' ||
        name === 'main.js' ||
        (name.startsWith('lib/') &&
          name.endsWith('.js') &&
          !name.endsWith('.tests.js') &&
          name !== 'lib/testHelpers.js')
    );
    result.verifiedSourceFiles = [];
    for (const name of productionFiles) {
      const file = await fs.realpath(path.join(source, name));
      const hash = createHash('sha1')
        .update(await fs.readFile(file))
        .digest('hex');
      if (watched.get(file) !== hash)
        throw new Error(
          'Compiled package source does not match selected source: ' + name
        );
      result.verifiedSourceFiles.push(name);
    }
    await fs.copyFile(
      buildInfoPath,
      path.join(output, 'package-buildinfo.json')
    );
  }
  console.log(
    `[core] App ready; executing upstream Puppeteer runner at ${result.url}`
  );
  browser = launch(
    node,
    [
      path.join(
        runtime.checkout,
        'packages/test-in-console/puppeteer_runner.js'
      ),
    ],
    {
      cwd: runtime.checkout,
      env: { ...env, URL: result.url },
      log: path.join(output, 'browser.log'),
    }
  );
  for (const stream of [browser.child.stdout, browser.child.stderr])
    stream.on('data', (data) => {
      browserText += data.toString();
      process.stdout.write(data);
    });
  let timer;
  let completed;
  try {
    completed = await Promise.race([
      browser.completion,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Core suite exceeded its overall timeout')),
          remaining()
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const match =
    /passed\/expected\/failed\/total\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/.exec(
      browserText
    );
  if (!match)
    throw new Error(
      'The upstream driver did not report a completed test suite'
    );
  result.tests = Object.fromEntries(
    ['passed', 'expected', 'failed', 'total'].map((name, index) => [
      name,
      Number(match[index + 1]),
    ])
  );
  if (!result.tests.total) throw new Error('The test inventory was empty');
  result.completedTests = [
    ...new Set(
      [
        ...browserText.matchAll(
          /^([SC]): (.+?) : (?:OK|EXPECTED FAILURE|!+ FAIL !+)/gm
        ),
      ].map((m) => `${m[1]}: ${m[2]}`)
    ),
  ].sort();
  result.browserExitCode = completed.code;
  result.status =
    completed.code === 0 && result.tests.failed === 0 ? 'passed' : 'failed';
} catch (error) {
  result.error = error.stack || String(error);
  console.error(result.error);
} finally {
  await stop(browser);
  await stop(app);
  if (packageDirectory)
    await fs.rm(packageDirectory, { recursive: true, force: true });
  if (runtime) {
    try {
      const after = await resolveMeteorRuntime({ meteorCli: runtime.cli });
      if (after.identity.revision !== runtime.identity.revision) {
        result.status = 'invalid';
        result.identityError = 'Core revision changed during the run';
      } else {
        result.generatedLockMetadata = await verifyCore(
          after.checkout,
          after.identity
        );
        result.coreUnchanged = true;
      }
      result.sourceUnchanged =
        (await sourceInfo(source)).hash === sourceIdentity.hash;
      if (!result.sourceUnchanged) {
        result.status = 'invalid';
        result.identityError = 'Reactive-publish source changed during the run';
      }
    } catch (error) {
      result.status = 'invalid';
      result.identityError = error.message;
    }
  }
  result.finishedAt = new Date().toISOString();
  await write();
}
console.log(`[core] ${result.status}: ${path.join(output, 'summary.json')}`);
if (result.status !== 'passed')
  process.exitCode = interruption() === 'SIGINT' ? 130 : 1;
