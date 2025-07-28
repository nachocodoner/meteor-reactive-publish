import { AsyncTracker } from '../AsyncReactive/AsyncTracker.js';
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

const methods = ['fetch', 'fetchAsync', 'mapAsync', 'forEachAsync'];
methods.forEach((method) => {
  const orig = MeteorCursor.prototype[method];
  MeteorCursor.prototype[method] = LocalCollection.Cursor.prototype[method] =
    async function (...args) {
      const opts = this._cursorDescription.options || {};
      const hasOrdered = Object.prototype.hasOwnProperty.call(opts, 'ordered');
      const useOrdered = hasOrdered ? opts.ordered : !!opts.sort;
      _attachReactiveDependency.call(
        this,
        useOrdered ? callbacksOrdered : callbacksUnordered
      );
      return orig.apply(this, args);
    };
});

function _attachReactiveDependency(changers) {
  const comp = AsyncTracker.currentComputation();
  if (!comp) return Promise.resolve(null);

  if (this._reactiveDependency || this._hasReactiveDepAttached) {
    this._reactiveDependency.depend();
    return Promise.resolve(null);
  }

  const dep = new AsyncTracker.Dependency();
  dep.depend();
  this._reactiveDependency = dep;

  const cb = {};
  ['added', 'changed', 'removed', 'addedBefore', 'movedBefore'].forEach(
    (event) => {
      if (changers[event]) {
        cb[event] = async () => {
          if (!this._initializing) {
            await dep.changed();
          }
        };
      }
    }
  );

  if (this._initializing) return this._observer;

  this._initializing = true;
  this._observer = this.observeChangesAsync(cb, {
    nonMutatingCallbacks: true,
  });
  this._observer.then((handle) => {
    this._initializing = false;
    comp.onStop(() => handle.stop());
  });

  return this._observer;
}

// 3) Wrap Collection.find() to cache cursors and re‐depend on fetchAsync
const origFind = Mongo.Collection.prototype.find;
Mongo.Collection.prototype.find = function (selector, options) {
  const comp = AsyncTracker.currentComputation();
  if (!comp) {
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
  for (const [existingKey, entry] of comp._cursorCache.entries()) {
    try {
      const parsed = JSON.parse(existingKey);
      if (
        parsed.collectionName === collectionName &&
        JSON.stringify(parsed.selector) === JSON.stringify(selector) &&
        JSON.stringify(parsed.options) !== JSON.stringify(options)
      ) {
        comp._cursorCache.delete(existingKey);
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }

  const key = JSON.stringify({ collectionName, selector, options });

  if (canUseCache && comp._cursorCache.has(key)) {
    const entry = comp._cursorCache.get(key);
    if (entry.cursor._reactiveDependency) {
      entry.cursor._reactiveDependency.depend();
    }
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
  cursor._hasReactiveDepAttached = true;

  if (canUseCache) {
    comp._cursorCache.set(key, { cursor });
  }
  return cursor;
};

const originalExists = MeteorCursor.prototype.exists;
if (originalExists) {
  MeteorCursor.prototype.exists = LocalCollection.Cursor.prototype.exists =
    function (...args) {
      if (this._isReactive() && !this._hasReactiveDepAttached) {
        _attachReactiveDependency.call(this, { added: true, removed: true });
        this._hasReactiveDepAttached = true;
      }
      return originalExists.apply(this, args);
    };
}
