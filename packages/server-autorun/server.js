import { Tracker } from 'meteor/tracker';
import { AsyncLocalStorage } from 'async_hooks';

// --- Tracker Context via AsyncLocalStorage ---
const trackerStorage = new AsyncLocalStorage();

function getTrackerInstance() {
  let instance = trackerStorage.getStore();
  if (!instance) {
    instance = new TrackerInstance();
    trackerStorage.enterWith(instance);
  }
  return instance;
}

class TrackerInstance {
  constructor() {
    this.active = false;
    this.currentComputation = null;
    this.pendingComputations = [];
    // Our flush callback queue (for afterFlush callbacks).
    this.flushCallbacks = [];
    // New: a promise chain that serializes flush cycles.
    this.flushQueue = Promise.resolve();
    this.willFlush = false;
    this.inFlush = false;
    this.inCompute = false;
  }

  setCurrentComputation(comp) {
    this.currentComputation = comp;
    this.active = !!comp;
  }

  _deferAndTransfer(func) {
    Meteor.defer(() => {
      trackerStorage.run(this, func);
    });
  }

  // Modified requireFlush returns a promise that resolves when the flush cycle finishes.
  requireFlush() {
    if (this.willFlush) return this.flushQueue;
    this.willFlush = true;
    this.flushQueue = this.flushQueue.then(() => {
      return new Promise((resolve) => {
        this._runFlush(resolve);
      });
    });
    return this.flushQueue;
  }

  // _runFlush is modified to accept a callback and then call it when finished.
  _runFlush(callback) {
    // Do not allow flush if we're inside a computation.
    if (this.inCompute) {
      throw new Error("Can't call Tracker.flush inside an autorun");
    }
    if (this.inFlush) {
      callback();
      return;
    }
    this.inFlush = true;
    try {
      // Process any pending computations.
      while (this.pendingComputations.length) {
        const comp = this.pendingComputations.shift();
        comp._recomputeSync();
        if (comp._needsRecompute()) {
          this.pendingComputations.unshift(comp);
        }
      }
      // Then process all flush callbacks (FIFO order).
      const cbs = this.flushCallbacks.splice(0, this.flushCallbacks.length);
      cbs.forEach((cb) => {
        try {
          cb();
        } catch (e) {
          console.error('Exception in Tracker afterFlush callback:', e);
        }
      });
    } finally {
      this.inFlush = false;
      this.willFlush = false;
      if (this.pendingComputations.length || this.flushCallbacks.length) {
        Meteor.setTimeout(() => this.requireFlush(), 10);
      }
    }
    callback();
  }
}

const privateObject = {}; // Restricts direct instantiation of Tracker.Computation

// --- Tracker API Methods ---
Tracker.flush = function (options) {
  // Return the promise that resolves when the flush cycle finishes.
  return getTrackerInstance().requireFlush();
};

Tracker.autorun = function (func, options) {
  if (typeof func !== 'function') {
    throw new Error('Tracker.autorun requires a function argument');
  }
  const comp = new Tracker.Computation(
    func,
    Tracker.currentComputation,
    options && options.onError,
    privateObject
  );
  if (Tracker.active) {
    Tracker.onInvalidate(() => comp.stop());
  }
  return comp;
};

Tracker.nonreactive = function (f) {
  const inst = getTrackerInstance();
  const previous = inst.currentComputation;
  inst.setCurrentComputation(null);
  try {
    return f();
  } finally {
    inst.setCurrentComputation(previous);
  }
};

Tracker.afterFlush = function (f) {
  const inst = getTrackerInstance();
  inst.flushCallbacks.push(f);
  inst.requireFlush();
};

Tracker.onInvalidate = function (f) {
  if (!Tracker.active) {
    throw new Error('Tracker.onInvalidate requires a currentComputation');
  }
  Tracker.currentComputation.onInvalidate(f);
};

Object.defineProperties(Tracker, {
  currentComputation: {
    get() {
      return getTrackerInstance().currentComputation;
    },
  },
  active: {
    get() {
      return getTrackerInstance().active;
    },
  },
});

