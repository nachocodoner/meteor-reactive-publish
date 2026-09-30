import { MongoConnection } from 'meteor/mongo/mongo_connection';
import { AsyncLocalStorage } from 'async_hooks';
import { AsyncTracker } from './ReactiveAsync/AsyncTracker';
import { LocalCollection } from 'meteor/minimongo';

const publishContextStore = new AsyncLocalStorage();

function getCollectionNames(result) {
  if (result && Array.isArray(result)) {
    // Filter only items that are non-null objects with a callable _getCollectionName method.
    return result
      .filter(
        (cursor) =>
          cursor &&
          typeof cursor === 'object' &&
          typeof cursor._getCollectionName === 'function'
      )
      .map((cursor) => cursor._getCollectionName());
  } else if (
    result &&
    typeof result === 'object' &&
    typeof result._getCollectionName === 'function'
  ) {
    return [result._getCollectionName()];
  } else {
    return [];
  }
}

function checkNames(publish, allCollectionNames, id, collectionNames) {
  // allCollectionNames may be an object where keys are computation IDs and values are arrays.
  for (const [compId, names] of Object.entries(allCollectionNames)) {
    if (compId !== id) {
      for (const collectionName of names) {
        if (collectionNames.includes(collectionName)) {
          publish.error(
            new Error(`Multiple cursors for collection '${collectionName}'`)
          );
          return false;
        }
      }
    }
  }
  return true;
}

function iterateObjectOrMapKeys(objectOrMap, fn) {
  if (objectOrMap instanceof Map) {
    for (const key of objectOrMap.keys()) {
      fn(key);
    }
  } else {
    for (const key in objectOrMap) {
      if (Object.prototype.hasOwnProperty.call(objectOrMap, key)) {
        fn(key);
      }
    }
  }
}

function union(...arrays) {
  // Flatten all arrays and return unique values.
  return Array.from(new Set(arrays.flat()));
}

function difference(array, ...others) {
  const othersUnion = new Set(others.flat());
  return array.filter((item) => !othersUnion.has(item));
}

// A simple implementation of Meteor._ensure if not already defined.
// It ensures that obj[key][collectionName] exists as an object.
Meteor._ensure =
  Meteor._ensure ||
  function (obj, key, collectionName) {
    if (!obj[key]) {
      obj[key] = {};
    }
    if (!obj[key][collectionName]) {
      obj[key][collectionName] = {};
    }
    return obj[key][collectionName];
  };

// --- Wrap Callbacks ---
function observeInComputation(observe, callbacks) {
  const computation = AsyncTracker.currentComputation();
  if (!computation) return observe(callbacks);

  // Register before starting the observer: stopping can happen while its
  // initial results are still being delivered and before its handle resolves.
  if (!computation._publicationObservers) {
    const observers = (computation._publicationObservers = new Set());
    const stopObservers = () => {
      for (const observer of observers) {
        observer.active = false;
        observer.handle?.stop();
      }
      observers.clear();
    };
    // Ordinary AsyncTracker users own their explicit observers. Publications
    // replace those observers at the next run. Let the current run finish even
    // if a dependency changes while Mongo is still sending its initial results.
    if (computation._publication) computation.beforeRun(stopObservers);
    computation.onStop(stopObservers);
  }
  const observers = computation._publicationObservers;
  const observer = { active: !computation.stopped };
  observers.add(observer);
  const wrapped = { ...callbacks };
  for (const name of [
    'added',
    'changed',
    'removed',
    'addedBefore',
    'movedBefore',
  ]) {
    const callback = callbacks[name];
    if (typeof callback !== 'function') continue;
    wrapped[name] = function (...args) {
      if (!observer.active || computation.stopped) return;
      // A shared Mongo multiplexer can invoke this callback in another
      // subscriber's async context. Always restore the observer's owner.
      return AsyncTracker.runWith(computation, () =>
        callback.apply(this, args)
      );
    };
  }
  const attach = (handle) => {
    observer.handle = handle;
    const stop = handle.stop;
    handle.stop = function (...args) {
      observer.active = false;
      observers.delete(observer);
      return stop.apply(this, args);
    };
    if (!observer.active || computation.stopped) handle.stop();
    return handle;
  };
  const failed = (error) => {
    observer.active = false;
    observers.delete(observer);
    throw error;
  };
  try {
    const result = observe(wrapped);
    return result?.then ? result.then(attach, failed) : attach(result);
  } catch (error) {
    return failed(error);
  }
}

