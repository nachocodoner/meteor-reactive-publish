import { check, Match } from 'meteor/check';
import { Tracker } from 'meteor/tracker';
import { EJSON } from 'meteor/ejson';
import { Meteor } from 'meteor/meteor';
import { DataLookup } from 'meteor/data-lookup'; // adjust if needed

const checkPath = (path) => {
  if (typeof path === 'string') {
    check(path, Match.NonEmptyString);
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
  check(subscriptionDataId, Match.NonEmptyString);
  const splits = subscriptionDataId.split('_');

  if (splits.length !== 2) {
    throw new Match.Error(`Invalid subscriptionDataId '${subscriptionDataId}'.`);
  }

  check(splits[0], Match.DocumentId);
  check(splits[1], Match.DocumentId);

  return true;
};

const SUBSCRIPTION_ID_REGEX = /_.+?$/;

const subscriptionDataSet = (collection, connectionId, subscriptionDataId, path, value) => {
  if (Meteor.isClient) {
    check(connectionId, null);
    check(subscriptionDataId, Match.DocumentId);
  } else {
    check(connectionId, Match.DocumentId);
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

  collection.update(
    {
      _id: subscriptionDataId,
      _connectionId: connectionId,
    },
    update
  );
};

export const handleMethods = (connection, collection, subscriptionDataId) => {
  const dataFunction = (path, equalsFunc) => {
    const getData = (fields) => {
      const data = collection.findOne(subscriptionDataId, { fields });

      if (!data) return data;

      const { _id, _connectionId, ...rest } = data;
      return rest;
    };

    if (path !== undefined) {
      if (typeof path === 'string') {
        const fields = { [path]: 1 };
        return DataLookup.get(() => getData(fields), path, equalsFunc);
      } else {
        return DataLookup.get(() => getData({ _connectionId: 0 }), path, equalsFunc);
      }
    } else {
      return getData({ _connectionId: 0 });
    }
  };

  const setDataFunction = (path, value) => {
    const oldValue = Tracker.nonreactive(() => dataFunction(path));
    if (EJSON.equals(value, oldValue)) return;

    if (Meteor.isClient) {
      const args = value === undefined ? [subscriptionDataId, path] : [subscriptionDataId, path, value];
      connection.apply('_subscriptionDataSet', args, (error) => {
        if (error) {
          console.error('_subscriptionDataSet error', error);
        }
      });
    } else {
      const connectionId = subscriptionDataId.replace(SUBSCRIPTION_ID_REGEX, '');
      subscriptionDataSet(collection, connectionId, subscriptionDataId, path, value);
    }
  };

  return {
    data: dataFunction,
    setData: setDataFunction,
  };
};

export const subscriptionDataMethods = (collection) => ({
  _subscriptionDataSet(subscriptionDataId, path, value) {
    check(subscriptionDataId, Match.DocumentId);
    check(path, Match.Where(checkPath));
    check(value, Match.Any);

    let connectionId;

    if (Meteor.isClient) {
      connectionId = null;
    } else {
      connectionId = this.connection.id;
      subscriptionDataId = `${connectionId}_${subscriptionDataId}`;
    }

    subscriptionDataSet(collection, connectionId, subscriptionDataId, path, value);
  },
});
