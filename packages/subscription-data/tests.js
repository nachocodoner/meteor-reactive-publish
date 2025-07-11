import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tinytest } from 'meteor/tinytest';

const TestDataCollection = new Mongo.Collection(null);
const TestCollection = new Mongo.Collection('testCollection');

if (Meteor.isServer) {
  Meteor.methods({
    insertTest(obj) {
      return TestDataCollection.insert(obj);
    },
    updateTest(selector, query) {
      return TestDataCollection.update(selector, query);
    },
    removeTest(selector) {
      return TestDataCollection.remove(selector);
    },
  });

  Meteor.publish('testDataPublish', function () {
    this.autorun(() => {
      this.setData('countAll', TestDataCollection.find().count());
    });

    this.autorun(() => {
      TestDataCollection.find({}, {
        sort: { i: 1 },
        limit: this.data('limit')
      }).observeChanges({
        addedBefore: (id, fields, before) => this.added('testDataCollection', id, fields),
        changed: (id, fields) => this.changed('testDataCollection', id, fields),
        removed: (id) => this.removed('testDataCollection', id),
      });

      this.ready();
    });
  });

  Meteor.publish('testPublish', function () {
    const id = Random.id();
    let previousData = {};

    this.autorun((computation) => {
      const newData = this.data();
      const data = { ...newData };

      for (const field in previousData) {
        if (!(field in data)) {
          data[field] = undefined;
        }
      }

      if (computation.firstRun) {
        this.added('testCollection', id, data);
      } else {
        this.changed('testCollection', id, data);
      }

      previousData = newData;
    });

    this.ready();
  });
}

// ---- Test: subscription-data - basic (testClientBasic)

Tinytest.addAsync('subscription-data - set/get basic', async (test, next) => {
  const sub = Meteor.subscribe('testPublish');
  await new Promise(resolve => Tracker.autorun(c => {
    if (sub.ready()) {
      c.stop();
      resolve();
    }
  }));

  const doc = TestCollection.findOne({}, { fields: { _id: 0 } }) || {};
  test.equal(doc, {});
  test.equal(sub.data(), {});

  sub.setData({ foo: 'test', bar: 123 });

  setTimeout(() => next(), 200);
});

Tinytest.addAsync('subscription-data - update field', async (test, next) => {
  const doc = TestCollection.findOne({}, { fields: { _id: 0 } });
  test.equal(doc, { foo: 'test', bar: 123 });

  const sub = Meteor.default_connection._subscriptions['testPublish'];
  test.equal(sub?.data(), { foo: 'test', bar: 123 });

  sub.setData('foo', 'test2');
  setTimeout(() => next(), 200);
});

Tinytest.addAsync('subscription-data - unset field', async (test, next) => {
  const doc = TestCollection.findOne({}, { fields: { _id: 0 } });
  test.equal(doc, { foo: 'test2', bar: 123 });

  const sub = Meteor.default_connection._subscriptions['testPublish'];
  test.equal(sub?.data(), { foo: 'test2', bar: 123 });

  sub.setData('foo', undefined);
  setTimeout(() => next(), 200);
});

// ---- Test: subscription-data - two-way (testClientTwoWay)

Tinytest.addAsync('subscription-data - two-way sync', async (test, next) => {
  const sub = Meteor.subscribe('testDataPublish');
  await new Promise(resolve => Tracker.autorun(c => {
    if (sub.ready()) {
      c.stop();
      resolve();
    }
  }));

  test.equal(TestDataCollection.find().count(), 0);
  test.equal(sub.data(), { countAll: 0 });

  for (let i = 0; i < 10; i++) {
    const result = await new Promise((res, rej) =>
      Meteor.call('insertTest', { i }, (err, id) => (err ? rej(err) : res(id)))
    );
    test.isTrue(result);
  }

  setTimeout(() => next(), 200);
});

Tinytest.addAsync('subscription-data - limit & reactive count', async (test, next) => {
  const sub = Meteor.default_connection._subscriptions['testDataPublish'];
  test.equal(TestDataCollection.find().count(), 10);
  test.equal(sub.data(), { countAll: 10 });

  sub.setData('limit', 5);
  setTimeout(() => next(), 200);
});

Tinytest.addAsync('subscription-data - confirm limit works', async (test, next) => {
  const sub = Meteor.default_connection._subscriptions['testDataPublish'];
  test.equal(TestDataCollection.find().count(), 5);
  test.equal(sub.data(), { countAll: 10, limit: 5 });

  for (let i = 0; i < 10; i++) {
    const result = await new Promise((res, rej) =>
      Meteor.call('insertTest', { i }, (err, id) => (err ? rej(err) : res(id)))
    );
    test.isTrue(result);
  }

  setTimeout(() => next(), 200);
});

Tinytest.addAsync('subscription-data - confirm count updates', (test, next) => {
  const sub = Meteor.default_connection._subscriptions['testDataPublish'];
  test.equal(TestDataCollection.find().count(), 5);
  test.equal(sub.data(), { countAll: 20, limit: 5 });

  next();
});


