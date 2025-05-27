import { Tinytest } from 'meteor/tinytest';
import { Tracker } from 'meteor/tracker';
import { ReactiveVar } from 'meteor/reactive-var';
import { Mongo } from 'meteor/mongo';
import { LocalCollection } from 'meteor/minimongo';
import { Random } from 'meteor/random';
import { AsyncTracker } from 'meteor/server-autorun';
console.log('=>(tests.js:8) AsyncTracker', AsyncTracker);

['STRING' /*'MONGO'*/].forEach((idGeneration) => {
  // _id generator.
  let generateId;
  if (idGeneration === 'STRING') {
    generateId = () => Random.id();
  } else {
    generateId = () => new Meteor.Collection.ObjectID();
  }

  // Create collections.
  const Test = new Mongo.Collection(
    `Test_meteor_reactivemongo_tests_${idGeneration}`,
    { idGeneration }
  );

  if (Meteor.isServer) {
    Tinytest.addAsync(
      'reactive-mongo - single document operations',
      async function (test) {
        await Test.find().forEachAsync(async (doc) => {
          await Test.removeAsync(doc._id);
        });

        let docsAdded = [];
        let docsChanged = [];
        let docsRemoved = [];
        let countReactive = 0;
        let computationIds = [];
        let fetchedDocs = [];
        let handleObserver;
        const trackerComputation = AsyncTracker.autorun(
          async function (computation) {
            countReactive++;
            const TestCursor = Test.find({});
            if (handleObserver) await handleObserver.stop();
            handleObserver = await TestCursor.observeChangesAsync({
              added(id) {
                docsAdded.push(id);
              },
              changed(id) {
                docsChanged.push(id);
              },
              removed(id) {
                docsRemoved.push(id);
              },
            });
            const fetched = await TestCursor.fetchAsync();
            fetchedDocs.push(fetched);

            // Additional cursor to ensure that cursor is cached.
            Test.find({ _id: 'a' });

            if (!computationIds.includes(computation._id)) {
              computationIds.push(computation._id);
            }
          }
        );

        let countBeforeRun = 0;
        trackerComputation.beforeRun(() => {
          countBeforeRun++;
        });

        let countAfterRun = 0;
        trackerComputation.afterRun(() => {
          countAfterRun++;
        });

        let countStop = 0;
        trackerComputation.onStop(async () => {
          countStop++;
          await handleObserver.stop();
        });

        await Meteor._sleepForMs(100);

        const insertedId = await Test.insertAsync({ _id: generateId() });
        await Meteor._sleepForMs(100);
        test.equal(docsAdded[0], insertedId);
        test.equal(countReactive, 2);
        test.equal(trackerComputation._cursorCache.size, 2);

        await Test.updateAsync({ _id: docsAdded[0] }, { $set: { foo: 'bar' } });
        await Meteor._sleepForMs(100);
        test.equal(docsChanged[0], insertedId);
        test.equal(countReactive, 3);
        test.equal(trackerComputation._cursorCache.size, 2);

        await Test.removeAsync(docsAdded[1]);
        await Meteor._sleepForMs(100);
        test.equal(docsRemoved[0], insertedId);
        test.equal(countReactive, 4);
        test.equal(trackerComputation._cursorCache.size, 2);

        test.equal(computationIds.length, 1);
        test.equal(
          JSON.stringify(fetchedDocs),
          JSON.stringify([
            [],
            [{ _id: insertedId }],
            [{ _id: insertedId, foo: 'bar' }],
            [],
          ])
        );
        test.equal(trackerComputation._cursorCache.size, 2);

        trackerComputation.stop();
        test.equal(countStop, 1);
        test.equal(trackerComputation._cursorCache.size, 0);

        test.equal(countBeforeRun, 3);
        test.equal(countAfterRun, 4);
      }
    );
  }

  if (Meteor.isServer) {
    Tinytest.addAsync(
      'reactive-mongo - userId posts update',
      async function (test) {
        await Test.find().forEachAsync(async (doc) => {
          await Test.removeAsync(doc._id);
        });

        // Create collections for users, posts, and fields
        const Users = new Mongo.Collection(
          `Users_reactive_mongo_tests_${idGeneration}`,
          { idGeneration }
        );
        const Posts = new Mongo.Collection(
          `Posts_reactive_mongo_tests_${idGeneration}`,
          { idGeneration }
        );
        const Fields = new Mongo.Collection(
          `Fields_reactive_mongo_tests_${idGeneration}`,
          { idGeneration }
        );

        // Helper function to omit fields
        const omit = (obj, ...keys) => {
          if (!obj) return {};
          const ret = Object.assign({}, obj);
          keys.forEach((key) => delete ret[key]);
          return ret;
        };

        // Helper function to normalize field projection
        // MongoDB doesn't allow mixing inclusion (1) and exclusion (0) in the same projection
        const normalizeProjection = (projection) => {
          if (!projection) return {};

          // Check if we have any exclusion fields (value === 0)
          const hasExclusion = Object.values(projection).some(
            (value) => value === 0
          );

          // If we have exclusion fields, convert all inclusion fields to exclusion
          if (hasExclusion) {
            const result = {};
            // Keep all exclusion fields (0) and remove inclusion fields (1)
            Object.entries(projection).forEach(([key, value]) => {
              if (value === 0) {
                result[key] = 0;
              }
            });
            return result;
          }

          // Otherwise, return the original projection (all inclusions)
          return projection;
        };

        // Clean up collections
        await Users.removeAsync({});
        await Posts.removeAsync({});
        await Fields.removeAsync({});

        // Create a user and some posts
        const userId = generateId();
        const postIds = [];

        for (let i = 0; i < 5; i++) {
          const postId = await Posts.insertAsync({
            title: `Post ${i}`,
            content: `Content ${i}`,
          });
          postIds.push(postId);
        }

        await Users.insertAsync({
          _id: userId,
          posts: postIds.slice(0, 3), // Initially assign first 3 posts
        });

        await Fields.insertAsync({
          _id: userId,
          title: 1,
          content: 1,
        });

        // Variables to track test state
        let rerunCount = 0;
        let observedPosts = [];
        let handleObserver;

        // Create the autorun computation that mimics the example in the issue description
        const trackerComputation = AsyncTracker.autorun(async (computation) => {
          rerunCount++;

          // Get user with posts field
          const user = await Users.findOneAsync(userId, {
            fields: { posts: 1 },
          });

          // Get projected fields
          const projectedField = await Fields.findOneAsync(userId);

          // Normalize the projection to avoid mixing inclusion and exclusion
          const normalizedProjection = normalizeProjection(
            omit(projectedField, '_id')
          );

          handleObserver = await Posts.find(
            { _id: { $in: (user && user.posts) || [] } },
            { fields: normalizedProjection }
          ).observeChangesAsync({
            added(id, fields) {
              fields.dummyField = true;
              if (!observedPosts.includes(id)) observedPosts.push(id);
            },
            removed(id) {
              observedPosts = observedPosts.filter((postId) => postId !== id);
            },
          });
        });

        trackerComputation.onStop(async () => {
          if (handleObserver) await handleObserver.stop();
        });

        await Meteor._sleepForMs(1000);

        // Verify initial state
        test.equal(rerunCount, 1, 'Computation should have run once initially');
        test.equal(
          observedPosts.length,
          3,
          'Should have observed 3 posts initially'
        );

        observedPosts = [];
        // Update user to include all posts
        await Users.updateAsync(userId, { $set: { posts: postIds } });
        await Meteor._sleepForMs(100);

        // Verify the computation reran and posts were updated
        test.equal(
          rerunCount,
          2,
          'Computation should have rerun after user update'
        );
        test.equal(observedPosts.length, 5, 'Should now observe all 5 posts');

        observedPosts = [];
        // Update user to include fewer posts
        await Users.updateAsync(userId, {
          $set: { posts: postIds.slice(2, 4) },
        });
        await Meteor._sleepForMs(100);

        // Verify the computation reran and posts were updated
        test.equal(
          rerunCount,
          3,
          'Computation should have rerun after second user update'
        );
        test.equal(observedPosts.length, 2, 'Should now observe 2 posts');

        observedPosts = [];
        // Update fields projection
        await Fields.updateAsync(userId, { $set: { content: 0 } });
        await Meteor._sleepForMs(100);

        // Verify the computation reran
        test.equal(
          rerunCount,
          4,
          'Computation should have rerun after fields update'
        );

        // Clean up
        trackerComputation.stop();
        await handleObserver.stop();

        // Clean up collections
        await Users.removeAsync({});
        await Posts.removeAsync({});
        await Fields.removeAsync({});
      }
    );
  }
});

