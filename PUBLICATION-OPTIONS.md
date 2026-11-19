# Choosing publication options

When an autorun returns a Mongo cursor, Meteor observes that query to keep the client up to date. By default, calling `find()` inside the autorun also makes the function rerun when matching data changes. In a join, editing a comment can therefore send the new text to the client and make the function fetch the parent posts again.

| When to use it | Set this on the autorun | What the benchmark measured |
| --- | --- | --- |
| [Publish a count](#publish-a-count) when most edits leave the same documents in the query | `countDependencies: 'membership'` | **80% fewer reruns** when four in five writes only changed a title. |
| [Return a live cursor from a join](#return-a-live-cursor-from-a-join) when edits can reach the client without another lookup | `cursorDependencies: 'onRead'` | **50% fewer reruns** on a mix of post and comment edits. |
| [Publish a changing list of IDs](#publish-a-changing-list-of-ids) when most IDs stay on the list between edits | `returnedCursorStrategy: 'incremental'` | **About 61% less server CPU per list edit** with read tracking enabled in both runs. |

All three options are included in the `1.2.0-beta.0` candidate. With `Meteor.publishReactive(name, fn, options)`, they apply to the one autorun that runs `fn`.

## Set options on individual autoruns

Here is the README's feed with a different setting on each `this.autorun(fn, options)`. The first autorun reads the user's list of post IDs and returns the posts. The second counts unread notifications. [Feed with default settings](./README.md#two-autoruns-in-one-publication)

```js
Meteor.publish('myFeed', function () {
  const userId = this.userId;
  if (!userId) return this.ready();

  this.autorun(async () => {
    const user = await Meteor.users.findOneAsync(userId, {
      fields: { subscribedPosts: 1 },
    });
    return Posts.find({ _id: { $in: user?.subscribedPosts || [] } });
  }, { cursorDependencies: 'onRead' });

  this.autorun(async () => {
    const count = await Notifications.find({ userId, read: false }).countAsync();
    await this.setData('unreadCount', count);
  }, { countDependencies: 'membership' });
});
```

Editing a post's title reaches the client through the returned cursor. With `'onRead'`, the first autorun skips looking up the user again. Marking a notification as read changes which IDs match, so the second autorun updates the count. Editing the notification's text leaves the count alone.

Each sibling or nested autorun that omits its options uses the defaults. Multiple autoruns can query the same collection, and only one can return a cursor for that collection. The ticket dashboard also shows how to combine read tracking with incremental observation in a single autorun. [Dashboard with three autoruns](#a-ticket-dashboard-with-three-autoruns)

Standalone server `AsyncTracker.autorun(fn, options)` also supports `countDependencies` and `cursorDependencies`. The returned cursor strategy applies to publication autoruns.

## Publish a count

With `countDependencies: 'membership'`, a count-only autorun tracks which documents match the query. It can skip edits to fields that leave those documents in the result.

For an open-ticket badge, closing a ticket removes it from the query and updates the count. Editing the title of an open ticket leaves the badge unchanged.

```js
Meteor.publishReactive('myOpenTicketCount', async function () {
  if (!this.userId) return this.ready();

  const count = await Tickets.find({
    assigneeId: this.userId,
    open: true,
  }).countAsync();
  await this.setData('count', count);
  this.ready();
}, { countDependencies: 'membership' });
```

This single setting turns on read tracking throughout the autorun. For an eligible `countAsync()`, the package observes the IDs that match the selector and executes the original count when the autorun runs. Other reads keep their own dependencies. If the same autorun also fetches the tickets, title edits still update that reader and the additional count observer can cost more.

The ID-only observer applies to plain, named server Mongo cursors. Explicit projections, transforms, sort, skip, limit, local cursors and custom observers keep their usual behavior. For example, an aggregation grouped by `authorId` needs to run when a post changes author, even when the total count stays the same. Project `authorId` explicitly on the cursor that provides that dependency. [Aggregation example](./README.md#derived-stats-via-aggregation)

The default `countDependencies: 'documents'` tracks document changes. You can also use `'membership'` with an explicit `cursorDependencies: 'onRead'`. Combining it with explicit `'onFind'` raises an error, since observing the full cursor at creation would wake the autorun on the very edits it should skip.

**Expected gain.** The more writes leave membership unchanged, the more recounts a count-only publication can avoid. With four in five writes editing a title, membership tracking produced **80% fewer autorun executions** and used **about 30% less Meteor process CPU per write** than document tracking. Both delivered every count change with identical traffic. Delivery time at p95 for counts that did change was **about 9% longer**. [Count measurements](./bench/COUNT-MEMBERSHIP.md#measured-effect)

## Return a live cursor from a join

Use `cursorDependencies: 'onRead'` when an autorun looks up data to build a second query and returns that query as a live cursor. Changes to the data it reads rerun the lookup. Meteor can send edits through the returned cursor without repeating that work.

For example, a publication reads the IDs of the subscriber's posts and returns their comments. Adding a post reruns the lookup to include its ID. Editing a comment's text goes straight to the client.

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

Here, `fetchAsync()` reads the posts. `return Comments.find(...)` hands Meteor a live query to publish. If the function also fetches the comments to calculate a summary, it reads their contents and relevant edits still rerun the function.

Supported server Mongo reads include `fetchAsync()`, `mapAsync()`, `forEachAsync()`, `countAsync()` and `fetch()`. Local collections keep their usual creation-time dependencies. Reading subscription data or a reactive variable also establishes a dependency.

**Choosing parent fields.** The example explicitly selects `_id` because the child selector uses only the parent IDs. If the function also reads a post's title, include `title` in the projection. Use the default `'onFind'` when creating a cursor is itself the signal to recompute a raw aggregation or run another side effect.

**Expected gain.** In the posts-and-comments benchmark, the autorun ran **50% fewer times** and used **about 33% less Meteor CPU per write**, with identical client traffic. That comparison ran once per mode. A separate comparison with six runs per mode measured a **6.8% CPU reduction** in a deeper join that also read the comments to find their authors. [Read-tracking measurements](./bench/PUBLICATION-MEASUREMENTS.md#read-tracking)

## Publish a changing list of IDs

Use `returnedCursorStrategy: 'incremental'` when a long-lived publication returns a `$in` query over a changing list of string IDs. Standard observation reuses the observer while the query stays the same. Incremental observation can also reuse observers across list edits because it watches groups of IDs separately.

When a reader saves one more post, the function still has to run again to include its ID. Groups of IDs that stayed on the saved list keep their observers.

```js
Meteor.publishReactive('mySavedPosts', async function () {
  if (!this.userId) return [];
  const [user] = await Meteor.users.find(
    { _id: this.userId },
    { fields: { savedPostIds: 1 } }
  ).fetchAsync();

  return Posts.find(
    { _id: { $in: user?.savedPostIds || [] }, visibility: 'public' },
    { fields: { title: 1 } }
  );
}, { returnedCursorStrategy: 'incremental' });
```

The example uses `'incremental'` on its own. Editing a saved post's title can still rerun the function under the default `'onFind'`. If those edits are common, add `cursorDependencies: 'onRead'` to the same options object. Title edits then go straight to the client, while edits to `savedPostIds` still rerun the function and benefit from observer reuse. [Example using both options](#a-ticket-dashboard-with-three-autoruns)

Incremental observation supports native server Mongo queries with one top-level `$in` containing up to 256 distinct string IDs. Additional top-level filters can be scalar equality conditions, and simple field projections are supported. Other queries use standard observation, including sorted or paginated windows, nested selectors, ObjectID lists, transforms and custom cursors. Keep the default `'standard'` strategy for short-lived subscriptions or lists that rarely change.

**Expected gain.** On lists with small, frequent membership changes, the saved-post query used **about 61% less Meteor process CPU per write** and client update latency at p95 fell **about 52%**. A foreign-key join on `postId` used **about 24% less CPU**, with **about 17% shorter** p95 delivery. Both the standard and incremental runs used `cursorDependencies: 'onRead'`. Incremental observation opens more observers at subscription time. The foreign-key case also increased MongoDB reads to track documents that can move between groups. [Incremental observation measurements](./bench/PUBLICATION-MEASUREMENTS.md#incremental-observation)

## A ticket dashboard with three autoruns

One subscription can count open tickets, publish a page of activity and show pinned tickets. Here each autorun picks the setting that fits the work it does.

```javascript
Meteor.publish('myTicketDashboard', function () {
  const assigneeId = this.userId;
  if (!assigneeId) return this.ready();

  // Closing a ticket changes the badge. Renaming it skips the recount.
  this.autorun(async () => {
    const count = await Tickets.find({ assigneeId, open: true }).countAsync();
    await this.setData('openCount', count);
  }, { countDependencies: 'membership' });

  // Loading more activity reruns this block. An edited message updates through the cursor.
  this.autorun(async () => {
    const limit = (await this.data('moreActivity')) === true ? 20 : 5;
    return Activity.find({ userId: assigneeId }, {
      fields: { message: 1, createdAt: 1 },
      sort: { createdAt: -1 },
      limit,
    });
  }, { cursorDependencies: 'onRead' });

  // Pinning a ticket changes the list. Unchanged groups of IDs keep their observers.
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

Renaming a pinned ticket updates its title on the client through the returned cursor. Closing that ticket also wakes the count autorun, so the badge decreases. Calling `sub.setData('moreActivity', true)` expands the activity page and reruns only its autorun.

## Compare filters by value

A polling service may return a fresh filter object with the same values on every refresh. When an autorun reads that filter from a `ReactiveVarAsync`, supply `EJSON.equals` to compare its contents. This works with the default autorun settings.

```js
import { EJSON } from 'meteor/ejson';
import { ReactiveVarAsync } from 'meteor/nachocodoner:reactive-publish';

const filter = new ReactiveVarAsync({ category: 'news' }, EJSON.equals);
```

Setting the filter to another `{ category: 'news' }` leaves the feed alone. Setting it to `{ category: 'events' }` reruns the query. [Filter equality and parent projection measurements](./bench/PUBLICATION-MEASUREMENTS.md#application-level-tuning)
