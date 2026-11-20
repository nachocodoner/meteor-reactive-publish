import { DDP } from 'meteor/ddp-client';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import {
  AsyncTracker,
  AsyncTrackerComputation,
  AsyncTrackerDependency,
  ReactiveVarAsync,
  type PublicationAutorunOptions,
} from 'meteor/nachocodoner:reactive-publish';

const Posts = new Mongo.Collection<{ _id: string; title: string }>('posts');
const pageSize = new ReactiveVarAsync(10);
const countOptions = {
  countDependencies: 'membership',
} satisfies PublicationAutorunOptions;

Meteor.publish('posts', function () {
  this.autorun(async function () {
    await this.setData('total', await Posts.find().countAsync());
  }, countOptions);
  this.autorun(() => Posts.find({}, { limit: pageSize.get() }), {
    cursorDependencies: 'onRead',
  });
  // @ts-expect-error Each autorun checks its own returned cursor strategy.
  this.autorun(() => Posts.find(), { returnedCursorStrategy: 'fast' });
});

Meteor.publishReactive(
  'savedPosts',
  function (ids: string[]) {
    return Posts.find({ _id: { $in: ids } });
  },
  { cursorDependencies: 'onRead', returnedCursorStrategy: 'incremental' }
);

Meteor.publish('recentPosts', function () {
  return this.autorun(() => Posts.find(), { cursorDependencies: 'onRead' });
});

const subscription = Meteor.subscribe('posts');
subscription.subscriptionId.toUpperCase();
subscription.data<number>('total').then((total) => total.toFixed());
subscription.setData('limit', 20);
DDP.connect('https://example.com').subscribe('posts').data<number>('total');
export const basicHandle: Meteor.SubscriptionHandle = {
  ready: () => true,
  stop: () => {},
};

const dependency = new AsyncTrackerDependency();
const computation = new AsyncTrackerComputation(() => dependency.depend(), {
  onError(message, cause) {
    console.warn(message.toUpperCase(), cause);
  },
});
computation.invalidate();
const rerun: Promise<void> = computation.run();
rerun.then(() => computation.stop());
AsyncTracker.runWith(computation, () =>
  AsyncTracker.currentComputation()?.flush()
);
AsyncTracker.drainReactions().then(() => dependency.changed());

// @ts-expect-error Unknown read modes must be rejected on a publication.
Meteor.publishReactive('invalid', () => {}, { cursorDependencies: 'reads' });
const incompatibleOptions = {
  ...countOptions,
  cursorDependencies: 'onFind',
} as const;
// @ts-expect-error A membership count requires read-time dependencies.
AsyncTracker.autorun(() => {}, incompatibleOptions);
// @ts-expect-error A standalone autorun does not publish a returned cursor.
AsyncTracker.autorun(() => {}, { returnedCursorStrategy: 'incremental' });
