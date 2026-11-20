import { AsyncTracker } from '../ReactiveAsync/AsyncTracker.js';
import { observeUntracked } from '../PublicationContext';
import { MongoInternals, Mongo } from 'meteor/mongo';
import { EJSON } from 'meteor/ejson';
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

const buildAsyncMethodOverride = (orig, countRead = false) =>
  function (...args) {
    const computation = AsyncTracker.currentComputation();
    // Outside a computation, preserve native return values, synchronous setup
    // and synchronous errors. An unconditional await changes Meteor's contract.
    if (
      !computation ||
      computation.stopped ||
      (countRead && computation.options.cursorDependencies !== 'onRead')
    )
      return orig.apply(this, args);
    const opts = this._cursorDescription?.options || {};
    const hasOrdered = Object.prototype.hasOwnProperty.call(opts, 'ordered');
    const useOrdered = hasOrdered ? opts.ordered : !!opts.sort;
    const observed =
      countRead && computation.options.countDependencies === 'membership'
        ? countDependencyCursor(this, computation)
        : this;
    return _attachReactiveDependency
      .call(observed, useOrdered ? callbacksOrdered : callbacksUnordered)
      .then(() => orig.apply(this, args));
  };

const methods = ['fetchAsync', 'mapAsync', 'forEachAsync'];
methods.forEach((method) => {
  const origMeteorCursor = MeteorCursor.prototype[method];
  MeteorCursor.prototype[method] = buildAsyncMethodOverride(origMeteorCursor);

  const origLocalCursor = LocalCollection.Cursor.prototype[method];
  LocalCollection.Cursor.prototype[method] =
    buildAsyncMethodOverride(origLocalCursor);
});

const origFetch = MeteorCursor.prototype.fetch;
MeteorCursor.prototype.fetch = buildAsyncMethodOverride(origFetch);

// find() supplied this dependency in the default mode. Opt-in read tracking
// must also preserve reactive counts, without changing the default count path.
for (const prototype of [
  MeteorCursor.prototype,
  LocalCollection.Cursor.prototype,
]) {
  if (typeof prototype.countAsync === 'function') {
    prototype.countAsync = buildAsyncMethodOverride(prototype.countAsync, true);
  }
}

const dependencies = new WeakMap();

// An ID-only view observes entry and exit even when the selector refers to
// other fields. Reads of document contents still observe the original cursor.
function countDependencyCursor(cursor, computation) {
  if (
    Object.getPrototypeOf(cursor) !== MeteorCursor.prototype ||
    Object.hasOwn(cursor, 'observeChanges') ||
    Object.hasOwn(cursor, 'observeChangesAsync')
  )
    return cursor;
  const { collectionName, selector, options } = cursor._cursorDescription;
  if (
    !collectionName ||
    Object.keys(options || {}).some(
      (key) => key !== 'transform' || options.transform != null
    )
  )
    return cursor;

  const state = computationDependencies(computation);
  state.countCursors ??= new WeakMap();
  let membership = state.countCursors.get(cursor);
  if (!membership) {
    membership = cursor._mongo.find(collectionName, selector, {
      fields: { _id: 1 },
    });
    state.countCursors.set(cursor, membership);
  }
  return membership;
}

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
      const unused =
        comp.options.cursorDependencies === 'onRead'
          ? entry.generation !== state.generation
          : !state.cursors.has(entry.cursor);
      if (unused) comp._cursorCache.delete(key);
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
  // A dependency tracks future changes. Minimongo may deliver its initial
  // addedBefore callbacks after the dependency observer has finished starting.
  const cb =
    this instanceof LocalCollection.Cursor ? { _suppress_initial: true } : {};
  ['added', 'changed', 'removed', 'addedBefore', 'movedBefore'].forEach(
    (event) => {
      if (shouldSkipAdded && event === 'added') return;
      const isActive =
        (shouldSkipAdded && changers.added && event === 'addedBefore') ||
        changers[event];
      if (isActive) {
        cb[event] = () => {
          if (record.active && !record.initializing) {
            // A publication rerun can wait for initial data on this very
            // cursor. Returning that promise to a serial observe driver
            // would block the delivery queue needed to attach the new handle.
            const rerun = dep.changed();
            if (!comp._publication) return rerun;
          }
        };
      }
    }
  );

  // Dependency observers survive a rerun while their query is still used.
  // They must not be treated as publication observers, which stop on invalidate.
  record.promise = observeUntracked(() =>
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

// Preserve field order (including sort priority) and distinguish extended Mongo
// values from lookalike JSON. Native JSON handles ordinary selectors cheaply.
function cacheKey(value) {
  let extended = false;
  function supported(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object') return false;
    if (Array.isArray(item)) return item.every(supported);
    const prototype = Object.getPrototypeOf(item);
    if (prototype === Object.prototype || prototype === null) {
      return Object.values(item).every(supported);
    }
    if (
      item instanceof Date ||
      item instanceof RegExp ||
      item instanceof Mongo.ObjectID ||
      EJSON.isBinary(item)
    ) {
      extended = true;
      return true;
    }
    return false;
  }
  if (!supported(value)) return null;
  return extended ? 'e' + EJSON.stringify(value) : JSON.stringify(value);
}

const origFind = Mongo.Collection.prototype.find;
Mongo.Collection.prototype.find = function (selector = {}, options) {
  const comp = AsyncTracker.currentComputation();
  if (!comp || comp.stopped) {
    return origFind.call(this, selector, options);
  }

  // Publication children keep their own cache for the lifetime of this child.
  const cacheQueries = !comp._parent || !!comp._publication;
  const readTracking = comp.options.cursorDependencies === 'onRead';
  // Returned-only cursors still need bounded cache ownership even though they
  // deliberately do not create an invalidating dependency in read mode.
  const cacheState = readTracking ? computationDependencies(comp) : null;
  // Each collection/selector keeps one options variant. A changed projection
  // or sort replaces that entry without decoding the other cached queries.
  const key = cacheQueries ? cacheKey([this._name, selector]) : null;
  const optionsKey =
    key === null || options === undefined ? '' : cacheKey(options);
  const canUseCache = key !== null && optionsKey !== null;
  const entry = canUseCache && comp._cursorCache.get(key);
  if (entry && entry.collection === this && entry.optionsKey === optionsKey) {
    if (readTracking) entry.generation = cacheState.generation;
    if (!readTracking || !(entry.cursor instanceof MeteorCursor))
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

  // Local collections also expose synchronous reads. Preserve their existing
  // eager dependency rather than silently making those reads nonreactive.
  if (!readTracking || !(cursor instanceof MeteorCursor))
    _attachReactiveDependency.call(cursor, cbSet);

  if (canUseCache) {
    comp._cursorCache.set(key, {
      cursor,
      collection: this,
      optionsKey,
      generation: cacheState?.generation,
    });
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
