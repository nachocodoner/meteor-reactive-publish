import { AsyncTracker } from './AsyncTracker.js';
import { ReactiveVarAsync } from './ReactiveVarAsync.js';
import { Meteor } from 'meteor/meteor';

export class ComputedField {
  constructor(func, equalsFunc, dontStop) {
    if (typeof equalsFunc === 'boolean') {
      dontStop = !!equalsFunc;
      equalsFunc = null;
    }

    let handle = null;
    let lastValue = null; // ReactiveVarAsync once initialized
    let lastResolvedValue = undefined; // For toString()

    // ————————————————————————————————————————————————————————————————
    // Build an autorun starter that ALWAYS uses AsyncTracker.autorun,
    // but preserves Blaze view/template context when present.
    // ————————————————————————————————————————————————————————————————
    const currentView =
      Package.blaze && Package.blaze.Blaze && Package.blaze.Blaze.currentView;

    const wrapInBlazeContext = (f) => {
      if (!currentView) return f;

      // capture current template instance func (so helpers still work)
      const templateInstanceFunc =
        Package.blaze.Blaze.Template._currentTemplateInstanceFunc;

      return async (c) => {
        return Package.blaze.Blaze._withCurrentView(currentView, async () => {
          return Package.blaze.Blaze.Template._withTemplateInstanceFunc(
            templateInstanceFunc,
            async () => f.call(currentView, c)
          );
        });
      };
    };

    const startAutorun = async () => {
      if (handle) return handle; // already running

      const runner = wrapInBlazeContext(async (computation) => {
        // Compute the value (may await)
        const value = await func();

        if (!lastValue) {
          lastValue = new ReactiveVarAsync(value, equalsFunc);
          lastResolvedValue = value;
        } else {
          await lastValue.set(value);
          lastResolvedValue = value;
        }

        // If nobody depends on this field, stop (unless dontStop)
        Meteor.defer(() => {
          if (!dontStop && lastValue && !lastValue.dep.hasDependents()) {
            // stop is async; we intentionally don't await inside defer
            getter.stop();
          }
        });
      });

      handle = AsyncTracker.autorun(runner);

      // Normalize stop behavior across environments
      if (handle.onStop) {
        handle.onStop(() => {
          handle = null;
        });
      } else {
        const originalStop = handle.stop;
        handle.stop = async function () {
          if (handle) {
            await originalStop.call(handle);
          }
          handle = null;
        };
      }

      // If we were created inside another autorun (Blaze or AsyncTracker),
      // it may auto-stop on parent; our onStop handler above will null it.
      return handle;
    };

    // ————————————————————————————————————————————————————————————————
    // Public getter (async as you had it)
    // ————————————————————————————————————————————————————————————————
    const getter = async function () {
      // Capture the outer autorun's computation BEFORE any await
      const callerComp = AsyncTracker.currentComputation();

      // Ensure our internal autorun is up to date (may start it; may await)
      await getter.flush();

      // Cold start: initialize the value once
      if (!lastValue) {
        const value = await func();
        lastValue = new ReactiveVarAsync(value, equalsFunc);
        lastResolvedValue = value;
        // Establish the dependency for the caller on first read
        return AsyncTracker.runWith(callerComp, () => lastValue.get());
      }

      // Re-enter the caller's computation JUST for the dependency-establishing read.
      // This fixes client context loss across awaits.
      return AsyncTracker.runWith(callerComp, () => lastValue.get());
    };

    // Make `getter instanceof ComputedField` true
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(getter, this.constructor.prototype);
    } else {
      getter.__proto__ = this.constructor.prototype;
    }

    getter.toString = function () {
      return `ComputedField{${lastResolvedValue}}`;
    };

    getter.apply = async () => getter();
    getter.call = async () => getter();

    getter.stop = async function () {
      if (!handle) return null;
      const h = handle;
      handle = null;
      await h.stop?.();
      return null;
    };

    getter._isRunning = () => !!handle;

    getter.flush = async () => {
      // Don't capture reactivity while flushing
      await AsyncTracker.nonreactive(async () => {
        if (!handle) {
          await startAutorun();
        } else {
          await handle.flush?.();
        }
      });
    };

    return getter;
  }
}
