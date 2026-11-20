import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './ReactiveAsync/AsyncTracker';
import { ReactiveVarAsync } from './ReactiveAsync/ReactiveVarAsync';
import { extendPublish } from './ReactivePublishServer';
import { Mongo } from 'meteor/mongo';
import { LocalCollection } from 'meteor/minimongo';
import { Random } from 'meteor/random';
import { waitFor } from './testHelpers';

Tinytest.addAsync(
  'ReactivePublish lifecycle - replacing a pending nested autorun preserves initial readiness and retained documents',
  async (test) => {
    const events = [];
    const resumeChildren = [];
    const stopCallbacks = [];
    const ids = new Set();
    const subscription = {
      _documents: new Map([['posts', ids]]),
      _idFilter: { idStringify: String, idParse: (id) => id },
      onStop(callback) {
        stopCallbacks.push(callback);
      },
      ready() {
        events.push('ready');
      },
      error() {
        events.push('error');
      },
      added(name, id) {
        ids.add(id);
        events.push('added');
      },
      changed() {},
      removed(name, id) {
        ids.delete(id);
        events.push('removed');
      },
    };
    let parent;
    let child;
    let publishFromParent = false;
    const [, publish] = extendPublish('nested-handoff', async function () {
      parent = await this.autorun(() => {
        this.autorun(async (computation) => {
          child = computation;
          await new Promise((resolve) => resumeChildren.push(resolve));
          this.added('posts', 'shared', { title: 'Same post' });
          if (computation.stopped)
            throw new Error('Retired child lookup failed');
        });
        if (publishFromParent)
          this.added('posts', 'shared', { title: 'Same post' });
        this.ready();
      });
    });
    try {
      await publish.call(subscription);
      await waitFor(() => !parent._running, 'Initial parent did not finish');
      test.equal(events, []);

      await parent.run();
      test.equal(events, [], 'Ready must wait for the replacement child');
      resumeChildren[0]();
      resumeChildren[1]();
      await waitFor(() => !child._running, 'Replacement child did not finish');
      test.equal(events, ['added', 'ready']);

      publishFromParent = true;
      await parent.run();
      test.equal(
        events,
        ['added', 'ready'],
        'The row stays during the handoff'
      );
      resumeChildren[2]();
      await waitFor(() => !child._running, 'Final child did not finish');
      test.equal(events, ['added', 'ready'], 'The retained row is not resent');
      test.equal([...ids], ['shared']);
      parent.stop();
      test.equal([...ids], [], 'Stopping both owners withdraws the shared row');
    } finally {
      for (const resume of resumeChildren) resume();
      for (const stop of stopCallbacks) await stop();
    }
  }
);

Tinytest.addAsync(
  'ReactivePublish lifecycle - retired parents cannot start publication children after an await',
  async (test) => {
    for (const action of ['stop', 'invalidate']) {
      const started = [];
      const published = [];
      let parent;
      let staleChild;
      let resume;
      const pause = new Promise((resolve) => {
        resume = resolve;
      });
      const subscription = {
        _documents: new Map(),
        _idFilter: { idStringify: String },
        onStop() {},
        added(name, id) {
          published.push(id);
        },
      };
      const [, publish] = extendPublish('late-child', async function () {
        let first = true;
        parent = await this.autorun(async () => {
          const label = first ? 'retired' : 'current';
          if (first) {
            first = false;
            await pause;
          }
          const child = await this.autorun(() => {
            started.push(label);
            this.added('posts', label, {});
          });
          if (label === 'retired') staleChild = child;
        });
      });
      try {
        await publish.call(subscription);
        parent[action]();
        resume();
        await waitFor(() => !parent._running, 'Parent failed to settle');
        const expected = action === 'stop' ? [] : ['current'];
        test.isTrue(staleChild.stopped);
        test.equal(started, expected);
        test.equal(published, expected);
      } finally {
        resume();
        parent?.stop();
      }
    }
  }
);

Tinytest.addAsync(
  'ReactivePublish lifecycle - a nested publication reuses cursors only within the same child',
  async (test) => {
    const collection = new Mongo.Collection('nested_cache_' + Random.id());
    const cursors = [];
    let parent;
    let child;
    const subscription = {
      _documents: new Map(),
      onStop() {},
      ready() {},
      async _publishHandlerResult(cursor) {
        if (cursor) {
          await cursor._publishCursor(this);
          this.ready();
        }
      },
    };
    const [, publish] = extendPublish('nested-cache', async function () {
      parent = await this.autorun(() => {
        this.autorun(
          (computation) => {
            child = computation;
            const cursor = collection.find(
              { active: true },
              { fields: { title: 1 } }
            );
            cursors.push(cursor);
            return cursor;
          },
          { cursorDependencies: 'onRead' }
        );
      });
    });
    try {
      await publish.call(subscription);
      await waitFor(
        () => !child._running && !parent._running,
        'Initial query did not finish'
      );
      const firstChild = child;
      await child.run();
      test.isTrue(
        cursors[0] === cursors[1],
        'The same child reuses its returned cursor'
      );

      await parent.run();
      await waitFor(() => !child._running, 'Replacement query did not finish');
      test.isTrue(firstChild.stopped);
      test.equal(firstChild._cursorCache.size, 0);
      test.equal(cursors.length, 3);
      test.isTrue(
        cursors[2] !== cursors[0],
        'The replacement child owns a fresh cursor'
      );
    } finally {
      parent?.stop();
    }
  }
);

