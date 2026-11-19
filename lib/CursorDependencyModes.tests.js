import { Meteor } from 'meteor/meteor';
import { Mongo, MongoInternals } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './ReactiveAsync/AsyncTracker';
import { waitFor } from './testHelpers';

const collectionName = 'reactive_publish_dependency_modes';
const pause = (ms) => new Promise((resolve) => Meteor.setTimeout(resolve, ms));

if (Meteor.isServer) {
  Tinytest.addAsync(
    'Cursor dependency modes - local synchronous cursors retain compatibility reactivity',
    async (test) => {
      const local = new Mongo.Collection(null);
      await local.insertAsync({ _id: 'local', value: 1 });
      let rows;
      let count;
      const comp = AsyncTracker.autorun(
        () => {
          rows = local.find({}).fetch();
          count = local.find({}).count();
        },
        { cursorDependencies: 'onRead' }
      );
      try {
        await waitFor(
          () => !comp._running && rows?.[0]?.value === 1,
          'Initial local read failed'
        );
        test.isTrue(
          Array.isArray(rows),
          'Synchronous fetch must remain synchronous'
        );
        await local.updateAsync('local', { $set: { value: 2 } });
        await waitFor(
          () => rows?.[0]?.value === 2,
          'Local synchronous fetch lost its dependency'
        );
        await local.removeAsync('local');
        await waitFor(
          () => rows?.length === 0 && count === 0,
          'Local count/removal lost its dependency'
        );
      } finally {
        comp.stop();
      }
    }
  );
  const docs = new Mongo.Collection(collectionName);
  const runs = new Map();
  const publish = function (id, mode) {
    runs.set(id, 0);
    this.onStop(() => runs.delete(id));
    this.autorun(
      () => {
        runs.set(id, runs.get(id) + 1);
        return docs.find({ _id: id });
      },
      mode ? { cursorDependencies: mode } : undefined
    );
  };
  Meteor.publish('dependency-mode-test', publish);
  Meteor.publishReactive(
    'dependency-mode-shorthand-test',
    function (id) {
      runs.set(id, (runs.get(id) || 0) + 1);
      this.onStop(() => runs.delete(id));
      return docs.find({ _id: id });
    },
    { cursorDependencies: 'onRead' }
  );
  const countOptions = { countDependencies: 'membership' };
  async function publishCount(id) {
    const count = await docs.find({ _id: id }).countAsync();
    if (!runs.has(id)) this.onStop(() => runs.delete(id));
    const executions = (runs.get(id) || 0) + 1;
    runs.set(id, executions);
    await this.setData('result', { count, executions });
    this.ready();
  }
  Meteor.publishReactive('count-mode-shorthand', publishCount, countOptions);
  Meteor.publish('count-mode-autorun', function (id) {
    return this.autorun(() => publishCount.call(this, id), countOptions);
  });
  Meteor.methods({
    async dependencyModeSeed(id) {
      await docs.insertAsync({ _id: id, value: 0, optional: 'present' });
    },
    async dependencyModeWrite(id, remove = false) {
      if (remove) return docs.removeAsync(id);
      return docs.updateAsync(id, {
        $set: { value: 1 },
        $unset: { optional: 1 },
      });
    },
    dependencyModeRuns(id) {
      return runs.get(id) ?? null;
    },
  });

  Tinytest.addAsync(
    'Cursor dependency modes - reads track fetches, counts and fresh values across awaits',
    async (test) => {
      const collection = new Mongo.Collection(`read_mode_${Random.id()}`);
      let computation;
      let countComputation;
      let snapshot;
      let count;
      try {
        await collection.insertAsync({
          _id: 'a',
          rank: 1,
          value: 1,
          ignored: true,
        });
        computation = AsyncTracker.autorun(
          async () => {
            const cursor = collection.find(
              {},
              { fields: { value: 1 }, sort: { rank: 1 }, limit: 2 }
            );
            await pause(1);
            snapshot = await cursor.fetchAsync();
          },
          { cursorDependencies: 'onRead' }
        );
        countComputation = AsyncTracker.autorun(
          async () => {
            count = await collection.find({}).countAsync();
          },
          { cursorDependencies: 'onRead' }
        );
        await waitFor(
          () => snapshot?.[0]?.value === 1 && count === 1,
          'Initial reads did not settle'
        );
        test.equal(snapshot, [{ _id: 'a', value: 1 }]);
        await collection.updateAsync('a', { $set: { value: 2 } });
        await waitFor(
          () => snapshot?.[0]?.value === 2 && !computation._running,
          'Fetched field did not invalidate'
        );
        await collection.insertAsync({ _id: 'b', rank: 0, value: 3 });
        await waitFor(
          () => snapshot?.[0]?._id === 'b' && count === 2,
          'Read-mode insert or count did not invalidate'
        );
        test.equal(snapshot, [
          { _id: 'b', value: 3 },
          { _id: 'a', value: 2 },
        ]);
        await collection.updateAsync('a', {
          $set: { rank: -1 },
          $unset: { value: 1 },
        });
        await waitFor(
          () =>
            snapshot?.[0]?._id === 'a' && !Object.hasOwn(snapshot[0], 'value'),
          'Projected sort movement/field clearing did not propagate'
        );
        test.equal(snapshot, [{ _id: 'a' }, { _id: 'b', value: 3 }]);
        await collection.removeAsync('b');
        await waitFor(
          () => snapshot?.length === 1 && count === 1,
          'Read-mode remove or count did not invalidate'
        );
      } finally {
        computation?.stop();
        countComputation?.stop();
        await collection.removeAsync({});
      }
      test.equal(computation._cursorCache.size, 0);
    }
  );

  Tinytest.addAsync(
    'Cursor dependency modes - membership counts skip field edits and preserve fetch reactivity',
    async (test) => {
      const ownerId = Random.id();
      const first = Random.id();
      const second = Random.id();
      const counts = [];
      const explicitReadCounts = [];
      const ordinary = [];
      const limited = [];
      const projected = [];
      const mixed = [];
      const computations = [];
      try {
        await docs.insertAsync({ _id: first, ownerId, value: 0 });
        const countWith = (results, options, queryOptions) =>
          AsyncTracker.autorun(async () => {
            results.push(
              await docs.find({ ownerId }, queryOptions).countAsync()
            );
          }, options);
        computations.push(countWith(counts, countOptions));
        computations.push(
          countWith(explicitReadCounts, {
            ...countOptions,
            cursorDependencies: 'onRead',
          })
        );
        computations.push(
          countWith(ordinary, { cursorDependencies: 'onRead' })
        );
        computations.push(
          countWith(limited, countOptions, { sort: { _id: 1 }, limit: 1 })
        );
        computations.push(
          countWith(projected, countOptions, { fields: { value: 1 } })
        );
        computations.push(
          AsyncTracker.autorun(async () => {
            const cursor = docs.find({ ownerId });
            const count = await cursor.countAsync();
            mixed.push({ count, rows: await cursor.fetchAsync() });
          }, countOptions)
        );
        const settled = () => computations.every((comp) => !comp._running);
        await waitFor(
          () =>
            settled() &&
            counts[0] === 1 &&
            explicitReadCounts[0] === 1 &&
            ordinary[0] === 1 &&
            limited[0] === 1 &&
            projected[0] === 1 &&
            mixed[0]?.count === 1,
          'All count readers must finish before the first edit'
        );

        await docs.updateAsync(first, { $set: { value: 1 } });
        await waitFor(
          () =>
            settled() &&
            ordinary.length > 1 &&
            limited.length > 1 &&
            projected.length > 1 &&
            mixed.at(-1)?.rows[0]?.value === 1,
          'A field edit must reach the ordinary, limited and projected counts and the mixed fetch'
        );
        test.equal(
          limited.at(-1),
          1,
          'The limited query still counts the same row'
        );
        test.equal(counts, [1]);
        test.equal(explicitReadCounts, [1]);

        const expectCount = async (value) => {
          await waitFor(
            () =>
              settled() &&
              counts.at(-1) === value &&
              explicitReadCounts.at(-1) === value &&
              ordinary.at(-1) === value &&
              mixed.at(-1)?.count === value &&
              mixed.at(-1)?.rows.length === value,
            `All readers must see ${value} matching documents`
          );
        };
        await docs.insertAsync({ _id: second, ownerId, value: 2 });
        await expectCount(2);
        await docs.updateAsync(first, { $unset: { ownerId: 1 } });
        await expectCount(1);
        await docs.removeAsync(second);
        await expectCount(0);
        test.equal(counts, [1, 2, 1, 0]);
        test.equal(explicitReadCounts, counts);
      } finally {
        for (const comp of computations) comp.stop();
        await docs.removeAsync({ _id: { $in: [first, second] } });
      }
      const mongo = MongoInternals.defaultRemoteCollectionDriver().mongo;
      await waitFor(
        () =>
          !Object.keys(mongo._observeMultiplexers).some((key) =>
            key.includes(ownerId)
          ),
        'Stopping the readers must release both count and document observers'
      );
    }
  );

  Tinytest.addAsync(
    'Cursor dependency modes - projecting parent IDs skips title edits and tracks owner changes',
    async (test) => {
      const ownerId = Random.id();
      const postId = Random.id();
      const allFields = [];
      const idOnly = [];
      const watchIds = (snapshots, options) =>
        AsyncTracker.autorun(async () => {
          const rows = await docs.find({ ownerId }, options).fetchAsync();
          snapshots.push(rows.map((row) => row._id));
        });
      let full;
      let projected;
      try {
        await docs.insertAsync({ _id: postId, ownerId, title: 'Initial' });
        full = watchIds(allFields);
        projected = watchIds(idOnly, { fields: { _id: 1 } });
        await waitFor(
          () =>
            allFields.length &&
            idOnly.length &&
            !full._running &&
            !projected._running,
          'Both parent reads must finish before edits'
        );
        const edits = 8;
        for (let edit = 1; edit <= edits; edit++) {
          await docs.updateAsync(postId, { $set: { title: `Edit ${edit}` } });
          await waitFor(
            () => allFields.length >= edit + 1 && !full._running,
            'Each title edit must reach the full-document reader'
          );
        }
        test.equal(
          allFields,
          Array.from({ length: edits + 1 }, () => [postId])
        );
        test.equal(idOnly, [[postId]]);

        await docs.updateAsync(postId, { $set: { ownerId: Random.id() } });
        await waitFor(
          () => allFields.at(-1)?.length === 0 && idOnly.at(-1)?.length === 0,
          'Both readers must observe the post leaving the owner query'
        );
        test.equal(allFields.length, edits + 2);
        test.equal(idOnly, [[postId], []]);
      } finally {
        full?.stop();
        projected?.stop();
        await docs.removeAsync(postId);
      }
    }
  );

  Tinytest.addAsync(
    'Cursor dependency modes - returned-only cursor cache stays bounded across explicit reruns',
    async (test) => {
      const collection = new Mongo.Collection(`read_cache_${Random.id()}`);
      let selector = 0;
      let current;
      const computation = AsyncTracker.autorun(
        () => {
          current = collection.find({ selector });
        },
        { cursorDependencies: 'onRead' }
      );
      try {
        await waitFor(
          () => !computation._running,
          'Initial cursor creation did not settle'
        );
        const first = current;
        await computation.run();
        test.isTrue(
          current === first,
          'An unchanged cursor must be reusable without a read dependency'
        );
        for (selector = 1; selector <= 20; selector++) {
          await computation.run();
          test.equal(computation._cursorCache.size, 1);
        }
        test.equal(
          computation._dependencies.size,
          0,
          'Cursor creation must not secretly attach a read dependency'
        );
      } finally {
        computation.stop();
      }
      test.equal(computation._cursorCache.size, 0);
    }
  );

  Tinytest.add(
    'Cursor dependency modes - invalid options fail before executing user code',
    (test) => {
      let executed = false;
      const run = () => {
        executed = true;
      };
      for (const options of [
        { cursorDependencies: 'typo' },
        { cursorDependencies: 'onRead', countDependencies: 'typo' },
        { cursorDependencies: 'onFind', countDependencies: 'membership' },
      ]) {
        test.throws(() => AsyncTracker.autorun(run, options));
      }
      test.isFalse(executed);
      test.throws(() =>
        Meteor.publishReactive('invalid-mode-test', () => {}, {
          cursorDependencies: 'typo',
        })
      );
    }
  );

  Tinytest.addAsync(
    'Cursor dependency modes - scopes are isolated and nested autoruns keep the default',
    async (test) => {
      const collection = new Mongo.Collection(`mode_scope_${Random.id()}`);
      const counts = { normal: 0, reads: 0, outer: 0, nested: 0 };
      let normal;
      let reads;
      let outer;
      try {
        await collection.insertAsync({ _id: 'doc', value: 0 });
        normal = AsyncTracker.autorun(() => {
          counts.normal++;
          collection.find({});
        });
        reads = AsyncTracker.autorun(
          () => {
            counts.reads++;
            collection.find({});
          },
          { cursorDependencies: 'onRead' }
        );
        outer = AsyncTracker.autorun(() => {
          counts.outer++;
          collection.find({});
          AsyncTracker.autorun(() => {
            counts.nested++;
            collection.find({});
          });
        }, countOptions);
        await waitFor(
          () =>
            !normal._running &&
            !reads._running &&
            !outer._running &&
            counts.nested === 1,
          'Initial scopes did not settle'
        );
        await collection.updateAsync('doc', { $set: { value: 1 } });
        await waitFor(
          () => counts.normal > 1 && counts.nested > 1,
          'Default dependencies failed beside an opted-in computation'
        );
        await pause(100);
        test.equal(counts.reads, 1);
        test.equal(counts.outer, 1);
        test.equal(normal.options.cursorDependencies, undefined);
      } finally {
        normal?.stop();
        reads?.stop();
        outer?.stop();
        await collection.removeAsync({});
      }
      test.equal(outer._children.size, 0);
    }
  );
}

