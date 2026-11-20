import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp-client';
import { Mongo, MongoInternals } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tinytest } from 'meteor/tinytest';
import { waitFor } from './testHelpers';

const name = 'reactive_publish_strategy_comments';
const documents = [
  ['a', 'a', 1],
  ['b', 'b', 2],
  ['shared', ['a', 'b', 'c'], 3],
  ['c', 'c', 4],
];

if (Meteor.isServer) {
  const comments = new Mongo.Collection(name);

  async function selectComments(scope, initialWindow) {
    const {
      groups = ['a', 'b'],
      view,
      windowed = initialWindow,
    } = await this.data();
    const selector = { postId: { $in: groups.map((g) => scope + g) } };
    const options = { fields: { rank: 1, note: 1 } };
    if (view) {
      selector.category = view;
      options.fields = { note: 1 };
    }
    if (windowed) {
      options.sort = { rank: -1 };
      options.limit = 1;
    }
    return comments.find(selector, options);
  }

  Meteor.publishReactive('strategy-incremental', selectComments, {
    cursorDependencies: 'onRead',
    returnedCursorStrategy: 'incremental',
  });
  Meteor.publish('strategy-standard', function (scope, windowed) {
    return this.autorun(() => selectComments.call(this, scope, windowed), {
      cursorDependencies: 'onRead',
    });
  });

  Meteor.methods({
    async strategySeed(scope) {
      for (const [id, group, rank] of documents) {
        await comments.insertAsync({
          _id: scope + id,
          postId: Array.isArray(group)
            ? group.map((g) => scope + g)
            : scope + group,
          rank,
          note: 'present',
          hidden: true,
          category: id === 'shared' ? 'review' : 'inbox',
        });
      }
    },
    async strategyMove(scope, id, group) {
      await comments.updateAsync(scope + id, {
        $set: { postId: scope + group },
        $unset: { note: 1 },
      });
    },
    strategyObserverHandles(scope) {
      const multiplexers =
        MongoInternals.defaultRemoteCollectionDriver().mongo
          ._observeMultiplexers;
      return Object.entries(multiplexers)
        .filter(([key]) => key.includes(name) && key.includes(scope))
        .flatMap(([, mux]) => Object.keys(mux._handles));
    },
    async strategyClean(scope) {
      await comments.removeAsync({
        _id: { $in: documents.map(([id]) => scope + id) },
      });
    },
  });

  Tinytest.add(
    'Returned cursor strategy - unknown strategy is rejected',
    (test) => {
      test.throws(() =>
        Meteor.publishReactive('strategy-bad-option', () => {}, {
          returnedCursorStrategy: 'typo',
        })
      );
    }
  );
}

