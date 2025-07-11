Package.describe({
  name: 'data-lookup',
  summary: "Reactively lookup a field in the object",
  version: '0.0.1',
});

Package.onUse(function (api) {
  api.versionsFrom(['3.0.1', '3.1', '3.2']);

  // Core dependencies.
  api.use([
    'ecmascript',
    'underscore',
    'tracker'
  ]);

  // 3rd party dependencies.
  api.use(['computed-field']);

  api.export('DataLookup');

  api.mainModule('lib.js');
});

Package.onTest(function (api) {
  api.versionsFrom(['3.0.1', '3.1', '3.2']);

  // Core dependencies.
  api.use([
    'ecmascript',
    'random',
    'underscore',
    'reactive-var'
  ]);

  // Internal dependencies.
  api.use(['data-lookup']);

  api.addFiles(['tests.js', 'computed-field.tests.js']);
});
