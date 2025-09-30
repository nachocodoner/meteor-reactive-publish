import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';
import { Tinytest } from 'meteor/tinytest';

const TestDataCollection = new Mongo.Collection('testDataCollection');
const TestCollection = new Mongo.Collection('testCollection');

if (Meteor.isServer) {
  Meteor.methods({
    async insertTest(obj) {
      return TestDataCollection.insertAsync(obj);
    },
    async removeTest(selector) {
      return TestDataCollection.removeAsync(selector);
    },
  });

  Meteor.publish('testDataPublish', function () {
    this.autorun(async () => {
      await this.setData(
        'countAll',
        await TestDataCollection.find().countAsync()
      );
    });

    this.autorun(async () => {
      const nextLimit = (await this.data('limit')) || 10;
      await TestDataCollection.find(
        {},
        {
          sort: { i: 1 },
          limit: nextLimit,
        }
      ).observeChangesAsync({
        addedBefore: (id, fields) =>
          this.added('testDataCollection', id, fields),
        changed: (id, fields) => this.changed('testDataCollection', id, fields),
        removed: (id) => this.removed('testDataCollection', id),
      });

      this.ready();
    });
  });

  Meteor.publish('testPublish', function () {
    const id = Random.id();
    let previousData = {};

    this.autorun(async (computation) => {
      const newData = await this.data();
      const data = { ...newData };

      for (const field in previousData) {
        if (!(field in data)) {
          data[field] = undefined;
        }
      }

      try {
        this.changed('testCollection', id, data);
      } catch (e) {
        this.added('testCollection', id, data);
      }

      previousData = newData;
    });

    this.ready();
  });
}

// ---- Test: ReactiveData - basic (testClientBasic)

if (Meteor.isClient) {
  let sub;
  let trackerCount = 0;
  Tinytest.addAsync('ReactiveData - set/get basic', async (test, next) => {
    await Meteor.callAsync('removeTest');

    if (sub) await sub.stop();
    sub = Meteor.subscribe('testPublish');
    await new Promise((resolve) =>
      Tracker.autorun((c) => {
        if (sub.ready()) {
          c.stop();
          resolve();
        }
      })
    );
    await Meteor.setTimeout(next, 500);

    Tracker.autorun(async () => {
      await sub.data();
      trackerCount++;
    });

    const doc =
      (await TestCollection.findOneAsync({}, { fields: { _id: 0 } })) || {};
    test.equal(doc, {});
    test.equal(await sub.data(), {});

    await sub.setData({ foo: 'test', bar: 123 });

    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
    test.isTrue(trackerCount >= 1);

    await Meteor.setTimeout(next, 1000);
  });

  Tinytest.addAsync('ReactiveData - update field', async (test, next) => {
    test.equal(await sub?.data(), { foo: 'test', bar: 123 });

    await sub.setData('foo', 'test2');

    test.equal(await sub?.data(), { foo: 'test2', bar: 123 });

    await sub.setData('new', 'value');

    test.equal(await sub?.data(), { foo: 'test2', bar: 123, new: 'value' });

    await sub.setData('nested.key', 'value');

    test.equal(await sub?.data(), {
      foo: 'test2',
      bar: 123,
      new: 'value',
      nested: { key: 'value' },
    });

    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
    test.isTrue(trackerCount >= 3);

    await Meteor.setTimeout(next, 1000);
  });

  Tinytest.addAsync('ReactiveData - unset field', async (test, next) => {
    await sub.setData('new', undefined);

    test.equal(await sub?.data(), {
      foo: 'test2',
      bar: 123,
      nested: { key: 'value' },
    });

    await sub.setData('nested.key', undefined);

    test.equal(await sub?.data(), { foo: 'test2', bar: 123, nested: {} });

    await sub.setData('nested', undefined);

    test.equal(await sub?.data(), { foo: 'test2', bar: 123 });

    await sub.setData('foo', undefined);

    test.equal(await sub?.data(), { bar: 123 });

    await sub.setData('bar', undefined);

    test.equal(await sub?.data(), {});

    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
    test.isTrue(trackerCount >= 6);

    await Meteor.setTimeout(next, 1000);
  });

  // ---- Test: ReactiveData - two-way (testClientTwoWay)

  Tinytest.addAsync('ReactiveData - two-way sync', async (test, next) => {
    await Meteor.callAsync('removeTest');

    if (sub) await sub.stop();
    sub = Meteor.subscribe('testDataPublish');
    await new Promise((resolve) =>
      Tracker.autorun((c) => {
        if (sub.ready()) {
          c.stop();
          resolve();
        }
      })
    );
    await Meteor.setTimeout(next, 500);

    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
    test.equal(await TestDataCollection.find().countAsync(), 0);
    test.equal(await sub.data(), { countAll: 0 });

    for (let i = 0; i < 10; i++) {
      const result = await Meteor.callAsync('insertTest', { i });
      test.isTrue(result);
    }

    test.equal(await sub.data(), { countAll: 10 });

    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
    test.isTrue(trackerCount >= 15);

    await Meteor.setTimeout(next, 1000);
  });

  Tinytest.addAsync(
    'ReactiveData - limit & reactive count',
    async (test, next) => {
      await sub.setData('limit', 5);
      await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
      const nextCount = await TestDataCollection.find().countAsync();
      test.isTrue(nextCount >= 5 && nextCount < 10);
      test.equal(await sub.data(), { countAll: 10, limit: 5 });

      await sub.setData('limit', 10);
      await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
      test.equal(await TestDataCollection.find().countAsync(), 10);
      test.equal(await sub.data(), { countAll: 10, limit: 10 });

      await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
      test.isTrue(trackerCount >= 20);

      await Meteor.setTimeout(next, 1000);
    }
  );

  Tinytest.addAsync(
    'ReactiveData - confirm count updates',
    async (test, next) => {
      for (let i = 0; i < 10; i++) {
        const result = await Meteor.callAsync('insertTest', { i: 10 + i });
        test.isTrue(result);
      }

      test.equal(await sub.data(), { countAll: 20, limit: 10 });

      if (sub) {
        await sub.stop();
      }

      await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
      test.isTrue(trackerCount >= 25);

      await Meteor.setTimeout(next, 1000);
    }
  );
}
