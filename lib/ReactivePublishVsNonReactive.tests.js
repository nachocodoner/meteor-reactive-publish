import { Tinytest } from 'meteor/tinytest';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';

// ---- Helpers ----

// A simple helper to check if arrays have the same items
function arraysHaveSameItems(a, b) {
  if (a.length !== b.length) return false;

  const countItems = (arr) =>
    arr.reduce((acc, item) => {
      acc[item] = (acc[item] || 0) + 1;
      return acc;
    }, {});

  const aCounts = countItems(a);
  const bCounts = countItems(b);

  return Object.keys(aCounts).every((key) => aCounts[key] === bCounts[key]);
}

function unsubscribeAll() {
  const connection = Meteor.connection;

  Object.keys(connection._subscriptions).forEach((subId) => {
    connection._subscriptions[subId].stop();
  });
}

// Helper function to sleep for a specified time
function sleep(ms = 500) {
  return new Promise((resolve) => Meteor.setTimeout(resolve, ms));
}

// runSteps runs an array of asynchronous step functions sequentially.
// Each step is a function(next) that uses "this" (shared context).
async function runSteps(steps, test, done) {
  // Create a shared context with some helper assertions.
  const context = {
    assertEqual(a, b) {
      test.equal(a, b);
    },
    assertTrue(condition, msg) {
      test.ok(condition, msg);
    },
    assertFalse(condition, msg) {
      test.ok(!condition, msg);
    },
    assertFail(msg) {
      test.fail(msg || 'Failure in test step');
    },
    assertItemsEqual(a, b) {
      // For simple arrays, sort before comparing.
      a = a.slice().sort();
      b = b.slice().sort();
      test.equal(a, b);
    },
    // Helper for successful subscription.
    subscribeSuccess(subscriptionName, ...args) {
      // Last argument is the callback.
      const onReady = args.pop();
      return Meteor.subscribe(subscriptionName, ...args, {
        onReady() {
          onReady();
        },
        onError(error) {
          test.fail(`${subscriptionName} failed: ${error.message}`);
          onReady();
        },
      });
    },
    // Helper for failed subscription.
    subscribeFail(subscriptionName, options, doneStep) {
      return Meteor.subscribe(subscriptionName, ...options, {
        onReady() {
          test.fail(`${subscriptionName} was expected to fail but succeeded`);
          doneStep();
        },
        onError() {
          doneStep();
        },
      });
    },
    // Collections will be attached later.
    usersCollection: null,
    postsCollection: null,
    categoriesCollection: null,
    commentsCollection: null,
    // Variables for test state.
    userId: null,
    fetchUserBumpsField: false,
    onlyPublishNameField: false,
    postsSub: null,
    categoriesSub: null,
  };

  // Bind all step functions to the context.
  let idx = 0;
  async function nextStep() {
    if (idx >= steps.length) {
      return done();
    }
    try {
      const step = steps[idx++];
      await step.call(context, nextStep);
    } catch (ex) {
      test.fail('Exception in test step: ' + ex.message);
      done();
    }
  }
  await nextStep();
}

