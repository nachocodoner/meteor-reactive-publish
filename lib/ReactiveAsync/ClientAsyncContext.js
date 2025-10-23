// ClientAsyncContext.js
// Configurable, idempotent Continuation-Local Storage for browsers.
// Default patches ONLY Promises (safe start). Timers/rAF/events optional.

const SYM = {
  PROM: Symbol.for('cls.patched.promise'),
  GBL: Symbol.for('cls.patched.global'),
  EVT: Symbol.for('cls.patched.events'),
  API: Symbol.for('cls.api'),
};

// Define the functions we'll export
let run, getStore;

// If already installed, just use the existing API
if (globalThis[SYM.API]) {
  run = globalThis[SYM.API].run;
  getStore = globalThis[SYM.API].get;
  // Exit early
  return;
}

// Re-entrant stack (no single global leakage)
const ctxStack = [];
let ctxCurrent = null;

// Define the functions if not already defined
getStore = function () {
  return ctxCurrent;
};
run = function (ctx, fn) {
  ctxStack.push(ctxCurrent);
  ctxCurrent = ctx;
  try {
    return fn();
  } finally {
    ctxCurrent = ctxStack.pop();
  }
};
// Temporarily disable propagation inside fn (useful for interop)
function suspend(fn) {
  return run(null, fn);
}

function capture() {
  return ctxCurrent;
}
const wrapCb = (cb, ctx) =>
  typeof cb === 'function'
    ? function wrapped(...args) {
        return run(ctx, () => cb.apply(this, args));
      }
    : cb;

// Originals so we can uninstall
const orig = {
  then: null,
  catch: null,
  finally: null,
  queueMicrotask: null,
  setTimeout: null,
  clearTimeout: null,
  setInterval: null,
  clearInterval: null,
  raf: null,
  add: null,
  remove: null,
};
const WRAPS = new WeakMap(); // listener -> (EventTarget -> wrapped)

function installPromisePatches() {
  if (Promise.prototype[SYM.PROM]) return;
  orig.then = Promise.prototype.then;
  orig.catch = Promise.prototype.catch;
  orig.finally = Promise.prototype.finally;

  Promise.prototype.then = function (onFulfilled, onRejected) {
    const c = capture();
    return orig.then.call(this, wrapCb(onFulfilled, c), wrapCb(onRejected, c));
  };
  Promise.prototype.catch = function (onRejected) {
    const c = capture();
    return orig.catch.call(this, wrapCb(onRejected, c));
  };
  Promise.prototype.finally = function (onFinally) {
    const c = capture();
    return orig.finally.call(this, wrapCb(onFinally, c));
  };

  Object.defineProperty(Promise.prototype, SYM.PROM, { value: true });
}

function installGlobalPatches({ timers = false, raf = false } = {}) {
  if (globalThis[SYM.GBL]) return;
  if (typeof globalThis.queueMicrotask === 'function') {
    orig.queueMicrotask = globalThis.queueMicrotask.bind(globalThis);
    globalThis.queueMicrotask = (fn) =>
      orig.queueMicrotask(wrapCb(fn, capture()));
  } else {
    const resolved = Promise.resolve();
    globalThis.queueMicrotask = (fn) => resolved.then(wrapCb(fn, capture()));
  }
  if (timers) {
    orig.setTimeout = globalThis.setTimeout?.bind(globalThis);
    orig.clearTimeout = globalThis.clearTimeout?.bind(globalThis);
    orig.setInterval = globalThis.setInterval?.bind(globalThis);
    orig.clearInterval = globalThis.clearInterval?.bind(globalThis);
    if (orig.setTimeout)
      globalThis.setTimeout = (fn, d, ...r) =>
        orig.setTimeout(wrapCb(fn, capture()), d, ...r);
    if (orig.setInterval)
      globalThis.setInterval = (fn, d, ...r) =>
        orig.setInterval(wrapCb(fn, capture()), d, ...r);
  }
  if (raf && typeof globalThis.requestAnimationFrame === 'function') {
    orig.raf = globalThis.requestAnimationFrame.bind(globalThis);
    globalThis.requestAnimationFrame = (cb) =>
      orig.raf((ts) => run(capture(), () => cb(ts)));
  }
  Object.defineProperty(globalThis, SYM.GBL, { value: true });
}

function installEventPatches() {
  if (typeof EventTarget === 'undefined' || EventTarget.prototype[SYM.EVT])
    return;
  orig.add = EventTarget.prototype.addEventListener;
  orig.remove = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (typeof listener !== 'function')
      return orig.add.call(this, type, listener, options);
    let map = WRAPS.get(listener);
    if (!map) {
      map = new WeakMap();
      WRAPS.set(listener, map);
    }
    let wrapped = map.get(this);
    if (!wrapped) {
      wrapped = wrapCb(listener, capture());
      map.set(this, wrapped);
    }
    return orig.add.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function (
    type,
    listener,
    options
  ) {
    const wrapped =
      (typeof listener === 'function'
        ? WRAPS.get(listener)?.get(this)
        : null) || listener;
    return orig.remove.call(this, type, wrapped, options);
  };
  Object.defineProperty(EventTarget.prototype, SYM.EVT, { value: true });
}

function uninstall() {
  // Promises
  if (Promise.prototype[SYM.PROM]) {
    if (orig.then) Promise.prototype.then = orig.then;
    if (orig.catch) Promise.prototype.catch = orig.catch;
    if (orig.finally) Promise.prototype.finally = orig.finally;
    delete Promise.prototype[SYM.PROM];
  }
  // Global
  if (globalThis[SYM.GBL]) {
    if (orig.queueMicrotask) globalThis.queueMicrotask = orig.queueMicrotask;
    if (orig.setTimeout) globalThis.setTimeout = orig.setTimeout;
    if (orig.clearTimeout) globalThis.clearTimeout = orig.clearTimeout;
    if (orig.setInterval) globalThis.setInterval = orig.setInterval;
    if (orig.clearInterval) globalThis.clearInterval = orig.clearInterval;
    if (orig.raf) globalThis.requestAnimationFrame = orig.raf;
    delete globalThis[SYM.GBL];
  }
  // Events
  if (typeof EventTarget !== 'undefined' && EventTarget.prototype[SYM.EVT]) {
    if (orig.add) EventTarget.prototype.addEventListener = orig.add;
    if (orig.remove) EventTarget.prototype.removeEventListener = orig.remove;
    delete EventTarget.prototype[SYM.EVT];
  }
  WRAPS.clear();
}

function install(options = {}) {
  // options: { timers?: boolean, raf?: boolean, events?: boolean }
  installPromisePatches();
  installGlobalPatches(options);
  if (options.events) installEventPatches();
}

// expose API
globalThis[SYM.API] = { install, uninstall, run, get: getStore, suspend };
globalThis.__cls = globalThis[SYM.API]; // friendly alias

// Initialize with minimal patching (Promises only) by default
// This is the safest approach as recommended in the issue description
install(); // No options means only Promises are patched
