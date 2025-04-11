Package.describe({
  name: 'extend-publish',
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
  api.use(['ecmascript']);
  api.mainModule('server.js', 'server');
});

Package.onTest(function (api) {
  api.use(['ecmascript']);
  api.use(['tinytest', 'test-helpers']);
  api.use('extend-publish');
  api.mainModule('tests.js');
});
