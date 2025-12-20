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
  let newFieldTrackerCount = 0;
  let nestedTrackerCount = 0;
  let nestedKeyTrackerCount = 0;
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

    // Specific field trackers
    Tracker.autorun(async () => {
      await sub.data('new');
      newFieldTrackerCount++;
    });

    Tracker.autorun(async () => {
      await sub.data('nested');
      nestedTrackerCount++;
    });

    Tracker.autorun(async () => {
      await sub.data('nested.key');
      nestedKeyTrackerCount++;
    });

    const doc =
      (await TestCollection.findOneAsync({}, { fields: { _id: 0 } })) || {};
    test.equal(doc, {});
    test.equal(await sub.data(), {});

    await sub.setData({ foo: 'test', bar: 123 });

    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

    test.equal(
      newFieldTrackerCount,
      1,
      'New field tracker should not increase when setData in other fields'
    );
    test.equal(
      nestedTrackerCount,
      1,
      'Nested tracker should not increase when setData in other fields'
    );
    test.equal(
      nestedKeyTrackerCount,
      1,
      'Nested.key tracker should not increase when setData in other fields'
    );
    test.isTrue(trackerCount >= 1);

    await Meteor.setTimeout(next, 1000);
  });

  Tinytest.addAsync('ReactiveData - update field', async (test, next) => {
    test.equal(await sub?.data(), { foo: 'test', bar: 123 });

    // Save initial counter values
    const initialTrackerCount = trackerCount;
    const initialNewFieldTrackerCount = newFieldTrackerCount;
    const initialNestedTrackerCount = nestedTrackerCount;
    const initialNestedKeyTrackerCount = nestedKeyTrackerCount;

    await sub.setData('foo', 'test2');

    test.equal(await sub?.data(), { foo: 'test2', bar: 123 });

    // Wait for reactivity to process
    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

    test.equal(
      newFieldTrackerCount,
      1,
      'New field tracker should not increase when setData in other fields'
    );
    test.equal(
      nestedTrackerCount,
      1,
      'Nested tracker should not increase when setData in other fields'
    );
    test.equal(
      nestedKeyTrackerCount,
      1,
      'Nested.key tracker should not increase when setData in other fields'
    );

    // Only the general tracker should have reacted
    test.isTrue(
      trackerCount > initialTrackerCount,
      'General tracker should react to foo change'
    );
    test.equal(
      newFieldTrackerCount,
      initialNewFieldTrackerCount,
      'New field tracker should not react to foo change'
    );
    test.equal(
      nestedTrackerCount,
      initialNestedTrackerCount,
      'Nested tracker should not react to foo change'
    );
    test.equal(
      nestedKeyTrackerCount,
      initialNestedKeyTrackerCount,
      'Nested.key tracker should not react to foo change'
    );

    // Save counter values before next change
    const preNewTrackerCount = trackerCount;
    const preNewFieldTrackerCount = newFieldTrackerCount;

    await sub.setData('new', 'value');

    test.equal(await sub?.data(), { foo: 'test2', bar: 123, new: 'value' });

    // Wait for reactivity to process
    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

    test.equal(newFieldTrackerCount, 2, 'New field tracker should increase');

    // General tracker and new field tracker should have reacted
    test.isTrue(
      trackerCount > preNewTrackerCount,
      'General tracker should react to new field change'
    );
    test.isTrue(
      newFieldTrackerCount > preNewFieldTrackerCount,
      'New field tracker should react to new field change'
    );
    test.equal(
      nestedTrackerCount,
      initialNestedTrackerCount,
      'Nested tracker should not react to new field change'
    );
    test.equal(
      nestedKeyTrackerCount,
      initialNestedKeyTrackerCount,
      'Nested.key tracker should not react to new field change'
    );

    // Save counter values before next change
    const preNestedTrackerCount = trackerCount;
    const preNestedFieldTrackerCount = nestedTrackerCount;
    const preNestedKeyFieldTrackerCount = nestedKeyTrackerCount;

    await sub.setData('nested.key', 'value');

    test.equal(await sub?.data(), {
      foo: 'test2',
      bar: 123,
      new: 'value',
      nested: { key: 'value' },
    });

    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

    test.equal(nestedTrackerCount, 2, 'Nested tracker should increase');
    test.equal(nestedKeyTrackerCount, 2, 'Nested.key tracker should increase');

    // General tracker, nested tracker, and nested.key tracker should have reacted
    test.isTrue(
      trackerCount > preNestedTrackerCount,
      'General tracker should react to nested.key change'
    );
    test.isTrue(
      nestedTrackerCount > preNestedFieldTrackerCount,
      'Nested tracker should react to nested.key change'
    );
    test.isTrue(
      nestedKeyTrackerCount > preNestedKeyFieldTrackerCount,
      'Nested.key tracker should react to nested.key change'
    );

    // Overall check
    test.isTrue(trackerCount >= 3);

    await Meteor.setTimeout(next, 1000);
  });

  Tinytest.addAsync('ReactiveData - unset field', async (test, next) => {
    // Save initial counter values
    const initialTrackerCount = trackerCount;
    const initialNewFieldTrackerCount = newFieldTrackerCount;
    const initialNestedTrackerCount = nestedTrackerCount;
    const initialNestedKeyTrackerCount = nestedKeyTrackerCount;

    await sub.setData('new', undefined);

    test.equal(await sub?.data(), {
      foo: 'test2',
      bar: 123,
      nested: { key: 'value' },
    });

    // Wait for reactivity to process
    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

    // General tracker and new field tracker should have reacted
    test.isTrue(
      trackerCount > initialTrackerCount,
      'General tracker should react to new field removal'
    );
    test.isTrue(
      newFieldTrackerCount > initialNewFieldTrackerCount,
      'New field tracker should react to new field removal'
    );
    test.equal(
      nestedTrackerCount,
      initialNestedTrackerCount,
      'Nested tracker should not react to new field removal'
    );
    test.equal(
      nestedKeyTrackerCount,
      initialNestedKeyTrackerCount,
      'Nested.key tracker should not react to new field removal'
    );

    // Save counter values before next change
    const preNestedKeyTrackerCount = trackerCount;
    const preNestedKeyFieldTrackerCount = nestedKeyTrackerCount;
    const preNestedFieldTrackerCount = nestedTrackerCount;

    await sub.setData('nested.key', undefined);

    test.equal(await sub?.data(), { foo: 'test2', bar: 123, nested: {} });

    // Wait for reactivity to process
    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

    // General tracker, nested tracker, and nested.key tracker should have reacted
    test.isTrue(
      trackerCount > preNestedKeyTrackerCount,
      'General tracker should react to nested.key removal'
    );
    test.isTrue(
      nestedTrackerCount > preNestedFieldTrackerCount,
      'Nested tracker should react to nested.key removal'
    );
    test.isTrue(
      nestedKeyTrackerCount > preNestedKeyFieldTrackerCount,
      'Nested.key tracker should react to nested.key removal'
    );

    // Save counter values before next change
    const preNestedTrackerCount = trackerCount;
    const preNestedOnlyFieldTrackerCount = nestedTrackerCount;

    await sub.setData('nested', undefined);

    test.equal(await sub?.data(), { foo: 'test2', bar: 123 });

    // Wait for reactivity to process
    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

    // General tracker and nested tracker should have reacted
    test.isTrue(
      trackerCount > preNestedTrackerCount,
      'General tracker should react to nested removal'
    );
    test.isTrue(
      nestedTrackerCount > preNestedOnlyFieldTrackerCount,
      'Nested tracker should react to nested removal'
    );

    // Save counter values before next change
    const preFooTrackerCount = trackerCount;

    await sub.setData('foo', undefined);

    test.equal(await sub?.data(), { bar: 123 });

    // Wait for reactivity to process
    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

    // Only general tracker should have reacted
    test.isTrue(
      trackerCount > preFooTrackerCount,
      'General tracker should react to foo removal'
    );

    // Save counter values before next change
    const preBarTrackerCount = trackerCount;

    await sub.setData('bar', undefined);

    test.equal(await sub?.data(), {});

    // Wait for reactivity to process
    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

    // Only general tracker should have reacted
    test.isTrue(
      trackerCount > preBarTrackerCount,
      'General tracker should react to bar removal'
    );

    // Overall check
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
      // Save initial counter values
      const initialTrackerCount = trackerCount;
      const initialNewFieldTrackerCount = newFieldTrackerCount;
      const initialNestedTrackerCount = nestedTrackerCount;
      const initialNestedKeyTrackerCount = nestedKeyTrackerCount;

      await sub.setData('limit', 5);
      await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
      const nextCount = await TestDataCollection.find().countAsync();
      test.isTrue(nextCount >= 5 && nextCount < 10);
      test.equal(await sub.data(), { countAll: 10, limit: 5 });

      // Only general tracker should have reacted to limit change
      test.isTrue(
        trackerCount > initialTrackerCount,
        'General tracker should react to limit change'
      );
      test.equal(
        newFieldTrackerCount,
        initialNewFieldTrackerCount,
        'New field tracker should not react to limit change'
      );
      test.equal(
        nestedTrackerCount,
        initialNestedTrackerCount,
        'Nested tracker should not react to limit change'
      );
      test.equal(
        nestedKeyTrackerCount,
        initialNestedKeyTrackerCount,
        'Nested.key tracker should not react to limit change'
      );

      // Save counter values before next change
      const preLimitTrackerCount = trackerCount;

      await sub.setData('limit', 10);
      await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
      test.equal(await TestDataCollection.find().countAsync(), 10);
      test.equal(await sub.data(), { countAll: 10, limit: 10 });

      // Only general tracker should have reacted to limit change
      test.isTrue(
        trackerCount > preLimitTrackerCount,
        'General tracker should react to second limit change'
      );
      test.equal(
        newFieldTrackerCount,
        initialNewFieldTrackerCount,
        'New field tracker should not react to second limit change'
      );
      test.equal(
        nestedTrackerCount,
        initialNestedTrackerCount,
        'Nested tracker should not react to second limit change'
      );
      test.equal(
        nestedKeyTrackerCount,
        initialNestedKeyTrackerCount,
        'Nested.key tracker should not react to second limit change'
      );

      await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
      test.isTrue(trackerCount >= 20);

      await Meteor.setTimeout(next, 1000);
    }
  );

  Tinytest.addAsync(
    'ReactiveData - confirm count updates',
    async (test, next) => {
      // Save initial counter values
      const initialTrackerCount = trackerCount;
      const initialNewFieldTrackerCount = newFieldTrackerCount;
      const initialNestedTrackerCount = nestedTrackerCount;
      const initialNestedKeyTrackerCount = nestedKeyTrackerCount;

      for (let i = 0; i < 10; i++) {
        const result = await Meteor.callAsync('insertTest', { i: 10 + i });
        test.isTrue(result);
      }

      test.equal(await sub.data(), { countAll: 20, limit: 10 });

      // Wait for reactivity to process
      await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

      // Only general tracker should have reacted to countAll change
      test.isTrue(
        trackerCount > initialTrackerCount,
        'General tracker should react to countAll change'
      );
      test.equal(
        newFieldTrackerCount,
        initialNewFieldTrackerCount,
        'New field tracker should not react to countAll change'
      );
      test.equal(
        nestedTrackerCount,
        initialNestedTrackerCount,
        'Nested tracker should not react to countAll change'
      );
      test.equal(
        nestedKeyTrackerCount,
        initialNestedKeyTrackerCount,
        'Nested.key tracker should not react to countAll change'
      );

      if (sub) {
        await sub.stop();
      }

      await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
      test.isTrue(trackerCount >= 25);

      await Meteor.setTimeout(next, 1000);
    }
  );
}
