import { AsyncTracker } from 'meteor/server-autorun';
import { MongoInternals, Mongo } from 'meteor/mongo';

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

MeteorCursor.prototype._isReactive = function () {
  const options = this._cursorDescription.options || {};
  return options.reactive !== undefined ? options.reactive : true;
};

const methods = ['fetch', 'fetchAsync', 'mapAsync', 'forEachAsync'];
methods.forEach((method) => {
  const orig = MeteorCursor.prototype[method];
  MeteorCursor.prototype[method] = async function (...args) {
    const opts = this._cursorDescription.options || {};
    const hasOrdered = Object.prototype.hasOwnProperty.call(opts, 'ordered');
    const useOrdered = hasOrdered ? opts.ordered : !!opts.sort;
    this._attachReactiveDependency(
      useOrdered ? callbacksOrdered : callbacksUnordered
    );
    return orig.apply(this, args);
  };
});

MeteorCursor.prototype._attachReactiveDependency = function (changers) {
  const comp = AsyncTracker.currentComputation();
  if (!comp) return Promise.resolve(null);

  if (this._reactiveDependency) {
    this._reactiveDependency.depend();
    return Promise.resolve(null);
  }

  const dep = new AsyncTracker.Dependency();
  dep.depend();
  this._reactiveDependency = dep;

  let initializing = true;
  const cb = {};

  ['added', 'changed', 'removed', 'addedBefore', 'movedBefore'].forEach(
    (event) => {
      if (changers[event]) {
        cb[event] = () => {
          if (!initializing) dep.changed();
        };
      }
    }
  );

  const handlePromise = this.observeChangesAsync(cb, {
    nonMutatingCallbacks: true,
  });
  handlePromise.then((handle) => {
    initializing = false;
    comp.onStop(() => handle.stop());
  });

  return handlePromise;
};

// 3) Wrap Collection.find() to cache cursors and re‐depend on fetchAsync
const origFind = Mongo.Collection.prototype.find;
Mongo.Collection.prototype.find = function (selector, options) {
  const comp = AsyncTracker.currentComputation();
  if (!comp) {
    return origFind.call(this, selector, options);
  }

  // Initialize per‐computation cache
  if (!comp._cursorCache) {
    comp._cursorCache = new Map();
    comp.onInvalidate(() => comp._cursorCache.clear());
  }

  const key = JSON.stringify({ selector, options });
  if (comp._cursorCache.has(key)) {
    const entry = comp._cursorCache.get(key);
    if (entry.cursor._reactiveDependency) {
      entry.cursor._reactiveDependency.depend();
    }
    return entry.cursor;
  }

  const cursor = origFind.call(this, selector, options);
  // First time: attach reactivity
  const { sort, ordered } = cursor._cursorDescription.options || {};
  const cbSet =
    'ordered' in (cursor._cursorDescription.options || {})
      ? ordered
        ? callbacksOrdered
        : callbacksUnordered
      : sort
        ? callbacksOrdered
        : callbacksUnordered;

  cursor._attachReactiveDependency(cbSet);
  cursor._hasReactiveDepAttached = true;

  comp._cursorCache.set(key, { cursor, lastUsed: Date.now() });
  return cursor;
};

const originalExists = MeteorCursor.prototype.exists;
if (originalExists) {
  MeteorCursor.prototype.exists = function (...args) {
    if (this._isReactive() && !this._hasReactiveDepAttached) {
      this._attachReactiveDependency({ added: true, removed: true });
      this._hasReactiveDepAttached = true;
    }
    return originalExists.apply(this, args);
  };
}
