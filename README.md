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

For the current stable release, run `meteor add nachocodoner:reactive-publish`. Once the first 1.2 beta is published, select it explicitly from your Meteor application.

``` bash
meteor add nachocodoner:reactive-publish@=1.2.0-beta.0
```

The 1.2 beta includes all three publication options below.

## Usage

### Choosing an autorun option

The 1.2 beta reuses observers for unchanged cursors and cleans up obsolete dependencies automatically. In a comparison with 1.1.1, the beta used **about 30% less Meteor process CPU per write** for a sorted publication that kept returning the same query. Both runs used default settings. [Default upgrade measurements](./bench/PUBLICATION-MEASUREMENTS.md#what-an-upgrade-gives-you-by-default)

Each option belongs to one autorun. `Meteor.publishReactive(name, fn, options)` runs `fn` in a single autorun with those settings. With `Meteor.publish`, each `this.autorun(fn, options)` can choose different settings. [Ticket dashboard with three autoruns](#multiple-autoruns)

| Your publication | Option | Expected benefit |
| --- | --- | --- |
| Shows a badge or total from `countAsync()` | `countDependencies: 'membership'` | Skip recounts after field edits. When four in five writes left membership unchanged, the autorun ran **80% fewer times**. [Count example and CPU cost](./PUBLICATION-OPTIONS.md#publish-a-count) |
| Reads parent documents and returns their children | `cursorDependencies: 'onRead'` | Deliver child edits directly. A join with a mix of parent and child writes ran **50% fewer times**. [Join example](./PUBLICATION-OPTIONS.md#return-a-live-cursor-from-a-join) |
| Publishes a long-lived list of saved IDs | `returnedCursorStrategy: 'incremental'` | Reuse observers for IDs that stay selected. A saved-posts list used **about 61% less Meteor process CPU per list edit**, with more observers at startup. [Saved-list example and tradeoffs](./PUBLICATION-OPTIONS.md#publish-a-changing-list-of-ids) |

In the following join, the function reads posts to work out which comments to publish. With the default `'onFind'`, editing a comment can rerun the function and fetch the post IDs again. With `'onRead'`, the post lookup stays reactive and the returned comments cursor delivers comment edits directly.

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

The parent query selects `_id` because the comments query uses only post IDs. Adding or removing an owned post reruns the join. If the function also reads a post's title, include `title` in the projection. [Options, measured improvements and tradeoffs](./PUBLICATION-OPTIONS.md)

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

A ticket dashboard shows an open-ticket count, recent activity and the tickets the subscriber has pinned. Each part responds to different changes, so each has its own autorun.

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

The last autorun combines two options because it handles two kinds of writes. `'onRead'` saves a user lookup when someone edits a ticket title. `'incremental'` saves observer setup when the list of pinned string IDs changes frequently. The sorted activity window uses the standard observer. [When incremental observation pays off](./PUBLICATION-OPTIONS.md#publish-a-changing-list-of-ids)

### Reactive Derived Data Publish

These examples show how to publish derived data reactively, allowing clients to receive updates without restarting subscriptions.

#### Infinite scrolling and counts

One subscription publishes both the total number of posts and a page of results. Both autoruns can query `Posts`, but only one can return a cursor for that collection. The count autorun publishes its number through `this.setData`. The list autorun reads the page limit and returns the live cursor.

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
  }, { cursorDependencies: 'onRead' });
});
```

Increasing the limit reruns only the list autorun. Editing a visible post's title reaches the client through the returned cursor and skips both autorun bodies. Inserting or deleting a post updates the total, and the cursor keeps the visible page in sync.

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

The 1.2 beta ships types for the package exports, `Meteor.publishReactive`, publication and subscription data, and the options on each `this.autorun`. For example, you can give a shared option a name and have TypeScript check its value where you define it.

```ts
import type { PublicationAutorunOptions } from 'meteor/nachocodoner:reactive-publish';

const openTicketCountOptions = {
  countDependencies: 'membership',
} satisfies PublicationAutorunOptions;
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
