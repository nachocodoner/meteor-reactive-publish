import { Tinytest } from 'meteor/tinytest';
import { Tracker } from 'meteor/tracker';
import { ReactiveVar } from 'meteor/reactive-var';
import { Mongo } from 'meteor/mongo';
import { LocalCollection } from 'meteor/minimongo';

Tinytest.addAsync('reactive-mongo - reactive stop', async function (test) {
  var coll = new LocalCollection();
  coll.insert({ _id: 'A' });
  coll.insert({ _id: 'B' });
  coll.insert({ _id: 'C' });
  await Meteor._sleepForMs(10);

  var addBefore = function (str, newChar, before) {
    var idx = str.indexOf(before);
    if (idx === -1) return str + newChar;
    return str.slice(0, idx) + newChar + str.slice(idx);
  };

  var x, y;
  var sortOrder = ReactiveVar(1);

  var c = Tracker.autorun(function () {
    var q = coll.find({}, { sort: { _id: sortOrder.get() } });
    x = '';
    q.observe({
      addedAt: function (doc, atIndex, before) {
        x = addBefore(x, doc._id, before);
      },
    });
    y = '';
    q.observeChanges({
      addedBefore: function (id, fields, before) {
        y = addBefore(y, id, before);
      },
    });
  });
  await Meteor._sleepForMs(10);

  test.equal(x, 'ABC');
  test.equal(y, 'ABC');

  sortOrder.set(-1);
  test.equal(x, 'ABC');
  test.equal(y, 'ABC');
  await Tracker.flush();

  await Meteor._sleepForMs(10);
  test.equal(x, 'CBA');
  test.equal(y, 'CBA');

  coll.insert({ _id: 'D' });
  coll.insert({ _id: 'E' });
  await Meteor._sleepForMs(10);
  test.equal(x, 'EDCBA');
  test.equal(y, 'EDCBA');

  c.stop();
  // stopping kills the observes immediately
  coll.insert({ _id: 'F' });
  await Meteor._sleepForMs(10);
  test.equal(x, 'EDCBA');
  test.equal(y, 'EDCBA');
});

Tinytest.addAsync('reactive-mongo - fetch in observe', async function (test) {
  var coll = new LocalCollection();
  var callbackInvoked = false;
  var observe = coll.find().observeChanges({
    added: function (id, fields) {
      callbackInvoked = true;
      test.equal(fields, { foo: 1 });
      var doc = coll.findOne({ foo: 1 });
      test.isTrue(doc);
      test.equal(doc.foo, 1);
    },
  });
  test.isFalse(callbackInvoked);
  var computation = Tracker.autorun(async function (computation) {
    if (computation.firstRun) {
      coll.insert({ foo: 1 });
      await Meteor._sleepForMs(10);
    }
  });
  await Meteor._sleepForMs(10);
  test.isTrue(callbackInvoked);
  observe.stop();
  computation.stop();
});

Tinytest.addAsync(
  'reactive-mongo - count on cursor with limit',
  async function (test) {
    var coll = new LocalCollection(),
      count;

    coll.insert({ _id: 'A' });
    coll.insert({ _id: 'B' });
    coll.insert({ _id: 'C' });
    coll.insert({ _id: 'D' });
    await Meteor._sleepForMs(10);

    var c = Tracker.autorun(function (c) {
      var cursor = coll.find(
        { _id: { $exists: true } },
        { sort: { _id: 1 }, limit: 3 }
      );
      count = cursor.count();
    });

    test.equal(count, 3);

    coll.remove('A'); // still 3 in the collection
    await Meteor._sleepForMs(10);
    await Tracker.flush();
    test.equal(count, 3);

    coll.remove('B'); // expect count now 2
    await Meteor._sleepForMs(10);
    await Tracker.flush();
    test.equal(count, 2);

    coll.insert({ _id: 'A' }); // now 3 again
    await Meteor._sleepForMs(10);
    await Tracker.flush();
    test.equal(count, 3);

    coll.insert({ _id: 'B' }); // now 4 entries, but count should be 3 still
    await Meteor._sleepForMs(10);
    await Tracker.flush();
    test.equal(count, 3);

    c.stop();
  }
);

Tinytest.addAsync(
  'reactive-mongo - fine-grained reactivity of query with fields projection',
  async function (test) {
    var X = new LocalCollection();
    var id = 'asdf';
    X.insert({ _id: id, foo: { bar: 123 } });

    var callbackInvoked = false;
    var computation = Tracker.autorun(function () {
      callbackInvoked = true;
      return X.findOne(id, { fields: { 'foo.bar': 1 } });
    });
    test.isTrue(callbackInvoked);
    callbackInvoked = false;
    X.update(id, { $set: { 'foo.baz': 456 } });
    await Meteor._sleepForMs(10);
    test.isFalse(callbackInvoked);
    X.update(id, { $set: { 'foo.bar': 124 } });
    await Meteor._sleepForMs(10);
    Tracker.flush();
    test.isTrue(callbackInvoked);

    computation.stop();
  }
);

Tinytest.addAsync(
  'reactive-mongo - testLocalQueries',
  async function (test, done) {
    const localCollection = new LocalCollection();
    const computations = [];
    const variable = new ReactiveVar(0);
    const runs = [];

    computations.push(
      Tracker.autorun(() => {
        localCollection.insert({ variable: variable.get() });
      })
    );

    computations.push(
      Tracker.autorun(async () => {
        const doc = localCollection.findOne({});
        runs.push(doc ? doc.variable : undefined);
        localCollection.remove({});
      })
    );

    await Meteor._sleepForMs(10);

    variable.set(1);
    await Tracker.flush();

    await Meteor._sleepForMs(10);

    variable.set(1);
    await Tracker.flush();

    await Meteor._sleepForMs(10);

    variable.set(2);
    await Tracker.flush();

    await Meteor._sleepForMs(10);

    test.equal(runs, [0, undefined, 1, undefined, 2, undefined]);
    computations.forEach((c) => c.stop());
    done();
  }
);