// ---- For each idGeneration type ----
['STRING' /* 'MONGO' */].forEach((idGeneration) => {
  // _id generator.
  let generateId;
  if (idGeneration === 'STRING') {
    generateId = () => Random.id();
  } else {
    generateId = () => new Meteor.Collection.ObjectID();
  }

  // Create collections
  const Posts = new Mongo.Collection(
    `reactive_vs_nonreactive_posts_${idGeneration}`,
    { idGeneration }
  );
  const Categories = new Mongo.Collection(
    `reactive_vs_nonreactive_categories_${idGeneration}`,
    { idGeneration }
  );
  const Comments = new Mongo.Collection(
    `reactive_vs_nonreactive_comments_${idGeneration}`,
    { idGeneration }
  );

  // Server-side setup
  if (Meteor.isServer) {
    // Publish custom fields
    Accounts._defaultPublishFields.projection = {
      bumps: 1,
    };

    // Clear collections before tests
    Meteor.startup(async () => {
      await Posts.removeAsync({});
      await Meteor.users.removeAsync({});
      await Categories.removeAsync({});
      await Comments.removeAsync({});
    });

    // Setup method to initialize the database
    Meteor.methods({
      [`cleanupTestUser_${idGeneration}`]: async function () {
        // Remove only the test user, not all users
        await Meteor.users.removeAsync({ username: 'bob' });
      },

      [`setupDb_${idGeneration}`]: async function () {
        await Posts.removeAsync({});
        // Remove only the test user, not all users
        await Meteor.users.removeAsync({ username: 'bob' });
        await Categories.removeAsync({});
        await Comments.removeAsync({});

        await Categories.insertAsync({ name: 'Technology' });
        await Categories.insertAsync({ name: 'Science' });

        await Comments.insertAsync({ text: 'Great post!' });
        await Comments.insertAsync({ text: 'Very informative' });

        const postIds = [];

        for (let i = 1; i <= 5; i++) {
          const postId = await Posts.insertAsync({ name: `post${i}` });
          postIds.push(postId);
        }

        const userId = await Accounts.createUserAsync({
          username: 'bob',
          password: '123',
        });

        // Update the Meteor.users collection instead of custom Users collection
        await Meteor.users.updateAsync(
          { _id: userId },
          { $set: { subscribedPosts: postIds, bumps: 0 } }
        );

        return userId;
      },

      [`bump_${idGeneration}`]: async function () {
        await Meteor.users.updateAsync(
          { _id: this.userId },
          { $inc: { bumps: 1 } }
        );
      },
    });

    // Non-reactive publication
    Meteor.publish(`categories_${idGeneration}`, function () {
      return Categories.find({});
    });

    Meteor.publish(`comments_${idGeneration}`, function () {
      return Comments.find({});
    });

    // Reactive publication
    Meteor.publish(
      `subscribed-posts_${idGeneration}`,
      function ({ fetchUserBumpsField, onlyPublishNameField }) {
        this.autorun(async () => {
          const userFields = { subscribedPosts: 1 };

          if (fetchUserBumpsField) userFields.bumps = 1;

          const user = await Meteor.users.findOneAsync(this.userId, {
            fields: userFields,
          });

          const postOptions = {};

          if (onlyPublishNameField) postOptions.fields = { name: 1 };

          return Posts.find(
            { _id: { $in: user?.subscribedPosts || [] } },
            postOptions
          );
        });
      }
    );

    // Non-reactive version of the same publication
    Meteor.publish(
      `subscribed-posts-nonreactive_${idGeneration}`,
      async function ({ fetchUserBumpsField, onlyPublishNameField }) {
        const userFields = { subscribedPosts: 1 };

        if (fetchUserBumpsField) userFields.bumps = 1;

        const user = await Meteor.users.findOneAsync(this.userId, {
          fields: userFields,
        });

        const postOptions = {};

        if (onlyPublishNameField) postOptions.fields = { name: 1 };

        return Posts.find(
          { _id: { $in: user?.subscribedPosts || [] } },
          postOptions
        );
      }
    );
  }

  // Step functions for reactive tests
  function reactiveSteps(test, fetchUserBumpsField, onlyPublishNameField) {
    return [
      // Step 1: Initialize collections
      async function (next) {
        this.usersCollection = Meteor.users;
        this.postsCollection = Posts;
        this.categoriesCollection = Categories;
        this.commentsCollection = Comments;
        this.fetchUserBumpsField = fetchUserBumpsField;
        this.onlyPublishNameField = onlyPublishNameField;
        next();
      },

      // Step 2: Setup test environment
      async function (next) {
        await Meteor.logout();
        await sleep();
        test.equal(Meteor.userId(), null, 'Not logged out');

        await Meteor.callAsync(`setupDb_${idGeneration}`);
        await sleep();
        next();
      },

      // Step 3: Subscribe to publications
      function (next) {
        this.postsSub = this.subscribeSuccess(
          `subscribed-posts_${idGeneration}`,
          {
            fetchUserBumpsField: this.fetchUserBumpsField,
            onlyPublishNameField: this.onlyPublishNameField,
          },
          () => {
            this.categoriesSub = this.subscribeSuccess(
              `categories_${idGeneration}`,
              next
            );
          }
        );
      },

      // Step 4: Login and verify initial state
      async function (next) {
        await Meteor.loginWithPassword('bob', '123');
        await sleep();

        test.notEqual(Meteor.userId(), null, 'Not logged in');

        await sleep();

        const category = await Categories.findOneAsync();
        console.log('category', category);
        test.notEqual(category, undefined, 'Category not found before bump');

        // Get initial posts
        const initialPosts = await Posts.find().fetchAsync();
        console.log('Initial posts count:', initialPosts.length);
        test.equal(initialPosts.length, 5, 'Should have 5 initial posts');

        // Check field filtering if onlyPublishNameField is true
        if (this.onlyPublishNameField) {
          const post = initialPosts[0];
          test.notEqual(post.name, undefined, 'Post name should be published');
          test.equal(
            Object.keys(post).length,
            2,
            'Only _id and name fields should be published'
          );
        }

        next();
      },

      // Step 5: Modify user data and verify reactive behavior
      async function (next) {
        // Modify user data which should trigger reactive publication
        await Meteor.callAsync(`bump_${idGeneration}`);
        await sleep();
        await sleep();

        const category2 = await Categories.findOneAsync();
        test.notEqual(category2, undefined, 'Category not found after bump');

        // Posts should still be the same after bump
        const postsAfterBump = await Posts.find().fetchAsync();
        console.log('Posts after bump count:', postsAfterBump.length);
        test.equal(
          postsAfterBump.length,
          5,
          'Should still have 5 posts after bump'
        );

        // If we're fetching the bumps field, the reactive publication should have re-run
        if (this.fetchUserBumpsField) {
          const user = await Meteor.users.findOneAsync(Meteor.userId());
          test.equal(user.bumps, 1, 'User bumps should be incremented');
        }

        next();
      },

      // Step 6: Cleanup
      async function (next) {
        if (this.postsSub) this.postsSub.stop();
        if (this.categoriesSub) this.categoriesSub.stop();
        unsubscribeAll();

        // Clean up the test user
        await Meteor.callAsync(`cleanupTestUser_${idGeneration}`);

        next();
      },
    ];
  }

  // Step functions for non-reactive tests
  function nonReactiveSteps(test, fetchUserBumpsField, onlyPublishNameField) {
    return [
      // Step 1: Initialize collections
      async function (next) {
        this.usersCollection = Meteor.users;
        this.postsCollection = Posts;
        this.categoriesCollection = Categories;
        this.commentsCollection = Comments;
        this.fetchUserBumpsField = fetchUserBumpsField;
        this.onlyPublishNameField = onlyPublishNameField;
        next();
      },

      // Step 2: Setup test environment
      async function (next) {
        await Meteor.logout();
        await sleep();
        test.equal(Meteor.userId(), null, 'Not logged out');

        await Meteor.callAsync(`setupDb_${idGeneration}`);
        await sleep();
        next();
      },

      // Step 3: Subscribe to publications
      function (next) {
        this.postsSub = this.subscribeSuccess(
          `subscribed-posts-nonreactive_${idGeneration}`,
          {
            fetchUserBumpsField: this.fetchUserBumpsField,
            onlyPublishNameField: this.onlyPublishNameField,
          },
          () => {
            this.categoriesSub = this.subscribeSuccess(
              `categories_${idGeneration}`,
              next
            );
          }
        );
      },

      // Step 4: Login and verify initial state
      async function (next) {
        await Meteor.loginWithPassword('bob', '123');
        await sleep();

        test.notEqual(Meteor.userId(), null, 'Not logged in');

        await sleep();

        const category = await Categories.findOneAsync();
        console.log('category', category);
        test.notEqual(category, undefined, 'Category not found before bump');

        // Get initial posts
        const initialPosts = await Posts.find().fetchAsync();
        console.log('Initial posts count:', initialPosts.length);
        test.equal(initialPosts.length, 5, 'Should have 5 initial posts');

        // Check field filtering if onlyPublishNameField is true
        if (this.onlyPublishNameField) {
          const post = initialPosts[0];
          test.notEqual(post.name, undefined, 'Post name should be published');
          test.equal(
            Object.keys(post).length,
            2,
            'Only _id and name fields should be published'
          );
        }

        next();
      },

      // Step 5: Modify user data and verify non-reactive behavior
      async function (next) {
        // Modify user data which should NOT trigger non-reactive publication
        await Meteor.callAsync(`bump_${idGeneration}`);
        await sleep();

        const category2 = await Categories.findOneAsync();
        console.log('category2', category2);
        test.notEqual(category2, undefined, 'Category not found after bump');

        // Posts should still be the same after bump
        const postsAfterBump = await Posts.find().fetchAsync();
        console.log('Posts after bump count:', postsAfterBump.length);
        test.equal(
          postsAfterBump.length,
          5,
          'Should still have 5 posts after bump'
        );

        // Even if we're fetching the bumps field, the non-reactive publication should NOT have re-run
        if (this.fetchUserBumpsField) {
          const user = await Meteor.users.findOneAsync(Meteor.userId());
          test.equal(user.bumps, 1, 'User bumps should be incremented');
        }

        next();
      },

      // Step 6: Cleanup
      async function (next) {
        if (this.postsSub) this.postsSub.stop();
        if (this.categoriesSub) this.categoriesSub.stop();
        unsubscribeAll();

        // Clean up the test user
        await Meteor.callAsync(`cleanupTestUser_${idGeneration}`);

        next();
      },
    ];
  }

  // Test cases
  if (Meteor.isClient) {
    // Tests for reactive publications
    Tinytest.addAsync(
      `ReactiveVsNonReactive (${idGeneration}) - Reactive with bumps field`,
      function (test, done) {
        runSteps(reactiveSteps(test, true, false), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactiveVsNonReactive (${idGeneration}) - Reactive without bumps field`,
      function (test, done) {
        runSteps(reactiveSteps(test, false, false), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactiveVsNonReactive (${idGeneration}) - Reactive with name field only`,
      function (test, done) {
        runSteps(reactiveSteps(test, false, true), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactiveVsNonReactive (${idGeneration}) - Reactive with bumps field and name field only`,
      function (test, done) {
        runSteps(reactiveSteps(test, true, true), test, done);
      }
    );

    // Tests for non-reactive publications
    Tinytest.addAsync(
      `ReactiveVsNonReactive (${idGeneration}) - Non-reactive with bumps field`,
      function (test, done) {
        runSteps(nonReactiveSteps(test, true, false), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactiveVsNonReactive (${idGeneration}) - Non-reactive without bumps field`,
      function (test, done) {
        runSteps(nonReactiveSteps(test, false, false), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactiveVsNonReactive (${idGeneration}) - Non-reactive with name field only`,
      function (test, done) {
        runSteps(nonReactiveSteps(test, false, true), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactiveVsNonReactive (${idGeneration}) - Non-reactive with bumps field and name field only`,
      function (test, done) {
        runSteps(nonReactiveSteps(test, true, true), test, done);
      }
    );
  }
});
