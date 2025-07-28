import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { handleMethods, subscriptionDataMethods } from './lib.js';

const SubscriptionData = new Mongo.Collection(null);
const CONNECTION_ID_REGEX = /^.+?_/;

export const extendPublish = (name, func, options) => {
  const newFunc = function (...args) {
    const publish = this;

    // If it's an unnamed publish endpoint, skip
    if (!publish._subscriptionId) {
      return func.apply(publish, args);
    }

    const id = `${publish.connection.id}_${publish._subscriptionId}`;

    SubscriptionData.insert({
      _id: id,
      _connectionId: publish.connection.id,
    });

    Object.assign(publish, handleMethods(Meteor, SubscriptionData, id));

    const result = func.apply(publish, args);

    publish.onStop(() => {
      SubscriptionData.remove({ _id: id });
    });

    return result;
  };

  return [name, newFunc, options];
};

// Mirror subscription data to client
Meteor.publish(null, function () {
  const handle = SubscriptionData.find(
    { _connectionId: this.connection.id },
    { fields: { _connectionId: 0 } }
  ).observeChanges({
    added: (id, fields) => {
      id = id.replace(CONNECTION_ID_REGEX, '');
      this.added('_subscriptionData', id, fields);
    },
    changed: (id, fields) => {
      id = id.replace(CONNECTION_ID_REGEX, '');
      this.changed('_subscriptionData', id, fields);
    },
    removed: (id) => {
      id = id.replace(CONNECTION_ID_REGEX, '');
      this.removed('_subscriptionData', id);
    },
  });

  this.onStop(() => handle.stop());

  this.ready();
});

// Attach server methods for manipulating _subscriptionData
Meteor.methods(subscriptionDataMethods(SubscriptionData));
