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
    }
    return true;
  }

  changed() {
    for (const comp of this._dependents.values()) {
      Meteor.defer(() => comp.invalidate());
    }
  }

  hasDependents() {
    for (var id in this._dependents) return true;
    return false;
  }
}

var nextId = 1;

class AsyncTrackerComputation {
  constructor(asyncFunc, options = {}) {
    this._id = nextId++;

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

    this._run();
  }

  beforeRun(fn) {
    if (typeof fn === 'function') {
      this._beforeRunCallbacks.push(fn);
    }
  }

  afterRun(fn) {
    if (typeof fn === 'function') {
      this._afterRunCallbacks.push(fn);
    }
  }

  async _run() {
    if (this.stopped) return;

    this._beforeRunCallbacks.forEach((fn) => {
      try {
        fn(this);
      } catch (e) {
        console.error('beforeRun error', e);
      }
    });

    this.invalidated = false;
    this._running = true;

    try {
      await asyncLocalStorage.run(this, () => this.asyncFunc(this));
    } catch (err) {
      if (this.options.onError) this.options.onError(err);
      else console.error('AsyncTracker computation error:', err);
    } finally {
      this._running = false;
    }

    this._afterRunCallbacks.forEach((fn) => {
      try {
        fn(this);
      } catch (e) {
        console.error('afterRun error', e);
      }
    });

    if (this.invalidated && !this.stopped) {
      await this._run();
    }
  }

  async invalidate() {
    if (this.stopped) return;
    this.invalidated = true;
    this._onInvalidateCallbacks.forEach((fn) => fn(this));
    if (!this._running) {
      await this._run();
    }
  }

  onInvalidate(fn) {
    if (typeof fn === 'function') {
      this._onInvalidateCallbacks.push(fn);
    }
  }

  onStop(fn) {
    if (typeof fn === 'function') {
      this._onStopCallbacks.push(fn);
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this._cursorCache.clear();
    this._onStopCallbacks.forEach((fn) => fn(this));
  }

  async flush() {
    if (this._running) return;

    await this._run();
  }

  async run() {
    await this.invalidate();
    await this.flush();
  }
}

const AsyncTracker = {
  autorun: (f, opts) => new AsyncTrackerComputation(f, opts),
  currentComputation: () => asyncLocalStorage.getStore(),
  Dependency: AsyncTrackerDependency,
};

export { AsyncTracker };
