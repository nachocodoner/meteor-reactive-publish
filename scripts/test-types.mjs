import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = fs.mkdtempSync(path.join(os.tmpdir(), 'reactive-publish-types-'));
const options = { cwd: app, stdio: 'inherit' };

try {
  fs.cpSync(new URL('./types/', import.meta.url), app, { recursive: true });
  fs.mkdirSync(path.join(app, '.meteor'));
  fs.mkdirSync(path.join(app, 'packages'));
  fs.writeFileSync(path.join(app, '.meteor/release'), 'METEOR@3.6\n');
  fs.writeFileSync(
    path.join(app, '.meteor/packages'),
    'meteor\nmongo\nnachocodoner:reactive-publish\n'
  );
  fs.symlinkSync(root, path.join(app, 'packages/reactive-publish'), 'junction');
  fs.symlinkSync(
    path.join(root, 'node_modules'),
    path.join(app, 'node_modules'),
    'junction'
  );

  execFileSync('meteor', ['types'], options);
  // The generator can also read legacy metadata. Check that the built package
  // advertises its declaration entry through the native API.
  const isopack = JSON.parse(
    fs.readFileSync(
      path.join(
        app,
        '.meteor/local/isopacks/nachocodoner_reactive-publish/isopack.json'
      ),
      'utf8'
    )
  );
  assert.ok(isopack['isopack-2'].typesEntry, 'Missing native types entry');
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'],
    options
  );
} finally {
  fs.rmSync(app, { recursive: true, force: true });
}
