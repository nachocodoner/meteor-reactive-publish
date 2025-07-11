Package.describe({
  name: 'subscription-data',
  summary: "Reactive and shared subscription data context",
  version: '0.0.1',
});

Package.onUse(function (api) {
  api.versionsFrom(['3.0.1', '3.1', '3.2']);

  // Core dependencies.
  api.use([
    'ecmascript',
    'mongo',
    'underscore',
    'tracker',
    'ejson',
    'extend-publish',
  ]);

  api.addFiles([
    'server.js'
  ], 'server');

  api.addFiles([
    'client.js'
  ], 'client');
});

Package.onTest(function (api) {
  api.versionsFrom(['3.0.1', '3.1', '3.2']);

  // Core dependencies.
  api.use([
    'ecmascript',
    'random',
    'mongo',
    'underscore'
  ]);

  // Internal dependencies.
  api.use([
    'subscription-data'
  ]);

  // 3rd party dependencies.
  api.use(['reactive-publish']);

  api.addFiles(['tests.js']);
});