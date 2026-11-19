# Choosing publication options

When an autorun returns a Mongo cursor, Meteor observes that query to keep the client up to date. By default, calling `find()` inside the autorun also makes the function rerun when matching data changes. In a join, editing a comment can therefore send the new text to the client and make the function fetch the parent posts again.

| What the publication does | Set this on the autorun | Work it can skip |
| --- | --- | --- |
| Publishes a count, such as the number of open tickets | `countDependencies: 'membership'` | Recounting after edits that leave the same documents in the query. |
| Reads parent documents to select a live child cursor | `cursorDependencies: 'onRead'` | Rerunning the parent query when a child changes. |
| Returns a long-lived cursor over a changing list of IDs | `returnedCursorStrategy: 'incremental'` | Rebuilding observers for IDs that stay on the list. |

`Meteor.publishReactive(name, fn, options)` creates one implicit autorun for `fn`. Inside a regular `Meteor.publish`, pass options to each `this.autorun(fn, options)` that needs them. Sibling and nested autoruns that omit their options use the defaults. The ticket dashboard uses different settings for its count, its activity window and its pinned tickets. [Walk through three autoruns in one subscription](./README.md#multiple-autoruns)

Standalone server `AsyncTracker.autorun(fn, options)` also supports `countDependencies` and `cursorDependencies`. The returned cursor strategy applies to publication autoruns.

Multiple autoruns can query the same collection in one publication. Only one can return a cursor for that collection. In the dashboard, the count sends a number with `this.setData` and the pinned list returns the tickets cursor.

All three options are included in the `1.2.0-beta.0` candidate.

## Publish a count

An open-ticket badge needs an update when a ticket opens or closes. Editing the title of an open ticket leaves the badge unchanged. Enable membership tracking on the autorun that computes the badge.

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

This single setting turns on read tracking throughout the autorun. For an eligible `countAsync()`, the package observes the IDs that match the selector and executes the original count when the autorun runs. Adding, removing or reassigning a ticket can change that set. A title edit alone leaves it intact. Other reads keep their own dependencies. If the same autorun also fetches the tickets, title edits still update that reader and the additional count observer can cost more.

The ID-only observer applies to plain, named server Mongo cursors. Explicit projections, transforms, sort, skip, limit, local cursors and custom observers keep their usual behavior. For example, an aggregation grouped by `authorId` needs to run when a post changes author, even when the total count stays the same. Project `authorId` explicitly on the cursor that provides that dependency. [Aggregation example](./README.md#derived-stats-via-aggregation)

The default `countDependencies: 'documents'` tracks document changes. You can also use `'membership'` with an explicit `cursorDependencies: 'onRead'`. Combining it with explicit `'onFind'` raises an error, since observing the full cursor at creation would wake the autorun on the very edits it should skip.

**Expected gain.** The more writes leave membership unchanged, the more recounts a count-only publication can avoid. With four in five writes editing a title, membership tracking produced **80% fewer autorun executions** and used **about 30% less Meteor process CPU per write** than document tracking. Both delivered every count change with identical traffic. Delivery time at p95 for counts that did change was **about 9% longer**. [Count measurements](./bench/COUNT-MEMBERSHIP.md#measured-effect)

## Return a live cursor from a join

Suppose a publication reads the IDs of the subscriber's posts and returns their comments. Adding a post makes the function run again to include that post's ID in the comments query. Editing the text of an existing comment leaves the post IDs alone.

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

Here, `fetchAsync()` reads the posts. `return Comments.find(...)` hands Meteor a live query to publish. With `'onRead'`, an edit to a comment's body travels through that cursor without fetching the posts again. If the function also fetches the comments to calculate a summary, it reads their contents and relevant edits still rerun the function.

Supported server Mongo reads include `fetchAsync()`, `mapAsync()`, `forEachAsync()`, `countAsync()` and `fetch()`. Local collections keep their usual creation-time dependencies. Reading subscription data or a reactive variable also establishes a dependency.

**Choosing parent fields.** The example explicitly selects `_id` because the child selector uses only the parent IDs. If the function also reads a post's title, include `title` in the projection. Use the default `'onFind'` when creating a cursor is itself the signal to recompute a raw aggregation or run another side effect.

**Expected gain.** Savings grow with the share of edits that only change returned documents. A posts-and-comments publication handling both parent and child writes ran **50% fewer times** with identical client traffic. In a deeper join that also read child documents, the observed CPU reduction per write was smaller. [Read-tracking measurements](./bench/PUBLICATION-MEASUREMENTS.md#read-tracking)

## Publish a changing list of IDs

Suppose a reader adds one post to a saved list. The function has to run again because the IDs it read have changed. Standard observation already reuses the observer when the returned query stays the same. Changing the list produces a new `$in` query and replaces that observer. Incremental observation watches groups of IDs separately, so groups whose IDs stay the same can keep their observers.

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

The example uses `'incremental'` on its own. Editing a saved post's title can still rerun the function under the default `'onFind'`. If those edits are common, add `cursorDependencies: 'onRead'` to the same options object. Title edits then go straight to the client, while edits to `savedPostIds` still rerun the function and benefit from observer reuse. [Example using both options](./README.md#multiple-autoruns)

Incremental observation supports native server Mongo queries with one top-level `$in` containing up to 256 distinct string IDs. Additional top-level filters can be scalar equality conditions, and simple field projections are supported. Other queries use standard observation, including sorted or paginated windows, nested selectors, ObjectID lists, transforms and custom cursors. Keep the default `'standard'` strategy for short-lived subscriptions or lists that rarely change.

**Expected gain.** On lists with small, frequent membership changes, the saved-post query used **about 61% less Meteor process CPU per write** and client update latency at p95 fell **about 52%**. A foreign-key join on `postId` used **about 24% less CPU**, with **about 17% shorter** p95 delivery. Both the standard and incremental runs used `cursorDependencies: 'onRead'`. Incremental observation opens more observers at subscription time. The foreign-key case also increased MongoDB reads to track documents that can move between groups. [Incremental observation measurements](./bench/PUBLICATION-MEASUREMENTS.md#incremental-observation)

## Compare filters by value

A polling service may return a fresh filter object with the same values on every refresh. When an autorun reads that filter from a `ReactiveVarAsync`, supply `EJSON.equals` to compare its contents. This works with the default autorun settings.

```js
import { EJSON } from 'meteor/ejson';
import { ReactiveVarAsync } from 'meteor/nachocodoner:reactive-publish';

const filter = new ReactiveVarAsync({ category: 'news' }, EJSON.equals);
```

Setting the filter to another `{ category: 'news' }` leaves the feed alone. Setting it to `{ category: 'events' }` reruns the query. [Filter equality and parent projection measurements](./bench/PUBLICATION-MEASUREMENTS.md#application-level-tuning)
