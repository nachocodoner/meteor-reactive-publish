import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { command } from './process.mjs';

export const runtimeLock = JSON.parse(
  await fs.readFile(
    new URL('../config/runtime-lock.json', import.meta.url),
    'utf8'
  )
);
const exec = promisify(execFile);
// Git output must not use command()'s bounded diagnostic tail: truncating a
// diff or filename list would silently alias different checkout contents.
const git = async (root, args) =>
  (
    await exec('git', args, {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60000,
    })
  ).stdout;

export function runtimeOptions({ meteor, meteorCli } = {}) {
  if (meteorCli && meteor)
    throw new Error(
      'Choose --meteor <release> OR --meteor-cli <checkout>/meteor, not both'
    );
  if (meteorCli) return { meteorCli: path.resolve(meteorCli) };
  const release = meteor || runtimeLock.meteor;
  if (!/^[0-9][A-Za-z0-9._-]*$/.test(release))
    throw new Error(
      'Meteor release must be a version such as 3.3.2 or 3.6-beta.0'
    );
  return { meteor: release };
}

async function checkoutIdentity(root, nested = false) {
  const revision = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
  const diff = await git(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--ignore-submodules=all',
    'HEAD',
    '--',
  ]);
  const digest = createHash('sha256')
    .update(revision)
    .update('\0')
    .update(diff);
  const paths = (
    await git(root, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ...(nested
        ? []
        : ['meteor', 'tools', 'packages', 'scripts', 'npm-packages']),
    ])
  )
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const name of paths) {
    const file = path.join(root, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error(
        `Cannot fingerprint untracked checkout directory: ${file}`
      );
    digest.update('\0').update(name).update('\0');
    digest.update(
      stat.isSymbolicLink() ? await fs.readlink(file) : await fs.readFile(file)
    );
    digest.update(String(stat.mode & 0o777));
  }
  const submodules = [];
  const entries = (await git(root, ['ls-files', '--stage', '-z']))
    .toString()
    .split('\0');
  for (const entry of entries) {
    const match = /^160000 ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    const [, pinnedRevision, name] = match;
    const directory = path.join(root, name);
    const initialized = await fs
      .stat(path.join(directory, '.git'))
      .catch(() => null);
    const identity = initialized
      ? await checkoutIdentity(directory, true)
      : null;
    submodules.push({ path: name, pinnedRevision, identity });
  }
  digest.update(JSON.stringify(submodules));
  return {
    revision,
    hash: digest.digest('hex'),
    dirty:
      !!diff.length ||
      !!paths.length ||
      submodules.some(
        ({ pinnedRevision, identity }) =>
          identity && (identity.dirty || identity.revision !== pinnedRevision)
      ),
    submodules,
  };
}

export async function resolveMeteorRuntime(options = {}) {
  const selected = runtimeOptions(options);
  if (!selected.meteorCli)
    return {
      cli: 'meteor',
      meteor: selected.meteor,
      releaseFile: `METEOR@${selected.meteor}`,
      lockName: selected.meteor,
      identity: { kind: 'release', release: selected.meteor },
    };
  const cli = await fs.realpath(selected.meteorCli).catch(() => {
    throw new Error(
      `Meteor checkout CLI does not exist: ${selected.meteorCli}`
    );
  });
  await fs.access(cli, fs.constants.X_OK);
  const root = path.dirname(cli);
  try {
    await fs.access(path.join(root, '.git'));
    await fs.access(path.join(root, 'tools/cli/main.js'));
    if (!(await fs.stat(path.join(root, 'packages'))).isDirectory())
      throw new Error();
    const top = (await git(root, ['rev-parse', '--show-toplevel']))
      .toString()
      .trim();
    if ((await fs.realpath(top)) !== root) throw new Error();
  } catch {
    throw new Error(
      '--meteor-cli must point to the executable at the root of a Meteor Git checkout (worktrees are supported)'
    );
  }
  const identity = { kind: 'checkout', ...(await checkoutIdentity(root)) };
  return {
    cli,
    checkout: root,
    meteor: `checkout-${identity.revision.slice(0, 12)}-${identity.hash.slice(0, 12)}`,
    releaseFile: 'none',
    lockName: `checkout-${identity.hash}`,
    identity,
  };
}

export async function writeRuntimeRelease(app, runtime) {
  await fs.mkdir(path.join(app, '.meteor'), { recursive: true });
  await fs.writeFile(
    path.join(app, '.meteor/release'),
    `${runtime.releaseFile}\n`
  );
}

export async function runtimeNode(runtime, app, log) {
  const node = (
    await command(runtime.cli, ['node', '-p', 'process.execPath'], {
      cwd: app,
      log,
    })
  )
    .split('\n')
    .at(-1);
  if (
    runtime.checkout &&
    (await fs.realpath(node)) !==
      (await fs.realpath(path.join(runtime.checkout, 'dev_bundle/bin/node')))
  )
    throw new Error(
      'Meteor CLI selected a Node executable outside its checkout dev bundle'
    );
  return node;
}

export async function assertRuntimeUnchanged(runtime) {
  if (!runtime.checkout) return;
  const current = await resolveMeteorRuntime({ meteorCli: runtime.cli });
  if (current.identity.hash !== runtime.identity.hash)
    throw new Error(
      'Meteor checkout changed during the build; keep core source fixed and retry'
    );
}
