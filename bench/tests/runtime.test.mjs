import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  runtimeOptions,
  resolveMeteorRuntime,
  writeRuntimeRelease,
  runtimeNode,
  assertRuntimeUnchanged,
} from '../runner/runtime.mjs';
import { command } from '../runner/process.mjs';
import { buildApp } from '../runner/build.mjs';

const git = (cwd, ...args) => command('git', args, { cwd });
const commit = (cwd) =>
  git(
    cwd,
    '-c',
    'user.name=Bench test',
    '-c',
    'user.email=bench@example.invalid',
    'commit',
    '-qm',
    'fixture'
  );

async function checkout(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bench runtime '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'tools/cli'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages'));
  await fs.writeFile(path.join(root, 'tools/cli/main.js'), '// CLI fixture\n');
  await fs.writeFile(path.join(root, 'packages/core.js'), '// core fixture\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'dev_bundle/\n*.cache\n');
  await fs.writeFile(
    path.join(root, 'meteor'),
    '#!/bin/sh\nexec "$(dirname "$0")/dev_bundle/bin/node" "$@"\n',
    { mode: 0o755 }
  );
  await git(root, 'init', '-q');
  await git(root, 'add', '.');
  await commit(root);
  return { root, meteorCli: path.join(root, 'meteor') };
}

test('release selection is explicit and cannot be mixed with a checkout', async () => {
  const runtime = await resolveMeteorRuntime({ meteor: '3.5.2' });
  assert.equal(runtime.releaseFile, 'METEOR@3.5.2');
  assert.equal(runtime.lockName, '3.5.2');
  assert.throws(
    () => runtimeOptions({ meteor: '../3.5.2' }),
    /must be a version/
  );
  assert.throws(
    () => runtimeOptions({ meteor: '3.5.2', meteorCli: '/core/meteor' }),
    /not both/
  );
  await assert.rejects(
    resolveMeteorRuntime({ meteorCli: process.execPath }),
    /Meteor Git checkout/
  );
});

test('checkout fingerprints cover full tracked diffs and untracked source, including staged edits', async (t) => {
  const { root, meteorCli } = await checkout(t);
  const initial = await resolveMeteorRuntime({ meteorCli });
  assert.equal(initial.releaseFile, 'none');
  assert.equal(initial.identity.dirty, false);
  const file = path.join(root, 'packages/core.js');
  const suffix = 'x'.repeat(32000);
  await fs.writeFile(file, `first\n${suffix}\n`);
  const first = await resolveMeteorRuntime({ meteorCli });
  await fs.writeFile(file, `other\n${suffix}\n`);
  await git(root, 'add', 'packages/core.js');
  const staged = await resolveMeteorRuntime({ meteorCli });
  assert.equal(staged.identity.dirty, true);
  assert.notEqual(first.identity.hash, staged.identity.hash);
  assert.notEqual(initial.lockName, staged.lockName);
  await fs.writeFile(path.join(root, 'packages/new.js'), 'new source');
  const untracked = await resolveMeteorRuntime({ meteorCli });
  assert.notEqual(untracked.identity.hash, staged.identity.hash);
  await fs.writeFile(path.join(root, 'packages/ignored.cache'), 'build cache');
  await fs.writeFile(path.join(root, 'review-notes.md'), 'unrelated notes');
  assert.equal(
    (await resolveMeteorRuntime({ meteorCli })).identity.hash,
    untracked.identity.hash
  );
  await assert.rejects(assertRuntimeUnchanged(initial), /checkout changed/);
  await assert.rejects(
    buildApp({ meteorCli, expectedRuntime: initial.identity }),
    /runtime changed/
  );
});

test('worktrees retain source identity without aliasing executable paths', async (t) => {
  const { root, meteorCli } = await checkout(t);
  const directory = `${root}-worktree`;
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await git(root, 'worktree', 'add', '--detach', directory, 'HEAD');
  const base = await resolveMeteorRuntime({ meteorCli });
  const worktree = await resolveMeteorRuntime({
    meteorCli: path.join(directory, 'meteor'),
  });
  assert.deepEqual(base.identity, worktree.identity);
  assert.notEqual(base.cli, worktree.cli);
  await fs.writeFile(path.join(directory, 'packages/core.js'), '// changed\n');
  assert.notEqual(
    (await resolveMeteorRuntime({ meteorCli: worktree.cli })).identity.hash,
    base.identity.hash
  );
});

test('dirty submodule contents affect the checkout identity even without a new commit', async (t) => {
  const parent = await checkout(t);
  const child = await checkout(t);
  await git(
    parent.root,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    child.root,
    'packages/child'
  );
  await commit(parent.root);
  const before = await resolveMeteorRuntime(parent);
  await fs.writeFile(
    path.join(parent.root, 'packages/child/packages/core.js'),
    '// modified child\n'
  );
  const after = await resolveMeteorRuntime(parent);
  assert.notEqual(after.identity.hash, before.identity.hash);
  assert.equal(after.identity.dirty, true);
  assert.equal(after.identity.submodules[0].identity.dirty, true);
});

test('checkout app uses none and rejects a Node executable from another runtime', async (t) => {
  const { root, meteorCli } = await checkout(t);
  // A tiny CLI stand-in validates argument/cwd behavior without building Meteor.
  await fs.writeFile(
    meteorCli,
    '#!/bin/sh\nif [ "$1" = node ]; then\n  shift\nfi\nexec "$(dirname "$0")/dev_bundle/bin/node" "$@"\n',
    { mode: 0o755 }
  );
  await fs.mkdir(path.join(root, 'dev_bundle/bin'), { recursive: true });
  await fs.symlink(process.execPath, path.join(root, 'dev_bundle/bin/node'));
  const runtime = await resolveMeteorRuntime({ meteorCli });
  const app = path.join(root, 'test-app');
  await writeRuntimeRelease(app, runtime);
  assert.equal(
    await fs.readFile(path.join(app, '.meteor/release'), 'utf8'),
    'none\n'
  );
  assert.equal(await runtimeNode(runtime, app), process.execPath);
  await fs.writeFile(meteorCli, '#!/bin/sh\nprintf "%s\\n" /bin/sh\n', {
    mode: 0o755,
  });
  await assert.rejects(runtimeNode(runtime, app), /outside its checkout/);
});