const originalObserveChanges = MongoConnection.prototype._observeChanges;
MongoConnection.prototype._observeChanges = function (
  cursorDescription,
  ordered,
  callbacks,
  nonMutatingCallbacks
) {
  return observeInComputation(
    (wrapped) =>
      originalObserveChanges.call(
        this,
        cursorDescription,
        ordered,
        wrapped,
        nonMutatingCallbacks
      ),
    callbacks
  );
};

// Server-local collections use Minimongo rather than MongoConnection. Keep
// their synchronous observeChanges API and its async counterpart working.
const originalLocalObserveChanges =
  LocalCollection.Cursor.prototype.observeChanges;
LocalCollection.Cursor.prototype.observeChanges = function (
  callbacks,
  ...args
) {
  return observeInComputation(
    (wrapped) => originalLocalObserveChanges.call(this, wrapped, ...args),
    callbacks
  );
};

export const wrapPublish = (newPublishArguments) => {
  // DDP Server constructor.
  const Server = Object.getPrototypeOf(Meteor.server).constructor;

  // A helper function that mimics underscore's isObject (returns true for objects and functions)
  const isObject = (val) =>
    val !== null && (typeof val === 'object' || typeof val === 'function');

  // Save the original publish function and override it.
  const originalPublish = Server.prototype.publish;
  Server.prototype.publish = function (...args) {
    // If the first argument is an object, let the original publish handle it.
    if (isObject(args[0])) {
      return originalPublish.apply(this, args);
    }

    // Otherwise, transform the arguments and then call the original publish function.
    const newArgs = newPublishArguments.apply(this, args);
    return originalPublish.apply(this, newArgs);
  };

  // Similarly, wrap Meteor.publish.
  const originalMeteorPublish = Meteor.publish;
  Meteor.publish = function (...args) {
    if (isObject(args[0])) {
      return originalMeteorPublish.apply(this, args);
    }
    const newArgs = newPublishArguments.apply(this, args);
    return originalMeteorPublish.apply(this, newArgs);
  };
};