if (Meteor.isClient) {
  const docs = new Mongo.Collection(collectionName);
  for (const name of ['count-mode-autorun', 'count-mode-shorthand']) {
    Tinytest.addAsync(
      `Cursor dependency modes - ${name} tracks a count with one option`,
      async (test) => {
        const id = Random.id();
        let sub;
        try {
          await Meteor.callAsync('dependencyModeSeed', id);
          sub = Meteor.subscribe(name, id);
          await waitFor(
            async () => sub.ready() && (await sub.data('result'))?.count === 1,
            'The initial count must reach the subscriber'
          );
          await Meteor.callAsync('dependencyModeWrite', id);
          await Meteor.callAsync('dependencyModeWrite', id, true);
          await waitFor(
            async () => (await sub.data('result'))?.count === 0,
            'The removal must reach the subscriber'
          );
          test.equal(await sub.data('result'), { count: 0, executions: 2 });
        } finally {
          sub?.stop();
          await Meteor.callAsync('dependencyModeWrite', id, true);
        }
      }
    );
  }
  for (const mode of [undefined, 'onFind', 'onRead', 'shorthand']) {
    Tinytest.addAsync(
      `Cursor dependency modes - ${mode || 'default'} publishes exact changes with intentional rerun behavior`,
      async (test) => {
        const id = Random.id();
        let sub;
        try {
          await Meteor.callAsync('dependencyModeSeed', id);
          sub = Meteor.subscribe(
            mode === 'shorthand'
              ? 'dependency-mode-shorthand-test'
              : 'dependency-mode-test',
            id,
            mode
          );
          await waitFor(
            () => sub.ready() && docs.findOne(id),
            'Publication did not become ready'
          );
          test.equal(docs.findOne(id), {
            _id: id,
            value: 0,
            optional: 'present',
          });
          const before = await Meteor.callAsync('dependencyModeRuns', id);
          test.equal(before, 1);
          await Meteor.callAsync('dependencyModeWrite', id);
          await waitFor(
            () =>
              docs.findOne(id)?.value === 1 &&
              !Object.hasOwn(docs.findOne(id), 'optional'),
            'Publication did not deliver changed/cleared fields'
          );
          if (!mode || mode === 'onFind') {
            await waitFor(
              async () =>
                (await Meteor.callAsync('dependencyModeRuns', id)) > before,
              'Default cursor-creation dependency stopped rerunning'
            );
          } else {
            // Bound the no-rerun assertion; exact data and cleanup remain required.
            await pause(100);
            test.equal(
              await Meteor.callAsync('dependencyModeRuns', id),
              before
            );
          }
          await Meteor.callAsync('dependencyModeWrite', id, true);
          await waitFor(
            () => !docs.findOne(id),
            'Publication did not remove document'
          );
          sub.stop();
          await waitFor(
            async () =>
              (await Meteor.callAsync('dependencyModeRuns', id)) === null,
            'Publication did not stop'
          );
        } finally {
          sub?.stop();
          await Meteor.callAsync('dependencyModeWrite', id, true);
        }
      }
    );
  }
}
