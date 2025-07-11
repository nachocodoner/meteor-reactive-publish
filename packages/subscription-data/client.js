import { handleMethods, subscriptionDataMethods } from './lib';

const Connection = Meteor.connection.constructor;

// Add the _initializeSubscriptionData method if not already present
Connection.prototype._initializeSubscriptionData = function () {
  if (this._subscriptionData) return;

  this._subscriptionData = new Mongo.Collection('_subscriptionData', {
    connection: this,
  });

  this.methods(subscriptionDataMethods(this._subscriptionData));
};

// Patch the _livedata_connected method
const originalLivedataConnected = Connection.prototype._livedata_connected;

Connection.prototype._livedata_connected = function (...args) {
  this._initializeSubscriptionData();
  return originalLivedataConnected.apply(this, args);
};

// Patch the subscribe method
const originalSubscribe = Connection.prototype.subscribe;

Connection.prototype.subscribe = function (...args) {
  this._initializeSubscriptionData();

  const handle = originalSubscribe.apply(this, args);

  Object.assign(
    handle,
    handleMethods(this, this._subscriptionData, handle.subscriptionId)
  );

  return handle;
};

// Recreate the Meteor.subscribe convenience method
Meteor.subscribe = Meteor.connection.subscribe.bind(Meteor.connection);
