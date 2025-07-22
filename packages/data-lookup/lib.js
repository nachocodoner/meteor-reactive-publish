import { AsyncTracker, ReactiveVarAsync } from 'meteor/server-autorun';

export class ComputedField {
  constructor(func, equalsFunc, dontStop) {
    if (typeof equalsFunc === 'boolean') {
      dontStop = equalsFunc;
      equalsFunc = null;
    }

    let handle = null;
    let lastValue = null;

    // TODO: Provide an option to prevent using view's autorun.
    //       One can wrap code with Blaze._withCurrentView(null, code) to prevent using view's autorun for now.
    let autorun;
    const currentView =
      Package.blaze && Package.blaze.Blaze && Package.blaze.Blaze.currentView;
    if (currentView) {
      if (currentView._isInRender) {
        // Inside render we cannot use currentView.autorun directly, so we use our own version of it.
        // This allows computed fields to be created inside Blaze template helpers, which are called
        // the first time inside render. While currentView.autorun is disallowed inside render because
        // autorun would be recreated for reach re-render, this is exactly what computed field does
        // anyway so it is OK for use to use autorun in this way.
        autorun = function (f) {
          const templateInstanceFunc =
            Package.blaze.Blaze.Template._currentTemplateInstanceFunc;

          const comp = AsyncTracker.autorun(async (c) => {
            await Package.blaze.Blaze._withCurrentView(
              currentView,
              async () => {
                await Package.blaze.Blaze.Template._withTemplateInstanceFunc(
                  templateInstanceFunc,
                  async () => {
                    await f.call(currentView, c);
                  }
                );
              }
            );
          });

          const stopComputation = () => {
            comp.stop();
          };
          currentView.onViewDestroyed(stopComputation);
          comp.onStop(() => {
            currentView.removeViewDestroyedListener(stopComputation);
          });

          return comp;
        };
      } else {
        autorun = async (f) => {
          return currentView.autorun(f);
        };
      }
    } else {
      autorun = AsyncTracker.autorun;
    }

    const startAutorun = async function () {
      handle = await autorun(async function (computation) {
        const value = await func();
        if (!lastValue) {
          lastValue = new ReactiveVarAsync(value, equalsFunc);
          // Initialize lastResolvedValue with the initial value
          lastResolvedValue = value;
        } else {
          lastValue.set(value);
          // Update lastResolvedValue when the value changes
          lastResolvedValue = value;
        }

        if (!dontStop) {
          // Use AsyncTracker.nonreactive instead of Tracker.afterFlush
          await AsyncTracker.nonreactive(async function () {
            // If there are no dependents anymore, stop the autorun. We will run
            // it again in the getter's flush call if needed.
            if (!lastValue.dep.hasDependents()) {
              await getter.stop();
            }
          });
        }
      });

      // If something stops our autorun from the outside, we want to know that and update internal state accordingly.
      // This means that if computed field was created inside an autorun, and that autorun is invalided our autorun is
      // stopped. But then computed field might be still around and it might be asked again for the value. We want to
      // restart our autorun in that case. Instead of trying to recompute the stopped autorun.
      if (handle.onStop) {
        handle.onStop(() => {
          handle = null;
        });
      } else {
        // XXX COMPAT WITH METEOR 1.1.0
        const originalStop = handle.stop;
        handle.stop = async function () {
          if (handle) {
            await originalStop.call(handle);
          }
          handle = null;
        };
      }
    };

    startAutorun();

    // Store the last resolved value for toString
    let lastResolvedValue = undefined;

    const getter = async function () {
      // We always flush so that you get the most recent value. This is a noop if autorun was not invalidated.
      await getter.flush();

      const value = lastValue.get();
      // Store the resolved value for toString
      lastResolvedValue = value;

      return lastResolvedValue;
    };

    // We mingle the prototype so that getter instanceof ComputedField is true.
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(getter, this.constructor.prototype);
    } else {
      getter.__proto__ = this.constructor.prototype;
    }

    getter.toString = function () {
      return `ComputedField{${lastResolvedValue}}`;
    };

    getter.apply = async () => {
      return getter();
    };

    getter.call = async () => {
      return getter();
    };

    // If this autorun is nested in the outside autorun it gets stopped automatically when the outside autorun gets
    // invalidated, so no need to call destroy. But otherwise you should call destroy when the field is not needed anymore.
    getter.stop = async function () {
      if (handle != null) {
        await handle.stop();
      }
      return (handle = null);
    };

    // For tests.
    getter._isRunning = () => {
      return !!handle;
    };

    // Sometimes you want to force recomputation of the new value before the global Tracker flush is done.
    // This is a noop if autorun was not invalidated.
    getter.flush = async () => {
      await AsyncTracker.nonreactive(async function () {
        if (handle) {
          await handle.flush();
        } else {
          // If there is no autorun, create it now. This will do initial recomputation as well. If there
          // will be no dependents after the global flush, autorun will stop (again).
          await startAutorun();
        }
      });
    };

    return getter;
  }
}

export class DataLookup {
  static async lookup(obj, path) {
    if (typeof path === 'string') {
      path = path.split('.');
    }

    if (typeof obj === 'function') {
      obj = await obj();
    }

    if (!Array.isArray(path)) {
      return obj;
    }

    while (path.length > 0) {
      const segment = path.shift();

      if (
        obj &&
        typeof obj === 'object' &&
        Object.prototype.hasOwnProperty.call(obj, segment)
      ) {
        obj = obj[segment];

        if (typeof obj === 'function') {
          obj = await obj();
        }
      } else {
        return undefined;
      }
    }

    return obj;
  }

  static async get(obj, path, equalsFunc) {
    if (!AsyncTracker.currentComputation()) {
      return this.lookup(obj, path);
    }

    const result = new ComputedField(async () => {
      return this.lookup(obj, path);
    }, equalsFunc);

    return result();
  }
}
