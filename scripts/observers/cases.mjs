import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { DDPClient } from '../../bench/clients/ddp-client.mjs';
import { until } from '../../bench/runner/process.mjs';

export async function exercise(url, redisCli) {
  async function withSubscriber(fn) {
    const peer = new DDPClient(url, { timeout: 6000 });
    const frames = [];
    peer.on('message', (m) => {
      if (['added', 'changed', 'removed', 'ready'].includes(m.msg))
        frames.push(m);
    });
    try {
      await peer.connect();
      assert.deepEqual(await peer.call('driver'), {
        redis: !!redisCli,
        oplog: !redisCli,
      });
      await fn(peer);
    } catch (error) {
      console.error('Subscriber frames:', JSON.stringify(frames));
      throw error;
    } finally {
      await peer.disconnect();
    }
  }

  async function checkObserver(peer, collection, id) {
    assert.deepEqual(
      await peer.call('publicationDrivers', [collection, id]),
      [redisCli ? 'RedisOplogObserveDriver' : 'oplog'],
      `active publication driver for ${collection}/${id}`
    );
    // The private server must actually have a subscription for this query.
    // The leaf and mixed cases disable optimistic local delivery.
    if (redisCli)
      await until(() => redisCli('PUBSUB', 'CHANNELS', `*${collection}*`), {
        label: `Redis subscription for ${collection}`,
      });
  }

  // First subscriber on a fresh server: no warm cursor/observer for the leaf.
  for (const mode of ['onRead', 'onFind', 'read']) {
    await test(`returned native cursor: ${mode}`, () =>
      withSubscriber(async (peer) => {
        const { id } = await peer.subscribe('leaf', [mode]);
        const doc = () => peer.store.collections.get('leaves')?.get(mode);
        assert.equal(doc()?.value, 0);
        assert.equal(await peer.call('runs', [mode]), 1);
        await checkObserver(peer, 'leaves', mode);
        for (const value of [1, 2]) {
          const before = await peer.call('runs', [mode]);
          await peer.call('edit', [mode, value]);
          await peer.waitFor(
            () => doc()?.value === value,
            `leaf value ${value}`
          );
          if (mode === 'onRead')
            assert.equal(await peer.call('runs', [mode]), 1);
          else
            await until(
              async () => (await peer.call('runs', [mode])) > before,
              {
                label: `${mode} invalidation after value ${value}`,
                timeout: 6000,
              }
            );
        }
        await peer.unsubscribe(id);
      }));
  }

  await test('direct parent and nested leaf stay live on the original subscriber', () =>
    withSubscriber(async (peer) => {
      const { id } = await peer.subscribe('mixed');
      assert.deepEqual(peer.store.snapshot(['parents']).parents, [
        { _id: 'parent', leaf: 'a' },
      ]);
      const leafIds = () =>
        [...peer.store.collections.get('leaves').keys()].sort();
      assert.deepEqual(leafIds(), ['a', 'shared']);
      // Only the parent is written. The sorted child is replaced by its
      // parent's autorun; Redis Oplog 3.0.1 can poll that sorted cursor.
      await checkObserver(peer, 'parents', 'parent');
      for (const leaf of ['b', 'c']) {
        const parentChanged = peer.waitFor(
          (m) =>
            m?.msg === 'changed' &&
            m.collection === 'parents' &&
            m.id === 'parent' &&
            m.fields?.leaf === leaf,
          `raw parent changed to ${leaf}`
        );
        const leafAdded = peer.waitFor(
          (m) =>
            m?.msg === 'added' && m.collection === 'leaves' && m.id === leaf,
          `new nested leaf ${leaf}`
        );
        await peer.call('switchLeaf', [leaf]);
        await Promise.all([leafAdded, parentChanged]);
        await peer.waitFor(
          () => leafIds().length === 2 && leafIds().includes(leaf),
          'old leaf removed'
        );
        assert.deepEqual(leafIds(), [leaf, 'shared'].sort());
        assert.deepEqual(peer.store.snapshot(['parents']).parents, [
          { _id: 'parent', leaf },
        ]);
      }
      await peer.unsubscribe(id);
    }));

  await test('a shared read/return observer restores a denied result', () =>
    withSubscriber(async (peer) => {
      const { id } = await peer.subscribe('visibleLeaf');
      const snapshot = () => peer.store.snapshot(['parents', 'leaves']);
      const visible = {
        parents: [{ _id: 'access', leaf: 'a' }],
        leaves: [{ _id: 'a', value: 0 }],
      };
      assert.deepEqual(snapshot(), visible);
      await checkObserver(peer, 'parents', 'access');
      for (const allowed of [false, true]) {
        const updated = await peer
          .call('setVisible', [allowed])
          .catch((error) => {
            throw new Error(`setVisible(${allowed}): ${error.message}`, {
              cause: error,
            });
          });
        assert.equal(updated, 1);
        const expected = allowed ? visible : { parents: [], leaves: [] };
        await peer.waitFor(
          () => isDeepStrictEqual(snapshot(), expected),
          allowed ? 'restore parent and leaf' : 'remove parent and leaf'
        );
      }
      await peer.unsubscribe(id);
    }));

  for (const scope of ['callback', 'registration']) {
    await test(`closing a gate withdraws the row with nonreactive ${scope}`, () =>
      withSubscriber(async (peer) => {
        const { id } = await peer.subscribe('callbackOwner', [scope]);
        assert.deepEqual(peer.store.snapshot(['callbackRows']).callbackRows, [
          { _id: 'a', value: 0 },
        ]);
        await checkObserver(peer, 'leaves', 'a');
        await checkObserver(peer, 'parents', scope);
        assert.equal(await peer.call('closeCallbackGate', [scope]), 1);
        await peer.waitFor(
          () => !peer.store.collections.get('callbackRows').has('a'),
          'callback row withdrawn on the original subscription'
        );
        await peer.unsubscribe(id);
      }));
  }
}
