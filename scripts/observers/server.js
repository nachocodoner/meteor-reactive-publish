import { Meteor } from 'meteor/meteor';
import { Mongo, MongoInternals } from 'meteor/mongo';
import { AsyncTracker } from 'meteor/nachocodoner:reactive-publish';

const redisAdapter = Package['cultofcoders:redis-oplog'];
if (redisAdapter) {
  // Consumer initialization after package evaluation can replace Mongo's hook.
  if (redisAdapter.Config.isInitialized)
    throw new Error('Redis auto-initialized');
  redisAdapter.RedisOplog.init(Meteor.settings.manualRedisOplog);
}

const leaves = new Mongo.Collection('leaves');
const parents = new Mongo.Collection('parents');
const runs = new Map();
const onRead = { cursorDependencies: 'onRead' };
const onFind = { cursorDependencies: 'onFind' };

Meteor.publish('leaf', async function (mode) {
  await this.autorun(
    () => {
      runs.set(mode, (runs.get(mode) || 0) + 1);
      const cursor = leaves.find({ _id: mode });
      if (mode === 'read') return cursor.fetchAsync().then(() => cursor);
      return cursor;
    },
    mode === 'onFind' ? onFind : onRead
  );
  return [];
});

Meteor.publish('mixed', async function () {
  const parent = () =>
    parents.find('parent', { fields: { leaf: 1 }, transform: null });
  await this.autorun(async () => {
    const [row] = await parent().fetchAsync();
    await this.autorun(
      () =>
        leaves.find(
          { _id: { $in: [row.leaf, 'shared'] } },
          { fields: { value: 1 }, sort: { value: 1 }, transform: null }
        ),
      onFind
    );
    return [];
  }, onRead);
  return [parent()];
});

Meteor.publish('visibleLeaf', function () {
  return this.autorun(async () => {
    const parent = parents.find(
      { _id: 'access', visible: true },
      { fields: { leaf: 1 }, transform: null }
    );
    const [row] = await parent.fetchAsync();
    return row ? [parent, leaves.find(row.leaf)] : [];
  }, onRead);
});

Meteor.publish('callbackOwner', function (scope) {
  const sub = this;
  let handle;
  sub.onStop(() => handle?.stop());
  return sub.autorun(async () => {
    const [gate] = await parents.find(scope).fetchAsync();
    if (gate.open) {
      const publishRow = (id, fields) => sub.added('callbackRows', id, fields);
      const observe = (added) =>
        leaves.find('a').observeChangesAsync({ added });
      if (scope === 'registration') {
        handle = await AsyncTracker.nonreactive(() => observe(publishRow));
      } else {
        await observe((id, fields) =>
          AsyncTracker.nonreactive(() => publishRow(id, fields))
        );
      }
    } else if (handle) {
      // A nonreactive registration is owned and stopped by the application.
      await handle.stop();
      handle = null;
    }
    return [];
  }, onRead);
});

Meteor.methods({
  driver() {
    return {
      redis: !!Package['cultofcoders:redis-oplog']?.Config.isInitialized,
      oplog:
        !!MongoInternals.defaultRemoteCollectionDriver().mongo._oplogHandle,
    };
  },
  publicationDrivers(collection, id) {
    const mongo = MongoInternals.defaultRemoteCollectionDriver().mongo;
    const drivers = new Set();
    for (const [key, mux] of Object.entries(mongo._observeMultiplexers)) {
      const { collectionName, selector, ordered } = JSON.parse(key);
      if (collectionName === collection && selector._id === id && !ordered) {
        const driver = mux._observeDriver;
        drivers.add(driver?._usesOplog ? 'oplog' : driver?.constructor.name);
      }
    }
    return [...drivers];
  },
  closeCallbackGate(scope) {
    return parents.updateAsync(scope, { $set: { open: false } });
  },
  runs(mode) {
    return runs.get(mode) || 0;
  },
  edit(mode, value) {
    return leaves.updateAsync(mode, { $set: { value } });
  },
  switchLeaf(leaf) {
    return parents.updateAsync('parent', { $set: { leaf } });
  },
  setVisible(visible) {
    // Also cover Redis Oplog's default synchronous local dispatch. A rerun
    // waiting for this same multiplexer must not block the restoring write.
    const modifier = { $set: { visible } };
    return Package['cultofcoders:redis-oplog']
      ? parents.updateAsync('access', modifier, {
          optimistic: true,
          pushToRedis: true,
        })
      : parents.updateAsync('access', modifier);
  },
});

Meteor.startup(async () => {
  for (const id of ['onRead', 'onFind', 'read', 'a', 'b', 'c', 'shared'])
    await leaves.insertAsync({ _id: id, value: 0 });
  await parents.insertAsync({ _id: 'parent', leaf: 'a', hidden: true });
  await parents.insertAsync({ _id: 'access', leaf: 'a', visible: true });
  for (const scope of ['callback', 'registration'])
    await parents.insertAsync({ _id: scope, open: true });
  console.log('Observer fixtures ready');
});
