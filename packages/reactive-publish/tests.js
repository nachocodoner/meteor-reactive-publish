import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from 'meteor/server-autorun';
import { ReactiveVar } from 'meteor/reactive-var';
import { Mongo } from 'meteor/mongo';
import { LocalCollection } from 'meteor/minimongo';
import { Random } from 'meteor/random';

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
        onError(error) {
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
['STRING' /*'MONGO'*/].forEach((idGeneration) => {
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

  async function setUpServer() {
    await Users.removeAsync({});
    await Posts.removeAsync({});
    await Addresses.removeAsync({});
    await Fields.removeAsync({});
  }

  // Save collections for multiplexer count.
  const allCollections = [Users, Posts, Addresses, Fields];

  // On the server, define additional (local) collections, publications, and methods.
  if (Meteor.isServer) {
    const LocalCollection = new Mongo.Collection(null, { idGeneration });
    const localCollectionLimit = new ReactiveVar(null);
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
        handle && handle.stop && (await handle.stop());
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

    Meteor.publish(`users-posts-autorun_${idGeneration}`, function (userId) {
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
            added(id) {
              count++;
              if (!initializing) {
                self.changed(`Counts_${idGeneration}`, countId, { count });
              }
            },
            removed(id) {
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

    const currentTime = new ReactiveVar(Date.now());
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
      self.autorun(() => {
        LocalCollection.find(
          {},
          { sort: { i: 1 }, limit: localCollectionLimit.get() }
        ).observeChanges({
          addedBefore(id, fields) {
            self.added(`localCollection_${idGeneration}`, id, fields);
          },
          changed(id, fields) {
            self.changed(`localCollection_${idGeneration}`, id, fields);
          },
          removed(id) {
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
    methods[`insertLocalCollection_${idGeneration}`] = function (doc) {
      return LocalCollection.insert(doc);
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
  localMethods[`clearLocalCollection_${idGeneration}`] = function () {
    return LocalCollection.remove({});
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

        await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));
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
      `ReactivePublish basic (${idGeneration}) - users-posts-foreach`,
      (test, done) => {
        runSteps(basicSteps('users-posts-foreach', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish basic (${idGeneration}) - users-posts-autorun`,
      (test, done) => {
        runSteps(basicSteps('users-posts-autorun', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish basic (${idGeneration}) - users-posts-method`,
      (test, done) => {
        runSteps(basicSteps('users-posts-method', test), test, done);
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
      `ReactivePublish unsubscribing (${idGeneration}) - users-posts-foreach`,
      (test, done) => {
        runSteps(unsubscribingSteps('users-posts-foreach', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish unsubscribing (${idGeneration}) - users-posts-autorun`,
      (test, done) => {
        runSteps(unsubscribingSteps('users-posts-autorun', test), test, done);
      }
    );

    Tinytest.addAsync(
      `ReactivePublish unsubscribing (${idGeneration}) - users-posts-method`,
      (test, done) => {
        runSteps(unsubscribingSteps('users-posts-method', test), test, done);
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
      `ReactivePublish remove field (${idGeneration}) - users-posts-autorun`,
      (test, done) => {
        runSteps(removeFieldSteps('users-posts-autorun', test), test, done);
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
        await Meteor.setTimeout(next, 1000);

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

  //
  // // REACTIVE TIME – Tests recent posts publishing and auto-removals.
  // Tinytest.addAsync(
  //   `ReactivePublish reactive time (${idGeneration}) - recent-posts`,
  //   (test, done) => {
  //     const steps = [
  //       function (next) {
  //         this.subscribeSuccess(`recent-posts_${idGeneration}`, () => {
  //           this.changes = [];
  //           this.handle = Posts.find({
  //             timestamp: { $exists: true },
  //           }).observeChanges({
  //             added: (id, fields) => {
  //               this.changes.push({ added: id, timestamp: Date.now() });
  //             },
  //             changed: (id, fields) => {
  //               test.fail('Changed should not occur');
  //             },
  //             removed: (id) => {
  //               this.changes.push({ removed: id, timestamp: Date.now() });
  //             },
  //           });
  //           next();
  //         });
  //       },
  //       function (next) {
  //         test.equal(Posts.find({ timestamp: { $exists: true } }).fetch(), []);
  //         this.posts = [];
  //         let pending = 10;
  //         for (let i = 0; i < 10; i++) {
  //           const timestamp = Date.now() + i * 91;
  //           Meteor.call(
  //             `insertPost_${idGeneration}`,
  //             timestamp,
  //             (error, id) => {
  //               test.isFalse(error, error && error.toString());
  //               test.ok(id);
  //               this.posts.push({ _id: id, timestamp });
  //               if (--pending === 0) {
  //                 Meteor.setTimeout(next, 1000);
  //               }
  //             }
  //           );
  //         }
  //       },
  //       function (next) {
  //         this.posts.sort((a, b) => a.timestamp - b.timestamp);
  //         test.equal(
  //           Posts.find(
  //             { timestamp: { $exists: true } },
  //             { sort: { timestamp: 1 } }
  //           ).fetch(),
  //           this.posts
  //         );
  //         Meteor.setTimeout(next, 3000);
  //       },
  //       function (next) {
  //         test.equal(Posts.find({ timestamp: { $exists: true } }).fetch(), []);
  //         test.equal(this.changes.length, 20);
  //         const postsId = this.posts.map((post) => post._id);
  //         const added = this.changes
  //           .filter((change) => change.added)
  //           .map((change) => change.added);
  //         this.assertItemsEqual(added, postsId);
  //         const removed = this.changes
  //           .filter((change) => change.removed)
  //           .map((change) => change.removed);
  //         test.equal(removed, postsId);
  //         const addedTimestamps = this.changes
  //           .filter((change) => change.added)
  //           .map((change) => change.timestamp);
  //         const removedTimestamps = this.changes
  //           .filter((change) => change.removed)
  //           .map((change) => change.timestamp);
  //         addedTimestamps.sort();
  //         removedTimestamps.sort();
  //         const sum = (list) => list.reduce((memo, num) => memo + num, 0);
  //         const averageAdded = sum(addedTimestamps) / addedTimestamps.length;
  //         const averageRemoved =
  //           sum(removedTimestamps) / removedTimestamps.length;
  //         test.ok(averageAdded + 2000 < averageRemoved);
  //         let removedDelta = 0;
  //         for (let i = 0; i < removedTimestamps.length - 1; i++) {
  //           removedDelta += removedTimestamps[i + 1] - removedTimestamps[i];
  //         }
  //         removedDelta /= removedTimestamps.length - 1;
  //         test.ok(removedDelta > 60, removedDelta);
  //         next();
  //       },
  //     ];
  //     runSteps(steps, test, done);
  //   }
  // );

  // MULTIPLE CURSORS – Expect errors on subscriptions.
  // Tinytest.addAsync(
  //   `ReactivePublish multiple cursors (${idGeneration})`,
  //   (test, done) => {
  //     // Both these subscriptions should trigger errors.
  //     // Using subscribeFail helper.
  //     runSteps(
  //       [
  //         function (next) {
  //           this.subscribeFail(`multiple-cursors-1_${idGeneration}`, [], next);
  //         },
  //         function (next) {
  //           this.subscribeFail(`multiple-cursors-2_${idGeneration}`, [], next);
  //         },
  //         function (next) {
  //           next();
  //         },
  //       ],
  //       test,
  //       done
  //     );
  //   }
  // );

  // LOCAL COLLECTION – Test insertions and limit changes.
  function localCollectionSteps() {
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

        next();
      },
      async function (next) {
        await Meteor.setTimeout(next, 100);
      },
      async function (next) {
        test.equal(await LocalCollection.find({}).countAsync(), 10);

        try {
          await Meteor.callAsync(`setLocalCollectionLimit_${idGeneration}`, 5);
          await Meteor.setTimeout(next, 100);
        } catch (error) {
          test.isFalse(error, error);
        }
      },
      async function (next) {
        test.equal(await LocalCollection.find({}).countAsync(), 5);

        // Insert more documents
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

        next();
      },
      async function (next) {
        await Meteor.setTimeout(next, 100);
      },
      async function (next) {
        test.equal(await LocalCollection.find({}).countAsync(), 5);

        try {
          await Meteor.callAsync(`setLocalCollectionLimit_${idGeneration}`, 15);
          await Meteor.setTimeout(next, 100);
        } catch (error) {
          test.isFalse(error, error);
        }
      },
      async function (next) {
        test.equal(await LocalCollection.find({}).countAsync(), 15);
        next();
      },
    ];
  }
  // Tinytest.addAsync(
  //   `ReactivePublish local collection (${idGeneration})`,
  //   (test, done) => {
  //     runSteps(localCollectionSteps(), test, done);
  //   }
  // );

  // UNBLOCKED PUBLISH – Verify multiplexer counts.
  function unblockedSteps(test) {
    return [
      async function (next) {
        // Run on server (assuming a "runOnServer" method exists).
        try {
          await Meteor.callAsync('runOnServer', () => {
            let count = 0;
            allCollections.forEach((collection) => {
              if (
                collection &&
                collection._driver &&
                collection._driver.mongo &&
                collection._driver.mongo._observeMultiplexers
              ) {
                count += Object.keys(
                  collection._driver.mongo._observeMultiplexers
                ).length;
              }
            });
            this.multiplexerCountBefore = count;
            next();
          });
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
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
          await Meteor.callAsync('runOnServer', () => {
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
            next();
          });
        } catch (error) {
          test.isFalse(error, error && error.toString());
        }
      },
    ];
  }
  // Tinytest.addAsync(
  //   `ReactivePublish unblocked (${idGeneration})`,
  //   (test, done) => {
  //     runSteps(unblockedSteps(), test, done);
  //   }
  // );

  // ---- ERROR TESTS ----
  // On the server, define error publications.
  if (Meteor.isServer) {
    Meteor.publish('initial error', function () {
      this.autorun(() => {
        throw new Meteor.Error('triggered error');
      });
    });
    Meteor.publish('rereun error', function () {
      const reactiveError = new ReactiveVar(false);
      this.autorun(() => {
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

  // Tinytest.addAsync(
  //   `ReactivePublish error (${idGeneration}) - initial error`,
  //   (test, done) => {
  //     Meteor.subscribe('initial error', {
  //       onError(error) {
  //         test.ok(true, 'Error received as expected');
  //         done();
  //       },
  //       onReady() {
  //         test.fail('Subscription should have failed');
  //         done();
  //       },
  //     });
  //   }
  // );
  //
  // Tinytest.addAsync(
  //   `ReactivePublish error (${idGeneration}) - rereun error`,
  //   (test, done) => {
  //     let isReady = false;
  //     Meteor.subscribe('rereun error', {
  //       onReady() {
  //         isReady = true;
  //       },
  //       onStop(error) {
  //         test.ok(isReady, 'Received error on rerun');
  //         test.equal(error.message, '[triggered error]');
  //         done();
  //       },
  //     });
  //   }
  // );
});
