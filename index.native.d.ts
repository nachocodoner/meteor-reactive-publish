import type { SubscriptionDataMethods } from './reactive-publish';
export * from './reactive-publish';

declare module 'meteor/meteor' {
  namespace Meteor {
    interface SubscriptionHandleWithId {
      data: SubscriptionDataMethods['data'];
      setData: SubscriptionDataMethods['setData'];
    }
  }
}
