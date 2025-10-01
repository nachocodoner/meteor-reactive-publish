## reactive-publish

`reactive-publish` is a Meteor package that adds **reactive publishing with async support**. It's based on [**peerlibrary:reactive-publish**](https://github.com/peerlibrary/meteor-reactive-publish) and [**peerlibrary:subscription-data**](https://github.com/peerlibrary/meteor-subscription-data), fully overhauled for compatibility with **Meteor 3** and its **fiber-free** environment.

- 🔄 Reactively publish data with related field changes across collections

- 📊 Reactively publish derived data publishing without restarting subscriptions

- ⚙️ Supports `autorun` in publication functions for **realtime updates**

- 🧵 Integrates `AsyncTracker` and `ReactiveVarAsync` for **async-compatible reactivity**

- 🚀 Optimized with **unique cursors per computation** to avoid redundant re-instantiation

🔥 [**Learn about the motivation**](./MOTIVATION.md) for reviving this package for Meteor 3.

🗺️ [**Explore the roadmap**](#roadmap) for future updates and support.

## Installation

``` bash
meteor add nachocodoner:reactive-publish@1.0.0-rc.1
```

## Usage

### Reactive Composed Data Publish

#### Basic

```javascript
Meteor.publish('subscribed-posts', function () {
  this.autorun(async () => {
    const user = await User.findOneAsync(this.userId, {
      fields: { subscribedPosts: 1 },
    });

    return Posts.find({ _id: { $in: user?.subscribedPosts || [] } });
  });
});
```

In the example above, you publish the user’s subscribed posts. When the User’s `subscribedPosts` field changes, autorun reruns and publishes the updated posts. Any queries with related data work the same way. You can also publish an array of cursors and use the same logic as in a normal publication body.

Since most use cases involve a single `autorun` block, you can use `Meteor.publishReactive` for cleaner syntax:

```javascript
Meteor.publishReactive('subscribed-posts', async function () {
  const user = await User.findOneAsync(this.userId, {
    fields: { subscribedPosts: 1 },
  });

  return Posts.find({ _id: { $in: user?.subscribedPosts || [] } });
});
```

#### Time-based queries

```javascript
import { ReactiveVarAsync } from 'meteor/nachocodoner:reactive-publish';

const currentTime = new ReactiveVarAsync(Date.now());

Meteor.setInterval(() => {
  currentTime.set(Date.now());
}, 1000); // ms

Meteor.publish('recent-posts', function () {
  this.autorun(() => {
    return Posts.find({
      timestamp: {
        $exists: true,
        $gte: currentTime.get() - 60 * 1000,
      },
    }, {
      sort: { timestamp: 1 },
    });
  });
});
```

#### Multiple autoruns

```javascript
Meteor.publish('users-posts-and-addresses', function (userId) {
  this.autorun(async () => {
    const user = await Users.findOneAsync(userId, {
      fields: { posts: 1 },
    });
    return Posts.find({ _id: { $in: user?.posts || [] } });
  });

  this.autorun(async () => {
    const user = await Users.findOneAsync(userId, {
      fields: { addresses: 1 },
    });
    return Addresses.find({ _id: { $in: user?.addresses || [] } });
  });
});
```

### Reactive Derived Data Publish

These examples show how to publish derived data reactively, allowing clients to receive updates without restarting subscriptions.

#### Example 1: Infinite scrolling and counts

This example shows how to publish a collection with a reactive total count and allow the client to increase the limit of published items without restarting the subscription.

Server:
```javascript
// /server/publications.js
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Mongo } from 'meteor/mongo';

export const Posts = new Mongo.Collection('posts');

Meteor.publish('posts.infiniteScroll', function () {
  // Reactive total count
  this.autorun(async () => {
    await this.setData('countAll', Posts.find().count());
  });

  // Reactive window of posts, adjustable by client
  this.autorun(async () => {
    const limit = Number(await this.data('limit')) || 10;
    check(limit, Number);
    return Posts.find({}, { limit, sort: { createdAt: -1 } });
  });
});
```

Client (Tracker):
```javascript
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Posts } from '/imports/api/posts.js';

const sub = Meteor.subscribe('posts.infiniteScroll');

// Reactive total count
Tracker.autorun(() => {
  console.log('Total posts:', sub.data('countAll'));
});

// Adjust published window without restarting
sub.setData('limit', 20);
```

#### Example 2: External reactive source

This example shows how to publish data reactively from an external source. Here it's simulated with an interval toggling a user's subscription tier, but in practice it could be an API, another database, or any third-party service.

Server:
```javascript
// /server/publications.js
import { Meteor } from 'meteor/meteor';

Meteor.publish('user.subscriptionTier', function (userId) {
  const pub = this;
  let tier = 'free';

  // Simulate external updates
  const handle = setInterval(async () => {
    tier = (tier === 'free') ? 'pro' : 'free';
    await pub.setData('tier', tier);
  }, 5000);

  pub.onStop(() => clearInterval(handle));
});
```

Client (React + useTracker):
```javascript
// /client/SubscriptionInfo.jsx
import React from 'react';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';

export default function SubscriptionInfo({ userId }) {
  const sub = Meteor.subscribe('user.subscriptionTier', userId);
  const tier = useTracker(() => sub.data('tier'));

  return <p>Subscription tier: {tier || 'loading...'}</p>;
}
```

## Roadmap

- **Stability** ✅
    - Ensure core changes in this package don't affect Meteor core tests
    - Release betas and RCs, with a feedback period for early adopters

- **Expansion** ✅
    - Support for `AsyncTracker` and `ReactiveVarAsync` on the client
    - Support for publishing derived data reactively

- **Performance**
    - [Run benchmarks](https://github.com/meteor/performance) to identify performance improvement opportunities
    - Compare results with [`reywood:publish-composite`](https://github.com/Meteor-Community-Packages/meteor-publish-composite) to ensure equal or better behavior

## Acknowledgments

This package builds on over a decade of work by [PeerLibrary](https://github.com/peerlibrary/meteor-reactive-publish) during the legacy Meteor era. Big thanks to everyone involved over those years, especially [mitar](https://github.com/mitar).

The original idea came from the excellent work of [Diggory Blake](https://github.com/Diggsey/meteor-reactive-publish), who created the first implementation.
