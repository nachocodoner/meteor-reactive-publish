// // Import required Meteor packages.
// import { Tracker } from 'meteor/tracker';
// import { MongoInternals } from 'meteor/mongo';
//
// // Get a reference to the MeteorCursor constructor.
// // (Assumes that MongoInternals.defaultRemoteCollectionDriver() exists.)
// const MeteorCursor = Object.getPrototypeOf(
//   MongoInternals.defaultRemoteCollectionDriver().mongo.find()
// ).constructor;
//
// // Save original methods for later use.
// const originalObserveChanges = MeteorCursor.prototype.observeChanges;
// const originalCount = MeteorCursor.prototype.count;
//
// // The next line is a PeerDB extension. It might not exist if the package is used
// // without PeerDB. However, we have defined a weak dependency on PeerDB so that it
// // is loaded before this package and has the chance to extend MeteorCursor.
// const originalExists = MeteorCursor.prototype.exists;
//
// // Add a method to decide if the cursor should be reactive.
// // By default all cursors are reactive unless options.reactive is set otherwise.
// MeteorCursor.prototype._isReactive = function () {
//   const options = this._cursorDescription.options || {};
//   return options.reactive !== undefined ? options.reactive : true;
// };
//
// // Define a helper method that creates a dependency for reactivity.
// MeteorCursor.prototype._depend = function (changers) {
//   // Exit if no Tracker computation is active.
//   if (!Tracker.active) {
//     return;
//   }
//
//   // Create and trigger a Tracker dependency.
//   const dependency = new Tracker.Dependency();
//   dependency.depend();
//
//   // On the server, observeChanges does not have _suppress_initial,
//   // so we skip the initial documents manually.
//   let initializing = true;
//
//   // Build callbacks that only notify the dependency if not initializing.
//   const callback = {};
//   ['added', 'changed', 'removed', 'addedBefore', 'movedBefore'].forEach(
//     (fnName) => {
//       if (changers[fnName]) {
//         callback[fnName] = () => {
//           if (!initializing) {
//             dependency.changed();
//           }
//         };
//       }
//     }
//   );
//
//   // Call observeChanges with non-mutating callbacks so that the cursor stops
//   // when the Tracker computation is invalidated.
//   this.observeChanges(callback, { nonMutatingCallbacks: true });
//
//   initializing = false;
// };
//
// // Override observeChanges so that when the cursor is reactive, it stops automatically
// // when the Tracker computation is invalidated.
// MeteorCursor.prototype.observeChanges = function (callbacks, options = {}) {
//   const handle = originalObserveChanges.call(this, callbacks, options);
//   if (Tracker.active && this._isReactive()) {
//     Tracker.onInvalidate(() => {
//       handle.stop();
//     });
//   }
//   return handle;
// };
//
// // Define two sets of callback groups based on the options of the cursor.
// const callbacksOrdered = {
//   addedBefore: true,
//   removed: true,
//   changed: true,
//   movedBefore: true,
// };
//
// const callbacksUnordered = {
//   added: true,
//   changed: true,
//   removed: true,
// };
//
// // Wrap forEach, map, and fetch to add reactive dependency.
// ['forEach', 'map', 'fetch'].forEach((method) => {
//   const originalMethod = MeteorCursor.prototype[method];
//   MeteorCursor.prototype[method] = function (...args) {
//     if (this._isReactive()) {
//       // Destructure sort and ordered from the cursor description options.
//       const { sort, ordered } = this._cursorDescription.options || {};
//       let callbacks;
//       if ('ordered' in (this._cursorDescription.options || {})) {
//         // if the 'ordered' property exists: if truthy, use the ordered callbacks
//         // otherwise use the unordered callbacks.
//         callbacks = ordered ? callbacksOrdered : callbacksUnordered;
//       } else {
//         // If no explicit ordered option is provided, choose based on sort.
//         callbacks = sort ? callbacksOrdered : callbacksUnordered;
//       }
//       this._depend(callbacks);
//     }
//     return originalMethod.apply(this, args);
//   };
// });
//
// // Override count so that it adds reactivity if needed.
// MeteorCursor.prototype.count = function (...args) {
//   if (this._isReactive()) {
//     this._depend({
//       added: true,
//       removed: true,
//     });
//   }
//   return originalCount.apply(this, args);
// };
//
// // If the original 'exists' method exists, wrap it similarly.
// if (originalExists) {
//   MeteorCursor.prototype.exists = function (...args) {
//     if (this._isReactive()) {
//       this._depend({
//         added: true,
//         removed: true,
//       });
//     }
//     return originalExists.apply(this, args);
//   };
// }
