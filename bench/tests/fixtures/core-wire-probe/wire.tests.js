import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { ReactiveVar } from 'meteor/reactive-var';
import { Random } from 'meteor/random';
import { Tinytest } from 'meteor/tinytest';
import { captureConnectionMessages } from 'meteor/test-helpers';

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Cursor replacement did not settle');
    await Meteor._sleepForMs(10);
  }
}

Tinytest.addAsync(
  'ReactivePublish core integration - metadata does not remove cursor documents',
  async (test) => {
    const { conn, messages, cleanup } = await captureConnectionMessages(test);
    const name = 'core_wire_probe_' + Random.id();
    const collection = new Mongo.Collection(name, {
      defineMutationMethods: false,
    });
    const limit = new ReactiveVar(1);
    let computation;
    let subscription;
    try {
      for (let index = 0; index < 3; index++)
        await collection.insertAsync({
          _id: 'item_' + index,
          title: 'Item ' + index,
        });
      Meteor.publish(name, async function (count) {
        return collection.find({}, { limit: count });
      });
      computation = Tracker.autorun(() => {
        subscription = conn.subscribe(name, limit.get());
      });
      await waitFor(() => subscription.ready());
      const previous = subscription.subscriptionId;
      limit.set(2);
      Tracker.flush();
      await waitFor(
        () =>
          subscription.subscriptionId !== previous &&
          subscription.ready() &&
          messages.some(
            (message) => message.msg === 'nosub' && message.id === previous
          ) &&
          messages.some(
            (message) =>
              message.msg === 'removed' &&
              message.collection === '_subscriptionData'
          )
      );
      const metadata = messages.filter(
        (message) => message.collection === '_subscriptionData'
      );
      const cursorMessages = messages.filter(
        (message) => message.collection !== '_subscriptionData'
      );
      console.log(
        'core-wire-probe',
        JSON.stringify(
          messages.map(({ msg, collection }) => ({ msg, collection }))
        )
      );
      // Keep the upstream cursor ordering contract, with its original eight events.
      test.equal(
        cursorMessages.map((message) => message.msg),
        ['sub', 'added', 'ready', 'sub', 'unsub', 'added', 'ready', 'nosub']
      );
      test.equal(
        messages.filter(
          (message) => message.msg === 'removed' && message.collection === name
        ).length,
        0
      );
      test.equal(
        metadata.filter((message) => message.msg === 'added').length,
        2
      );
      test.equal(
        metadata.filter((message) => message.msg === 'removed').length,
        1
      );
    } finally {
      computation?.stop();
      cleanup();
      conn.disconnect();
      await collection.removeAsync({});
      delete Meteor.server.publish_handlers[name];
    }
  }
);
