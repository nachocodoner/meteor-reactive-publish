## reactive-publish

`reactive-publish` is a Meteor package that adds **reactive publishing with async support**. It's based on [**peerlibrary:reactive-publish**](https://github.com/peerlibrary/meteor-reactive-publish) and [**peerlibrary:subscription-data**](https://github.com/peerlibrary/meteor-subscription-data), fully overhauled for compatibility with **Meteor 3** and its **fiber-free** environment.

- 🔄 Reactively publish data with related field changes across collections

- 📊 Publish derived data without restarting subscriptions

- ⚙️ Supports `autorun` in publication functions for **realtime updates**

- 🧵 Use `AsyncTracker` and `ReactiveVarAsync` with async code on the client and server

🔥 [**Learn about the motivation**](./MOTIVATION.md) for reviving this package for Meteor 3.

🗺️ [**Explore the roadmap**](#roadmap) for future updates and support.

## Installation

From your Meteor application, install the current stable release.

```sh
meteor add nachocodoner:reactive-publish
```

Once the first 1.2 beta is published, you can select it with `meteor add nachocodoner:reactive-publish@=1.2.0-beta.0`.

## Usage

### Reactive Composed Data Publish

A publication can read one collection to decide which documents to publish from another. Wrap that lookup in `this.autorun` to keep it reactive.

#### Basic

This publication sends the posts a user subscribes to. When the user subscribes to another post, the client receives it through the same subscription.

```javascript
Meteor.publish('subscribed-posts', function () {
  if (!this.userId) return this.ready();
  this.autorun(async () => {
    const user = await Meteor.users.findOneAsync(this.userId, {
      fields: { subscribedPosts: 1 },
    });

    return Posts.find({ _id: { $in: user?.subscribedPosts || [] } });
  });
});
```

Just like a regular publication, an autorun can return a cursor or an array of cursors. When the publication uses a single autorun, `Meteor.publishReactive` provides a shorthand.

```javascript
Meteor.publishReactive('subscribed-posts', async function () {
  if (!this.userId) return this.ready();
  const user = await Meteor.users.findOneAsync(this.userId, {
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

The 1.2 beta lets each autorun choose what should trigger another run and how to observe the cursor it returns. With `Meteor.publishReactive(name, fn, options)`, the settings apply to its single autorun. With `Meteor.publish`, pass them to the individual `this.autorun(fn, options)` that needs them. An autorun that omits options uses the defaults.

### Multiple autoruns

A ticket dashboard shows an open-ticket count, recent activity and the tickets the subscriber has pinned. The badge uses `'membership'` because it only needs to know when a ticket enters or leaves the count. The activity feed uses `'onRead'` because it reads the page size and returns a live cursor for the entries on that page.

```javascript
Meteor.publish('myTicketDashboard', function () {
  const assigneeId = this.userId;
  if (!assigneeId) return this.ready();

  this.autorun(async () => {
    const count = await Tickets.find({ assigneeId, open: true }).countAsync();
    await this.setData('openCount', count);
  }, { countDependencies: 'membership' });

  this.autorun(async () => {
    const limit = (await this.data('moreActivity')) === true ? 20 : 5;
    return Activity.find({ userId: assigneeId }, {
      fields: { message: 1, createdAt: 1 },
      sort: { createdAt: -1 },
      limit,
    });
  }, { cursorDependencies: 'onRead' });

  this.autorun(async () => {
    const [user] = await Meteor.users.find(
      { _id: assigneeId },
      { fields: { pinnedTicketIds: 1 } }
    ).fetchAsync();
    return Tickets.find(
      { assigneeId, _id: { $in: user?.pinnedTicketIds || [] } },
      { fields: { title: 1, open: 1 } }
    );
  }, {
    cursorDependencies: 'onRead',
    returnedCursorStrategy: 'incremental',
  });
});
```

| What changes | What the subscriber sees | Which autorun runs again |
| --- | --- | --- |
| Edit a pinned ticket's title | The title updates through the returned `Tickets` cursor. | None. The count still matches the same IDs, and the pinned list only reads the user's `pinnedTicketIds`. |
| Close an open, pinned ticket | The badge decreases and the pinned ticket shows as closed. | Only the count. The cursor delivers the new `open` field. |
| Call `sub.setData('moreActivity', true)` | The activity window expands. | Only the activity autorun reads this setting. |
| Pin another assigned ticket | The ticket joins the list. | Only the pinned-ticket autorun. It reads the new IDs and reuses observers for groups of IDs that stay selected. |

By default, editing a pinned ticket can also wake the autorun that looked up the user's pinned IDs. With `'onRead'`, the returned cursor delivers the new title and skips that lookup. Pinning another ticket changes the query itself, so the autorun needs to run again. With `'incremental'`, groups of string IDs that stay pinned can keep their observers. This opens more observers up front and pays off when the list changes frequently.

See the [publication options guide](./PUBLICATION-OPTIONS.md) for individual examples, supported queries and measured tradeoffs. The benchmark also covers [improvements with default settings](./bench/PUBLICATION-MEASUREMENTS.md#what-an-upgrade-gives-you-by-default).

## TypeScript Support

The 1.2 beta ships types for the package exports, publication helpers, subscription data and autorun options. For example, the scrolling subscription can specify the type of the total it reads.

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
avoids downloading additional browsers. Package CI checks a clean lockfile install
and lint as well as client/server tests on Meteor 3.3.2 and 3.6. The `test:types`
check generates the declarations in a Meteor 3.6 app and type-checks its package imports.
Use Meteor 3.6 or later to publish a release with native declaration metadata.
The Meteor-core suite runs on manual dispatch. See the [core verification guide](./bench/CORE-TESTING.md).

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