if (Meteor.isClient) {
  async function fixture(callback) {
    const scope = Random.id();
    const peers = [];
    await Meteor.callAsync('strategySeed', scope);
    try {
      async function subscribe(publication, windowed = false) {
        const connection = DDP.connect(Meteor.absoluteUrl());
        const peer = {
          connection,
          comments: new Mongo.Collection(name, { connection }),
        };
        peers.push(peer);
        await new Promise((resolve, reject) => {
          peer.sub = connection.subscribe(publication, scope, windowed, {
            onReady: resolve,
            onError: reject,
          });
        });
        return peer;
      }
      await callback(scope, subscribe);
    } finally {
      for (const peer of peers) {
        peer.sub?.stop();
        peer.connection.close();
      }
      try {
        await waitFor(
          async () =>
            !(await Meteor.callAsync('strategyObserverHandles', scope)).length,
          'Observers were left active after unsubscribe'
        );
      } finally {
        await Meteor.callAsync('strategyClean', scope);
      }
    }
  }

  const ids = (peer, scope) =>
    peer.comments
      .find()
      .fetch()
      .map((doc) => doc._id.slice(scope.length))
      .sort();

  async function expectIds(peer, scope, expected) {
    await waitFor(
      () => JSON.stringify(ids(peer, scope)) === JSON.stringify(expected),
      `Expected published IDs ${expected.join(', ')}`
    );
  }

  Tinytest.addAsync(
    'Returned cursor strategy - incremental reuses observers and preserves overlapping ownership',
    async (test) => {
      await fixture(async (scope, subscribe) => {
        const peer = await subscribe('strategy-incremental');
        test.equal(ids(peer, scope), ['a', 'b', 'shared']);
        test.equal(peer.comments.findOne(scope + 'shared'), {
          _id: scope + 'shared',
          rank: 3,
          note: 'present',
        });
        const before = await Meteor.callAsync('strategyObserverHandles', scope);
        test.isTrue(before.length > 0);
        await peer.sub.setData('groups', ['a', 'b', 'c']);
        await expectIds(peer, scope, ['a', 'b', 'c', 'shared']);
        const after = await Meteor.callAsync('strategyObserverHandles', scope);
        test.isTrue(
          before.some((id) => after.includes(id)),
          'Existing observer work must survive expansion'
        );

        const other = await subscribe('strategy-standard');
        test.equal(ids(other, scope), ['a', 'b', 'shared']);
        await peer.sub.setData('groups', ['b', 'c']);
        await expectIds(peer, scope, ['b', 'c', 'shared']);
        test.equal(ids(other, scope), ['a', 'b', 'shared']);

        // Both b and c remain selected, so moving b's comment between them keeps it live.
        let removals = 0;
        const watch = await peer.comments
          .find(scope + 'b')
          .observeChangesAsync({
            removed() {
              removals++;
            },
          });
        try {
          await Meteor.callAsync('strategyMove', scope, 'b', 'c');
          await waitFor(() => {
            const doc = peer.comments.findOne(scope + 'b');
            return doc && !Object.hasOwn(doc, 'note');
          }, 'Moved comment must retain its projected fields and clear the removed field');
          await expectIds(peer, scope, ['b', 'c', 'shared']);
          await expectIds(other, scope, ['a', 'shared']);
          test.equal(peer.comments.findOne(scope + 'b'), {
            _id: scope + 'b',
            rank: 2,
          });

          test.equal(
            removals,
            0,
            'Moving between selected parents must preserve continuous membership'
          );
        } finally {
          await watch.stop();
        }

        await peer.sub.setData('groups', []);
        await expectIds(peer, scope, []);
        await peer.sub.setData('groups', ['c', 'c']);
        await expectIds(peer, scope, ['b', 'c', 'shared']);
        test.equal(ids(other, scope), ['a', 'shared']);
      });
    }
  );

  Tinytest.addAsync(
    'Returned cursor strategy - current filters and projections control retained documents',
    async (test) => {
      await fixture(async (scope, subscribe) => {
        const peer = await subscribe('strategy-incremental');
        test.equal(ids(peer, scope), ['a', 'b', 'shared']);
        await peer.sub.setData('view', 'inbox');
        await expectIds(peer, scope, ['a', 'b']);
        await waitFor(
          () => !Object.hasOwn(peer.comments.findOne(scope + 'a'), 'rank'),
          'Narrowing a projection must clear previously owned fields'
        );
        test.equal(peer.comments.findOne(scope + 'a'), {
          _id: scope + 'a',
          note: 'present',
        });
        await peer.sub.setData('view', 'review');
        await expectIds(peer, scope, ['shared']);
        test.equal(peer.comments.findOne(scope + 'shared'), {
          _id: scope + 'shared',
          note: 'present',
        });
        await peer.sub.setData('view', null);
        await expectIds(peer, scope, ['a', 'b', 'shared']);
        await waitFor(
          () => peer.comments.findOne(scope + 'shared')?.rank === 3,
          'Restoring the projection must restore its fields'
        );
      });
    }
  );

  Tinytest.addAsync(
    'Returned cursor strategy - global sort and limit use one window across all parents',
    async (test) => {
      await fixture(async (scope, subscribe) => {
        const peer = await subscribe('strategy-incremental', true);
        test.equal(ids(peer, scope), ['shared']);
        await peer.sub.setData('groups', ['a', 'b', 'c']);
        await expectIds(peer, scope, ['c']);
        await peer.sub.setData('windowed', false);
        await expectIds(peer, scope, ['a', 'b', 'c', 'shared']);
        await peer.sub.setData('windowed', true);
        await expectIds(peer, scope, ['c']);
        await peer.sub.setData('groups', ['a']);
        await expectIds(peer, scope, ['shared']);
        await Meteor.callAsync('strategyMove', scope, 'shared', 'c');
        await expectIds(peer, scope, ['a']);
      });
    }
  );
}
