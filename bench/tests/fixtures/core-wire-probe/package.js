Package.describe({
  name: 'reactive-publish-core-wire-probe',
  version: '0.0.1',
  summary: 'Diagnostic of subscription metadata during core cursor replacement',
});

Package.onTest(function (api) {
  api.use([
    'ecmascript',
    'tinytest',
    'test-helpers',
    'mongo',
    'tracker',
    'reactive-var',
    'random',
    'nachocodoner:reactive-publish',
  ]);
  api.addFiles('wire.tests.js', 'server');
});
