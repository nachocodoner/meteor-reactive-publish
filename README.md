## reactive-publish

`reactive-publish` is a Meteor package that adds **reactive publishing with async support**. It's based on [**peerlibrary:reactive-publish**](https://github.com/peerlibrary/meteor-reactive-publish) and [**peerlibrary:subscription-data**](https://github.com/peerlibrary/meteor-subscription-data), fully overhauled for compatibility with **Meteor 3** and its **fiber-free** environment.

- 🔄 Reactively publish data with related field changes across collections

- 📊 Publish derived data without restarting subscriptions

- ⚙️ Supports `autorun` in publication functions for **realtime updates**

- 🧵 Use `AsyncTracker` and `ReactiveVarAsync` with async code on the client and server

🔥 [**Learn about the motivation**](./MOTIVATION.md) for reviving this package for Meteor 3.

## Contents

- [Installation](#installation)
- [Usage examples](#usage)
  - [Publish related documents](#reactive-composed-data-publish)
  - [Two autoruns in one publication](#two-autoruns-in-one-publication)
  - [Nest an autorun inside a lookup](#nest-an-autorun-inside-a-lookup)
  - [Publish derived data](#reactive-derived-data-publish)
- [Choosing an autorun option](#choosing-an-autorun-option)
  - [Recount when documents enter or leave a query](#recount-when-documents-enter-or-leave-a-query)
  - [Return a live cursor without repeating the lookup](#return-a-live-cursor-without-repeating-the-lookup)
  - [Reuse observers when a list of IDs changes](#reuse-observers-when-a-list-of-ids-changes)
- [TypeScript support](#typescript-support)
- [Development and testing](#development)
- [Roadmap](#roadmap)
- [Acknowledgments](#acknowledgments)

## Installation

From your Meteor application, install the current stable release.

```sh
meteor add nachocodoner:reactive-publish
```

To test the beta, select it with `meteor add nachocodoner:reactive-publish@=1.2.0-beta.1`.

## Usage

### Reactive Composed Data Publish

A publication can read one collection to decide which documents to publish from another.

#### Basic

This publication sends the posts a user subscribes to. When the user subscribes to another post, the client receives it through the same subscription.

```javascript
Meteor.publishReactive('subscribed-posts', async function () {
  if (!this.userId) return this.ready();
  const user = await Meteor.users.findOneAsync(this.userId, {
    fields: { subscribedPosts: 1 },
  });

  return Posts.find({ _id: { $in: user?.subscribedPosts || [] } });
});
```

`Meteor.publishReactive` runs the function in one autorun. Like a regular publication, it can return a cursor or an array of cursors.

#### Two autoruns in one publication

Use `Meteor.publish` directly when one subscription has two pieces of reactive work. This feed publishes the user's subscribed posts and an unread notification count.

```javascript
Meteor.publish('myFeed', function () {
  const userId = this.userId;
  if (!userId) return this.ready();

  this.autorun(async () => {
    const user = await Meteor.users.findOneAsync(userId, {
      fields: { subscribedPosts: 1 },
    });
    return Posts.find({ _id: { $in: user?.subscribedPosts || [] } });
  });

  this.autorun(async () => {
    const count = await Notifications.find({ userId, read: false }).countAsync();
    await this.setData('unreadCount', count);
  });
});
```

The client subscribes to `myFeed` once. Posts arrive in its `Posts` collection, and it can read the count with `sub.data('unreadCount')`. [Choose an option for each autorun](#choosing-an-autorun-option)

#### Nest an autorun inside a lookup

> Starting with `nachocodoner:reactive-publish@1.2.0-beta.0`

Suppose the same feed should show the five newest posts the user follows, with a button to load more. The parent autorun looks up the user's followed post IDs. The child uses those IDs and the requested page size to select the posts. While that child is active, it can reuse its cursor whenever the query stays the same.

```javascript
import { Meteor } from 'meteor/meteor';
import { Posts } from '/imports/api/collections.js';

Meteor.publish('myFeed.pagedPosts', function () {
  const userId = this.userId;
  if (!userId) return this.ready();

  this.autorun(async () => {
    const user = await Meteor.users.findOneAsync(userId, {
      fields: { subscribedPosts: 1 },
    });
    const postIds = user?.subscribedPosts || [];
    if (postIds.length === 0) return [];

    this.autorun(async () => {
      const limit = (await this.data('showMore')) === true ? 20 : 5;
      return Posts.find(
        { _id: { $in: postIds } },
        {
          fields: { title: 1, createdAt: 1 },
          sort: { createdAt: -1, _id: 1 },
          limit,
        }
      );
    }, { cursorDependencies: 'onRead' });
  });
});
```

The client subscribes once. Call `showMorePosts()` from the feed’s “Load more” button to expand the page from five posts to twenty.

```javascript
import { Meteor } from 'meteor/meteor';

const sub = Meteor.subscribe('myFeed.pagedPosts');

export function showMorePosts() {
  return sub.setData('showMore', true);
}
```

Loading more reruns only the child and skips the user lookup. With `cursorDependencies: 'onRead'` on the child, editing a title goes straight to the client through the live cursor. Changing the followed IDs reruns the parent and replaces the child. If the list is empty, the subscription withdraws its posts.

Nesting is useful when the lookup changes less often than the child’s filter or page size. In the benchmark, changing the child’s filter 20 times avoided all 20 repeat lookups. [Nested benchmark](./bench/PUBLICATION-MEASUREMENTS.md#nested-autoruns) · [Options for a nested autorun](./PUBLICATION-OPTIONS.md#options-for-a-nested-autorun)

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

### Reactive Derived Data Publish

These examples show how to publish derived data reactively, allowing clients to receive updates without restarting subscriptions.

#### Infinite scrolling and counts

One subscription publishes the total number of posts and a page of results. The first autorun sends the total with `this.setData`. The second reads the page size and returns the posts.

Server:
```javascript
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Mongo } from 'meteor/mongo';

export const Posts = new Mongo.Collection('posts');

Meteor.publish('posts.infiniteScroll', function () {
  this.autorun(async () => {
    await this.setData('countAll', await Posts.find().countAsync());
  });

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

## Choosing an autorun option

> Starting with `nachocodoner:reactive-publish@1.2.0-beta.0`

Each autorun can have its own settings. `countDependencies` and `cursorDependencies` control which changes trigger a rerun. `returnedCursorStrategy` controls how Meteor watches the returned documents when the query changes.

Each example is a complete server module for a feed in an app with Meteor accounts. A user's `subscribedPosts` field holds an array of post IDs. Each notification has a `userId` and a boolean `read` field. The publications share these collections, defined once in `/imports/api/collections.js`.

```javascript
import { Mongo } from 'meteor/mongo';

export const Posts = new Mongo.Collection('posts');
export const Notifications = new Mongo.Collection('notifications');
```

### Recount when documents enter or leave a query

Use `countDependencies: 'membership'` when an autorun publishes a count. For a plain `countAsync()` query, it tracks which document IDs match. Edits that leave the same IDs in the result can skip the recount.

For an unread badge, editing a notification's text leaves the count unchanged. Marking it as read takes it out of the query, so the autorun recounts and the badge drops by one.

```javascript
import { Meteor } from 'meteor/meteor';
import { Notifications } from '/imports/api/collections.js';

Meteor.publish('myFeed.unreadCount', function () {
  const userId = this.userId;
  if (!userId) return this.ready();

  this.autorun(async () => {
    const count = await Notifications.find({ userId, read: false }).countAsync();
    await this.setData('unreadCount', count);
    this.ready();
  }, { countDependencies: 'membership' });
});
```

Membership enables read tracking automatically. In a benchmark where four out of five writes only edited a title, it produced **80% fewer autorun executions** and used **about 30% less server CPU per write**. Delivery of counts that did change took about 9% longer at the 95th percentile. [Count benchmark](./bench/COUNT-MEMBERSHIP.md#measured-effect)

### Return a live cursor without repeating the lookup

Use `cursorDependencies: 'onRead'` when an autorun reads data to decide which cursor to return. By default, calling `find()` also makes the autorun depend on that cursor's results. With `'onRead'`, the lookup stays reactive and the returned cursor can deliver its own updates without repeating the lookup.

In this feed, editing a post's title sends the new title straight to the client. Changing the user's `subscribedPosts` still reruns the function because it reads that list to choose the posts.

```javascript
import { Meteor } from 'meteor/meteor';
import { Posts } from '/imports/api/collections.js';

Meteor.publish('myFeed.subscribedPosts', function () {
  const userId = this.userId;
  if (!userId) return this.ready();

  this.autorun(async () => {
    const user = await Meteor.users.findOneAsync(userId, {
      fields: { subscribedPosts: 1 },
    });
    return Posts.find(
      { _id: { $in: user?.subscribedPosts || [] } },
      { fields: { title: 1 } }
    );
  }, { cursorDependencies: 'onRead' });
});
```

A join that read posts and returned comments ran **50% fewer times** with `'onRead'` and delivered the same client updates. If the function also reads the comments to compute a value, edits to those comments still rerun it. [Read-tracking benchmark](./bench/PUBLICATION-MEASUREMENTS.md#read-tracking)

### Reuse observers when a list of IDs changes

Use `returnedCursorStrategy: 'incremental'` for a long-lived `$in` query when a few string IDs change at a time. The autorun still reruns to publish the new list. The server saves work on that run by keeping the observers that watch unchanged groups of IDs.

This version of the feed publishes posts and the unread badge together. When a reader subscribes to one more post, the posts autorun updates its query and reuses observers. It also uses `'onRead'` so title edits skip the user lookup. The count autorun chooses `'membership'` independently.

```javascript
import { Meteor } from 'meteor/meteor';
import { Notifications, Posts } from '/imports/api/collections.js';

Meteor.publish('myFeed.withOptions', function () {
  const userId = this.userId;
  if (!userId) return this.ready();

  this.autorun(async () => {
    const user = await Meteor.users.findOneAsync(userId, {
      fields: { subscribedPosts: 1 },
    });
    return Posts.find(
      { _id: { $in: user?.subscribedPosts || [] } },
      { fields: { title: 1 } }
    );
  }, {
    cursorDependencies: 'onRead',
    returnedCursorStrategy: 'incremental',
  });

  this.autorun(async () => {
    const count = await Notifications.find({ userId, read: false }).countAsync();
    await this.setData('unreadCount', count);
  }, { countDependencies: 'membership' });
});
```

In the saved-post benchmark, adding this option to `'onRead'` used **about 61% less server CPU per list edit** and cut client update time **about 52% at the 95th percentile**. It opened more observers at startup and took longer to become ready, so it fits feeds that stay open across many list edits. [Supported queries](./PUBLICATION-OPTIONS.md#publish-a-changing-list-of-ids) · [Saved-post benchmark](./bench/PUBLICATION-MEASUREMENTS.md#incremental-observation)

### Multiple autoruns

The client subscribes once for both autoruns. This client module reads the posts from Minimongo and the count from the subscription when the feed first becomes ready.

```javascript
import { Meteor } from 'meteor/meteor';
import { Posts } from '/imports/api/collections.js';

const sub = Meteor.subscribe('myFeed.withOptions', {
  async onReady() {
    const posts = await Posts.find().fetchAsync();
    const unreadCount = await sub.data('unreadCount');
    console.log({ posts, unreadCount });
  },
});
```

Each `this.autorun(fn, options)` on the server has its own settings. With `Meteor.publishReactive(name, fn, options)`, the settings apply to its single autorun. [Ticket dashboard with three autoruns](./PUBLICATION-OPTIONS.md#a-ticket-dashboard-with-three-autoruns)

With the default settings, `1.2.0-beta.0` used **about 30% less server CPU per write** than `1.1.1` in the sorted feed benchmark. Both versions sent identical updates. [Default upgrade benchmark](./bench/PUBLICATION-MEASUREMENTS.md#what-an-upgrade-gives-you-by-default)

## TypeScript Support

> Starting with `nachocodoner:reactive-publish@1.2.0-beta.0`

Meteor 3.6 and later can load the package’s native TypeScript declarations for package exports, publication helpers, subscription data and autorun options. For example, the scrolling subscription can specify the type of the total it reads.

```ts
import { Meteor } from 'meteor/meteor';

const sub = Meteor.subscribe('posts.infiniteScroll');
const total = await sub.data<number | undefined>('countAll');
```

**Meteor 3.6 and later.** In an app configured for native Meteor types, run the following after adding the package or updating it. This regenerates the declarations for your editor and type checker.

```sh
meteor types
```

If you are switching an existing app to native types, include `./.meteor/types/packages.d.ts` in your app's `tsconfig.json` and map `meteor/*` to `./.meteor/types/packages/*`. Keep the app's source files in the TypeScript project. Meteor skips native generation when the app lists `zodern:types` directly. [Meteor's provider setup and migration guide](https://docs.meteor.com/cli/using-core-types)

**Earlier Meteor 3 releases.** Use `meteor add zodern:types` in an app that needs the legacy declarations. Apps already using that provider can keep their existing configuration and package imports. [Legacy provider setup](https://github.com/zodern/meteor-types)

## Development

Use Node 22.12 or newer and install Meteor. From this repository:

```sh
npm ci
npm run lint
npm run test:ci
npm run test:types
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
avoids downloading additional browsers. Every PR runs lint, the benchmark harness unit
tests, and client/server package tests on Meteor 3.3.2 and 3.6. The `test:types`
check generates the declarations in a Meteor 3.6 app and type-checks its package imports.
Use Meteor 3.6 or later to publish a release with native declaration metadata.
Pull requests that change the package runtime, its build configuration or the core test runner also run Meteor's core package tests. Each Mongo backend runs once on unmodified core and once with this package loaded. The same checks run on pushes to `master` and can be started manually. [Core verification guide](./bench/CORE-TESTING.md)

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
