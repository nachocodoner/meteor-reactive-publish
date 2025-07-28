Package.describe({
  name: 'publish-reactive',
  version: '0.0.1',
  // Brief, one-line summary of the package.
  summary: 'Reactive publish for Meteor with async support',
  // URL to the Git repository containing the source code for this package.
  git: '',
  // By default, Meteor will default to using README.md for documentation.
  // To avoid submitting documentation, set this field to null.
  documentation: 'README.md',
});

Package.onUse(function (api) {
  api.versionsFrom(['3.0.1', '3.1', '3.2']);
  api.use(['ecmascript', 'mongo', 'minimongo']);

  // Export the AsyncTracker and ReactiveVarAsync
  api.export('AsyncTracker');
  api.export('ReactiveVarAsync');

  // Add the files
  api.addFiles(
    [
      'lib/async-reactive/AsyncTracker.js',
      'lib/async-reactive/ReactiveVarAsync.js',
      'lib/mongo-reactive/ReactiveMongoServer.js',
      'lib/PublishReactiveServer.js',
    ],
    'server'
  );
});

Package.onTest(function (api) {
  api.use(['ecmascript', 'reactive-var', 'insecure', 'random', 'check']);
  api.use(['tinytest', 'test-helpers']);
  api.use('publish-reactive');

  // Add the test files
  api.addFiles(
    [
      'lib/async-reactive/AsyncTracker.tests.js',
      'lib/async-reactive/ReactiveVarAsync.tests.js',
      'lib/mongo-reactive/ReactiveMongoServer.tests.js',
    ],
    'server'
  );
  api.addFiles(['lib/PublishReactive.tests.js']);
});