// --- Tracker.Computation Implementation ---
Tracker.Computation = class Computation {
  constructor(func, _parent, _onError, _private) {
    if (_private !== privateObject) {
      throw new Error(
        'Tracker.Computation constructor is private; use Tracker.autorun'
      );
    }
    this.stopped = false;
    this.invalidated = false;
    this.firstRun = true;
    this._id = Date.now(); // or use an incrementing id
    this._onInvalidateCallbacks = [];
    this._onStopCallbacks = [];
    this._beforeRunCallbacks = [];
    this._afterRunCallbacks = [];
    this._recomputing = false;
    this._trackerInstance = getTrackerInstance();

    const onException = (error) => {
      if (this.firstRun) throw error;
      if (_onError) _onError(error);
      else console.error('Exception from Tracker recompute:', error);
    };

    // Bind the user function to Meteor's environment.
    this._func = Meteor.bindEnvironment(func, onException, this);

    let errored = true;
    try {
      // Synchronously perform the initial computation so dependencies register.
      this._computeSync();
      errored = false;
    } finally {
      this.firstRun = false;
      if (errored) this.stop();
    }
  }

  onInvalidate(f) {
    if (typeof f !== 'function')
      throw new Error('onInvalidate requires a function');
    if (this.invalidated) {
      Tracker.nonreactive(() => f(this));
    } else {
      this._onInvalidateCallbacks.push(f);
    }
  }

  onStop(f) {
    if (typeof f !== 'function') throw new Error('onStop requires a function');
    if (this.stopped) {
      Tracker.nonreactive(() => f(this));
    } else {
      this._onStopCallbacks.push(f);
    }
  }

  beforeRun(f) {
    if (typeof f !== 'function')
      throw new Error('beforeRun requires a function');
    this._beforeRunCallbacks.push(f);
  }

  afterRun(f) {
    if (typeof f !== 'function')
      throw new Error('afterRun requires a function');
    this._afterRunCallbacks.push(f);
  }

  invalidate() {
    if (!this.invalidated) {
      if (!this._recomputing && !this.stopped) {
        this._trackerInstance.requireFlush();
        this._trackerInstance.pendingComputations.push(this);
      }
      this.invalidated = true;
      for (const callback of this._onInvalidateCallbacks) {
        Tracker.nonreactive(() => callback(this));
      }
      this._onInvalidateCallbacks = [];
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.invalidate();
    while (this._onStopCallbacks.length) {
      const callback = this._onStopCallbacks.shift();
      Tracker.nonreactive(() => callback(this));
    }
  }

  // Synchronous run-inside helper.
  _runInsideSync(func) {
    const inst = this._trackerInstance;
    const previous = inst.currentComputation;
    inst.setCurrentComputation(this);
    const prevInCompute = inst.inCompute;
    inst.inCompute = true;
    try {
      return func(this);
    } finally {
      inst.setCurrentComputation(previous);
      inst.inCompute = prevInCompute;
    }
  }

  _computeSync() {
    this.invalidated = false;
    return this._runInsideSync(() => {
      while (this._beforeRunCallbacks.length) {
        const callback = this._beforeRunCallbacks.shift();
        Tracker.nonreactive(() => callback(this));
      }
      const result = this._func.call(null, this);
      while (this._afterRunCallbacks.length) {
        const callback = this._afterRunCallbacks.shift();
        Tracker.nonreactive(() => callback(this));
      }
      return result;
    });
  }

  _needsRecompute() {
    return this.invalidated && !this.stopped;
  }

  _recomputeSync() {
    if (this._recomputing) throw new Error('Already recomputing');
    this._recomputing = true;
    try {
      if (this._needsRecompute()) {
        this._computeSync();
      }
    } finally {
      this._recomputing = false;
    }
  }

  flush() {
    if (this._recomputing) return;
    return this._recomputeSync();
  }

  run() {
    this.invalidate();
    return this.flush();
  }
};

Tracker.Dependency = class Dependency {
  constructor() {
    this._dependentsById = {};
  }
  depend(computation) {
    if (!computation) {
      if (!Tracker.active) return false;
      computation = Tracker.currentComputation;
    }
    const id = computation._id;
    if (!(id in this._dependentsById)) {
      this._dependentsById[id] = computation;
      computation.onInvalidate(() => {
        delete this._dependentsById[id];
      });
      return true;
    }
    return false;
  }
  changed() {
    for (const id in this._dependentsById) {
      if (Object.prototype.hasOwnProperty.call(this._dependentsById, id)) {
        this._dependentsById[id].invalidate();
      }
    }
  }
  hasDependents() {
    return Object.keys(this._dependentsById).length > 0;
  }
};

export { Tracker };
