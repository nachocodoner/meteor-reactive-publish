import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';
import { Tinytest } from 'meteor/tinytest';
import { DDP } from 'meteor/ddp-client';
import { waitFor } from '../testHelpers.js';

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
  Tinytest.addAsync('ReactiveData - set/get basic', async (test) => {
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
    await new Promise((resolve) => Meteor.setTimeout(resolve, 500));

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

    await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));
  });

  Tinytest.addAsync('ReactiveData - update field', async (test) => {
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

    await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));
  });

  Tinytest.addAsync('ReactiveData - unset field', async (test) => {
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

    await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));
  });

  // ---- Test: ReactiveData - two-way (testClientTwoWay)

  Tinytest.addAsync('ReactiveData - two-way sync', async (test) => {
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
    await new Promise((resolve) => Meteor.setTimeout(resolve, 500));

    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
    test.equal(await TestDataCollection.find().countAsync(), 0);
    test.equal(await sub.data(), { countAll: 0 });

    for (let i = 0; i < 10; i++) {
      const result = await Meteor.callAsync('insertTest', { i });
      test.isTrue(result);
    }

    await waitFor(
      async () => (await sub.data('countAll')) === 10,
      'The reactive count should reach 10 after all inserts'
    );
    test.equal(await sub.data(), { countAll: 10 });

    await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
    test.isTrue(trackerCount >= 15);

    await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));
  });

  Tinytest.addAsync('ReactiveData - limit & reactive count', async (test) => {
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

    await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));
  });

  Tinytest.addAsync('ReactiveData - confirm count updates', async (test) => {
    // Save initial counter values
    const initialTrackerCount = trackerCount;
    const initialNewFieldTrackerCount = newFieldTrackerCount;
    const initialNestedTrackerCount = nestedTrackerCount;
    const initialNestedKeyTrackerCount = nestedKeyTrackerCount;

    for (let i = 0; i < 10; i++) {
      const result = await Meteor.callAsync('insertTest', { i: 10 + i });
      test.isTrue(result);
    }

    await waitFor(
      async () => (await sub.data('countAll')) === 20,
      'The reactive count should reach 20 after all inserts'
    );
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

    await new Promise((resolve) => Meteor.setTimeout(resolve, 1000));
  });
}

const rpcFixtureMethod = 'reactiveDataRpcFixture';
const rpcFixturePublication = 'reactive-data-rpc-unwrapped';

if (Meteor.isServer) {
  const cases = new Map();

  // Reproduce the registry state of a publication registered before wrapping.
  Meteor.server.publish_handlers[rpcFixturePublication] = function (scope) {
    const state = cases.get(scope);
    state.generations++;
    state.connections.add(this.connection);
    this.onStop(() => state.stops++);
    this.ready();
  };

  Meteor.methods({
    async [rpcFixtureMethod](action, scope, subscriptionId) {
      if (action === 'create') {
        const state = { generations: 0, stops: 0, connections: new Set() };
        state.gate = new Promise((resolve) => {
          state.release = resolve;
        });
        cases.set(scope, state);
        return;
      }
      const state = cases.get(scope);
      if (action === 'cleanup') {
        state?.connections.forEach((connection) => connection.close());
        state?.release();
        cases.delete(scope);
        return;
      }
      if (action === 'hold') {
        state.session = Meteor.server.sessions.get(this.connection.id);
        await state.gate;
        return;
      }
      if (action === 'waitForHold') {
        await waitFor(
          () => state.session,
          'The fixture method must hold the session'
        );
        return;
      }
      if (action === 'waitForWrite') {
        await waitFor(() => {
          const message = state.session?.inQueue?.peek();
          return (
            message?.msg === 'method' &&
            message.method === '_subscriptionDataSet' &&
            message.params[0] === subscriptionId
          );
        }, 'The metadata write must reach the server behind the held method');
        return state.session.id;
      }
      if (action === 'release') {
        state.release();
        return;
      }
      if (action === 'close') {
        state.session.connectionHandle.close();
        state.release();
        return;
      }
      return { generations: state.generations, stops: state.stops };
    },
  });
}

