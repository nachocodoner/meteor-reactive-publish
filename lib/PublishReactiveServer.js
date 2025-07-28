import { MongoInternals } from 'meteor/mongo';
import { MongoConnection } from 'meteor/mongo/mongo_connection';
import { AsyncLocalStorage } from 'async_hooks';
import { AsyncTracker } from './async-reactive/AsyncTracker';

const publishContextStore = new AsyncLocalStorage();

// Get a reference to the MeteorCursor constructor.
// (Assumes that MongoInternals.defaultRemoteCollectionDriver() exists.)
const MeteorCursor = Object.getPrototypeOf(
  MongoInternals.defaultRemoteCollectionDriver().mongo.find()
).constructor;

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

// --- Wrap Callbacks (to help pass a computation to observeChanges callbacks) ---
// In Meteor 3 with async publish functions there is no Fiber.
// So we simply wrap the callbacks if Tracker.active without trying to "inject" a computation.
function wrapCallbacks(callbacks, initializingReference) {
  const currentComputation = AsyncTracker.currentComputation();
  if (currentComputation) {
    // Shallow clone the callbacks so we can override specific ones.
    callbacks = Object.assign({}, callbacks);
    const namesToWrap = [
      'added',
      'changed',
      'removed',
      'addedBefore',
      'movedBefore',
    ];
    namesToWrap.forEach((callbackName) => {
      const callback = callbacks[callbackName];
      if (callback && typeof callback === 'function') {
        callbacks[callbackName] = Meteor.bindEnvironment((...args) => {
          if (initializingReference.initializing) {
            publishContextStore.enterWith({
              publishComputation: currentComputation,
            });
          }
          callback(...args);
        });
      }
    });
  }
  return callbacks;
}

// --- Wrap the observeChanges functions ---

// Override the low-level observeChanges to wrap its callbacks.
const originalObserveChanges = MongoConnection.prototype._observeChanges;
MongoConnection.prototype._observeChanges = async function (
  cursorDescription,
  ordered,
  callbacks,
  nonMutatingCallbacks
) {
  const initRef = { initializing: true };
  callbacks = wrapCallbacks(callbacks, initRef);
  const handle = await originalObserveChanges.call(
    this,
    cursorDescription,
    ordered,
    callbacks,
    nonMutatingCallbacks
  );
  initRef.initializing = false;
  return handle;
};

const originalObserveChangesAsync = MeteorCursor.prototype.observeChangesAsync;
// Override observeChangesAsync so that when the cursor is reactive, it stops automatically
// when the AsyncTracker computation is invalidated.
MeteorCursor.prototype.observeChangesAsync = async function (
  callbacks,
  options = {}
) {
  const initRef = { initializing: true };
  callbacks = wrapCallbacks(callbacks, initRef);
  const handle = await originalObserveChangesAsync.call(
    this,
    callbacks,
    options
  );
  initRef.initializing = false;
  return handle;
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
    if (Meteor.isTest) {
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
      if (!computation) return;

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
          Meteor._setImmediate(() => {
            oldDocuments[computation._id] = documents[computation._id] || {};
            documents[computation._id] = {};
          });
        });

        computation.afterRun(() => {
          Meteor._setImmediate(() => {
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
              const diffIds = computation?._parent
                ? difference(
                    currentlyPublishedDocumentIds,
                    currentComputationAddedDocumentIds
                  )
                : difference(
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
        });

        Meteor._setImmediate(computation.flush.bind(computation));
      }
    };

    const originalAdded = publish.added;
    publish.added = function (collectionName, id, fields) {
      const stringId = publish._idFilter.idStringify(id);

      publish._installCallbacks();

      const currentComputation = publish._currentComputation();
      if (currentComputation) {
        Meteor._ensure(documents, currentComputation._id, collectionName)[
          stringId
        ] = true;
      }

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
    const originalReady = publish.ready;
    publish.ready = function () {
      publish._installCallbacks();
      if (!ready) {
        originalReady.call(publish);
        ready = true;
      }
    };

    const handles = [];
    publish.autorun = async function (runFunc) {
      const handle = AsyncTracker.autorun(async function (computation) {
        publishContextStore.enterWith({
          name,
          publishComputation: computation,
        });
        computation.onInvalidate(() => {
          delete allCollectionNames[computation._id];
        });

        let result;
        try {
          result = runFunc.call(publish, computation);
          result =
            result && typeof result.then === 'function' ? await result : result;
        } catch (error) {
          computation.stop();
          if (computation.firstRun) {
            publish.error(error);
            throw error;
          } else {
            publish.error(error);
            return;
          }
        }

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
            handles.push(result);
          }
        } else {
          if (!publish._isDeactivated || !publish._isDeactivated()) {
            if (publish._publishHandlerResult) {
              await publish._publishHandlerResult(result);
            }
          }
        }
      });

      if (publish._isDeactivated && publish._isDeactivated()) {
        await handle.stop();
      } else {
        handles.push(handle);
      }
      return handle;
    };

    publish.onStop(async function () {
      while (handles.length) {
        const handle = handles.shift();
        if (handle && typeof handle.stop === 'function') {
          await handle.stop();
        }
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
        handles.push(result);
      }
      // Do not return anything.
      return;
    } else {
      return result;
    }
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
