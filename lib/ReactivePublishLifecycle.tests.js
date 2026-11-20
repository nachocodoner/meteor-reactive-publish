import { Meteor } from 'meteor/meteor';
import { Mongo, MongoInternals } from 'meteor/mongo';
import { DDP } from 'meteor/ddp-client';
import { Random } from 'meteor/random';
import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './ReactiveAsync/AsyncTracker';
import { SubscriptionData } from './ReactiveData/ReactiveData';

const names = {
  posts: 'reactive_publish_lifecycle_posts',
  comments: 'reactive_publish_lifecycle_comments',
};
const pause = (ms) => new Promise((resolve) => Meteor.setTimeout(resolve, ms));

async function eventually(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await pause(10);
  }
}

if (Meteor.isServer) {
  const posts = new Mongo.Collection(names.posts);
  const comments = new Mongo.Collection(names.comments);
  const lateDataReads = new Map();
  const changingPublications = new Map();
  const stoppedPublications = new Map();
  const nestedParentRuns = new Map();

  Meteor.publish('lifecycle-regression', function (scope, scenario) {
    if (scenario === 'mirrored-cursor') {
      return this.autorun(async () => {
        const narrow = await this.data('narrow');
        const cursor = posts.find(narrow ? { scope, index: 0 } : { scope });
        cursor._publishCursor = async (sub) => {
          const handle = await cursor.observeChangesAsync({
            added(id, fields) {
              sub.added(names.posts, id, fields);
              sub.added(names.comments, `mirror-${id}`, fields);
            },
            changed(id, fields) {
              sub.changed(names.posts, id, fields);
              sub.changed(names.comments, `mirror-${id}`, fields);
            },
            removed(id) {
              sub.removed(names.posts, id);
              sub.removed(names.comments, `mirror-${id}`);
            },
          });
          sub.onStop(() => handle.stop());
        };
        return cursor;
      });
    }
    if (scenario === 'nested-cursor') {
      const connectionId = this.connection.id;
      const stats = { runs: 0 };
      nestedParentRuns.set(connectionId, stats);
      this.onStop(() => nestedParentRuns.delete(connectionId));
      this.autorun(async () => {
        const index = (await this.data('parentIndex')) || 0;
        const parent = await posts.findOneAsync(
          { scope, index, active: true },
          { fields: { _id: 1 } }
        );
        stats.runs++;
        if (!parent) return;

        this.autorun(
          async () => {
            const hidden = await this.data('hideComments');
            return hidden ? [] : comments.find({ scope, parent: parent._id });
          },
          { cursorDependencies: 'onRead' }
        );
      });
      this.autorun(async () => {
        if (await this.data('pinComment')) {
          this.added(names.comments, `${scope}-comment-1`, { pinned: true });
        }
      });
      this.ready();
      return;
    }
    if (scenario === 'shared-document') {
      this.autorun(async () => {
        if (await this.data('releaseCursor')) return [];
        return posts.find({ scope, index: { $in: [0, 1] } });
      });
      this.autorun(async () => {
        const selection = await this.data('manualSelection');
        if (selection === 'both')
          this.added(names.posts, `${scope}-0`, { scope });
        if (selection) this.added(names.posts, `${scope}-2`, { scope });
      });
      return;
    }
    if (scenario === 'callback-churn') {
      const key = `${scope}:${this.connection.id}`;
      changingPublications.set(key, this);
      this.onStop(() => {
        changingPublications.delete(key);
        stoppedPublications.set(
          scope,
          (stoppedPublications.get(scope) || 0) + 1
        );
      });
      this.autorun(async () => {
        const index = (await this.data('index')) || 0;
        return posts.find({ scope, index });
      });
      return;
    }
    if (scenario === 'late-data') {
      const stopped = new Promise((resolve) => this.onStop(resolve));
      lateDataReads.set(
        `${scope}:${this.connection.id}`,
        stopped.then(() => this.data('late'))
      );
      return posts.find({ scope });
    }
    if (scenario === 'mixed') {
      this.autorun(() => comments.find({ scope }));
      return (async () => {
        await pause(80);
        return posts.find({ scope });
      })();
    }
    if (scenario === 'ready') {
      this.autorun(() => posts.find({ scope }));
      this.autorun(async () => {
        await pause(80);
        return comments.find({ scope });
      });
      return;
    }
    this.autorun(async () => {
      if (scenario === 'delayed-query') {
        const narrow = await this.data('narrow');
        await pause(60);
        return posts.find(narrow ? { scope, _id: `${scope}-0` } : { scope });
      }
      if (scenario === 'limit') {
        const limit = (await this.data('limit')) || 2;
        return posts.find({ scope }, { sort: { index: 1 }, limit });
      }
      const parents = posts.find({ scope, active: true });
      if (scenario === 'children') {
        const docs = await parents.fetchAsync();
        return [
          parents,
          comments.find({ scope, parent: { $in: docs.map((doc) => doc._id) } }),
        ];
      }
      return parents;
    });
  });

  Meteor.methods({
    lifecycleNestedParentRuns() {
      return nestedParentRuns.get(this.connection.id)?.runs;
    },
    lifecycleCallbackStats(scope) {
      return {
        callbacks: [...changingPublications]
          .filter(([key]) => key.startsWith(`${scope}:`))
          .map(([, publication]) => publication._stopCallbacks.length),
        stopped: stoppedPublications.get(scope) || 0,
      };
    },
    async lifecycleLateData(scope) {
      const key = `${scope}:${this.connection.id}`;
      try {
        await lateDataReads.get(key);
      } finally {
        lateDataReads.delete(key);
      }
    },
    async lifecycleSeed(scope) {
      for (let index = 0; index < 3; index++) {
        await posts.insertAsync({
          _id: `${scope}-${index}`,
          scope,
          index,
          active: true,
          optional: 'present',
        });
        await comments.insertAsync({
          _id: `${scope}-comment-${index}`,
          scope,
          parent: `${scope}-${index}`,
        });
      }
    },
    async lifecycleWrite(scope, operation, value) {
      if (operation === 'insert') {
        await posts.insertAsync({
          _id: `${scope}-3`,
          scope,
          index: 3,
          active: true,
        });
      } else if (operation === 'value') {
        await posts.updateAsync(`${scope}-0`, { $set: { revision: value } });
      } else if (operation === 'unset') {
        await posts.updateAsync(`${scope}-0`, { $unset: { optional: '' } });
      } else if (operation === 'exclude-parent') {
        await posts.updateAsync(`${scope}-0`, { $set: { active: false } });
      } else if (operation === 'move-child') {
        await comments.updateAsync(`${scope}-comment-1`, {
          $set: { parent: `${scope}-0` },
        });
      } else if (operation === 'insert-excluded-child') {
        await comments.insertAsync({
          _id: `${scope}-comment-new`,
          scope,
          parent: `${scope}-0`,
        });
      }
    },
    lifecycleHandles() {
      const multiplexers =
        MongoInternals.defaultRemoteCollectionDriver().mongo
          ._observeMultiplexers;
      return Object.entries(multiplexers)
        .filter(([key]) =>
          Object.values(names).some((name) => key.includes(name))
        )
        .reduce(
          (count, [, mux]) => count + Object.keys(mux._handles || {}).length,
          0
        );
    },
    lifecycleObserverIds(scope) {
      const multiplexers =
        MongoInternals.defaultRemoteCollectionDriver().mongo
          ._observeMultiplexers;
      return Object.entries(multiplexers)
        .filter(([key]) => key.includes(scope) && key.includes(names.posts))
        .flatMap(([, mux]) => Object.keys(mux._handles || {}))
        .sort();
    },
    async lifecycleCleanup(scope) {
      await comments.removeAsync({ scope });
      await posts.removeAsync({ scope });
      stoppedPublications.delete(scope);
    },
  });

  Tinytest.addAsync(
    'ReactivePublish lifecycle - stop during observer initialization',
    async (test) => {
      const scope = Random.id();
      await posts.insertAsync({ scope });
      const cursor = posts.find({ scope });
      let added = 0;
      let computation;
      try {
        await new Promise((resolve, reject) => {
          computation = AsyncTracker.autorun(async (comp) => {
            try {
              await cursor.observeChangesAsync({
                added() {
                  added++;
                  // The observer has not returned its handle yet.
                  comp.stop();
                },
              });
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
        await posts.insertAsync({ scope });
        await pause(50);
        test.equal(
          added,
          1,
          'A handle resolving after stop must also be stopped'
        );
        const multiplexers =
          MongoInternals.defaultRemoteCollectionDriver().mongo
            ._observeMultiplexers;
        test.isFalse(
          Object.keys(multiplexers).some((key) => key.includes(scope)),
          'The late observer must release its Mongo multiplexer'
        );
      } finally {
        computation?.stop();
        await posts.removeAsync({ scope });
      }
    }
  );
}

if (Meteor.isClient) {
  const ids = (collection) =>
    collection
      .find()
      .fetch()
      .map((doc) => doc._id)
      .sort();
  const equalIds = (collection, expected) =>
    JSON.stringify(ids(collection)) === JSON.stringify([...expected].sort());

  async function fixture(scenario, callback) {
    const scope = Random.id();
    const peers = [];
    await Meteor.callAsync('lifecycleSeed', scope);
    try {
      // Separate DDP sessions sharing identical Mongo queries reproduce both
      // missing context and attribution to another subscriber's computation.
      for (let index = 0; index < 2; index++) {
        const connection = DDP.connect(Meteor.absoluteUrl());
        const peer = {
          connection,
          posts: new Mongo.Collection(names.posts, { connection }),
          comments: new Mongo.Collection(names.comments, { connection }),
        };
        peers.push(peer);
        let failure;
        peer.subscription = connection.subscribe(
          'lifecycle-regression',
          scope,
          scenario,
          {
            onReady() {
              peer.atReady = {
                posts: ids(peer.posts),
                comments: ids(peer.comments),
              };
            },
            onStop(error) {
              failure = error;
            },
          }
        );
        await eventually(() => {
          if (failure) throw failure;
          return peer.atReady;
        }, `The ${scenario} publication did not become ready`);
      }
      await callback(scope, peers);
    } finally {
      for (const peer of peers) {
        peer.subscription?.stop();
        peer.connection.close();
      }
      await eventually(
        async () => (await Meteor.callAsync('lifecycleHandles')) === 0,
        'Publication observers should stop when their connections close'
      );
      await Meteor.callAsync('lifecycleCleanup', scope);
    }
  }

  Tinytest.addAsync(
    'ReactivePublish lifecycle - a custom cursor retains the collection names and IDs it publishes',
    async (test) => {
      await fixture('mirrored-cursor', async (scope, [first, second]) => {
        const all = [0, 1, 2].map((index) => `${scope}-${index}`);
        const mirrors = all.map((id) => `mirror-${id}`);
        for (const peer of [first, second]) {
          test.equal(peer.atReady.posts, all);
          test.equal(peer.atReady.comments, mirrors);
        }
        await Meteor.callAsync('lifecycleWrite', scope, 'value', 1);
        await eventually(
          () =>
            [first, second].every(
              (peer) =>
                peer.posts.findOne(all[0])?.revision === 1 &&
                peer.comments.findOne(mirrors[0])?.revision === 1
            ),
          'A retained custom cursor must deliver edits under both names'
        );
        await first.subscription.setData('narrow', true);
        await eventually(
          () =>
            equalIds(first.posts, [all[0]]) &&
            equalIds(first.comments, [mirrors[0]]),
          'Replacing the cursor must release precisely the obsolete output IDs'
        );
        test.equal(ids(second.comments), mirrors);
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - nested returned cursors follow their parent across awaits',
    async (test) => {
      await fixture('nested-cursor', async (scope, [first, second]) => {
        const original = [`${scope}-comment-0`];
        const next = [`${scope}-comment-1`];
        const parentRuns = () =>
          first.connection.callAsync('lifecycleNestedParentRuns');
        test.equal(first.atReady.comments, original);
        test.equal(second.atReady.comments, original);

        await first.subscription.setData('hideComments', true);
        await eventually(
          () => equalIds(first.comments, []),
          'The child must rerun when its own input changes'
        );
        await first.subscription.setData('hideComments', false);
        await eventually(
          () => equalIds(first.comments, original),
          'The child must still observe its input after an await'
        );
        test.equal(await parentRuns(), 1);

        await first.subscription.setData('parentIndex', 1);
        await eventually(
          () => equalIds(first.comments, next),
          'Switching parents must replace the child and its documents'
        );
        test.equal(await parentRuns(), 2);
        test.equal(ids(second.comments), original);

        await first.subscription.setData('pinComment', true);
        await eventually(
          () => first.comments.findOne(next[0])?.pinned,
          'The sibling must own the same comment as the current child'
        );
        await Meteor.callAsync('lifecycleWrite', scope, 'exclude-parent');
        await eventually(
          () => equalIds(second.comments, []),
          'Withdrawing the parent must withdraw the last child cursor'
        );
        await first.subscription.setData('parentIndex', 0);
        await eventually(
          async () => (await parentRuns()) === 3,
          'The first peer must also reach the branch without a child'
        );
        test.equal(ids(first.comments), next);
        test.isTrue(first.comments.findOne(next[0])?.pinned);
        await first.subscription.setData('pinComment', false);
        await eventually(
          () => equalIds(first.comments, []),
          'The comment must be withdrawn when its last owner releases it'
        );
        test.equal(ids(second.comments), []);
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - cursor replacement bounds stop callbacks',
    async (test) => {
      await fixture('callback-churn', async (scope, peers) => {
        const initial = await Meteor.callAsync('lifecycleCallbackStats', scope);
        for (let version = 1; version <= 20; version++) {
          const index = version % 3;
          for (const peer of peers)
            await peer.subscription.setData('index', index);
          await eventually(
            () =>
              peers.every((peer) =>
                equalIds(peer.posts, [`${scope}-${index}`])
              ),
            'Every replacement must publish exactly the selected document'
          );
        }
        const current = await Meteor.callAsync('lifecycleCallbackStats', scope);
        test.equal(
          current.callbacks,
          initial.callbacks,
          'Retired cursors must not accumulate subscription stop callbacks'
        );
        test.equal(
          current.stopped,
          0,
          'User subscription callbacks must not run when a cursor is replaced'
        );
        for (const peer of peers) peer.subscription.stop();
        await eventually(async () => {
          const stats = await Meteor.callAsync('lifecycleCallbackStats', scope);
          return stats.stopped === peers.length && stats.callbacks.length === 0;
        }, 'Subscription callbacks must still run exactly once on stop');
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - old cursor events during an awaited query change are retired',
    async (test) => {
      await fixture('delayed-query', async (scope, peers) => {
        const changing = Promise.all(
          peers.map((peer) => peer.subscription.setData('narrow', true))
        );
        await pause(10);
        await Meteor.callAsync('lifecycleWrite', scope, 'insert');
        await changing;
        await eventually(
          () => peers.every((peer) => equalIds(peer.posts, [`${scope}-0`])),
          'Events from the previous cursor must not retain obsolete documents'
        );
        await pause(100);
        for (const peer of peers) test.equal(ids(peer.posts), [`${scope}-0`]);
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - unchanged returned cursors reuse observer handles',
    async (test) => {
      await fixture('cursor', async (scope, peers) => {
        const initial = await Meteor.callAsync('lifecycleObserverIds', scope);
        test.isTrue(initial.length > 0);
        for (let revision = 1; revision <= 10; revision++) {
          await Meteor.callAsync('lifecycleWrite', scope, 'value', revision);
          await eventually(
            () =>
              peers.every(
                (peer) =>
                  peer.posts.findOne(`${scope}-0`)?.revision === revision
              ),
            'A retained observer must continue delivering changes to each owner'
          );
        }
        await pause(100);
        test.equal(
          await Meteor.callAsync('lifecycleObserverIds', scope),
          initial,
          'Stable returned queries must not recreate observer handles on writes'
        );
        for (const peer of peers) test.equal(peer.posts.find().count(), 3);
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - a shared document stays until the last autorun releases it',
    async (test) => {
      await fixture('shared-document', async (scope, [first, second]) => {
        const expected = (...indexes) =>
          indexes.map((index) => `${scope}-${index}`);
        test.equal(first.atReady.posts, expected(0, 1));
        await Meteor.callAsync('lifecycleWrite', scope, 'value', 1);
        await eventually(
          () => first.posts.findOne(`${scope}-0`)?.revision === 1,
          'The retained cursor must deliver updates before a second owner joins'
        );
        await first.subscription.setData('manualSelection', 'both');
        await eventually(
          () => equalIds(first.posts, expected(0, 1, 2)),
          'The second autorun must add its exclusive document'
        );
        await first.subscription.setData('releaseCursor', true);
        await eventually(
          () => equalIds(first.posts, expected(0, 2)),
          'Releasing the cursor must only withdraw its exclusive document'
        );
        await first.subscription.setData('manualSelection', 'exclusive');
        await eventually(
          () => equalIds(first.posts, expected(2)),
          'Releasing the last owner must withdraw the shared document'
        );
        test.equal(ids(second.posts), expected(0, 1));
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - cursor CRUD across shared observers',
    async (test) => {
      await fixture('cursor', async (scope, peers) => {
        await Meteor.callAsync('lifecycleWrite', scope, 'insert');
        const expected = [0, 1, 2, 3].map((index) => `${scope}-${index}`);
        await eventually(
          () => peers.every((peer) => equalIds(peer.posts, expected)),
          'Both subscribers should retain all matching posts after an insert'
        );
        await Meteor.callAsync('lifecycleWrite', scope, 'unset');
        await eventually(
          () =>
            peers.every(
              (peer) =>
                peer.posts.findOne(`${scope}-0`) &&
                !Object.hasOwn(peer.posts.findOne(`${scope}-0`), 'optional')
            ),
          'Unsetting a field should reach both subscribers'
        );
        await pause(100);
        for (const peer of peers)
          test.equal(ids(peer.posts), [...expected].sort());
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - obsolete child observers stop on rerun',
    async (test) => {
      await fixture('children', async (scope, peers) => {
        await Meteor.callAsync('lifecycleWrite', scope, 'exclude-parent');
        await eventually(
          () =>
            peers.every((peer) =>
              equalIds(
                peer.comments,
                [1, 2].map((index) => `${scope}-comment-${index}`)
              )
            ),
          'Old children should be removed'
        );
        await Meteor.callAsync('lifecycleWrite', scope, 'move-child');
        await Meteor.callAsync(
          'lifecycleWrite',
          scope,
          'insert-excluded-child'
        );
        await eventually(
          () =>
            peers.every((peer) =>
              equalIds(peer.comments, [`${scope}-comment-2`])
            ),
          'An obsolete observer must not republish children outside the current relationship'
        );
        await pause(100);
        for (const peer of peers)
          test.equal(ids(peer.comments), [`${scope}-comment-2`]);
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - changing limits retains only current observers',
    async (test) => {
      await fixture('limit', async (scope, peers) => {
        const initialHandles = await Meteor.callAsync('lifecycleHandles');
        for (const limit of [1, 3, 2, 1, 3, 1]) {
          for (const peer of peers)
            await peer.subscription.setData('limit', limit);
          const expected = Array.from(
            { length: limit },
            (_, index) => `${scope}-${index}`
          );
          await eventually(
            () => peers.every((peer) => equalIds(peer.posts, expected)),
            `Both subscribers should converge to limit ${limit}`
          );
        }
        await pause(100);
        test.isTrue(
          (await Meteor.callAsync('lifecycleHandles')) <= initialHandles + 2,
          'Observer counts must stay bounded across query changes'
        );
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - subscription data is created on first write',
    async (test) => {
      await fixture('cursor', async (scope, peers) => {
        for (const peer of peers) {
          const data = peer.connection._subscriptionData;
          const id = peer.subscription.subscriptionId;
          test.equal(await peer.subscription.data(), {});
          test.equal(await data.findOneAsync(id), undefined);
          test.equal(peer.atReady.posts.length, 3);

          await peer.subscription.setData('limit', 1);
          test.equal(await peer.subscription.data('limit'), 1);
          test.isTrue(!!(await data.findOneAsync(id)));
          peer.subscription.stop();
          await eventually(
            async () => !(await data.findOneAsync(id)),
            'Lazily created subscription data must be removed on stop'
          );
        }
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - late data reads cannot recreate stopped subscription metadata',
    async (test) => {
      await fixture('late-data', async (scope, peers) => {
        for (const peer of peers) {
          const data = peer.connection._subscriptionData;
          const id = peer.subscription.subscriptionId;
          test.equal(await data.findOneAsync(id), undefined);
          peer.subscription.stop();
          await peer.connection.callAsync('lifecycleLateData', scope);
          test.equal(await data.findOneAsync(id), undefined);
        }
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - ready waits for every initial autorun',
    async (test) => {
      await fixture('ready', async (scope, peers) => {
        test.isTrue(
          SubscriptionData === Meteor.connection._subscriptionData,
          'Additional DDP sessions must not replace the default subscription data export'
        );
        for (const peer of peers) {
          test.equal(peer.atReady.posts.length, 3);
          test.equal(
            peer.atReady.comments,
            [0, 1, 2].map((index) => `${scope}-comment-${index}`),
            'All initial autoruns must finish before the subscription is ready'
          );
        }
      });
    }
  );

  Tinytest.addAsync(
    'ReactivePublish lifecycle - returned cursors share the readiness barrier',
    async (test) => {
      await fixture('mixed', async (scope, peers) => {
        for (const peer of peers) {
          test.equal(peer.atReady.posts.length, 3);
          test.equal(peer.atReady.comments.length, 3);
        }
        await Meteor.callAsync(
          'lifecycleWrite',
          scope,
          'insert-excluded-child'
        );
        await eventually(
          () => peers.every((peer) => peer.comments.find().count() === 4),
          'Autorun updates must preserve the normally returned cursor'
        );
        await pause(100);
        for (const peer of peers) test.equal(peer.posts.find().count(), 3);
      });
    }
  );
}
