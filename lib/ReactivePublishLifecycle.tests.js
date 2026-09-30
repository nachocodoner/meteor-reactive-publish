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

  Meteor.publish('lifecycle-regression', function (scope, scenario) {
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
    async lifecycleWrite(scope, operation) {
      if (operation === 'insert') {
        await posts.insertAsync({
          _id: `${scope}-3`,
          scope,
          index: 3,
          active: true,
        });
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
    async lifecycleCleanup(scope) {
      await comments.removeAsync({ scope });
      await posts.removeAsync({ scope });
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
        await new Promise((resolve, reject) => {
          peer.subscription = connection.subscribe(
            'lifecycle-regression',
            scope,
            scenario,
            {
              onReady: resolve,
              onError: reject,
            }
          );
        });
        peer.atReady = { posts: ids(peer.posts), comments: ids(peer.comments) };
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
