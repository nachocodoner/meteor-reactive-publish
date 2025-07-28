import { Tinytest } from 'meteor/tinytest';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { AsyncTracker } from '../AsyncReactive/AsyncTracker.js';

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

  Tinytest.addAsync(
    'MongoReactiveServer - reactivity of single document operations (insert, update, remove)',
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
      const trackerComputation = await AsyncTracker.autorun(
        async function (computation) {
          countReactive++;
          const TestCursor = Test.find({});
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

      await trackerComputation.stop();
      test.equal(countStop, 1);
      test.equal(trackerComputation._cursorCache.size, 0);

      test.equal(countBeforeRun, 3);
      test.equal(countAfterRun, 4);
    }
  );

  // Create collections for users, posts, and fields
  const Users = new Mongo.Collection(
    `Users_MongoReactiveServer_tests_${idGeneration}`,
    { idGeneration }
  );
  const Posts = new Mongo.Collection(
    `Posts_MongoReactiveServer_tests_${idGeneration}`,
    { idGeneration }
  );
  const Fields = new Mongo.Collection(
    `Fields_MongoReactiveServer_tests_${idGeneration}`,
    { idGeneration }
  );

  Tinytest.addAsync(
    'MongoReactiveServer - findOneAsync with field projection and related collections',
    async function (test) {
      await Test.find().forEachAsync(async (doc) => {
        await Test.removeAsync(doc._id);
      });

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

  Tinytest.addAsync(
    'MongoReactiveServer - forEachAsync reactivity with document modifications',
    async function (test) {
      // Create a test collection
      const TestForEach = new Mongo.Collection(
        `Test_forEachAsync_${Random.id()}`,
        { idGeneration }
      );

      // Clean up any existing documents
      await TestForEach.find().forEachAsync(async (doc) => {
        await TestForEach.removeAsync(doc._id);
      });

      // Variables to track test state
      let rerunCount = 0;
      let processedValues = [];
      let handleObserver;
      let computationIds = [];

      // Create the autorun computation
      const trackerComputation = AsyncTracker.autorun(async (computation) => {
        rerunCount++;

        // Store computation ID to verify it's the same computation rerunning
        if (!computationIds.includes(computation._id)) {
          computationIds.push(computation._id);
        }

        // Clear previous values
        processedValues = [];

        // Use forEachAsync to process documents
        await TestForEach.find({}, { sort: { value: 1 } }).forEachAsync(
          async (doc) => {
            processedValues.push(doc.value);
          }
        );
      });

      // Set up onStop handler
      trackerComputation.onStop(async () => {
        if (handleObserver) await handleObserver.stop();
      });

      // Wait for initial run to complete
      await Meteor._sleepForMs(100);

      // Verify initial state
      test.equal(rerunCount, 1, 'Computation should have run once initially');
      test.equal(
        processedValues.length,
        0,
        'No documents should be processed initially'
      );
      test.equal(computationIds.length, 1, 'Should be a single computation');

      // Insert test documents
      const docIds = [];
      for (let i = 0; i < 5; i++) {
        const docId = await TestForEach.insertAsync({
          value: i,
          squared: i * i,
        });
        docIds.push(docId);
      }

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran and processed all documents
      test.equal(
        rerunCount,
        5,
        'Computation should have rerun after inserting documents'
      );
      test.equal(
        processedValues,
        [0, 1, 2, 3, 4],
        'All documents should be processed in order'
      );
      test.equal(
        computationIds.length,
        1,
        'Should still be the same computation'
      );

      // Update documents
      for (const docId of docIds) {
        await TestForEach.updateAsync(docId, { $set: { updated: true } });
      }

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran
      test.equal(
        rerunCount,
        9,
        'Computation should have rerun after updating documents'
      );
      test.equal(
        processedValues,
        [0, 1, 2, 3, 4],
        'All documents should still be processed in order'
      );

      // Remove some documents
      await TestForEach.removeAsync(docIds[1]); // Remove document with value 1
      await TestForEach.removeAsync(docIds[3]); // Remove document with value 3

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran and processed remaining documents
      test.equal(
        rerunCount,
        11,
        'Computation should have rerun after removing documents'
      );
      test.equal(
        processedValues,
        [0, 2, 4],
        'Only remaining documents should be processed'
      );

      // Clean up
      trackerComputation.stop();
      await TestForEach.find().forEachAsync(async (doc) => {
        await TestForEach.removeAsync(doc._id);
      });
    }
  );

  Tinytest.addAsync(
    'MongoReactiveServer - mapAsync reactivity with document transformations',
    async function (test) {
      // Create a test collection
      const TestMap = new Mongo.Collection(`Test_mapAsync_${Random.id()}`, {
        idGeneration,
      });

      // Clean up any existing documents
      await TestMap.find().forEachAsync(async (doc) => {
        await TestMap.removeAsync(doc._id);
      });

      // Variables to track test state
      let rerunCount = 0;
      let transformedResults = [];
      let handleObserver;
      let computationIds = [];

      // Create the autorun computation
      const trackerComputation = AsyncTracker.autorun(async (computation) => {
        rerunCount++;

        // Store computation ID to verify it's the same computation rerunning
        if (!computationIds.includes(computation._id)) {
          computationIds.push(computation._id);
        }

        // Use mapAsync to transform documents
        transformedResults = await TestMap.find(
          {},
          { sort: { value: 1 } }
        ).mapAsync(async (doc) => {
          // Square the value
          return doc.value * doc.value;
        });
      });

      // Set up onStop handler
      trackerComputation.onStop(async () => {
        if (handleObserver) await handleObserver.stop();
      });

      // Wait for initial run to complete
      await Meteor._sleepForMs(100);

      // Verify initial state
      test.equal(rerunCount, 1, 'Computation should have run once initially');
      test.equal(
        transformedResults.length,
        0,
        'No documents should be transformed initially'
      );
      test.equal(computationIds.length, 1, 'Should be a single computation');

      // Insert test documents
      const docIds = [];
      for (let i = 0; i < 5; i++) {
        const docId = await TestMap.insertAsync({
          value: i,
          name: `Item ${i}`,
        });
        docIds.push(docId);
      }

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran and transformed all documents
      test.equal(
        rerunCount,
        5,
        'Computation should have rerun after inserting documents'
      );
      test.equal(
        transformedResults,
        [0, 1, 4, 9, 16],
        'All documents should be transformed correctly'
      );
      test.equal(
        computationIds.length,
        1,
        'Should still be the same computation'
      );

      // Update documents to change the values
      for (let i = 0; i < docIds.length; i++) {
        await TestMap.updateAsync(docIds[i], { $set: { value: i * 2 } });
      }

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran with updated values
      test.equal(
        rerunCount,
        8,
        'Computation should have rerun after updating documents'
      );
      test.equal(
        transformedResults,
        [0, 4, 16, 36, 64],
        'Documents should be transformed with new values'
      );

      // Remove some documents
      await TestMap.removeAsync(docIds[1]); // Remove document with value 2
      await TestMap.removeAsync(docIds[3]); // Remove document with value 6

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran and transformed remaining documents
      test.equal(
        rerunCount,
        10,
        'Computation should have rerun after removing documents'
      );
      test.equal(
        transformedResults,
        [0, 16, 64],
        'Only remaining documents should be transformed'
      );

      // Clean up
      trackerComputation.stop();
      await TestMap.find().forEachAsync(async (doc) => {
        await TestMap.removeAsync(doc._id);
      });
    }
  );

  Tinytest.addAsync(
    'MongoReactiveServer - fetchAsync reactivity with query options (sort, filter, limit, skip, projection)',
    async function (test) {
      // Create a test collection
      const TestFetch = new Mongo.Collection(`Test_fetchAsync_${Random.id()}`, {
        idGeneration,
      });

      // Clean up any existing documents
      await TestFetch.find().forEachAsync(async (doc) => {
        await TestFetch.removeAsync(doc._id);
      });

      // Variables to track test state
      let rerunCount = 0;
      let fetchedResults = [];
      let handleObserver;
      let computationIds = [];

      // Query parameters
      let queryFilter = {};
      let sortOrder = { value: 1 };
      let limitValue = null;
      let skipValue = null;
      let fieldsProjection = null;

      // Create the autorun computation
      const trackerComputation = AsyncTracker.autorun(async (computation) => {
        rerunCount++;

        // Store computation ID to verify it's the same computation rerunning
        if (!computationIds.includes(computation._id)) {
          computationIds.push(computation._id);
        }

        // Set up options for the query
        const options = { sort: sortOrder };

        if (limitValue !== null) {
          options.limit = limitValue;
        }

        if (skipValue !== null) {
          options.skip = skipValue;
        }

        if (fieldsProjection !== null) {
          options.fields = fieldsProjection;
        }

        fetchedResults = await TestFetch.find(
          queryFilter,
          options
        ).fetchAsync();
      });

      // Set up onStop handler
      trackerComputation.onStop(async () => {
        if (handleObserver) await handleObserver.stop();
      });

      // Wait for initial run to complete
      await Meteor._sleepForMs(100);

      // Verify initial state
      test.equal(rerunCount, 1, 'Computation should have run once initially');
      test.equal(
        fetchedResults.length,
        0,
        'No documents should be fetched initially'
      );
      test.equal(computationIds.length, 1, 'Should be a single computation');

      // Insert test documents
      const docIds = [];
      for (let i = 0; i < 5; i++) {
        const docId = await TestFetch.insertAsync({
          value: i,
          name: `Item ${i}`,
        });
        docIds.push(docId);
      }

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran and fetched all documents
      test.equal(
        rerunCount,
        5,
        'Computation should have rerun after inserting documents'
      );
      test.equal(fetchedResults.length, 5, 'All documents should be fetched');
      test.equal(
        fetchedResults.map((doc) => doc.value),
        [0, 1, 2, 3, 4],
        'Documents should be sorted by value ascending'
      );

      // Change sort order
      sortOrder = { value: -1 };
      await trackerComputation.run();

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran with new sort order
      test.equal(
        rerunCount,
        6,
        'Computation should have rerun after changing sort order'
      );
      test.equal(
        fetchedResults.map((doc) => doc.value),
        [4, 3, 2, 1, 0],
        'Documents should be sorted by value descending'
      );

      // Apply filter for even values
      queryFilter = { value: { $mod: [2, 0] } };
      await trackerComputation.run();

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran with filter
      test.equal(
        rerunCount,
        7,
        'Computation should have rerun after applying filter'
      );
      test.equal(
        fetchedResults.map((doc) => doc.value),
        [4, 2, 0],
        'Only documents with even values should be fetched'
      );

      // Apply limit
      limitValue = 3;
      await trackerComputation.run();

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran with limit
      test.equal(
        rerunCount,
        8,
        'Computation should have rerun after applying limit'
      );
      test.equal(
        fetchedResults.length,
        3,
        'Only the first 3 documents should be fetched'
      );
      test.equal(
        fetchedResults.map((doc) => doc.value),
        [4, 2, 0],
        'Only the first 3 documents should be fetched (with descending sort)'
      );

      // Apply skip
      skipValue = 1;
      await trackerComputation.run();

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran with skip
      test.equal(
        rerunCount,
        9,
        'Computation should have rerun after applying skip'
      );
      test.equal(
        fetchedResults.map((doc) => doc.value),
        [2, 0],
        'Documents should be fetched with skip applied'
      );

      // Apply fields projection
      fieldsProjection = { value: 0 };
      await trackerComputation.run();

      // Wait for computation to rerun
      await Meteor._sleepForMs(100);

      // Verify computation reran with projection
      test.equal(
        rerunCount,
        10,
        'Computation should have rerun after applying projection'
      );
      test.equal(fetchedResults.length, 2, 'Should still fetch 2 documents');

      // Check that only the value field is present
      test.isTrue(
        fetchedResults.every((doc) => doc.value === undefined),
        'fetchAsync should respect fields projection'
      );

      // Clean up
      trackerComputation.stop();
      await TestFetch.find().forEachAsync(async (doc) => {
        await TestFetch.removeAsync(doc._id);
      });
    }
  );

  Tinytest.addAsync(
    'MongoReactiveServer - nested autoruns with mongo operations',
    async function (test) {
      // Create a test collection
      const NestedTest = new Mongo.Collection(`NestedTest_${Random.id()}`, {
        idGeneration,
      });

      // Clean up any existing documents
      await NestedTest.find().forEachAsync(async (doc) => {
        await NestedTest.removeAsync(doc._id);
      });

      // Variables to track test state
      let outerRunCount = 0;
      let innerRunCount = 0;
      let innerComputationIds = [];
      let outerResults = [];
      let innerResults = [];

      // Create the outer autorun computation
      const outerComputation = await AsyncTracker.autorun(
        async (computation) => {
          outerRunCount++;

          // Find all documents in the collection
          const outerDocs = await NestedTest.find(
            {},
            { sort: { value: 1 } }
          ).fetchAsync();
          outerResults.push(outerDocs.map((doc) => doc.value));

          // Create nested computation that depends on a subset of documents
          await AsyncTracker.autorun(async (innerComputation) => {
            innerRunCount++;

            if (!innerComputationIds.includes(innerComputation._id)) {
              innerComputationIds.push(innerComputation._id);
            }

            // Find documents with even values
            const innerDocs = await NestedTest.find(
              { value: { $mod: [2, 0] } },
              { sort: { value: 1 } }
            ).fetchAsync();

            innerResults.push(innerDocs.map((doc) => doc.value));
          });
        }
      );

      // Wait for initial runs
      await Meteor._sleepForMs(100);

      // Verify initial state
      test.equal(
        outerRunCount,
        1,
        'Outer computation should run once initially'
      );
      test.equal(
        innerRunCount,
        1,
        'Inner computation should run once initially'
      );
      test.equal(
        innerComputationIds.length,
        1,
        'Should have created one inner computation'
      );
      test.equal(outerResults.length, 1, 'Should have one outer result');
      test.equal(innerResults.length, 1, 'Should have one inner result');
      test.equal(
        outerResults[0].length,
        0,
        'Should have no documents initially'
      );
      test.equal(
        innerResults[0].length,
        0,
        'Should have no documents initially'
      );

      // Insert documents that affect both outer and inner computations
      const docIds = [];
      for (let i = 0; i < 5; i++) {
        const docId = await NestedTest.insertAsync({
          value: i,
          name: `Item ${i}`,
        });
        docIds.push(docId);

        // Wait for computations to rerun
        await Meteor._sleepForMs(100);
      }

      // Verify state after insertions
      test.equal(
        outerRunCount,
        6,
        'Outer computation should run for each insert'
      );
      test.equal(
        innerRunCount,
        6,
        'Inner computation should run for each insert'
      );
      test.equal(
        innerComputationIds.length,
        6,
        'Should have created a new inner computation for each outer run'
      );
      test.equal(
        outerResults[5].length,
        5,
        'Should have 5 documents in outer result'
      );
      test.equal(
        innerResults[5].length,
        3,
        'Should have 3 documents with even values in inner result'
      );
      test.equal(
        outerResults[5],
        [0, 1, 2, 3, 4],
        'Outer results should contain all values'
      );
      test.equal(
        innerResults[5],
        [0, 2, 4],
        'Inner results should contain even values'
      );

      // Update a document that affects only the outer computation
      await NestedTest.updateAsync(
        { value: 1 },
        { $set: { name: 'Updated Item 1' } }
      );

      // Wait for computations to rerun
      await Meteor._sleepForMs(100);

      // Verify state after update to odd-valued document
      test.equal(
        outerRunCount,
        7,
        'Outer computation should rerun after update'
      );
      test.equal(
        innerRunCount,
        7,
        'Inner computation should rerun when outer reruns'
      );
      test.equal(
        innerComputationIds.length,
        7,
        'Should have created a new inner computation when outer reruns'
      );

      // Update a document that affects both outer and inner computations
      // It will trigger rerun twice (+2. 7 => 9), since two events happened:
      // a change and a movedBefore as sort order is changed.
      await NestedTest.updateAsync(
        { value: 2 },
        { $set: { value: 6, name: 'Updated Item 2' } }
      );

      // Wait for computations to rerun
      await Meteor._sleepForMs(100);

      // Verify state after update to even-valued document
      test.equal(
        outerRunCount,
        9,
        'Outer computation should rerun after update'
      );
      test.equal(
        innerRunCount,
        9,
        'Inner computation should rerun when outer reruns'
      );
      test.equal(
        innerComputationIds.length,
        9,
        'Should have created a new inner computation when outer reruns'
      );
      test.equal(
        outerResults[7].length,
        5,
        'Should still have 5 documents in outer result'
      );
      test.equal(
        innerResults[7].length,
        3,
        'Should have 3 documents with even values in inner result'
      );
      test.equal(
        outerResults[7],
        [0, 1, 3, 4, 6],
        'Outer results should reflect the update'
      );
      test.equal(
        innerResults[7],
        [0, 4, 6],
        'Inner results should reflect the update'
      );

      // Remove a document that affects both outer and inner computations
      await NestedTest.removeAsync({ value: 0 });

      // Wait for computations to rerun
      await Meteor._sleepForMs(100);

      // Verify state after removal
      test.equal(
        outerRunCount,
        10,
        'Outer computation should rerun after removal'
      );
      test.equal(
        innerRunCount,
        10,
        'Inner computation should rerun when outer reruns'
      );
      test.equal(
        innerComputationIds.length,
        10,
        'Should have created a new inner computation when outer reruns'
      );
      test.equal(
        outerResults[9].length,
        4,
        'Should have 4 documents in outer result'
      );
      test.equal(
        innerResults[9].length,
        2,
        'Should have 2 documents with even values in inner result'
      );
      test.equal(
        outerResults[9],
        [1, 3, 4, 6],
        'Outer results should reflect the removal'
      );
      test.equal(
        innerResults[9],
        [4, 6],
        'Inner results should reflect the removal'
      );

      // Clean up
      outerComputation.stop();
      await NestedTest.find().forEachAsync(async (doc) => {
        await NestedTest.removeAsync(doc._id);
      });
    }
  );

  Tinytest.addAsync(
    'MongoReactiveServer - cursor cache clearing in all scenarios',
    async function (test) {
      // Create a test collection
      const CacheTest = new Mongo.Collection(`CacheTest_${Random.id()}`, {
        idGeneration,
      });

      // Clean up any existing documents
      await CacheTest.find().forEachAsync(async (doc) => {
        await CacheTest.removeAsync(doc._id);
      });

      // Insert some test documents
      const docIds = [];
      for (let i = 0; i < 5; i++) {
        const docId = await CacheTest.insertAsync({
          value: i,
          name: `Item ${i}`,
        });
        docIds.push(docId);
      }

      // Variables to track test state
      let rerunCount = 0;
      let cacheSize = 0;
      let cacheSizeHistory = [];

      // Create the autorun computation
      const trackerComputation = await AsyncTracker.autorun(
        async (computation) => {
          rerunCount++;

          // Run a find operation to populate the cache
          await CacheTest.find({}).fetchAsync();

          // Run another find with different selector to populate cache more
          await CacheTest.find({ value: { $lt: 3 } }).fetchAsync();

          // Store the current cache size
          cacheSize = computation._cursorCache
            ? computation._cursorCache.size
            : 0;
          cacheSizeHistory.push(cacheSize);
        }
      );

      // Wait for initial run to complete
      await Meteor._sleepForMs(100);

      // Verify initial state
      test.equal(rerunCount, 1, 'Computation should have run once initially');
      test.equal(cacheSize, 2, 'Cache should contain 2 entries initially');

      // Test scenario 1: Changing a document should invalidate the cache
      await CacheTest.updateAsync(docIds[0], {
        $set: { name: 'Updated Item' },
      });
      await Meteor._sleepForMs(100);

      test.equal(rerunCount, 2, 'Computation should have rerun after update');
      test.equal(
        cacheSize,
        2,
        'Cache should still contain 2 entries after update'
      );

      // Test scenario 2: Using the same selector with different options
      await AsyncTracker.autorun(async () => {
        // This should clear the existing cache entry for this selector and create a new one
        await CacheTest.find({}, { sort: { value: -1 } }).fetchAsync();
      });

      await Meteor._sleepForMs(100);

      // The original computation's cache should remain unchanged
      test.equal(
        cacheSize,
        2,
        'Original computation cache should be unaffected'
      );

      // Test scenario 3: Changing the selector with same options
      const selectorChangeComputation = await AsyncTracker.autorun(
        async (computation) => {
          // First run with one selector
          await CacheTest.find({ value: 1 }).fetchAsync();

          // Store cache size after first run
          if (computation._runCount === 1) {
            test.equal(
              computation._cursorCache.size,
              1,
              'Cache should have 1 entry after first run'
            );

            // Change the selector for next run
            await CacheTest.updateAsync(docIds[1], { $set: { value: 10 } });
          }
        }
      );

      await Meteor._sleepForMs(100);

      // The cache should still have 1 entry but with the updated selector
      test.equal(
        selectorChangeComputation._cursorCache.size,
        1,
        'Cache should still have 1 entry after selector change'
      );

      // Clean up this computation
      await selectorChangeComputation.stop();

      // Test scenario 4: Stopping and restarting computation
      await trackerComputation.stop();

      // Verify cache is cleared when computation stops
      test.equal(
        trackerComputation._cursorCache.size,
        0,
        'Cache should be cleared when computation stops'
      );

      // Create a new computation to test cache initialization
      const newComputation = await AsyncTracker.autorun(async (computation) => {
        await CacheTest.find({}).fetchAsync();
        await CacheTest.find({ value: { $gt: 3 } }).fetchAsync();
        await CacheTest.find({ value: { $lt: 2 } }).fetchAsync();
      });

      await Meteor._sleepForMs(100);

      // Verify new computation has its own cache
      test.equal(
        newComputation._cursorCache.size,
        3,
        'New computation should have its own cache'
      );

      // Test scenario 5: Stopping another computation also clears its cache
      await newComputation.stop();

      // Verify cache is cleared when computation stops
      test.equal(
        newComputation._cursorCache.size,
        0,
        'Cache should be cleared when computation stops'
      );

      // Clean up
      await CacheTest.find().forEachAsync(async (doc) => {
        await CacheTest.removeAsync(doc._id);
      });
    }
  );
});
