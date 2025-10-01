// AsyncTracker.js
const { AsyncLocalStorage } = Meteor.isServer
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('async_hooks')
  : {
      AsyncLocalStorage: class {},
    }; // TODO: replace with something else for client-side support
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

  async changed() {
    // Invalidate all dependents
    const comps = Array.from(this._dependents.values());
    try {
      for await (const comp of comps) {
        await comp.run();
      }
    } catch (e) {
      console.error(e);
    }
  }

  changedSync() {
    // Invalidate all dependents
    const comps = Array.from(this._dependents.values());
    try {
      for (const comp of comps) {
        Meteor.defer(() => comp.run());
      }
    } catch (e) {
      console.error(e);
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
    this._parent = options.parent || AsyncTracker.currentComputation();

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

class AsyncTracker {
  static autorun(f, options = {}) {
    if (typeof f !== 'function') {
      throw new Error('AsyncTracker.autorun requires a function argument');
    }

    const parent = AsyncTracker.currentComputation();
    const computation = new AsyncTrackerComputation(f, {
      ...options,
      parent,
    });

    if (parent) {
      parent.onInvalidate(() => {
        computation.stop();
      });
    }

    return computation;
  }

  static currentComputation() {
    return asyncLocalStorage.getStore();
  }

  static Dependency = AsyncTrackerDependency;

  static async nonreactive(f) {
    // run f with no current computation
    return asyncLocalStorage.run(null, () => f());
  }
}

export { AsyncTracker, AsyncTrackerComputation, AsyncTrackerDependency };
