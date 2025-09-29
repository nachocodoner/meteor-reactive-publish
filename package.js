Package.describe({
  name: 'nachocodoner:reactive-publish',
  version: '1.0.0-rc.1',
  summary: 'Reactive publish for Meteor with async support',
  git: 'https://github.com/nachocodoner/meteor-reactive-publish',
  documentation: 'README.md',
});

Npm.depends({
  effect: '3.17.14',
});

Package.onUse(function (api) {
  api.versionsFrom(['3.0.1']);
  api.use(['ecmascript', 'mongo', 'minimongo']);

  // Export the AsyncTracker and ReactiveVarAsync
  api.export('AsyncTracker');
  api.export('ReactiveVarAsync');

  // Add the files for client and server
  api.addFiles(
    [
      'lib/ReactiveAsync/AsyncTracker.js',
      'lib/ReactiveAsync/ReactiveVarAsync.js',
    ],
    ['client', 'server']
  );

  // Add the files for server
  api.addFiles(
    [
      'lib/ReactiveMongo/ReactiveMongoServer.js',
      'lib/ReactivePublishServer.js',
    ],
    'server'
  );

  // Add the main module for the server
  api.mainModule('main.js', 'server');
});

Package.onTest(function (api) {
  api.use([
    'ecmascript',
    'reactive-var',
    'insecure',
    'random',
    'check',
    'jquery',
  ]);
  api.use(['accounts-base', 'accounts-password']);
  api.use(['tinytest', 'test-helpers']);
  api.use('nachocodoner:reactive-publish');

  // Add the test files for server
  api.addFiles(['lib/ReactiveMongo/ReactiveMongoServer.tests.js'], ['server']);

  // Add the test files for server and client
  api.addFiles([
    'lib/ReactiveAsync/AsyncTracker.tests.js',
    'lib/ReactiveAsync/ReactiveVarAsync.tests.js',
    'lib/ReactiveAsync/ReactiveAsyncShowcase.tests.js',
    'lib/ReactivePublish.tests.js',
    'lib/ReactivePublishVsNonReactive.tests.js',
  ]);
});