// --- The extendPublish function ---
// This function takes a publication name, a publish function, and options,
// and returns an array [name, newPublishFunction, options] where newPublishFunction
// wraps the original publish function with additional behavior.
export const extendPublish = (name, publishFunction, options) => {
  // Declare the new publish function as async so that it can await asynchronous work.
  async function newPublishFunction(...args) {
    const publish = this;

    // These objects hold state per computation.
    const oldDocuments = {};
    const documents = {};
    const allCollectionNames = {};

    // If in test mode, expose these objects for testing
    if (Meteor.isTest || Meteor.isPackageTest) {
      // Store references to the actual documents and oldDocuments objects
      global._testDocumentsRef = documents;
      global._testOldDocumentsRef = oldDocuments;
      global._testAllCollectionNamesRef = allCollectionNames;
    }

    // Provide a helper to get the current computation.
    // In Meteor 3, we use AsyncTracker instead of Tracker.
    // so we simply return null if no active computation.
    publish._currentComputation = function () {
      const currentComputation = AsyncTracker.currentComputation();
      if (currentComputation) {
        return currentComputation;
      } else {
        // Retrieve the stored computation from AsyncLocalStorage.
        const store = publishContextStore.getStore();
        return store && store.publishComputation;
      }
    };

    // Install callbacks so that the appropriate publish methods (like "added",
    // "changed", and "removed") will be called at the right times.
    publish._installCallbacks = function () {
      const computation = publish._currentComputation();
      if (!computation || computation.stopped) return;

      if (!computation._publishOnStopSet) {
        computation._publishOnStopSet = true;
        computation.onStop(() => {
          delete oldDocuments[computation._id];
          delete documents[computation._id];
        });
      }

      if (!computation._publishAfterRunSet) {
        computation._publishAfterRunSet = true;

        computation.beforeRun(() => {
          oldDocuments[computation._id] = documents[computation._id] || {};
          documents[computation._id] = {};
        });

        computation.afterRun(() => {
          if (computation.stopped) return;
          iterateObjectOrMapKeys(publish._documents, (collectionName) => {
            let currentlyPublishedDocumentIds;
            if (publish._documents instanceof Map) {
              currentlyPublishedDocumentIds = Array.from(
                publish._documents.get(collectionName) || []
              );
            } else {
              currentlyPublishedDocumentIds = Object.keys(
                publish._documents[collectionName] || {}
              );
            }
            const currentComputationAddedDocumentIds = Object.keys(
              (documents[computation._id] &&
                documents[computation._id][collectionName]) ||
                {}
            );
            const otherComputationsAddedDocumentsIds = union(
              ...Object.entries(documents)
                .filter(([compId]) => compId !== String(computation._id))
                .map(([, docs]) => Object.keys(docs[collectionName] || {}))
            );
            const otherComputationsPreviouslyAddedDocumentsIds = union(
              ...Object.entries(oldDocuments)
                .filter(([compId]) => compId !== String(computation._id))
                .map(([, docs]) => Object.keys(docs[collectionName] || {}))
            );
            const diffIds = difference(
              currentlyPublishedDocumentIds,
              currentComputationAddedDocumentIds,
              otherComputationsAddedDocumentsIds,
              otherComputationsPreviouslyAddedDocumentsIds
            );
            diffIds.forEach((id) => {
              publish.removed(collectionName, publish._idFilter.idParse(id));
            });
          });
        });
      }
    };

    const originalAdded = publish.added;
    publish.added = function (collectionName, id, fields) {
      const currentComputation = publish._currentComputation();
      if (currentComputation?.stopped) return;
      const stringId = publish._idFilter.idStringify(id);

      publish._installCallbacks();

      Meteor._ensure(documents, currentComputation?._id ?? '', collectionName)[
        stringId
      ] = true;

      // If the document is already published then call "changed" to send an update.
      if (
        (publish._documents instanceof Map &&
          publish._documents.get(collectionName) &&
          publish._documents.get(collectionName).has(stringId)) ||
        (publish._documents[collectionName] &&
          publish._documents[collectionName][stringId])
      ) {
        const oldFields = {};
        const sessionView =
          publish._session &&
          publish._session.getCollectionView(collectionName);
        const _documents = (sessionView && sessionView.documents) || {};
        let dataByKey;
        if (_documents instanceof Map) {
          dataByKey =
            (_documents.get(stringId) && _documents.get(stringId).dataByKey) ||
            {};
        } else {
          dataByKey =
            (_documents[stringId] && _documents[stringId].dataByKey) || {};
        }
        iterateObjectOrMapKeys(dataByKey, (field) => {
          oldFields[field] = undefined;
        });

        // Combine oldFields and new fields.
        publish.changed(collectionName, id, Object.assign(oldFields, fields));
      } else {
        originalAdded.call(publish, collectionName, id, fields);
      }
    };

    let ready = false;
    let readyRequested = false;
    let handlerRunning = true;
    const initialRuns = new Set();
    const originalReady = publish.ready;
    const maybeReady = () => {
      if (
        !ready &&
        readyRequested &&
        !handlerRunning &&
        !initialRuns.size &&
        (!publish._isDeactivated || !publish._isDeactivated())
      ) {
        ready = true;
        originalReady.call(publish);
      }
    };
    publish.ready = function () {
      publish._installCallbacks();
      readyRequested = true;
      maybeReady();
    };

    const handles = new Set();
    const trackHandle = (handle) => {
      if (handle.stopped) return;
      handles.add(handle);
      handle.onStop?.(() => handles.delete(handle));
    };
    publish.autorun = async function (runFunc) {
      // Reserve the initial run before autorun starts executing synchronously.
      // Nested autoruns add their own reservation before their parent finishes.
      const initialRun = {};
      initialRuns.add(initialRun);
      let initialized = false;
      const handle = AsyncTracker.autorun(async function (computation) {
        computation._publication = publish;
        if (!initialized) {
          initialized = true;
          computation.onInvalidate(() => {
            delete allCollectionNames[computation._id];
          });
          computation.onStop(() => {
            delete allCollectionNames[computation._id];
            initialRuns.delete(initialRun);
            maybeReady();
          });
        }
        await publishContextStore.run(
          {
            name,
            publishComputation: computation,
          },
          async () => {
            let result;
            try {
              result = runFunc.call(publish, computation);
              result =
                result && typeof result.then === 'function'
                  ? await result
                  : result;
            } catch (error) {
              publish.error(error);
              computation.stop();
              return;
            }

            if (computation.stopped) return;

            const collectionNames = getCollectionNames(result);
            allCollectionNames[computation._id] = collectionNames;
            if (
              !checkNames(
                publish,
                allCollectionNames,
                String(computation._id),
                collectionNames
              )
            ) {
              computation.stop();
              return;
            }

            if (
              result &&
              typeof result.stop === 'function' &&
              typeof result.onInvalidate === 'function'
            ) {
              if (publish._isDeactivated && publish._isDeactivated()) {
                result.stop();
              } else {
                trackHandle(result);
              }
            } else {
              if (!publish._isDeactivated || !publish._isDeactivated()) {
                if (publish._publishHandlerResult) {
                  await publish._publishHandlerResult(result);
                }
              }
            }
          }
        );
        initialRuns.delete(initialRun);
        maybeReady();
      });

      if (publish._isDeactivated && publish._isDeactivated()) {
        await handle.stop();
      } else {
        trackHandle(handle);
      }
      return handle;
    };

    publish.onStop(async function () {
      for (const handle of handles) {
        if (handle && typeof handle.stop === 'function') {
          await handle.stop();
        }
      }
      handles.clear();
      for (const state of [documents, oldDocuments, allCollectionNames]) {
        for (const key of Object.keys(state)) delete state[key];
      }
    });

    // Call the original publish function. In an async publish, await the result.
    const result = await publishFunction.apply(publish, args);
    const collectionNames = getCollectionNames(result);
    allCollectionNames[''] = collectionNames;
    if (!checkNames(publish, allCollectionNames, '', collectionNames)) {
      return;
    }
    if (
      result &&
      typeof result.stop === 'function' &&
      typeof result.onInvalidate === 'function'
    ) {
      if (publish._isDeactivated && publish._isDeactivated()) {
        result.stop();
      } else {
        trackHandle(result);
      }
    } else if (result && (result._publishCursor || Array.isArray(result))) {
      // Include normally returned cursors in the same initial readiness barrier
      // as autoruns. Meteor must not publish them again after we return.
      await publish._publishHandlerResult(result);
    } else {
      handlerRunning = false;
      maybeReady();
      return result;
    }
    handlerRunning = false;
    maybeReady();
  }

  return [name, newPublishFunction, options];
};

// Add the publishReactive function
Meteor.publishReactive = function (name, publishFunction, options) {
  return Meteor.publish(
    name,
    function (...args) {
      const publish = this;

      // Set up a single autorun and pass the provided function as the first autorun
      publish.autorun(function (computation) {
        return publishFunction.apply(publish, [...args, computation]);
      });
    },
    options
  );
};

wrapPublish(extendPublish);
