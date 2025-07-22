// async-tracker-server.js
import { AsyncLocalStorage } from 'async_hooks';
const asyncLocalStorage = new AsyncLocalStorage();

class AsyncTrackerDependency {
  constructor() {
    this._dependents = new Map();
    this._attached = new WeakSet();
  }

  depend() {
    const comp = AsyncTracker.currentComputation();
    if (!comp) return false;
    if (!this._dependents.has(comp._id)) {
      this._dependents.set(comp._id, comp);
    }
    if (!this._attached.has(comp)) {
      this._attached.add(comp);
      comp.onInvalidate(() => {
        this._dependents.delete(comp._id);
        this._attached.delete(comp);
      });
      comp.onStop(() => {
        this._dependents.delete(comp._id);
        this._attached.delete(comp);
      });
    }
    return true;
  }

  changed() {
    // Schedule a full rerun (invalidate+flush) on each dependent
    for (const comp of this._dependents.values()) {
      Meteor.defer(() => {
        comp.run().catch((err) => console.error(err));
      });
    }
  }

  hasDependents() {
    return this._dependents.size > 0;
  }
}

let nextId = 1;

class AsyncTrackerComputation {
  constructor(asyncFunc, options = {}) {
    this._id = nextId++;
    this.firstRun = true;
    this.asyncFunc = asyncFunc;
    this.options = options;
    this.stopped = false;
    this.invalidated = false;
    this._running = false;

    this._beforeRunCallbacks = [];
    this._afterRunCallbacks = [];
    this._onInvalidateCallbacks = [];
    this._onStopCallbacks = [];
    this._cursorCache = new Map();

    // perform first run
    this._run();
  }

  beforeRun(fn) {
    this._beforeRunCallbacks.push(fn);
  }
  afterRun(fn) {
    this._afterRunCallbacks.push(fn);
  }

  async _run() {
    if (this.stopped) return;

    this._beforeRunCallbacks.forEach((fn) => {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    });

    this.invalidated = false;
    this._running = true;
    try {
      await asyncLocalStorage.run(this, () => this.asyncFunc(this));
    } catch (err) {
      (this.options.onError || console.error)('AsyncTracker error:', err);
    } finally {
      this._running = false;
    }

    this._afterRunCallbacks.forEach((fn) => {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    });

    if (this.invalidated && !this.stopped) {
      await this._run();
    }

    this.firstRun = false;
  }

  invalidate() {
    if (this.stopped) return;
    if (!this.invalidated) {
      this.invalidated = true;
      this._onInvalidateCallbacks.forEach((fn) => {
        try {
          fn(this);
        } catch (e) {
          console.error(e);
        }
      });
    }
  }

  onInvalidate(fn) {
    this._onInvalidateCallbacks.push(fn);
  }
  onStop(fn) {
    this._onStopCallbacks.push(fn);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this._cursorCache.clear();
    this._onStopCallbacks.forEach((fn) => {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    });
  }

  /** Rerun once if invalidated (no‐op if running) */
  async flush() {
    if (this._running) return;
    if (this.invalidated) {
      await this._run();
    }
  }

  /** Force an immediate re‐run */
  async run() {
    this.invalidate();
    await this.flush();
  }
}

const AsyncTracker = {
  autorun: (f, opts) => new AsyncTrackerComputation(f, opts),
  currentComputation: () => asyncLocalStorage.getStore(),
  Dependency: AsyncTrackerDependency,
  nonreactive: async (f) =>
    // run f with no current computation
    asyncLocalStorage.run(null, () => f()),
};

const ReactiveVarAsync = function (initialValue, equalsFunc) {
  if (!(this instanceof ReactiveVarAsync)) {
    return new ReactiveVarAsync(initialValue, equalsFunc);
  }
  this.curValue = initialValue;
  this.equalsFunc = equalsFunc;
  this.dep = new AsyncTracker.Dependency();
};

ReactiveVarAsync._isEqual = function (a, b) {
  if (a !== b) return false;
  return !a || ['number', 'boolean', 'string'].includes(typeof a);
};

ReactiveVarAsync.prototype.get = function () {
  this.dep.depend();
  return this.curValue;
};

ReactiveVarAsync.prototype.set = function (newValue) {
  const oldValue = this.curValue;
  const equals = this.equalsFunc || ReactiveVarAsync._isEqual;
  if (equals(oldValue, newValue)) return;
  this.curValue = newValue;
  this.dep.changed();
};

ReactiveVarAsync.prototype.toString = function () {
  return 'ReactiveVarAsync{' + this.get() + '}';
};

ReactiveVarAsync.prototype._numListeners = function () {
  return this.dep._dependents.size;
};

export { AsyncTracker, ReactiveVarAsync };
