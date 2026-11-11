import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const runner = fileURLToPath(
  new URL('../../scripts/test-core.mjs', import.meta.url)
);

async function fixture(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-runner-test-'));
  const core = path.join(root, 'core');
  const source = path.join(root, 'source');
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const git = (...args) => exec('git', args, { cwd: core });
  try {
    await write(
      path.join(source, 'package.js'),
      "Package.describe({name:'nachocodoner:reactive-publish'});\n"
    );
    await write(path.join(source, 'main.js'), 'export {};\n');
    await fs.mkdir(path.join(source, 'lib'));
    await write(path.join(core, '.gitignore'), 'dev_bundle/\nseen.json\n');
    await write(
      path.join(core, 'tools/cli/main.js'),
      '// unchanged core entry\n'
    );
    await write(
      path.join(core, 'packages/sentinel.tests.js'),
      "const expectedMessages = ['sub', 'added', 'ready'];\n"
    );
    await write(
      path.join(core, 'packages/test-in-console/puppeteer_runner.js'),
      `
console.log('C: tinytest - fixture - contract : ' + (process.env.FAKE_FAILURE ? '!!!!!!!!! FAIL !!!!!!!!!!!' : 'OK'));
console.log(process.env.FAKE_FAILURE ? 'passed/expected/failed/total 0 / 0 / 1 / 1' : 'passed/expected/failed/total 1 / 0 / 0 / 1');
// A successful process must not hide failed assertions.
process.exit(0);
`
    );
    await write(
      path.join(core, 'meteor'),
      `#!/usr/bin/env node
const fs=require('node:fs'); const path=require('node:path');
const args=process.argv.slice(2); if(args[0]==='--help') process.exit(0);
fs.writeFileSync('seen.json',JSON.stringify(args));
if(process.env.FAKE_MUTATE_CORE)fs.appendFileSync('packages/sentinel.tests.js','// unexpected mutation\\n');
const app=args[args.indexOf('--test-app-path')+1];
fs.mkdirSync(path.join(app,'.meteor'),{recursive:true});
fs.writeFileSync(path.join(app,'.meteor/versions'), args.includes('--extra-packages') && !process.env.FAKE_WRONG_GRAPH ? 'nachocodoner:reactive-publish@1.1.1\\n' : 'meteor@3.6.0\\n');
if(args.includes('--extra-packages')) {
 const search=process.env.METEOR_PACKAGE_DIRS.split(path.delimiter);
 const selected=search.map(dir=>path.join(dir,'reactive-publish')).find(dir=>fs.existsSync(path.join(dir,'package.js')));
 if(!selected) throw new Error('Selected source is not discoverable as a local package');
 const files=Object.fromEntries(['package.js','main.js'].map(name=>{
  const file=fs.realpathSync(path.join(selected,name));
  return [file,process.env.FAKE_WRONG_SOURCE ? 'wrong' : require('node:crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex')];
 }));
 const dir=path.join(app,'.meteor/local/isopacks/nachocodoner_reactive-publish');
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'isopack-buildinfo.json'),JSON.stringify({unibuildDependencies:{'os.json':{files}}}));
}
require('node:http').createServer((req,res)=>res.end('test app')).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1',()=>console.log('test-in-console listening'));
`
    );
    await fs.chmod(path.join(core, 'meteor'), 0o755);
    await fs.mkdir(path.join(core, 'dev_bundle/bin'), { recursive: true });
    await fs.symlink(process.execPath, path.join(core, 'dev_bundle/bin/node'));
    await write(path.join(core, 'dev_bundle/.bundle_version.txt'), 'fixture\n');
    await write(
      path.join(core, 'dev_bundle/lib/node_modules/puppeteer/package.json'),
      '{"version":"25.9.0"}\n'
    );
    await git('init', '-q');
    await git('add', '.');
    await git(
      '-c',
      'user.name=Test fixture',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture'
    );
    const invoke = async (mode, extraEnv = {}) => {
      const output = path.join(root, 'results-' + mode);
      let execution;
      try {
        execution = await exec(
          process.execPath,
          [
            runner,
            '--checkout',
            core,
            '--source',
            source,
            '--mode',
            mode,
            '--output',
            output,
            '--executable',
            process.execPath,
            '--timeout',
            '20000',
          ],
          { env: { ...process.env, ...extraEnv }, timeout: 30000 }
        );
        execution.code = 0;
      } catch (error) {
        execution = error;
      }
      return {
        execution,
        summary: JSON.parse(
          await fs.readFile(path.join(output, 'summary.json'))
        ),
        args: JSON.parse(await fs.readFile(path.join(core, 'seen.json'))),
      };
    };
    await work({ invoke, git, core });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('core runner selects the full upstream baseline and leaves tests untouched', async () => {
  await fixture(async ({ invoke, git }) => {
    const { execution, summary, args } = await invoke('baseline');
    assert.equal(execution.code, 0, execution.stderr);
    assert.equal(summary.status, 'passed');
    assert.equal(summary.scope, 'all-core-packages');
    assert.deepEqual(summary.excludedCorePackages, []);
    assert.equal(args.includes('--extra-packages'), false);
    assert.equal(args.includes('--filter'), false);
    assert.equal(
      args[args.indexOf('--exclude') + 1],
      'nachocodoner:reactive-publish'
    );
    assert.equal(summary.tests.total, 1);
    assert.deepEqual(summary.completedTests, [
      'C: tinytest - fixture - contract',
    ]);
    assert.equal(summary.coreUnchanged, true);
    assert.equal((await git('diff', '--exit-code')).stdout, '');
  });
});

test('core runner loads the package through the CLI and propagates assertion failures', async () => {
  await fixture(async ({ invoke, git }) => {
    const { execution, summary, args } = await invoke('package', {
      FAKE_FAILURE: '1',
    });
    assert.equal(execution.code, 1);
    assert.equal(summary.status, 'failed');
    assert.equal(summary.browserExitCode, 0);
    assert.equal(summary.tests.failed, 1);
    assert.deepEqual(summary.verifiedSourceFiles, ['main.js', 'package.js']);
    assert.equal(
      args[args.indexOf('--extra-packages') + 1],
      'nachocodoner:reactive-publish'
    );
    assert.equal((await git('diff', '--exit-code')).stdout, '');
  });
});

test('core runner rejects a missing package instead of comparing the wrong graph', async () => {
  await fixture(async ({ invoke }) => {
    const { execution, summary } = await invoke('package', {
      FAKE_WRONG_GRAPH: '1',
    });
    assert.equal(execution.code, 1);
    assert.equal(summary.status, 'incomplete');
    assert.match(summary.error, /package graph does not match/);
    assert.equal(summary.tests, undefined);
  });
});

test('core runner detects changed upstream assertions without resetting them', async () => {
  await fixture(async ({ invoke, core }) => {
    const { execution, summary } = await invoke('baseline', {
      FAKE_MUTATE_CORE: '1',
    });
    assert.equal(execution.code, 1);
    assert.equal(summary.status, 'invalid');
    assert.match(summary.identityError, /Core source has local changes/);
    assert.match(
      await fs.readFile(path.join(core, 'packages/sentinel.tests.js'), 'utf8'),
      /unexpected mutation/
    );
  });
});

test('core runner rejects another build of the same package version', async () => {
  await fixture(async ({ invoke }) => {
    const { execution, summary } = await invoke('package', {
      FAKE_WRONG_SOURCE: '1',
    });
    assert.equal(execution.code, 1);
    assert.equal(summary.status, 'incomplete');
    assert.match(summary.error, /Compiled package source does not match/);
    assert.equal(summary.tests, undefined);
  });
});
