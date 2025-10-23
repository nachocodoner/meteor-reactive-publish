import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { check, Match } from 'meteor/check';
import { EJSON } from 'meteor/ejson';
import { AsyncTracker } from '../ReactiveAsync/AsyncTracker.js';
import { DataLookup } from '../ReactiveAsync/DataLookup.js';

const checkPath = (path) => {
  if (typeof path === 'string') {
    check(path, String);
    if (['_id', '_connectionId'].includes(path)) {
      throw new Match.Error(`Cannot modify '${path}'.`);
    }
  } else {
    const update = path;
    check(update, Object);

    for (const field in update) {
      if (['_id', '_connectionId'].includes(field)) {
        throw new Match.Error(`Cannot modify '${field}'.`);
      }
      if (field.startsWith('$')) {
        throw new Match.Error(`Invalid field name '${field}'.`);
      }
    }
  }

  return true;
};

const checkSubscriptionDataId = (subscriptionDataId) => {
  check(subscriptionDataId, String);
  const splits = subscriptionDataId.split('_');

  if (splits.length !== 2) {
    throw new Match.Error(
      `Invalid subscriptionDataId '${subscriptionDataId}'.`
    );
  }

  check(splits[0], String);
  check(splits[1], String);

  return true;
};

const SUBSCRIPTION_ID_REGEX = /_.+?$/;

const subscriptionDataSet = async (
  collection,
  connectionId,
  subscriptionDataId,
  path,
  value
) => {
  if (Meteor.isClient) {
    check(connectionId, null);
    check(subscriptionDataId, String);
  } else {
    check(connectionId, String);
    check(subscriptionDataId, Match.Where(checkSubscriptionDataId));
  }

  check(path, Match.Where(checkPath));
  check(value, Match.Any);

  let update;

  if (typeof path === 'string') {
    update =
      value === undefined
        ? { $unset: { [path]: '' } }
        : { $set: { [path]: value } };
  } else {
    update = {
      ...path,
      _connectionId: connectionId,
    };
  }

  await collection.updateAsync(
    {
      _id: subscriptionDataId,
      _connectionId: connectionId,
    },
    update,
    { upsert: true }
  );
};

const handleMethods = (connection, collection, subscriptionDataId) => {
  const dataFunction = async (path, equalsFunc) => {
    const getData = async (fields) => {
      const data =
        (
          await collection.find(subscriptionDataId, { fields }).fetchAsync()
        )?.[0] || {};
      if (!data) return data;
      const { _id, _connectionId, ...rest } = data;
      return rest;
    };

    if (path !== undefined) {
      if (typeof path === 'string') {
        const fields = { [path]: 1 };
        return DataLookup.get(() => getData(fields), path, equalsFunc);
      } else {
        return DataLookup.get(
          () => getData({ _connectionId: 0 }),
          path,
          equalsFunc
        );
      }
    } else {
      return getData({ _connectionId: 0 });
    }
  };

  const setDataFunction = async (path, value) => {
    const oldValue = await AsyncTracker.nonreactive(() => dataFunction(path));
    if (EJSON.equals(value, oldValue)) return;

    if (Meteor.isClient) {
      const args =
        value === undefined
          ? [subscriptionDataId, path]
          : [subscriptionDataId, path, value];
      await connection.applyAsync('_subscriptionDataSet', args, (error) => {
        if (error) {
          console.error('_subscriptionDataSet error', error);
        }
      });
    } else {
      const connectionId = subscriptionDataId.replace(
        SUBSCRIPTION_ID_REGEX,
        ''
      );
      await subscriptionDataSet(
        collection,
        connectionId,
        subscriptionDataId,
        path,
        value
      );
    }
  };

  return {
    data: dataFunction,
    setData: setDataFunction,
  };
};

const subscriptionDataMethods = (collection) => ({
  async _subscriptionDataSet(subscriptionDataId, path, value) {
    check(subscriptionDataId, String);
    check(path, Match.Where(checkPath));
    check(value, Match.Any);

    let connectionId;
    if (Meteor.isClient) {
      connectionId = null;
    } else {
      connectionId = this.connection.id;
      subscriptionDataId = `${connectionId}_${subscriptionDataId}`;
    }

    await subscriptionDataSet(
      collection,
      connectionId,
      subscriptionDataId,
      path,
      value
    );
  },
});

if (Meteor.isServer) {
  const SubscriptionData = new Mongo.Collection(null);
  const CONNECTION_ID_REGEX = /^.+?_/;

  const wrapPublish = (newPublishArguments) => {
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

  const extendPublish = (name, func, options) => {
    async function newFunc(...args) {
      const publish = this;

      // If it's an unnamed publish endpoint, skip
      if (!publish._subscriptionId) {
        return func.apply(publish, args);
      }

      const id = `${publish.connection.id}_${publish._subscriptionId}`;

      const subscriptionData = await SubscriptionData.findOneAsync({ _id: id });
      if (!subscriptionData) {
        await SubscriptionData.insertAsync({
          _id: id,
          _connectionId: publish.connection.id,
        });
      }

      Object.assign(publish, handleMethods(Meteor, SubscriptionData, id));

      const result = func.apply(publish, args);

      publish.onStop(async () => {
        await SubscriptionData.removeAsync({ _id: id });
      });

      return result;
    }

    return [name, newFunc, options];
  };

  wrapPublish(extendPublish);

  // Mirror subscription data to client
  Meteor.publish(null, async function () {
    const pub = this;
    const handle = await SubscriptionData.find(
      { _connectionId: pub.connection.id },
      { fields: { _connectionId: 0 } }
    ).observeChangesAsync({
      added: (id, fields) => {
        id = id.replace(CONNECTION_ID_REGEX, '');
        pub.added('_subscriptionData', id, fields);
      },
      changed: (id, fields) => {
        id = id.replace(CONNECTION_ID_REGEX, '');
        pub.changed('_subscriptionData', id, fields);
      },
      removed: (id) => {
        id = id.replace(CONNECTION_ID_REGEX, '');
        pub.removed('_subscriptionData', id);
      },
    });

    pub.onStop(() => handle.stop());

    pub.ready();
  });

  // Attach server methods for manipulating _subscriptionData
  Meteor.methods(subscriptionDataMethods(SubscriptionData));
}

if (Meteor.isClient) {
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
}
