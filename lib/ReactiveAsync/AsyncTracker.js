// AsyncTracker.js

// --- Async context adapter: Node ALS on server, minimal shim on client ---
const isServer = Meteor.isServer;

let asyncContext;

if (isServer) {
  // Server: real AsyncLocalStorage
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require('async_hooks');
  const als = new AsyncLocalStorage();

  asyncContext = {
    run(store, fn) {
      // Works with sync or async fns; ALS keeps context across awaits
      return als.run(store, fn);
    },
    getStore() {
      return als.getStore();
    },
  };
} else {
  // Client: minimal continuation-local-storage shim
  // Propagates context through await/Promise.then/finally, setTimeout, queueMicrotask

  // Avoid double-patching if this file is reloaded (HMR, tests, etc.)
  const ALS_FLAG = '__alsPatched__';

  let _current = null;

  function getStore() {
    return _current;
  }
  function run(store, fn) {
    const prev = _current;
    _current = store;
    try {
      return fn();
    } finally {
      _current = prev;
    }
  }

  // Patch Promise.then/finally once
  if (!Promise.prototype[ALS_FLAG]) {
    const _then = Promise.prototype.then;
    const _finally = Promise.prototype.finally;

    const wrap = (cb, ctx) =>
      typeof cb === 'function'
        ? function (...args) {
            const prev = _current;
            _current = ctx;
            try {
              return cb.apply(this, args);
            } finally {
              _current = prev;
            }
          }
        : cb;

    Promise.prototype.then = function (onFulfilled, onRejected) {
      const ctx = _current;
      return _then.call(this, wrap(onFulfilled, ctx), wrap(onRejected, ctx));
    };

    Promise.prototype.finally = function (onFinally) {
      const ctx = _current;
      return _finally.call(this, wrap(onFinally, ctx));
    };

    Object.defineProperty(Promise.prototype, ALS_FLAG, { value: true });
  }

  // Patch setTimeout once
  if (typeof window !== 'undefined' && !window[ALS_FLAG]) {
    const _setTimeout = window.setTimeout;
    window.setTimeout = (fn, ...rest) => {
      const ctx = _current;
      return _setTimeout(() => run(ctx, fn), ...rest);
    };

    if (window.queueMicrotask) {
      const _qmt = window.queueMicrotask;
      window.queueMicrotask = (fn) => {
        const ctx = _current;
        return _qmt(() => run(ctx, fn));
      };
    }

    Object.defineProperty(window, ALS_FLAG, { value: true });
  }

  asyncContext = { run, getStore };
}

// --- The rest of your implementation (unchanged API), wired to asyncContext ---

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
      await asyncContext.run(this, () => this.asyncFunc(this));
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
    const computation = new AsyncTrackerComputation(f, { ...options, parent });

    if (parent) {
      parent.onInvalidate(() => {
        computation.stop();
      });
    }

    return computation;
  }

  static currentComputation() {
    return asyncContext.getStore();
  }

  static Dependency = AsyncTrackerDependency;

  static async nonreactive(f) {
    // run f with no current computation
    return asyncContext.run(null, () => f());
  }
}

export { AsyncTracker };
