import { AsyncTracker } from '../ReactiveAsync/AsyncTracker.js';
import { MongoInternals, Mongo } from 'meteor/mongo';
import { LocalCollection } from 'meteor/minimongo';

const callbacksOrdered = {
  addedBefore: true,
  removed: true,
  changed: true,
  movedBefore: true,
};
const callbacksUnordered = { added: true, changed: true, removed: true };

const MeteorCursor = Object.getPrototypeOf(
  MongoInternals.defaultRemoteCollectionDriver().mongo.find()
).constructor;

MeteorCursor.prototype._isReactive =
  LocalCollection.Cursor.prototype._isReactive = function () {
    const options = this._cursorDescription.options || {};
    return options.reactive !== undefined ? options.reactive : true;
  };

const buildAsyncMethodOverride = (orig) =>
  async function (...args) {
    const opts = this._cursorDescription?.options || {};
    const hasOrdered = Object.prototype.hasOwnProperty.call(opts, 'ordered');
    const useOrdered = hasOrdered ? opts.ordered : !!opts.sort;
    await _attachReactiveDependency.call(
      this,
      useOrdered ? callbacksOrdered : callbacksUnordered
    );
    return orig.apply(this, args);
  };

const methods = ['fetchAsync', 'mapAsync', 'forEachAsync'];
methods.forEach((method) => {
  const origMeteorCursor = MeteorCursor.prototype[method];
  MeteorCursor.prototype[method] = buildAsyncMethodOverride(origMeteorCursor);

  const origLocalCursor = MeteorCursor.prototype[method];
  LocalCollection.Cursor.prototype[method] =
    buildAsyncMethodOverride(origLocalCursor);
});

const origFetch = MeteorCursor.prototype.fetch;
MeteorCursor.prototype.fetch = buildAsyncMethodOverride(origFetch);

const dependencies = new WeakMap();

function computationDependencies(comp) {
  if (dependencies.has(comp)) return dependencies.get(comp);
  const state = { generation: 0, cursors: new Map() };
  dependencies.set(comp, state);
  const dispose = (cursor, record) => {
    record.active = false;
    record.handle?.stop();
    state.cursors.delete(cursor);
  };
  comp.beforeRun(() => {
    state.generation++;
  });
  comp.afterRun(() => {
    for (const [cursor, record] of state.cursors) {
      if (record.generation !== state.generation) dispose(cursor, record);
    }
    for (const [key, entry] of comp._cursorCache) {
      if (!state.cursors.has(entry.cursor)) comp._cursorCache.delete(key);
    }
  });
  comp.onStop(() => {
    for (const [cursor, record] of state.cursors) dispose(cursor, record);
  });
  return state;
}

function _attachReactiveDependency(changers) {
  const comp = AsyncTracker.currentComputation();
  if (!comp || comp.stopped) return Promise.resolve(null);
  const state = computationDependencies(comp);
  let record = state.cursors.get(this);
  if (record) {
    record.generation = state.generation;
    record.dep.depend();
    return record.promise;
  }

  const dep = new AsyncTracker.Dependency();
  dep.depend();
  record = {
    dep,
    active: true,
    initializing: true,
    generation: state.generation,
  };
  state.cursors.set(this, record);

  const cursorOpts = this._cursorDescription?.options || {};
  const isNamedCol = !!this._cursorDescription?.collectionName;
  const hasPagination = cursorOpts.limit != null || cursorOpts.skip != null;
  const shouldSkipAdded = !isNamedCol || hasPagination;
  const cb = {};
  ['added', 'changed', 'removed', 'addedBefore', 'movedBefore'].forEach(
    (event) => {
      if (shouldSkipAdded && event === 'added') return;
      const isActive =
        (shouldSkipAdded && changers.added && event === 'addedBefore') ||
        changers[event];
      if (isActive) {
        cb[event] = async () => {
          if (record.active && !record.initializing) {
            await dep.changed();
          }
        };
      }
    }
  );

  // Dependency observers survive a rerun while their query is still used.
  // They must not be treated as publication observers, which stop on invalidate.
  record.promise = AsyncTracker.nonreactive(() =>
    this.observeChangesAsync(cb, {
      nonMutatingCallbacks: true,
    })
  ).then((handle) => {
    record.handle = handle;
    record.initializing = false;
    if (!record.active || comp.stopped) handle.stop();
    return handle;
  });
  // find() cannot await observer creation. Fetches await this same promise;
  // report a failure even when the cursor is only returned from a publication.
  record.promise.catch((error) => console.error(error));
  return record.promise;
}

// 3) Wrap Collection.find() to cache cursors and re‐depend on fetchAsync
const origFind = Mongo.Collection.prototype.find;
Mongo.Collection.prototype.find = function (selector = {}, options) {
  const comp = AsyncTracker.currentComputation();
  if (!comp || comp.stopped) {
    return origFind.call(this, selector, options);
  }

  const canUseCache = !comp?._parent;
  // Initialize per‐computation cache
  if (canUseCache && !comp._cursorCache) {
    comp._cursorCache = new Map();
    comp.onStop(() => comp._cursorCache.clear());
  }

  const collectionName = this?._name;
  // Clear any existing cursors with the same selector but different options
  // This ensures that when options change, we don't use the cached cursor
  for (const existingKey of comp._cursorCache.keys()) {
    try {
      const parsed = JSON.parse(existingKey);
      if (
        parsed.collectionName === collectionName &&
        JSON.stringify(parsed.selector) === JSON.stringify(selector) &&
        JSON.stringify(parsed.options) !== JSON.stringify(options)
      ) {
        comp._cursorCache.delete(existingKey);
      }
    } catch {
      // Ignore parsing errors
    }
  }

  const key = JSON.stringify({ collectionName, selector, options });

  if (canUseCache && comp._cursorCache.has(key)) {
    const entry = comp._cursorCache.get(key);
    _attachReactiveDependency.call(entry.cursor, callbacksUnordered);
    return entry.cursor;
  }

  const cursor = origFind.call(this, selector, options);
  // First time: attach reactivity
  const { sort, ordered } =
    cursor?._cursorDescription?.options || options || {};
  const cbSet =
    'ordered' in (cursor?._cursorDescription?.options || options || {})
      ? ordered
        ? callbacksOrdered
        : callbacksUnordered
      : sort
        ? callbacksOrdered
        : callbacksUnordered;

  _attachReactiveDependency.call(cursor, cbSet);

  if (canUseCache) {
    comp._cursorCache.set(key, { cursor });
  }
  return cursor;
};

const originalExists = MeteorCursor.prototype.exists;
if (originalExists) {
  MeteorCursor.prototype.exists = function (...args) {
    if (this._isReactive()) {
      _attachReactiveDependency.call(this, { added: true, removed: true });
    }
    return originalExists.apply(this, args);
  };
}

const originalLocalExists = MeteorCursor.prototype.exists;
if (originalLocalExists) {
  LocalCollection.Cursor.prototype.exists = function (...args) {
    if (this._isReactive()) {
      _attachReactiveDependency.call(this, { added: true, removed: true });
    }
    return originalExists.apply(this, args);
  };
}
