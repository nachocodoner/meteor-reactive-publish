## reactive-publish

`reactive-publish` is a Meteor package that adds **reactive publishing with async support**. It's based on [**peerlibrary:reactive-publish**](https://github.com/peerlibrary/meteor-reactive-publish) and [**peerlibrary:subscription-data**](https://github.com/peerlibrary/meteor-subscription-data), fully overhauled for compatibility with **Meteor 3** and its **fiber-free** environment.

- 🔄 Reactively publish data with related field changes across collections

- 📊 Reactively publish derived data publishing without restarting subscriptions

- ⚙️ Supports `autorun` in publication functions for **realtime updates**

- 🧵 Integrates `AsyncTracker`/`ReactiveVarAsync` for **async-safe reactivity* (server only)

- 🚀 Optimized with **unique cursors per computation** to avoid redundant re-instantiation

🔥 [**Learn about the motivation**](./MOTIVATION.md) for reviving this package for Meteor 3.

🗺️ [**Explore the roadmap**](#roadmap) for future updates and support.

## Installation

For the stable release, run `meteor add nachocodoner:reactive-publish`. To try the read-tracking and incremental cursor options in **1.2.0-beta.0** once it is published, run

``` bash
meteor add nachocodoner:reactive-publish@=1.2.0-beta.0
```

You can try `countDependencies: 'membership'` in this checkout ahead of its first package release.

## Usage

### Choosing an autorun option

The 1.2 beta reuses observers for unchanged cursors and cleans up obsolete dependencies automatically. A sorted publication that kept returning the same query used **about 30% less Meteor process CPU per write** on upgrade from 1.1.1 with default settings. [Default upgrade measurements](./bench/PUBLICATION-MEASUREMENTS.md#what-an-upgrade-gives-you-by-default)

You can enable each option independently on the autorun that needs it.

| Your publication | Option | Expected benefit |
| --- | --- | --- |
| Shows a badge or total from `countAsync()` | `countDependencies: 'membership'` | Skip recounts after field edits. When four in five writes left membership unchanged, the autorun ran **80% fewer times**. [Count example and CPU cost](./PUBLICATION-OPTIONS.md#publish-a-count) |
| Reads parent documents and returns their children | `cursorDependencies: 'onRead'` | Deliver child edits directly. A join with a mix of parent and child writes ran **50% fewer times**. [Join example](./PUBLICATION-OPTIONS.md#return-a-live-cursor-from-a-join) |
| Publishes a long-lived list of saved IDs | `returnedCursorStrategy: 'incremental'` | Reuse observers for IDs that stay selected. A saved-posts list used **about 61% less Meteor process CPU per list edit**, with more observers at startup. [Saved-list example and tradeoffs](./PUBLICATION-OPTIONS.md#publish-a-changing-list-of-ids) |

Pass the option when registering your function with `Meteor.publishReactive` or `this.autorun`. This publication reads the subscriber's post IDs and returns their comments. Editing a comment updates the client directly. Adding or removing an owned post reruns the function.

```js
async function commentsOnMyPosts() {
  if (!this.userId) return [];
  const posts = await Posts.find(
    { ownerId: this.userId },
    { fields: { _id: 1 } }
  ).fetchAsync();
  return Comments.find(
    { postId: { $in: posts.map(post => post._id) } },
    { fields: { postId: 1, body: 1 } }
  );
}

Meteor.publishReactive('commentsOnMyPosts', commentsOnMyPosts, {
  cursorDependencies: 'onRead',
});
```

The parent query explicitly selects `_id` because the comments query uses only post IDs. If your function uses the title too, include it in the projection. The default `cursorDependencies: 'onFind'` also tracks cursors that the function only creates. Keep it when those changes trigger derived work. [Options, measured improvements and tradeoffs](./PUBLICATION-OPTIONS.md)

### Reactive Composed Data Publish

These examples show how to publish composed data reactively, letting clients receive updates when related fields change.

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

This example shows how you can use `ReactiveVarAsync` to control the autorun block and re-publish on time intervals.

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

This example shows define multiple autoruns for more efficient reactive triggers.

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

#### Infinite scrolling and counts

This example shows how to publish a collection with a reactive total count and allow the client to increase the limit of published items without restarting the subscription.

Server:
```javascript
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Mongo } from 'meteor/mongo';

export const Posts = new Mongo.Collection('posts');

Meteor.publish('posts.infiniteScroll', function () {
  // An edit to a post title leaves this total unchanged.
  this.autorun(async () => {
    await this.setData('countAll', await Posts.find().countAsync());
  }, { countDependencies: 'membership' });

  // Reactive window of posts, adjustable by client
  this.autorun(async () => {
    const limit = Number(await this.data('limit')) || 10;
    check(limit, Number);
    return Posts.find({}, { limit, sort: { createdAt: -1 } });
  });
});
```

Membership tracking enables read tracking for the count autorun. Inserts and deletions still update the total. The second autorun keeps its own defaults for the paginated list.

Client (Tracker):
```javascript
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Posts } from '/imports/api/posts.js';

const sub = Meteor.subscribe('posts.infiniteScroll');

// Reactive total count
Tracker.autorun(async () => {
  console.log('Total posts:', await sub.data('countAll'));
});

// Adjust published window without restarting
sub.setData('limit', 20);
```

#### External reactive source

This example simulates an external service changing a user's subscription tier every five seconds.

Server:
```javascript
import { Meteor } from 'meteor/meteor';

Meteor.publish('user.subscriptionTier', function (userId) {
  const pub = this;
  let tier = 'free';

  // Simulate external updates (It could be an API, database, or service)
  const handle = setInterval(async () => {
    tier = (tier === 'free') ? 'pro' : 'free';
    await pub.setData('tier', tier);
  }, 5000);

  pub.onStop(() => clearInterval(handle));
});
```

Client (React + useTracker):
```javascript
import React from 'react';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';

export default function SubscriptionInfo({ userId }) {
  const sub = Meteor.subscribe('user.subscriptionTier', userId);
  const tier = useTracker(() => sub.data('tier'));

  return <p>Subscription tier: {tier || 'loading...'}</p>;
}
```

A polling service may send a fresh settings object with the same values on every refresh. If your publication reads those settings from a `ReactiveVarAsync`, you can give that variable an equality function. With `new ReactiveVarAsync({ category: 'news' }, EJSON.equals)`, another `{ category: 'news' }` skips a rerun, while `{ category: 'events' }` updates the feed. Import `EJSON` from `meteor/ejson`. [Filter equality and parent projection measurements](./bench/PUBLICATION-MEASUREMENTS.md#application-level-tuning)

#### Derived stats via aggregation

This example shows how to publish derived data from a Mongo aggregation.

It uses autorun to recalculate when the underlying collections change, and setData to push aggregated stats to the client. The projected `authorId` and `postId` fields declare which edits must refresh the aggregation. Moving a post to another author changes both authors' statistics while the total number of posts stays the same.

Server:
```javascript
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

export const Posts = new Mongo.Collection('posts');
export const Likes = new Mongo.Collection('likes');

Meteor.publish('stats.authorActivity', function () {
  const pub = this;

  pub.autorun(async () => {
    // Reactive deps: touching cursors ensures recalculation on changes
    await Posts.find({}, { fields: { authorId: 1 } }).countAsync();
    await Likes.find({}, { fields: { postId: 1 } }).countAsync();

    const pipeline = [
      { $lookup: { from: 'likes', localField: '_id', foreignField: 'postId', as: 'likes' } },
      { $group: {
          _id: '$authorId',
          postsCount: { $sum: 1 },
          likesCount: { $sum: { $size: '$likes' } },
        }
      },
      { $project: { _id: 0, authorId: '$_id', postsCount: 1, likesCount: 1 } },
    ];

    const stats = await Posts.rawCollection().aggregate(pipeline).toArray();
    await pub.setData('authorStats', stats);
    
    pub.ready();
  });
});
```

Client (React + useTracker):
```javascript
import React from 'react';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';

export default function AuthorStats() {
  const sub = Meteor.subscribe('stats.authorActivity');
  const stats = useTracker(() => sub.data('authorStats') || []);

  return (
    <ul>
      {stats.map(({ authorId, postsCount, likesCount }) => (
        <li key={authorId}>
          {`${authorId}: ${postsCount} posts · ${likesCount} likes`}
        </li>
      ))}
    </ul>
  );
}
```

## TypeScript Support

This package includes TypeScript definitions for all its APIs. To enable type checking:

1. Make sure your app has [zodern:types](https://github.com/zodern/meteor-types) installed:

```bash
meteor add zodern:types
```

2. Import the package using the Meteor import syntax:

```typescript
import { AsyncTracker, ReactiveVarAsync } from 'meteor/nachocodoner:reactive-publish';
```

This package extends Meteor's core types to add reactive publishing capabilities. The type definitions include:

- Extensions to `Meteor.publish` context with the `autorun`, `data` and `setData` methods
- The `Meteor.publishReactive` function
- `AsyncTracker` and `ReactiveVarAsync` with full generic type support

## Development

Use Node 22.12 or newer and install Meteor. From this repository:

```sh
npm ci
npm run lint
npm run test:ci
npm run bench:setup
npm run bench:test
npm run bench -- doctor
npm run bench:smoke
```

`test:ci` tests this checkout explicitly and defaults to the release in
`bench/config/runtime-lock.json`. Use `npm run test:ci -- --release 3.5.2`
to test another release. It uses Puppeteer's downloaded Chrome or an installed
Chrome on macOS/Linux; set `PUPPETEER_EXECUTABLE_PATH` to select another executable.
If Chrome is already installed, `PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm ci`
avoids downloading additional browsers. Package CI checks a clean lockfile install
and lint as well as client/server tests on Meteor 3.3.2 and 3.6. The Meteor-core
suite runs on manual dispatch. See the [core verification guide](./bench/CORE-TESTING.md).

See the [benchmark guide](./bench/README.md) for isolated databases, paired
comparisons, calibration, profiling, and interpretation of measurements.
The [regression audit](./bench/REGRESSION-AUDIT.md) records the branch/base test
comparison, test synchronization fixes, and remaining verification.

## Roadmap

- **Stability** ✅
    - Ensure core changes in this package don't affect Meteor core tests
    - Release betas and RCs, with a feedback period for early adopters

- **Expansion** ✅
    - Support for `AsyncTracker` and `ReactiveVarAsync` on the client
    - Support for publishing derived data reactively

- **Performance**
    - [Run the repository benchmark suite](./bench/README.md) for DDP workloads, library comparisons, and regression reports
    - Use `npm run bench:comprehensive` for repeated CPU, memory, event-loop, GC, load, retention, and MongoDB comparisons with publish-composite
    - [Run benchmarks](https://github.com/meteor/performance) to identify performance improvement opportunities
    - Compare results with [`reywood:publish-composite`](https://github.com/Meteor-Community-Packages/meteor-publish-composite) to ensure equal or better behavior

## Acknowledgments

This package builds on over a decade of work by [PeerLibrary](https://github.com/peerlibrary/meteor-reactive-publish) during the legacy Meteor era. Big thanks to everyone involved over those years, especially [mitar](https://github.com/mitar).

The original idea came from the excellent work of [Diggory Blake](https://github.com/Diggsey/meteor-reactive-publish), who created the first implementation.
