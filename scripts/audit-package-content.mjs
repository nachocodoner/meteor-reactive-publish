#!/usr/bin/env node
// Read-only audit of the watch sets Meteor uses to select published source.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    source: { type: 'string', default: process.cwd() },
    isopacks: { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.isopacks || !values.output) {
  throw new Error(
    'Provide --isopacks <app/.meteor/local/isopacks> --output <local-report.json> [--source <package>]'
  );
}
const root = fs.realpathSync(values.source);
const report = {
  createdAt: new Date().toISOString(),
  source: root,
  method:
    'Compiled production and test watch sets, matching Meteor Isopack.getSourceFilesUnderSourceRoot source selection. This is not an upload or a publish command.',
  packages: [],
};
const forbidden =
  /^(bench|scripts|meteor-core|node_modules)\/|\.(cpuprofile|heapsnapshot)$/;
for (const name of [
  'nachocodoner_reactive-publish',
  'local-test_nachocodoner_reactive-publish',
]) {
  const info = JSON.parse(
    fs.readFileSync(path.join(values.isopacks, name, 'isopack-buildinfo.json'))
  );
  const sources = new Map();
  for (const set of [
    info.pluginDependencies,
    ...Object.values(info.unibuildDependencies || {}),
  ]) {
    for (const [file, hash] of Object.entries(set?.files || {})) {
      if (!hash) continue;
      // Preserve missing inputs as a failed freshness check rather than silently
      // treating deleted files as absent from the previously compiled package.
      const real = fs.existsSync(file)
        ? fs.realpathSync(file)
        : path.resolve(file);
      const relative = path.relative(root, real);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        continue;
      sources.set(relative, {
        path: relative,
        hash,
        matchesCurrentSource:
          fs.existsSync(real) &&
          createHash('sha1').update(fs.readFileSync(real)).digest('hex') ===
            hash,
      });
    }
  }
  const files = [...sources.values()].sort((a, b) =>
    a.path.localeCompare(b.path)
  );
  report.packages.push({
    name,
    builtBy: info.builtBy,
    files,
    forbidden: files.filter((file) => forbidden.test(file.path)),
  });
}
report.passed = report.packages.every(
  (pkg) =>
    pkg.files.length > 0 &&
    !pkg.forbidden.length &&
    pkg.files.every((file) => file.matchesCurrentSource)
);
fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
fs.writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    passed: report.passed,
    packages: report.packages.map((pkg) => ({
      name: pkg.name,
      sourceFiles: pkg.files.length,
      forbidden: pkg.forbidden.map((file) => file.path),
      stale: pkg.files
        .filter((file) => !file.matchesCurrentSource)
        .map((file) => file.path),
    })),
  })
);
process.exitCode = report.passed ? 0 : 2;