// Tinytest.addAsync('reactive-mongo - reactive stop', async function (test) {
//   var coll = new LocalCollection();
//   coll.insert({ _id: 'A' });
//   coll.insert({ _id: 'B' });
//   coll.insert({ _id: 'C' });
//   await Meteor._sleepForMs(10);
//
//   var addBefore = function (str, newChar, before) {
//     var idx = str.indexOf(before);
//     if (idx === -1) return str + newChar;
//     return str.slice(0, idx) + newChar + str.slice(idx);
//   };
//
//   var x, y;
//   var sortOrder = ReactiveVar(1);
//
//   var c = Tracker.autorun(function () {
//     var q = coll.find({}, { sort: { _id: sortOrder.get() } });
//     x = '';
//     q.observe({
//       addedAt: function (doc, atIndex, before) {
//         x = addBefore(x, doc._id, before);
//       },
//     });
//     y = '';
//     q.observeChanges({
//       addedBefore: function (id, fields, before) {
//         y = addBefore(y, id, before);
//       },
//     });
//   });
//   await Meteor._sleepForMs(10);
//
//   test.equal(x, 'ABC');
//   test.equal(y, 'ABC');
//
//   sortOrder.set(-1);
//   test.equal(x, 'ABC');
//   test.equal(y, 'ABC');
//   await Tracker.flush();
//
//   await Meteor._sleepForMs(10);
//   test.equal(x, 'CBA');
//   test.equal(y, 'CBA');
//
//   coll.insert({ _id: 'D' });
//   coll.insert({ _id: 'E' });
//   await Meteor._sleepForMs(10);
//   test.equal(x, 'EDCBA');
//   test.equal(y, 'EDCBA');
//
//   c.stop();
//   // stopping kills the observes immediately
//   coll.insert({ _id: 'F' });
//   await Meteor._sleepForMs(10);
//   test.equal(x, 'EDCBA');
//   test.equal(y, 'EDCBA');
// });
//
// Tinytest.addAsync('reactive-mongo - fetch in observe', async function (test) {
//   var coll = new LocalCollection();
//   var callbackInvoked = false;
//   var observe = coll.find().observeChanges({
//     added: function (id, fields) {
//       callbackInvoked = true;
//       test.equal(fields, { foo: 1 });
//       var doc = coll.findOne({ foo: 1 });
//       test.isTrue(doc);
//       test.equal(doc.foo, 1);
//     },
//   });
//   test.isFalse(callbackInvoked);
//   var computation = Tracker.autorun(async function (computation) {
//     if (computation.firstRun) {
//       coll.insert({ foo: 1 });
//       await Meteor._sleepForMs(10);
//     }
//   });
//   await Meteor._sleepForMs(10);
//   test.isTrue(callbackInvoked);
//   observe.stop();
//   computation.stop();
// });
//
// Tinytest.addAsync(
//   'reactive-mongo - count on cursor with limit',
//   async function (test) {
//     var coll = new LocalCollection(),
//       count;
//
//     coll.insert({ _id: 'A' });
//     coll.insert({ _id: 'B' });
//     coll.insert({ _id: 'C' });
//     coll.insert({ _id: 'D' });
//     await Meteor._sleepForMs(10);
//
//     var c = Tracker.autorun(function (c) {
//       var cursor = coll.find(
//         { _id: { $exists: true } },
//         { sort: { _id: 1 }, limit: 3 }
//       );
//       count = cursor.count();
//     });
//
//     test.equal(count, 3);
//
//     coll.remove('A'); // still 3 in the collection
//     await Meteor._sleepForMs(10);
//     await Tracker.flush();
//     test.equal(count, 3);
//
//     coll.remove('B'); // expect count now 2
//     await Meteor._sleepForMs(10);
//     await Tracker.flush();
//     test.equal(count, 2);
//
//     coll.insert({ _id: 'A' }); // now 3 again
//     await Meteor._sleepForMs(10);
//     await Tracker.flush();
//     test.equal(count, 3);
//
//     coll.insert({ _id: 'B' }); // now 4 entries, but count should be 3 still
//     await Meteor._sleepForMs(10);
//     await Tracker.flush();
//     test.equal(count, 3);
//
//     c.stop();
//   }
// );
//
// Tinytest.addAsync(
//   'reactive-mongo - fine-grained reactivity of query with fields projection',
//   async function (test) {
//     var X = new LocalCollection();
//     var id = 'asdf';
//     X.insert({ _id: id, foo: { bar: 123 } });
//
//     var callbackInvoked = false;
//     var computation = Tracker.autorun(function () {
//       callbackInvoked = true;
//       return X.findOne(id, { fields: { 'foo.bar': 1 } });
//     });
//     test.isTrue(callbackInvoked);
//     callbackInvoked = false;
//     X.update(id, { $set: { 'foo.baz': 456 } });
//     await Meteor._sleepForMs(10);
//     test.isFalse(callbackInvoked);
//     X.update(id, { $set: { 'foo.bar': 124 } });
//     await Meteor._sleepForMs(10);
//     Tracker.flush();
//     test.isTrue(callbackInvoked);
//
//     computation.stop();
//   }
// );
//
// Tinytest.addAsync(
//   'reactive-mongo - testLocalQueries',
//   async function (test, done) {
//     const localCollection = new LocalCollection();
//     const computations = [];
//     const variable = new ReactiveVar(0);
//     const runs = [];
//
//     computations.push(
//       Tracker.autorun(() => {
//         localCollection.insert({ variable: variable.get() });
//       })
//     );
//
//     computations.push(
//       Tracker.autorun(async () => {
//         const doc = localCollection.findOne({});
//         runs.push(doc ? doc.variable : undefined);
//         localCollection.remove({});
//       })
//     );
//
//     await Meteor._sleepForMs(10);
//
//     variable.set(1);
//     await Tracker.flush();
//
//     await Meteor._sleepForMs(10);
//
//     variable.set(1);
//     await Tracker.flush();
//
//     await Meteor._sleepForMs(10);
//
//     variable.set(2);
//     await Tracker.flush();
//
//     await Meteor._sleepForMs(10);
//
//     test.equal(runs, [0, undefined, 1, undefined, 2, undefined]);
//     computations.forEach((c) => c.stop());
//     done();
//   }
// );
