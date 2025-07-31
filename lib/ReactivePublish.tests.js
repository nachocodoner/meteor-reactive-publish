import { Tinytest } from 'meteor/tinytest';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { check } from 'meteor/check';
import { ReactiveVarAsync } from './ReactiveAsync/ReactiveVarAsync';

// ---- Helpers ----

// A simple omit helper.
const omit = (obj, ...keys) => {
  if (!obj) return {};
  const ret = Object.assign({}, obj);
  keys.forEach((key) => delete ret[key]);
  return ret;
};

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

function shuffleArray(array) {
  let currentIndex = array.length;
  let randomIndex;

  // While there remain elements to shuffle…
  while (currentIndex !== 0) {
    // Pick a remaining element…
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }

  return array;
}

function unsubscribeAll() {
  const connection = Meteor.connection;

  Object.keys(connection._subscriptions).forEach((subId) => {
    connection._subscriptions[subId].stop();
  });
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
    addressesCollection: null,
    fieldsCollection: null,
    countsCollection: null,
    localCollection: null,
    // Variables for test state.
    userId: null,
    countId: null,
    posts: [],
    shortPosts: [],
    postsSubscribe: null,
    multiplexerCountBefore: 0,
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

  // Create collections.
  const Users = new Mongo.Collection(
    `Users_meteor_reactivepublish_tests_${idGeneration}`,
    { idGeneration }
  );
  const Posts = new Mongo.Collection(
    `Posts_meteor_reactivepublish_tests_${idGeneration}`,
    { idGeneration }
  );
  const Addresses = new Mongo.Collection(
    `Addresses_meteor_reactivepublish_tests_${idGeneration}`,
    { idGeneration }
  );
  const Fields = new Mongo.Collection(
    `Fields_meteor_reactivepublish_tests_${idGeneration}`,
    { idGeneration }
  );
  const Counts = new Mongo.Collection(`Counts_${idGeneration}`, {
    idGeneration,
  });
  const CleanupTest = new Mongo.Collection(`cleanup-test_${idGeneration}`, {
    idGeneration,
  });

  // Save collections for multiplexer count.
  const allCollections = [Users, Posts, Addresses, Fields, CleanupTest];

  // On the server, define additional (local) collections, publications, and methods.
  if (Meteor.isServer) {
    const LocalCollection = new Mongo.Collection(null, {
      idGeneration,
    });
    const localCollectionLimit = new ReactiveVarAsync(null);
    // Expose for client methods.
    global.LocalCollection = LocalCollection;

    // Publications
    Meteor.publish(null, function () {
      return Users.find();
    });

    Meteor.publish(`posts_${idGeneration}`, function (ids) {
      return Posts.find({ _id: { $in: ids } });
    });

    Meteor.publish(`users-posts_${idGeneration}`, function (userId) {
      const self = this;
      let handle = self.autorun(async () => {
        const user = await Users.findOneAsync(userId, { fields: { posts: 1 } });
        const projectedField = await Fields.findOneAsync(userId);

        await Posts.find(
          { _id: { $in: (user && user.posts) || [] } },
          { fields: omit(projectedField, '_id') }
        ).observeChangesAsync({
          added(id, fields) {
            fields.dummyField = true;
            self.added(
              `Posts_meteor_reactivepublish_tests_${idGeneration}`,
              id,
              fields
            );
          },
          changed(id, fields) {
            self.changed(
              `Posts_meteor_reactivepublish_tests_${idGeneration}`,
              id,
              fields
            );
          },
          removed(id) {
            self.removed(
              `Posts_meteor_reactivepublish_tests_${idGeneration}`,
              id
            );
          },
        });
        self.ready();
      });
      self.onStop(async () => {
        if (handle && handle.stop) {
          await handle.stop();
        }
      });
    });

    Meteor.publish(`users-posts-foreach_${idGeneration}`, function (userId) {
      const self = this;
      self.autorun(async () => {
        const user = await Users.findOneAsync(userId, { fields: { posts: 1 } });
        const projectedField = await Fields.findOneAsync(userId);
        await Posts.find(
          { _id: { $in: (user && user.posts) || [] } },
          { fields: omit(projectedField, '_id') }
        ).forEachAsync((document) => {
          const fields = omit(document, '_id');
          fields.dummyField = true;
          self.added(
            `Posts_meteor_reactivepublish_tests_${idGeneration}`,
            document._id,
            fields
          );
        });
        self.ready();
      });
    });

    Meteor.publish(`users-posts-nested_${idGeneration}`, function (userId) {
      const self = this;
      self.autorun(async () => {
        const user = await Users.findOneAsync(userId, { fields: { posts: 1 } });
        const projectedField = await Fields.findOneAsync(userId);
        self.autorun(async () => {
          await Posts.find(
            { _id: { $in: (user && user.posts) || [] } },
            { fields: omit(projectedField, '_id') }
          ).forEachAsync((document) => {
            const fields = omit(document, '_id');
            fields.dummyField = true;
            self.added(
              `Posts_meteor_reactivepublish_tests_${idGeneration}`,
              document._id,
              fields
            );
          });
        });
        self.ready();
      });
    });

    Meteor.publish(`users-posts-method_${idGeneration}`, function (userId) {
      const self = this;
      self.autorun(async () => {
        const { user, projectedField } = await Meteor.callAsync(
          `userAndProjection_${idGeneration}`,
          userId
        );
        await Posts.find(
          { _id: { $in: (user && user.posts) || [] } },
          { fields: omit(projectedField, '_id') }
        ).observeChangesAsync({
          added(id, fields) {
            fields.dummyField = true;
            self.added(
              `Posts_meteor_reactivepublish_tests_${idGeneration}`,
              id,
              fields
            );
          },
          changed(id, fields) {
            self.changed(
              `Posts_meteor_reactivepublish_tests_${idGeneration}`,
              id,
              fields
            );
          },
          removed(id) {
            self.removed(
              `Posts_meteor_reactivepublish_tests_${idGeneration}`,
              id
            );
          },
        });
        self.ready();
      });
    });

    // Test the new publishReactive function
    Meteor.publishReactive(
      `users-posts-reactive_${idGeneration}`,
      async function (userId, computation) {
        // Verify that computation is passed as the last argument
        if (!computation || typeof computation.firstRun !== 'boolean') {
          throw new Error('Computation not passed to publishReactive function');
        }

        const user = await Users.findOneAsync(userId, { fields: { posts: 1 } });
        const projectedField = await Fields.findOneAsync(userId);

        return Posts.find(
          { _id: { $in: (user && user.posts) || [] } },
          { fields: omit(projectedField, '_id') }
        );
      }
    );

    // Test for subscribed-posts with autorun
    Meteor.publish(`users-posts-autorun_${idGeneration}`, function (userId) {
      this.autorun(async () => {
        const user = await Users.findOneAsync(userId, {
          fields: { posts: 1 },
        });

        return Posts.find({ _id: { $in: (user && user.posts) || [] } });
      });
    });

    Meteor.publish(
      `users-posts-and-addresses_${idGeneration}`,
      function (userId) {
        const self = this;
        self.autorun(async () => {
          if (self !== this) throw new Error('Publish context mismatch');
          const user1 = await Users.findOneAsync(userId, {
            fields: { posts: 1 },
          });
          return Posts.find({ _id: { $in: (user1 && user1.posts) || [] } });
        });
        self.autorun(async () => {
          const user2 = await Users.findOneAsync(userId, {
            fields: { addresses: 1 },
          });
          return Addresses.find({
            _id: { $in: (user2 && user2.addresses) || [] },
          });
        });
      }
    );

    Meteor.publish(
      `users-posts-and-addresses-together_${idGeneration}`,
      function (userId) {
        const self = this;
        self.autorun(async () => {
          const user = await Users.findOneAsync(userId, {
            fields: { posts: 1, addresses: 1 },
          });
          return [
            Posts.find({ _id: { $in: (user && user.posts) || [] } }),
            Addresses.find({ _id: { $in: (user && user.addresses) || [] } }),
          ];
        });
      }
    );

    Meteor.publish(
      `users-posts-count_${idGeneration}`,
      function (userId, countId) {
        const self = this;
        self.autorun(async (computation) => {
          const user = await Users.findOneAsync(userId, {
            fields: { posts: 1 },
          });
          let count = 0;
          let initializing = true;
          const handle = await Posts.find({
            _id: { $in: (user && user.posts) || [] },
          }).observeChangesAsync({
            added() {
              count++;
              if (!initializing) {
                self.changed(`Counts_${idGeneration}`, countId, { count });
              }
            },
            removed() {
              count--;
              if (!initializing) {
                self.changed(`Counts_${idGeneration}`, countId, { count });
              }
            },
          });
          computation.onStop(async () => {
            await handle.stop(); // stop the previous observer before re-running
          });
          initializing = false;
          self.added(`Counts_${idGeneration}`, countId, { count });
          self.ready();
        });
      }
    );

    const currentTime = new ReactiveVarAsync(Date.now());
    Meteor.setInterval(() => {
      currentTime.set(Date.now());
    }, 1);
    Meteor.publish(`recent-posts_${idGeneration}`, function () {
      const self = this;
      self.autorun(() => {
        const timestamp = currentTime.get() - 2000;
        return Posts.find(
          { timestamp: { $exists: true, $gte: timestamp } },
          { sort: { timestamp: 1 } }
        );
      });
    });

    Meteor.publish(`multiple-cursors-1_${idGeneration}`, function () {
      const self = this;
      self.autorun(() => {
        return Posts.find();
      });
      self.autorun(() => {
        return Posts.find();
      });
    });
    Meteor.publish(`multiple-cursors-2_${idGeneration}`, function () {
      const self = this;
      self.autorun(() => {
        return Posts.find();
      });
      return Posts.find();
    });

    Meteor.publish(`localCollection_${idGeneration}`, function () {
      const self = this;
      self.autorun(async () => {
        const limit = localCollectionLimit.get();
        await LocalCollection.find(
          {},
          { sort: { i: 1 }, ...(limit && { limit }) }
        ).observeChangesAsync({
          addedBefore(id, fields) {
            self.added(`localCollection_${idGeneration}`, id, fields);
          },
          changed(id, fields) {
            // if (AsyncTracker.currentComputation()) return;
            self.changed(`localCollection_${idGeneration}`, id, fields);
          },
          removed(id) {
            // if (AsyncTracker.currentComputation()) return;
            self.removed(`localCollection_${idGeneration}`, id);
          },
        });
        self.ready();
      });
    });

    Meteor.publish(`unblocked-users-posts_${idGeneration}`, function (userId) {
      this.unblock();
      return this.autorun(async () => {
        const user = await Users.findOneAsync(userId, { fields: { posts: 1 } });
        return Posts.find({ _id: { $in: (user && user.posts) || [] } });
      });
    });

    // Methods.
    const methods = {};
    methods[`insertPost_${idGeneration}`] = function (timestamp) {
      check(timestamp, Number);
      return Posts.insertAsync({ timestamp });
    };
    methods[`userAndProjection_${idGeneration}`] = async function (userId) {
      const user = await Users.findOneAsync(userId, { fields: { posts: 1 } });
      const projectedField = await Fields.findOneAsync(userId);
      return { user, projectedField };
    };
    methods[`setLocalCollectionLimit_${idGeneration}`] = function (limit) {
      localCollectionLimit.set(limit);
    };
    methods[`insertLocalCollection_${idGeneration}`] = async function (doc) {
      return LocalCollection.insertAsync(doc);
    };
    methods[`runOnServer_${idGeneration}`] = async function () {};

    // Method to insert a document into the CleanupTest collection
    methods[`insertCleanupTest_${idGeneration}`] = async function (doc) {
      return CleanupTest.insertAsync(doc);
    };

    // Method to update a document in the CleanupTest collection
    methods[`updateCleanupTest_${idGeneration}`] = async function (id, update) {
      return CleanupTest.updateAsync({ _id: id }, { $set: update });
    };

    // Method to remove a document from the CleanupTest collection
    methods[`removeCleanupTest_${idGeneration}`] = async function (id) {
      return CleanupTest.removeAsync({ _id: id });
    };

    // Method to check if documents and oldDocuments are empty
    methods[`checkDocumentsCleanup_${idGeneration}`] = function () {
      // Access the documents and oldDocuments objects directly through the references
      // These references are set in server.js when Meteor.isTest is true
      const documentsRef = global._testDocumentsRef || {};
      const oldDocumentsRef = global._testOldDocumentsRef || {};
      const allCollectionNamesRef = global._testAllCollectionNamesRef || {};

      // Check if the objects are empty (no keys)
      const documentsEmpty = Object.keys(documentsRef).length === 0;
      const oldDocumentsEmpty = Object.keys(oldDocumentsRef).length === 0;
      const allCollectionNamesEmpty =
        Object.keys(allCollectionNamesRef).length === 0;

      return {
        documentsEmpty,
        oldDocumentsEmpty,
        allCollectionNamesEmpty,
      };
    };

    Meteor.methods(methods);
  } else {
    // On the client, create persistent LocalCollection.
    global.LocalCollection = new Mongo.Collection(
      `localCollection_${idGeneration}`,
      { idGeneration }
    );
  }

  // Methods available on both client and server.
  const localMethods = {};
  localMethods[`clearLocalCollection_${idGeneration}`] = async function () {
    // eslint-disable-next-line no-undef
    return LocalCollection.removeAsync({});
  };
  Meteor.methods(localMethods);

  // BASIC TESTS – These tests subscribe, insert, update, and remove.
  function basicSteps(publishName, test) {
    return [
      async function (next) {
        this.countsCollection = Counts;
        next();
      },
      function (next) {
        this.userId = generateId();
        this.countId = generateId();
        this.subscribeSuccess(
          `${publishName}_${idGeneration}`,
          this.userId,
          () => {
            this.subscribeSuccess(
              `users-posts-count_${idGeneration}`,
              this.userId,
              this.countId,
              next
            );
          }
        );
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), []);
        const countObj = (this.countsCollection &&
          (await this.countsCollection.findOneAsync(this.countId))) || {
          count: 0,
        };
        test.equal(countObj.count, 0);
        this.posts = [];
        let pending = 10;
        for (let i = 0; i < 10; i++) {
          try {
            const id = await Posts.insertAsync({});
            test.ok(id);
            this.posts.push(id);
            if (--pending === 0) {
              await Meteor.setTimeout(next, 1000);
            }
          } catch (error) {
            test.isFalse(error, error && error.toString());
          }
        }
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), []);
        const countObj = (this.countsCollection &&
          (await this.countsCollection.findOneAsync(this.countId))) || {
          count: 0,
        };
        test.equal(countObj.count, 0);
        try {
          const userId = await Users.insertAsync({
            _id: this.userId,
            posts: this.posts,
          });
          test.isFalse(false);
          test.ok(userId);
          test.equal(userId, this.userId);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        const posts = await Posts.find().fetchAsync();

        posts.forEach((post) => {
          test.ok(post.dummyField);
        });
        test.isTrue(
          arraysHaveSameItems(
            posts.map((doc) => doc._id),
            this.posts
          )
        );

        const countObj = (this.countsCollection &&
          (await this.countsCollection.findOneAsync(this.countId))) || {
          count: 0,
        };

        test.equal(countObj.count, this.posts.length);

        this.shortPosts = this.posts.slice(0, 5);

        try {
          await Users.updateAsync(this.userId, {
            posts: this.shortPosts,
          });
          await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));
          next();
        } catch (error) {
          test.isFalse(error, error && error.toString());
          next();
        }
      },
      async function (next) {
        const postsCursor = Posts.find();
        const posts = await postsCursor.fetchAsync();

        posts.forEach((post) => {
          test.ok(post.dummyField);
        });

        test.isTrue(
          arraysHaveSameItems(
            posts.map((doc) => doc._id),
            this.shortPosts
          )
        );

        const countObj = (this.countsCollection &&
          (await this.countsCollection.findOneAsync(this.countId))) || {
          count: 0,
        };

        test.equal(countObj.count, this.shortPosts.length);

        try {
          await Users.updateAsync(this.userId, { posts: [] });
          await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));
          next();
        } catch (error) {
          test.isFalse(error, error && error.toString());
          next();
        }
      },
      async function (next) {
        const postIds = (await Posts.find().fetchAsync()).map((doc) => doc._id);
        test.equal(postIds, []);

        try {
          await Users.updateAsync(this.userId, {
            posts: this.posts,
          });
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        const posts = await Posts.find().fetchAsync();
        posts.forEach((post) => {
          test.ok(post.dummyField);
        });

        test.isTrue(
          arraysHaveSameItems(
            posts.map((doc) => doc._id),
            this.posts
          )
        );

        try {
          const count = await Posts.removeAsync(this.posts[0]);
          test.equal(count, 1);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await new Promise((resolve) => Meteor.setTimeout(resolve, 2000));
        next();
      },
      async function (next) {
        const posts = await Posts.find().fetchAsync();
        posts.forEach((post) => {
          test.ok(post.dummyField);
        });

        const postIds = posts.map((doc) => doc._id);
        test.isTrue(arraysHaveSameItems(postIds, this.posts.slice(1)));

        try {
          await Users.removeAsync(this.userId);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        const posts = await Posts.find().fetchAsync();
        test.equal(
          posts.map((doc) => doc._id),
          []
        );

        const countObj = (this.countsCollection &&
          (await this.countsCollection.findOneAsync(this.countId))) || {
          count: 0,
        };
        test.equal(countObj.count, 0);

        unsubscribeAll();

        next();
      },
    ];
  }

  if (Meteor.isClient) {
    Tinytest.addAsync(
      `ReactivePublish basic (${idGeneration}) - users-posts`,
      (test, done) => {
        runSteps(basicSteps('users-posts', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish basic (${idGeneration}) - users-posts-autorun`,
      (test, done) => {
        runSteps(basicSteps('users-posts-autorun', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish basic (${idGeneration}) - users-posts-foreach`,
      (test, done) => {
        runSteps(basicSteps('users-posts-foreach', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish basic (${idGeneration}) - users-posts-nested`,
      (test, done) => {
        runSteps(basicSteps('users-posts-nested', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish basic (${idGeneration}) - users-posts-method`,
      (test, done) => {
        runSteps(basicSteps('users-posts-method', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish basic (${idGeneration}) - users-posts-reactive`,
      (test, done) => {
        runSteps(basicSteps('users-posts-reactive', test), test, done);
      }
    );
  }

  // UNSUBSCRIBING TESTS.
  function unsubscribingSteps(publishName, test) {
    return [
      async function (next) {
        this.countsCollection = Counts;
        next();
      },
      function (next) {
        this.userId = generateId();
        this.countId = generateId();
        this.subscribeSuccess(
          `${publishName}_${idGeneration}`,
          this.userId,
          () => {
            this.subscribeSuccess(
              `users-posts-count_${idGeneration}`,
              this.userId,
              this.countId,
              next
            );
          }
        );
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), []);
        const countObj = (this.countsCollection &&
          (await this.countsCollection.findOneAsync(this.countId))) || {
          count: 0,
        };
        test.equal(countObj.count, 0);
        this.posts = [];
        for (let i = 0; i < 10; i++) {
          try {
            const id = await Posts.insertAsync({});
            test.ok(id);
            this.posts.push(id);
          } catch (error) {
            test.isFalse(error, error && error.toString());
          }
        }
        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        try {
          const userId = await Users.insertAsync({
            _id: this.userId,
            posts: this.posts,
          });
          test.equal(userId, this.userId);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        Posts.find().forEach((post) => {
          test.ok(post.dummyField);
        });

        test.isTrue(
          arraysHaveSameItems(
            (await Posts.find().fetchAsync()).map((doc) => doc._id),
            this.posts
          )
        );

        try {
          // Trigger a rerun by shuffling posts.
          await Users.updateAsync(this.userId, {
            posts: shuffleArray(this.posts),
          });
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        unsubscribeAll();
        this.postsSubscribe = Meteor.subscribe(
          `posts_${idGeneration}`,
          this.posts,
          {
            onReady: next,
            onError: (error) => {
              test.fail('Subscription failed: ' + error.message);
              next();
            },
          }
        );
        await Meteor.setTimeout(next, 2000);
      },
      async function (next) {
        Posts.find().forEach((post) => {
          // Expect dummyField to have been removed in client simulation.
          test.isFalse(typeof post.dummyField !== 'undefined');
        });

        test.isTrue(
          arraysHaveSameItems(
            (await Posts.find().fetchAsync()).map((doc) => doc._id),
            this.posts
          )
        );

        if (
          this.postsSubscribe &&
          typeof this.postsSubscribe.stop === 'function'
        ) {
          this.postsSubscribe.stop();
        }

        unsubscribeAll();

        next();
      },
    ];
  }

  if (Meteor.isClient) {
    Tinytest.addAsync(
      `ReactivePublish unsubscribing (${idGeneration}) - users-posts`,
      (test, done) => {
        runSteps(unsubscribingSteps('users-posts', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish unsubscribing (${idGeneration}) - users-posts-autorun`,
      (test, done) => {
        runSteps(unsubscribingSteps('users-posts-autorun', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish unsubscribing (${idGeneration}) - users-posts-foreach`,
      (test, done) => {
        runSteps(unsubscribingSteps('users-posts-foreach', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish unsubscribing (${idGeneration}) - users-posts-nested`,
      (test, done) => {
        runSteps(unsubscribingSteps('users-posts-nested', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish unsubscribing (${idGeneration}) - users-posts-method`,
      (test, done) => {
        runSteps(unsubscribingSteps('users-posts-method', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish unsubscribing (${idGeneration}) - users-posts-reactive`,
      (test, done) => {
        runSteps(unsubscribingSteps('users-posts-reactive', test), test, done);
      }
    );
  }

  // REMOVE FIELD TESTS.
  function removeFieldSteps(publishName, test) {
    return [
      async function (next) {
        this.countsCollection = Counts;
        next();
      },
      function (next) {
        this.userId = generateId();
        this.subscribeSuccess(
          `${publishName}_${idGeneration}`,
          this.userId,
          next
        );
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), []);

        try {
          const fieldsId = await Fields.insertAsync({
            _id: this.userId,
            foo: 1,
            dummyField: 1,
          });

          test.ok(fieldsId);
          this.fieldsId = fieldsId;
          const postId = await Posts.insertAsync({ foo: 'bar' });

          test.ok(postId);
          this.postId = postId;
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), []);
        try {
          const userId = await Users.insertAsync({
            _id: this.userId,
            posts: [this.postId],
          });
          test.ok(userId);
          test.equal(userId, this.userId);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), [
          { _id: this.postId, foo: 'bar', dummyField: true },
        ]);
        try {
          const count = await Posts.updateAsync(this.postId, {
            $set: { foo: 'baz' },
          });
          test.equal(count, 1);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), [
          { _id: this.postId, foo: 'baz', dummyField: true },
        ]);
        try {
          const count = await Posts.updateAsync(this.postId, {
            $unset: { foo: '' },
          });
          test.equal(count, 1);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), [
          { _id: this.postId, dummyField: true },
        ]);

        try {
          const count = await Posts.updateAsync(this.postId, {
            $set: { foo: 'bar' },
          });
          test.equal(count, 1);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), [
          { _id: this.postId, foo: 'bar', dummyField: true },
        ]);
        try {
          await Fields.updateAsync(this.userId, {
            $unset: { foo: '' },
          });
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), [
          { _id: this.postId, dummyField: true },
        ]);

        unsubscribeAll();

        next();
      },
    ];
  }

  if (Meteor.isClient) {
    Tinytest.addAsync(
      `ReactivePublish remove field (${idGeneration}) - users-posts`,
      (test, done) => {
        runSteps(removeFieldSteps('users-posts', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish remove field (${idGeneration}) - users-posts-foreach`,
      (test, done) => {
        runSteps(removeFieldSteps('users-posts-foreach', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish remove field (${idGeneration}) - users-posts-nested`,
      (test, done) => {
        runSteps(removeFieldSteps('users-posts-nested', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish remove field (${idGeneration}) - users-posts-method`,
      (test, done) => {
        runSteps(removeFieldSteps('users-posts-method', test), test, done);
      }
    );
  }

  // MULTIPLE TESTS.
  function multipleSteps(publishName, test) {
    return [
      function (next) {
        this.userId = generateId();
        this.subscribeSuccess(
          `${publishName}_${idGeneration}`,
          this.userId,
          next
        );
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), []);
        test.equal(await Addresses.find().fetchAsync(), []);
        this.posts = [];
        this.addresses = [];

        // Insert posts
        for (let i = 0; i < 10; i++) {
          try {
            const id = await Posts.insertAsync({});
            test.ok(id);
            this.posts.push(id);
          } catch (error) {
            test.isFalse(error, error && error.toString());
          }
        }
        await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));

        // Insert addresses
        for (let j = 0; j < 10; j++) {
          try {
            const id = await Addresses.insertAsync({});
            test.ok(id);
            this.addresses.push(id);
          } catch (error) {
            test.isFalse(error, error && error.toString());
          }
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.equal(await Posts.find().fetchAsync(), []);
        test.equal(await Addresses.find().fetchAsync(), []);

        try {
          const userId = await Users.insertAsync({
            _id: this.userId,
            posts: this.posts,
            addresses: this.addresses,
          });
          test.ok(userId);
          test.equal(userId, this.userId);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.isTrue(
          arraysHaveSameItems(
            (await Posts.find().fetchAsync()).map((doc) => doc._id),
            this.posts
          )
        );
        test.isTrue(
          arraysHaveSameItems(
            (await Addresses.find().fetchAsync()).map((doc) => doc._id),
            this.addresses
          )
        );

        try {
          await Users.updateAsync(this.userId, {
            $set: { posts: this.posts.slice(0, 6) },
          });
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 5000);
      },
      async function (next) {
        test.isTrue(
          arraysHaveSameItems(
            (await Posts.find().fetchAsync()).map((doc) => doc._id),
            this.posts.slice(0, 6)
          )
        );
        test.isTrue(
          arraysHaveSameItems(
            (await Addresses.find().fetchAsync()).map((doc) => doc._id),
            this.addresses
          )
        );

        try {
          await Users.updateAsync(this.userId, {
            $set: { addresses: this.addresses.slice(0, 6) },
          });
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.isTrue(
          arraysHaveSameItems(
            (await Posts.find().fetchAsync()).map((doc) => doc._id),
            this.posts.slice(0, 6)
          )
        );
        test.isTrue(
          arraysHaveSameItems(
            (await Addresses.find().fetchAsync()).map((doc) => doc._id),
            this.addresses.slice(0, 6)
          )
        );

        try {
          await Users.updateAsync(this.userId, {
            $unset: { addresses: '' },
          });
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.isTrue(
          arraysHaveSameItems(
            (await Posts.find().fetchAsync()).map((doc) => doc._id),
            this.posts.slice(0, 6)
          )
        );
        test.isTrue(
          arraysHaveSameItems(
            (await Addresses.find().fetchAsync()).map((doc) => doc._id),
            []
          )
        );

        try {
          await Users.removeAsync(this.userId);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        test.isTrue(
          arraysHaveSameItems(
            (await Posts.find().fetchAsync()).map((doc) => doc._id),
            []
          )
        );
        test.isTrue(
          arraysHaveSameItems(
            (await Addresses.find().fetchAsync()).map((doc) => doc._id),
            []
          )
        );
        next();
      },
    ];
  }

  if (Meteor.isClient) {
    Tinytest.addAsync(
      `ReactivePublish multiple (${idGeneration}) - users-posts-and-addresses`,
      (test, done) => {
        runSteps(multipleSteps('users-posts-and-addresses', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish multiple (${idGeneration}) - users-posts-and-addresses-together`,
      (test, done) => {
        runSteps(
          multipleSteps('users-posts-and-addresses-together', test),
          test,
          done
        );
      }
    );
  }

  if (Meteor.isClient) {
    // REACTIVE TIME – Tests recent posts publishing and auto-removals.
    Tinytest.addAsync(
      `ReactivePublish reactive time (${idGeneration}) - recent-posts`,
      (test, done) => {
        const steps = [
          async function (next) {
            this.subscribeSuccess(`recent-posts_${idGeneration}`, () => {
              this.changes = [];
              this.handle = Posts.find({
                timestamp: { $exists: true },
              }).observeChangesAsync({
                added: (id) => {
                  if (this.changes.some((change) => change.added === id)) {
                    return;
                  } // TODO should not happen re-added for same id
                  this.changes.push({ added: id, timestamp: Date.now() });
                },
                changed: (_id) => {
                  test.fail('Changed should not occur');
                },
                removed: (id) => {
                  if (this.changes.some((change) => change.removed === id)) {
                    return;
                  } // TODO should not happen re-removed for same id
                  this.changes.push({ removed: id, timestamp: Date.now() });
                },
              });
              next();
            });
          },
          async function (next) {
            test.equal(
              await Posts.find({ timestamp: { $exists: true } }).fetchAsync(),
              []
            );
            this.posts = [];
            let pending = 10;
            for (let i = 0; i < 10; i++) {
              const timestamp = Date.now() + i * 91;
              try {
                const id = await Meteor.callAsync(
                  `insertPost_${idGeneration}`,
                  timestamp
                );
                test.ok(id);
                this.posts.push({ _id: id, timestamp });
                if (--pending === 0) {
                  await Meteor.setTimeout(next, 1000);
                }
              } catch (error) {
                test.isFalse(error, error && error.toString());
              }
            }
          },
          async function (next) {
            this.posts.sort((a, b) => a.timestamp - b.timestamp);
            test.isTrue(
              arraysHaveSameItems(
                await Posts.find(
                  { timestamp: { $exists: true } },
                  { sort: { timestamp: 1 } }
                ).fetchAsync(),
                this.posts
              )
            );
            await Meteor.setTimeout(next, 2000);
          },
          async function (next) {
            test.equal(
              await Posts.find({ timestamp: { $exists: true } }).fetchAsync(),
              []
            );
            test.equal(this.changes.length, 20);
            const postsId = this.posts.map((post) => post._id);
            const added = this.changes
              .filter((change) => change.added)
              .map((change) => change.added);
            test.isTrue(arraysHaveSameItems(added, postsId));
            this.assertItemsEqual(added, postsId);
            const removed = this.changes
              .filter((change) => change.removed)
              .map((change) => change.removed);
            test.isTrue(arraysHaveSameItems(removed, postsId));
            const addedTimestamps = this.changes
              .filter((change) => change.added)
              .map((change) => change.timestamp);
            const removedTimestamps = this.changes
              .filter((change) => change.removed)
              .map((change) => change.timestamp);
            addedTimestamps.sort();
            removedTimestamps.sort();
            const sum = (list) => list.reduce((memo, num) => memo + num, 0);
            const averageAdded = sum(addedTimestamps) / addedTimestamps.length;
            const averageRemoved =
              sum(removedTimestamps) / removedTimestamps.length;
            test.ok(averageAdded + 2000 < averageRemoved);
            let removedDelta = 0;
            for (let i = 0; i < removedTimestamps.length - 1; i++) {
              removedDelta += removedTimestamps[i + 1] - removedTimestamps[i];
            }
            removedDelta /= removedTimestamps.length - 1;
            test.ok(removedDelta > 60, removedDelta);

            next();
          },
        ];
        runSteps(steps, test, done);
      }
    );
  }

  if (Meteor.isClient) {
    // MULTIPLE CURSORS – Expect errors on subscriptions.
    Tinytest.addAsync(
      `ReactivePublish multiple cursors (${idGeneration}) - multiple-cursors`,
      (test, done) => {
        // Both these subscriptions should trigger errors.
        // Using subscribeFail helper.
        runSteps(
          [
            function (next) {
              this.subscribeFail(
                `multiple-cursors-1_${idGeneration}`,
                [],
                next
              );
            },
            function (next) {
              this.subscribeFail(
                `multiple-cursors-2_${idGeneration}`,
                [],
                next
              );
            },
            function (next) {
              next();
            },
          ],
          test,
          done
        );
      }
    );
  }

  // LOCAL COLLECTION – Test insertions and limit changes.
  function localCollectionSteps(test) {
    return [
      async function (next) {
        try {
          await Meteor.callAsync(`clearLocalCollection_${idGeneration}`);
          next();
        } catch (error) {
          test.isFalse(error, error);
        }
      },
      async function (next) {
        try {
          await Meteor.callAsync(`setLocalCollectionLimit_${idGeneration}`, 10);
          next();
        } catch (error) {
          test.isFalse(error, error);
        }
      },
      function (next) {
        this.subscribeSuccess(`localCollection_${idGeneration}`, next);
      },
      async function (next) {
        // eslint-disable-next-line no-undef
        test.equal(await LocalCollection.find({}).fetchAsync(), []);

        // Insert documents
        for (let i = 0; i < 10; i++) {
          try {
            const documentId = await Meteor.callAsync(
              `insertLocalCollection_${idGeneration}`,
              { i: i }
            );
            test.ok(documentId);
          } catch (error) {
            test.isFalse(error, error);
          }
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        // eslint-disable-next-line no-undef
        test.equal(LocalCollection.find({}).count(), 10);

        try {
          await Meteor.callAsync(`setLocalCollectionLimit_${idGeneration}`, 5);
          await Meteor.setTimeout(next, 100);
        } catch (error) {
          test.isFalse(error, error);
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        // eslint-disable-next-line no-undef
        test.equal(await LocalCollection.find({}).countAsync(), 5);

        // Insert more documents
        for (let i = 10; i < 20; i++) {
          try {
            const documentId = await Meteor.callAsync(
              `insertLocalCollection_${idGeneration}`,
              { i: i }
            );
            test.ok(documentId);
          } catch (error) {
            test.isFalse(error, error);
          }
        }

        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        // eslint-disable-next-line no-undef
        test.equal(await LocalCollection.find({}).countAsync(), 5);

        try {
          await Meteor.callAsync(`setLocalCollectionLimit_${idGeneration}`, 15);
          await Meteor.setTimeout(next, 100);
        } catch (error) {
          test.isFalse(error, error);
        }
      },
      async function (next) {
        // eslint-disable-next-line no-undef
        test.equal(await LocalCollection.find({}).countAsync(), 15);
        next();
      },
    ];
  }

  if (Meteor.isClient) {
    Tinytest.addAsync(
      `ReactivePublish local collection (${idGeneration}) - localCollection`,
      (test, done) => {
        runSteps(localCollectionSteps(test), test, done);
      }
    );
  }

  // UNBLOCKED PUBLISH – Verify multiplexer counts.
  function unblockedSteps(test) {
    return [
      async function (next) {
        try {
          await Meteor.callAsync(`runOnServer_${idGeneration}`);
          let count = 0;
          allCollections.forEach((collection) => {
            console.log(collection);
            if (
              collection &&
              collection._driver &&
              collection._driver.mongo &&
              collection._driver.mongo._observeMultiplexers
            ) {
              console.log(collection._driver.mongo._observeMultiplexers);
              count += Object.keys(
                collection._driver.mongo._observeMultiplexers
              ).length;
            }
          });
          this.multiplexerCountBefore = count;
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
        next();
      },
      async function (next) {
        this.userId = generateId();
        const handle = Meteor.subscribe(
          `unblocked-users-posts_${idGeneration}`,
          this.userId
        );
        if (handle && typeof handle.stop === 'function') {
          handle.stop();
        }
        await Meteor.setTimeout(next, 1000);
      },
      async function (next) {
        try {
          await Meteor.callAsync(`runOnServer_${idGeneration}`);
          let countAfter = 0;
          allCollections.forEach((collection) => {
            if (
              collection &&
              collection._driver &&
              collection._driver.mongo &&
              collection._driver.mongo._observeMultiplexers
            ) {
              countAfter += Object.keys(
                collection._driver.mongo._observeMultiplexers
              ).length;
            }
          });
          test.equal(this.multiplexerCountBefore, countAfter);
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
        next();
      },
    ];
  }

  if (Meteor.isClient) {
    Tinytest.addAsync(
      `ReactivePublish unblocked (${idGeneration}) - runOnServer`,
      (test, done) => {
        runSteps(unblockedSteps(test), test, done);
      }
    );
  }

  // ---- ERROR TESTS ----
  // On the server, define error publications.
  if (Meteor.isServer) {
    Meteor.publish('initial error', function () {
      this.autorun(async () => {
        throw new Meteor.Error('triggered error');
      });
    });
    Meteor.publish('rereun error', function () {
      const reactiveError = new ReactiveVarAsync(false);
      this.autorun(async () => {
        if (reactiveError.get()) {
          throw new Meteor.Error('triggered error');
        }
      });
      setTimeout(() => {
        reactiveError.set(true);
      }, 1000);
      this.ready();
    });
  }

  // Initial error test steps
  function initialErrorSteps(test) {
    return [
      function (next) {
        // First, make sure we have no active subscriptions
        unsubscribeAll();

        // Subscribe to the initial error publication
        Meteor.subscribe('initial error', {
          onError(error) {
            console.log('Error received:', error);
            test.ok(true, 'Error received as expected');
            next();
          },
          onReady() {
            test.fail('Subscription should have failed');
            next();
          },
        });
      }
    ];
  }

  // Rerun error test steps
  function rerunErrorSteps(test) {
    return [
      function (next) {
        // First, make sure we have no active subscriptions
        unsubscribeAll();

        let isReady = false;
        Meteor.subscribe('rereun error', {
          onReady() {
            isReady = true;
          },
          onStop(error) {
            test.ok(isReady, 'Received error on rerun');
            test.equal(error.message, '[triggered error]');
            next();
          },
        });
      }
    ];
  }

  if (Meteor.isClient) {
    Tinytest.addAsync(
      `ReactivePublish error (${idGeneration}) - initial error`,
      (test, done) => {
        runSteps(initialErrorSteps(test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish error (${idGeneration}) - rereun error`,
      (test, done) => {
        runSteps(rerunErrorSteps(test), test, done);
      }
    );
  }

  // ---- CLEANUP TESTS ----
  // On the server, define a publication for testing cleanup
  if (Meteor.isServer) {
    Meteor.publish(`cleanup-test_${idGeneration}`, function () {
      const self = this;
      self.autorun(async () => {
        // Query the collection and publish the results
        return CleanupTest.find();
      });
    });

    // Create Maps to store rerun counts and computations outside the publish context
    const rerunCountsMap = new Map();
    const computationsMap = new Map();

    // Publication that tracks rerun counts
    Meteor.publish(`subscription-stop-test_${idGeneration}`, function (countId) {
      const self = this;

      // Initialize or reset the rerun count
      let rerunCount = 0;
      rerunCountsMap.set(countId, rerunCount);

      // Initialize the computation variable
      let computation;

      // Run the autorun
      self.autorun(async (comp) => {
        // Store the computation passed to the callback
        computation = comp;

        // Increment the rerun count
        rerunCount++;

        // Update the count in the map
        rerunCountsMap.set(countId, rerunCount);

        // Publish the count
        self.added(`RerunCounts_${idGeneration}`, countId, { count: rerunCount });

        // Query the collection and publish the results
        return CleanupTest.find();
      });

      // Store the computation in the map
      computationsMap.set(countId, computation);
    });

    // Methods to get the current rerun count and computation state
    Meteor.methods({
      [`getRerunCount_${idGeneration}`](countId) {
        return rerunCountsMap.get(countId) || 0;
      },
      [`getComputationState_${idGeneration}`](countId) {
        const computation = computationsMap.get(countId);
        if (!computation) return { exists: false };

        return {
          exists: true,
          stopped: computation.stopped,
          cursorCacheSize: computation._cursorCache ? computation._cursorCache.size : 0
        };
      }
    });
  }

  // Test that documents and oldDocuments are emptied after subscription is stopped
  function cleanupSteps(test) {
    return [
      async function (next) {
        // First, make sure we have no active subscriptions
        unsubscribeAll();

        // Wait a bit to ensure cleanup from previous tests
        await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
        next();
      },
      async function (next) {
        // Insert a test document into the collection from the client
        try {
          await Meteor.callAsync(`insertCleanupTest_${idGeneration}`, { _id: 'test-id', value: 'test' });
          next();
        } catch (error) {
          test.fail(`Failed to insert test document: ${error.message}`);
          next();
        }
      },
      function (next) {
        // Subscribe to the cleanup test publication
        this.subscribeSuccess(`cleanup-test_${idGeneration}`, next);
      },
      async function (next) {
        // Check that we received the document
        const doc = await CleanupTest.findOneAsync({ _id: 'test-id' });
        test.isNotUndefined(doc, 'Document should exist in the collection');
        test.equal(doc?.value, 'test', 'Document should have the expected value');

        // Verify that documents and oldDocuments are not empty during active subscription
        try {
          const beforeCleanup = await Meteor.callAsync(
            `checkDocumentsCleanup_${idGeneration}`
          );
          test.isFalse(
            beforeCleanup.documentsEmpty,
            'documents should not be empty during active subscription'
          );
          test.isFalse(
            Object.keys(beforeCleanup.allCollectionNamesEmpty).filter(Boolean).length > 0,
            'allCollectionNames should not be empty during active subscription'
          );
          next();
        } catch (error) {
          test.fail(`Failed to check documents cleanup: ${error.message}`);
          next();
        }
      },
      function (next) {
        // Stop all subscriptions
        unsubscribeAll();

        // Wait for cleanup to occur
        Meteor.setTimeout(next, 500);
      },
      async function (next) {
        // Verify that documents and oldDocuments are empty after subscription is stopped
        try {
          const afterCleanup = await Meteor.callAsync(
            `checkDocumentsCleanup_${idGeneration}`
          );
          test.isTrue(
            afterCleanup.documentsEmpty,
            'documents should be empty after subscription is stopped'
          );
          test.isTrue(
            afterCleanup.oldDocumentsEmpty,
            'oldDocuments should be empty after subscription is stopped'
          );
          test.isTrue(
            Object.keys(afterCleanup.allCollectionNamesEmpty).filter(Boolean).length === 0,
            'allCollectionNames should be empty after subscription is stopped'
          );
          next();
        } catch (error) {
          test.fail(`Failed to check documents cleanup: ${error.message}`);
          next();
        }
      }
    ];
  }

  if (Meteor.isClient) {
    Tinytest.addAsync(
      `ReactivePublish cleanup (${idGeneration}) - documents and oldDocuments cleanup`,
      (test, done) => {
        runSteps(cleanupSteps(test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish subscription stop (${idGeneration}) - no reruns after stopping subscription`,
      (test, done) => {
        runSteps(subscriptionStopSteps(test), test, done);
      }
    );
  }

  // Test that after stopping a subscription, new operations won't cause the publication to rerun
  function subscriptionStopSteps(test) {
    return [
      async function (next) {
        // First, make sure we have no active subscriptions
        unsubscribeAll();

        // Wait a bit to ensure cleanup from previous tests
        await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
        next();
      },
      function (next) {
        // Generate a unique ID for tracking the rerun count
        this.countId = generateId();

        // Subscribe to the subscription-stop-test publication
        this.subscription = this.subscribeSuccess(
          `subscription-stop-test_${idGeneration}`,
          this.countId,
          next
        );
      },
      async function (next) {
        // Wait a bit for the subscription to be ready
        await new Promise((resolve) => Meteor.setTimeout(resolve, 500));

        // Get the initial rerun count
        try {
          this.initialRerunCount = await Meteor.callAsync(
            `getRerunCount_${idGeneration}`,
            this.countId
          );
          test.isTrue(this.initialRerunCount > 0, 'Initial rerun count should be greater than 0');

          // Get the initial computation state
          this.initialComputationState = await Meteor.callAsync(
            `getComputationState_${idGeneration}`,
            this.countId
          );
          test.isTrue(this.initialComputationState.exists, 'Computation should exist');
          test.isFalse(this.initialComputationState.stopped, 'Computation should not be stopped initially');
          test.isTrue(this.initialComputationState.cursorCacheSize > 0, 'Cursor cache should have entries initially');

          next();
        } catch (error) {
          test.fail(`Failed to get initial state: ${error.message}`);
          next();
        }
      },
      async function (next) {
        // Insert a document to trigger a rerun
        try {
          await Meteor.callAsync(
            `insertCleanupTest_${idGeneration}`,
            { _id: 'test-doc-1', value: 'test1' }
          );
          next();
        } catch (error) {
          test.fail(`Failed to insert test document: ${error.message}`);
          next();
        }
      },
      async function (next) {
        // Wait a bit for the publication to rerun
        await new Promise((resolve) => Meteor.setTimeout(resolve, 500));

        // Get the rerun count after inserting a document
        try {
          this.rerunCountAfterInsert = await Meteor.callAsync(
            `getRerunCount_${idGeneration}`,
            this.countId
          );
          test.isTrue(
            this.rerunCountAfterInsert > this.initialRerunCount,
            'Rerun count should increase after inserting a document'
          );
          next();
        } catch (error) {
          test.fail(`Failed to get rerun count after insert: ${error.message}`);
          next();
        }
      },
      function (next) {
        // Stop the subscription
        if (this.subscription && typeof this.subscription.stop === 'function') {
          this.subscription.stop();
        }

        // Wait a bit for the subscription to stop
        Meteor.setTimeout(next, 500);
      },
      async function (next) {
        // Get the rerun count and computation state after stopping the subscription
        try {
          this.rerunCountAfterStop = await Meteor.callAsync(
            `getRerunCount_${idGeneration}`,
            this.countId
          );
          test.equal(
            this.rerunCountAfterStop,
            this.rerunCountAfterInsert,
            'Rerun count should not change after stopping the subscription'
          );

          // Get the computation state after stopping
          this.computationStateAfterStop = await Meteor.callAsync(
            `getComputationState_${idGeneration}`,
            this.countId
          );
          test.isTrue(this.computationStateAfterStop.exists, 'Computation should still exist after stopping');
          test.isTrue(this.computationStateAfterStop.stopped, 'Computation should be stopped');
          test.equal(this.computationStateAfterStop.cursorCacheSize, 0, 'Cursor cache size should be 0 after stopping');

          next();
        } catch (error) {
          test.fail(`Failed to get state after stop: ${error.message}`);
          next();
        }
      },
      async function (next) {
        // Insert another document that would normally trigger a rerun
        try {
          await Meteor.callAsync(
            `insertCleanupTest_${idGeneration}`,
            { _id: 'test-doc-2', value: 'test2' }
          );
          next();
        } catch (error) {
          test.fail(`Failed to insert second test document: ${error.message}`);
          next();
        }
      },
      async function (next) {
        // Update a document that would normally trigger a rerun
        try {
          await Meteor.callAsync(
            `updateCleanupTest_${idGeneration}`,
            'test-doc-1',
            { value: 'updated' }
          );
          next();
        } catch (error) {
          test.fail(`Failed to update test document: ${error.message}`);
          next();
        }
      },
      async function (next) {
        // Remove a document that would normally trigger a rerun
        try {
          await Meteor.callAsync(
            `removeCleanupTest_${idGeneration}`,
            'test-doc-1'
          );
          next();
        } catch (error) {
          test.fail(`Failed to remove test document: ${error.message}`);
          next();
        }
      },
      async function (next) {
        // Wait a bit to ensure any potential reruns would have happened
        await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));

        // Get the final rerun count
        try {
          this.finalRerunCount = await Meteor.callAsync(
            `getRerunCount_${idGeneration}`,
            this.countId
          );
          test.equal(
            this.finalRerunCount,
            this.rerunCountAfterStop,
            'Rerun count should remain the same after operations that would normally trigger reruns'
          );
          next();
        } catch (error) {
          test.fail(`Failed to get final rerun count: ${error.message}`);
          next();
        }
      },
      async function (next) {
        // Clean up by removing test documents
        try {
          await Meteor.callAsync(
            `removeCleanupTest_${idGeneration}`,
            'test-doc-2'
          );
          next();
        } catch (error) {
          test.fail(`Failed to clean up test documents: ${error.message}`);
          next();
        }
      }
    ];
  }

  // ---- USER ID TEST ----
  // On the server, define a publication that uses Meteor.userId() in an autorun
  // To check the next error doesn't happen: Meteor.userId can only be invoked in method calls or publications.
  if (Meteor.isServer) {
    Meteor.publish(`user-id-check_${idGeneration}`, function () {
      const self = this;
      self.autorun(() => {
        // Check if user is not logged in
        if (!Meteor.userId()) {
          self.added(`user-id-collection_${idGeneration}`, 'test-id', {
            isLoggedIn: false
          });
        }
        self.ready();
      });
    });
  }

  function userIdCheckSteps(test) {
    return [
      async function (next) {
        // First, make sure we have no active subscriptions
        unsubscribeAll();

        // Wait a bit to ensure cleanup from previous tests
        await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
        next();
      },
      function (next) {
        // Subscribe to the user ID test publication
        this.subscribeSuccess(`user-id-check_${idGeneration}`, next);
      },
      async function (next) {
        // Create a local collection to receive the documents
        const UserIdCollection = new Mongo.Collection(`user-id-collection_${idGeneration}`);

        // Check that we received the document with isLoggedIn: false
        const doc = await UserIdCollection.findOneAsync('test-id');
        test.isNotUndefined(doc, 'Document should exist');
        test.equal(doc.isLoggedIn, false, 'User should not be logged in');

        // Stop all subscriptions
        unsubscribeAll();

        // Wait for cleanup
        await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
        next();
      }
    ];
  }

  if (Meteor.isClient) {
    Tinytest.addAsync(
      `ReactivePublish userId check (${idGeneration}) - autorun with Meteor.userId()`,
      (test, done) => {
        runSteps(userIdCheckSteps(test), test, done);
      }
    );
  }
});
