import { Tinytest } from 'meteor/tinytest';
import { Tracker } from 'meteor/tracker';
import { ReactiveVar } from 'meteor/reactive-var';
import { Mongo } from 'meteor/mongo';

Tinytest.addAsync(
  'server-autorun: testReactiveVariable',
  async function (test, done) {
    let computation;
    const variable = new ReactiveVar(0);
    const runs = [];

    computation = Tracker.autorun(() => {
      runs.push(variable.get());
    });

    test.equal(runs, [0]);

    variable.set(1);
    await Tracker.flush();

    test.equal(runs, [0, 1]);

    variable.set(1);
    await Tracker.flush();

    test.equal(runs, [0, 1]);

    variable.set(2);
    await Tracker.flush();

    test.equal(runs, [0, 1, 2]);
    computation.stop();
    done();
  }
);

Tinytest.addAsync(
  'server-autorun: testInvalidationsInsideAutorun',
  async function (test, done) {
    let computation;
    const variable = new ReactiveVar(0);
    const runs = [];

    Tracker.afterFlush(() => {
      runs.push('flush1');
    });

    computation = Tracker.autorun(() => {
      Tracker.afterFlush(() => {
        runs.push('flush-before');
      });

      runs.push(variable.get());

      if (variable.get() < 3) {
        variable.set(variable.get() + 1);
      }

      Tracker.afterFlush(() => {
        runs.push('flush-after');
      });
    });

    Tracker.afterFlush(() => {
      runs.push('flush2');
    });

    variable.set(1);
    await Tracker.flush();

    Tracker.afterFlush(() => {
      runs.push('flush3');
    });
    variable.set(1);
    await Tracker.flush();

    Tracker.afterFlush(() => {
      runs.push('flush4');
    });
    variable.set(2);
    await Tracker.flush();

    const expected = [
      0,
      1,
      2,
      3,
      'flush1',
      'flush-before',
      'flush-after',
      'flush2',
      'flush-before',
      'flush-after',
      'flush-before',
      'flush-after',
      'flush-before',
      'flush-after',
      1,
      2,
      3,
      'flush3',
      'flush-before',
      'flush-after',
      'flush-before',
      'flush-after',
      'flush-before',
      'flush-after',
      2,
      3,
      'flush4',
      'flush-before',
      'flush-after',
      'flush-before',
      'flush-after',
    ];
    test.equal(runs, expected);
    computation.stop();
    done();
  }
);

Tinytest.addAsync(
  'server-autorun: testServerInvalidationsInsideAutorunWithYields (async version)',
  async function (test, done) {
    let computation;
    const variable = new ReactiveVar(0);
    const runs = [];

    // Register afterFlush callbacks outside autorun.
    Tracker.afterFlush(() => {
      runs.push('flush1');
    });

    // Write an async autorun callback.
    computation = Tracker.autorun(async function (comp) {
      // Register multiple afterFlush callbacks (they will be queued for the current flush cycle).
      Tracker.afterFlush(() => {
        runs.push('flush-before');
      });
      // Push the current value.
      runs.push(variable.get());

      // Await a sleep to yield control.
      await Meteor._sleepForMs(1);

      // Queue an afterFlush callback.
      Tracker.afterFlush(() => {
        runs.push('flush-after');
      });
    });

    // Register another afterFlush callback.
    Tracker.afterFlush(() => {
      runs.push('flush2');
    });

    // Trigger changes and flush.
    variable.set(1);
    await Meteor._sleepForMs(1);
    await Tracker.flush();

    Tracker.afterFlush(() => {
      runs.push('flush3');
    });
    variable.set(1);
    await Meteor._sleepForMs(1);
    await Tracker.flush();

    Tracker.afterFlush(() => {
      runs.push('flush4');
    });
    variable.set(2);
    await Meteor._sleepForMs(1);
    await Tracker.flush();

    await Meteor._sleepForMs(1);
    await Tracker.flush();

    // The ordering of output under async/await may differ from the fiber version.
    // For example, your output might be (based on your observation):
    const expected = [
      0,
      1,
      'flush1',
      'flush-before',
      'flush2',
      'flush-before',
      'flush-after',
      'flush3',
      'flush-after',
      2,
      'flush4',
      'flush-before',
      'flush-after',
    ];
    test.equal(runs, expected);
    computation.stop();
    done();
  }
);

Tinytest.addAsync('server-autorun: testQueries', async function (test, done) {
  const computations = [];
  const variable = new ReactiveVar(0);
  const runs = [];
  let collection = new Mongo.Collection(`test_collection-${test.id}`);
  collection = Meteor.isClient ? collection._collection : collection;

  // Remove all existing documents by retrieving their _id values and removing them individually.
  let docs = await collection.find({}).fetchAsync({});
  await Promise.all(docs.map((doc) => collection.removeAsync(doc._id)));

  computations.push(
    Tracker.autorun(async () => {
      const variableValue = variable.get();
      await collection.insertAsync({ variable: variableValue });
    })
  );

  computations.push(
    Tracker.autorun(async () => {
      // Depend on the reactive variable.
      const variableValue = variable.get();
      if (Meteor.isServer) {
        await Meteor._sleepForMs(100);
      }
      // Use nonreactive query.
      const doc = await collection.findOneAsync(
        { variable: variableValue },
        { reactive: false }
      );
      runs.push(doc ? doc.variable : undefined);
    })
  );

  variable.set(1);
  await Tracker.flush();

  variable.set(1);
  await Tracker.flush();

  variable.set(2);
  await Tracker.flush();

  await Meteor._sleepForMs(200);

  test.equal(runs, [0, 1, 2]);
  computations.forEach((c) => c.stop());

  // Remove all documents again by their _id values.
  docs = await collection.find({}).fetchAsync({});
  await Promise.all(docs.map((doc) => collection.removeAsync(doc._id)));

  done();
});
