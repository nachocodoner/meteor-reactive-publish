Package.describe({
  name: 'publish-reactive',
  version: '0.0.1',
  summary: 'Reactive publish for Meteor with async support',
  git: '',
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
      'lib/AsyncReactive/AsyncTracker.js',
      'lib/AsyncReactive/ReactiveVarAsync.js',
      'lib/MongoReactive/MongoReactiveServer.js',
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
      'lib/AsyncReactive/AsyncTracker.tests.js',
      'lib/AsyncReactive/ReactiveVarAsync.tests.js',
      'lib/MongoReactive/MongoReactiveServer.tests.js',
    ],
    'server'
  );
  api.addFiles(['lib/PublishReactive.tests.js']);
});