Tinytest.addAsync(
  'ReactivePublish lifecycle - cleanup in another subscription cannot withdraw a retained cursor row',
  async (test) => {
    const posts = new LocalCollection('posts');
    const visibleToPeer = new ReactiveVarAsync(true);
    const stopCallbacks = [];
    async function subscribe(run) {
      const rows = new Set();
      let computation;
      const [, publish] = extendPublish('cleanup-isolation', async function () {
        computation = await this.autorun(run);
      });
      await publish.call({
        _documents: new Map([['posts', rows]]),
        _idFilter: { idStringify: String, idParse: (id) => id },
        onStop(callback) {
          stopCallbacks.push(callback);
        },
        ready() {},
        added(name, id) {
          this._documents.get(name).add(id);
        },
        removed(name, id) {
          this._documents.get(name).delete(id);
        },
        async _publishHandlerResult(cursor) {
          if (cursor) await cursor._publishCursor(this);
          this.ready();
        },
      });
      await waitFor(() => !computation._running, 'Subscription did not settle');
      return { rows, computation };
    }

    await posts.insertAsync({ _id: 'shared', visibleToPeer: true });
    const cursor = posts.find();
    cursor._publishCursor = async (sub) => {
      const handle = await cursor.observeChangesAsync({
        added(id) {
          sub.added('posts', id, {});
        },
        changed(id, fields) {
          return visibleToPeer.set(fields.visibleToPeer);
        },
      });
      sub.onStop(() => handle.stop());
    };

    try {
      const owner = await subscribe(() => cursor);
      const peer = await subscribe(function () {
        if (visibleToPeer.get()) this.added('posts', 'shared', {});
      });
      test.equal([...owner.rows], ['shared']);
      test.equal([...peer.rows], ['shared']);

      // Trigger the peer's cleanup from inside the owner's observer callback.
      await posts.updateAsync('shared', { $set: { visibleToPeer: false } });
      await waitFor(() => !peer.rows.size, 'The peer did not withdraw its row');
      await owner.computation.run();
      test.equal(
        [...owner.rows],
        ['shared'],
        'Reusing the cursor must retain the row the peer withdrew'
      );
    } finally {
      for (const stop of stopCallbacks) await stop();
    }
  }
);

Tinytest.addAsync(
  'ReactivePublish lifecycle - read mode releases removed membership without rerunning',
  async (test) => {
    const collection = new Mongo.Collection(`read_mode_churn_${Random.id()}`);
    let computation;
    let documents;
    let runs = 0;
    const subscription = {
      _documents: new Map(),
      _idFilter: { idStringify: String, idParse: (id) => id },
      _stopCallbacks: [],
      _isDeactivated: () => false,
      onStop(callback) {
        this._stopCallbacks.push(callback);
      },
      ready() {},
      added(name, id) {
        if (!this._documents.has(name)) this._documents.set(name, new Set());
        this._documents.get(name).add(id);
      },
      removed(name, id) {
        this._documents.get(name)?.delete(id);
      },
      changed() {},
      async _publishHandlerResult(cursor) {
        await cursor._publishCursor(this);
        this.ready();
      },
    };
    const [, publish] = extendPublish('read-mode-churn', async function () {
      documents = global._testDocumentsRef;
      computation = await this.autorun(
        () => {
          runs++;
          return collection.find({});
        },
        { cursorDependencies: 'onRead' }
      );
    });
    try {
      await publish.call(subscription);
      await waitFor(() => !computation._running, 'Initial run did not settle');
      for (let i = 0; i < 20; i++) {
        const id = `doc-${i}`;
        await collection.insertAsync({ _id: id });
        await waitFor(
          () => subscription._documents.get(collection._name)?.has(id),
          'Added document was not published'
        );
        await collection.removeAsync(id);
        await waitFor(
          () => !subscription._documents.get(collection._name)?.has(id),
          'Removed document remained published'
        );
        test.equal(
          Object.keys(documents[computation._id]?.[collection._name] || {}),
          [],
          'Removed IDs must not accumulate until the next autorun'
        );
      }
      test.equal(runs, 1);
      test.equal(computation._publicationObservers.size, 1);
      test.equal([...computation._publicationObservers][0].ids.size, 0);
      test.equal(subscription._stopCallbacks.length, 1);
    } finally {
      computation?.stop();
      for (const callback of subscription._stopCallbacks) await callback();
      await collection.removeAsync({});
    }
    test.equal(Object.keys(documents), []);
  }
);