if (Meteor.isClient) {
  async function rpcFixture(callback) {
    const scope = Random.id();
    await Meteor.callAsync(rpcFixtureMethod, 'create', scope);
    const connection = DDP.connect(Meteor.absoluteUrl(), { retry: false });
    const subscription = connection.subscribe(rpcFixturePublication, scope);
    const control = (action) =>
      Meteor.callAsync(
        rpcFixtureMethod,
        action,
        scope,
        subscription.subscriptionId
      );
    try {
      await waitFor(() => subscription.ready(), 'The fixture must be ready');
      await callback({ scope, connection, subscription, control });
    } finally {
      subscription.stop();
      connection.close();
      await control('cleanup');
    }
  }

  const outcome = (promise) =>
    promise.then(
      () => ({ resolved: true }),
      (error) => ({ error: error.error })
    );

  Tinytest.addAsync(
    'ReactiveData RPC - unwrapped active publications acknowledge client writes',
    async (test) => {
      await rpcFixture(async ({ scope, connection, subscription, control }) => {
        const held = outcome(
          connection.applyAsync(rpcFixtureMethod, ['hold', scope], {
            returnServerResultPromise: true,
            noRetry: true,
          })
        );
        await control('waitForHold');
        let settled = false;
        const written = outcome(subscription.setData('answer', 7)).then(
          (result) => {
            settled = true;
            return result;
          }
        );
        await control('waitForWrite');
        test.isFalse(settled, 'setData must await the server acknowledgment');
        await control('release');
        test.equal(await held, { resolved: true });
        test.equal(await written, { resolved: true });
        await connection.callAsync(rpcFixtureMethod, 'inspect', scope);
        test.equal(await subscription.data(), { answer: 7 });
        subscription.stop();
        await connection.callAsync(rpcFixtureMethod, 'inspect', scope);
        await waitFor(
          () =>
            !connection._subscriptionData.findOne(subscription.subscriptionId),
          'Stopping the unwrapped publication must remove its metadata'
        );
      });
    }
  );

  Tinytest.addAsync(
    'ReactiveData RPC - stopped and missing subscriptions reject awaited writes',
    async (test) => {
      await rpcFixture(async ({ scope, connection, subscription }) => {
        subscription.stop();
        const state = await connection.callAsync(
          rpcFixtureMethod,
          'inspect',
          scope
        );
        test.equal(
          state.stops,
          1,
          'The server must have stopped the subscription'
        );
        test.equal(await outcome(subscription.setData('rejected', true)), {
          error: 'subscription-data-unavailable',
        });
        test.equal(await outcome(subscription.setData('absent', undefined)), {
          error: 'subscription-data-unavailable',
        });
        const absentId = Random.id();
        test.equal(
          await outcome(
            connection.callAsync('_subscriptionDataSet', absentId, 'value', 1)
          ),
          { error: 'subscription-data-unavailable' }
        );
        await connection.callAsync(rpcFixtureMethod, 'inspect', scope);
        test.equal(
          connection._subscriptionData.findOne(subscription.subscriptionId),
          undefined,
          'Rejected stopped writes must not leave an optimistic or server row'
        );
        test.equal(connection._subscriptionData.findOne(absentId), undefined);
      });
    }
  );

  Tinytest.addAsync(
    'ReactiveData RPC - reconnect rejects a pending write before resubscription',
    async (test) => {
      await rpcFixture(async ({ scope, connection, subscription, control }) => {
        const held = outcome(
          connection.applyAsync(rpcFixtureMethod, ['hold', scope], {
            returnServerResultPromise: true,
            noRetry: true,
          })
        );
        await control('waitForHold');
        let writeResult;
        const written = outcome(subscription.setData('lost', true)).then(
          (result) => {
            writeResult = result;
            return result;
          }
        );
        const oldSessionId = await control('waitForWrite');
        await control('close');
        connection.reconnect({ _force: true });
        await waitFor(
          () =>
            connection._lastSessionId !== oldSessionId &&
            subscription.ready() &&
            writeResult,
          'The replacement session must settle the abandoned client write'
        );
        test.equal(await written, { error: 'invocation-failed' });
        test.equal(await held, { error: 'invocation-failed' });
        const state = await connection.callAsync(
          rpcFixtureMethod,
          'inspect',
          scope
        );
        test.equal(
          state.generations,
          2,
          'The actual DDP subscription must restart'
        );
        test.equal(
          connection._subscriptionData.findOne(subscription.subscriptionId),
          undefined,
          'The abandoned write must not create metadata in the new session'
        );
        test.equal(await outcome(subscription.setData('fresh', 2)), {
          resolved: true,
        });
        await connection.callAsync(rpcFixtureMethod, 'inspect', scope);
        test.equal(await subscription.data(), { fresh: 2 });
      });
    }
  );
}
