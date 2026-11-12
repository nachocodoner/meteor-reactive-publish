import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './ReactiveAsync/AsyncTracker';
import { extendPublish } from './ReactivePublishServer';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { waitFor } from './testHelpers';

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
        { cursorDependencies: 'reads' }
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