Tinytest.addAsync(
  'ReactivePublish lifecycle - stop during returned cursor setup releases late callbacks',
  async (test) => {
    let resume;
    const paused = new Promise((resolve) => {
      resume = resolve;
    });
    let computation;
    let firstStops = 0;
    let secondStarts = 0;
    const first = {
      _getCollectionName: () => 'first',
      async _publishCursor(sub) {
        await paused;
        sub.onStop(() => {
          firstStops++;
        });
      },
    };
    const second = {
      _getCollectionName: () => 'second',
      _publishCursor() {
        secondStarts++;
      },
    };
    const subscription = {
      _documents: new Map(),
      _stopCallbacks: [],
      _isDeactivated: () => false,
      onStop(callback) {
        this._stopCallbacks.push(callback);
      },
      ready() {},
      added() {},
      async _publishHandlerResult(cursor) {
        await cursor._publishCursor(this);
        this.ready();
      },
    };
    const [, publish] = extendPublish('late-cursor-test', async function () {
      computation = await this.autorun(() => [first, second]);
    });
    try {
      await publish.call(subscription);
      computation.stop();
      resume();
      await AsyncTracker.drainReactions();
      test.equal(firstStops, 1, 'Late cursor cleanup must run exactly once');
      test.equal(
        secondStarts,
        0,
        'A stopped computation must not start another cursor'
      );
      test.equal(computation._publicationCursorStops.size, 0);
      test.equal(
        subscription._stopCallbacks.length,
        1,
        'Only subscription cleanup remains registered'
      );
    } finally {
      resume();
      computation?.stop();
      for (const callback of subscription._stopCallbacks) await callback();
    }
  }
);

Tinytest.addAsync(
  'ReactivePublish lifecycle - unsubscribe releases incremental observers whose handles arrive late',
  async (test) => {
    const name = 'late_partitions_' + Random.id();
    const collection = new Mongo.Collection(name);
    // Seventeen IDs fill one partition and start a second, plus the ID-only observer.
    const ids = Array.from({ length: 17 }, (_, i) => 'post-' + i);
    const cursor = collection.find(
      { postId: { $in: ids } },
      { fields: { rank: 1 } }
    );
    const mongo = cursor._mongo;
    const observed = [];
    let resume;
    const paused = new Promise((resolve) => {
      resume = resolve;
    });
    cursor._mongo = {
      find(collectionName, selector, options) {
        const source = mongo.find(collectionName, selector, options);
        return {
          async observeChanges(callbacks, observeOptions) {
            const handle = await source.observeChanges(
              callbacks,
              observeOptions
            );
            const record = {
              membership: options.projection?._id === 1,
              stops: 0,
            };
            observed.push(record);
            await paused;
            // A queued callback can run after stop, before handing back the handle.
            callbacks.added('late-row', { rank: 1 });
            return {
              stop() {
                record.stops++;
                return handle.stop();
              },
            };
          },
        };
      },
    };
    let sent = 0;
    let stopped = false;
    let computation;
    const stopCallbacks = [];
    const subscription = {
      _documents: new Map(),
      _idFilter: { idStringify: String, idParse: (id) => id },
      _isDeactivated: () => stopped,
      onStop(callback) {
        stopCallbacks.push(callback);
      },
      ready() {
        sent++;
      },
      added() {
        sent++;
      },
      async _publishHandlerResult(c) {
        await c._publishCursor(this);
      },
    };
    const [, publish] = extendPublish(name, async function () {
      computation = await this.autorun(() => cursor, {
        returnedCursorStrategy: 'incremental',
      });
    });
    const unsubscribe = async () => {
      stopped = true;
      for (const callback of stopCallbacks.splice(0)) await callback();
    };
    try {
      await publish.call(subscription);
      await waitFor(
        () => observed.length === 3,
        'Expected two projected observers and one membership observer'
      );
      test.equal(observed.filter((record) => record.membership).length, 1);
      await unsubscribe();
      test.isTrue(computation.stopped);
      resume();
      await waitFor(
        () => !computation._running,
        'Interrupted cursor setup did not finish'
      );
      test.equal(
        observed.map((record) => record.stops),
        [1, 1, 1]
      );
      test.equal(
        sent,
        0,
        'No documents or ready signal may arrive after unsubscribe'
      );
      await waitFor(
        () =>
          !Object.keys(mongo._observeMultiplexers).some((key) =>
            key.includes(name)
          ),
        'Interrupted cursor setup retained a Mongo multiplexer'
      );
    } finally {
      resume();
      await unsubscribe();
    }
  }
);
