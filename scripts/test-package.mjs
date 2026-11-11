import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = JSON.parse(
  fs.readFileSync(new URL('../bench/config/runtime-lock.json', import.meta.url))
);
const args = process.argv.slice(2);
const release = args.some(
  (arg) => arg === '--release' || arg.startsWith('--release=')
)
  ? []
  : ['--release', runtime.meteor];
const executable =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_BIN ||
  [
    puppeteer.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((file) => fs.existsSync(file));
if (!executable) {
  throw new Error(
    'Install Chrome or set PUPPETEER_EXECUTABLE_PATH to its executable.'
  );
}

// An explicit package path prevents a sibling checkout with the same package
// name from being selected by Meteor's package-directory scan.
const child = spawn(
  process.execPath,
  [
    require.resolve('@zodern/mtest'),
    '--package',
    path.resolve(root),
    '--once',
    ...release,
    ...args,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      METEOR_PACKAGE_DIRS: root,
      PUPPETEER_EXECUTABLE_PATH: executable,
    },
  }
);
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = signal === 'SIGINT' ? 130 : 143;
    // mtest's SIGINT handler stops its Meteor process tree and browser.
    child.kill('SIGINT');
  });
}
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = interrupted ?? code ?? (signal ? 1 : 0);
});
