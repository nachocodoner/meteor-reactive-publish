Package.describe({
  name: 'reactive-publish',
  version: '0.0.1',
  // Brief, one-line summary of the package.
  summary: '',
  // URL to the Git repository containing the source code for this package.
  git: '',
  // By default, Meteor will default to using README.md for documentation.
  // To avoid submitting documentation, set this field to null.
  documentation: 'README.md',
});

Package.onUse(function (api) {
  api.versionsFrom(['3.0.1', '3.1', '3.2']);
  api.use([
    'ecmascript',
    'mongo',
    'minimongo',
    'server-autorun',
    'reactive-mongo',
  ]);
  api.mainModule('server.js', 'server');
});

Package.onTest(function (api) {
  api.use(['ecmascript', 'insecure', 'random', 'reactive-var', 'check']);
  api.use(['tinytest', 'test-helpers']);
  api.use('reactive-publish');
  api.mainModule('tests.js');
});
