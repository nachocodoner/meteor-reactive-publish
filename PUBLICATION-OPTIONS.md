# Choosing publication options

Start with the default settings. Creating a reactive server Mongo cursor inside an autorun establishes a dependency, and the publication observes every cursor it returns. An unchanged returned cursor can reuse its observer across runs.

Choose the option that matches the work your publication repeats.

| What the publication does | Set this on the autorun | Work it can skip |
| --- | --- | --- |
| Publishes a count, such as the number of open tickets | `countDependencies: 'membership'` | Recounting after edits that leave the same documents in the query. |
| Reads parent documents to select a live child cursor | `cursorDependencies: 'onRead'` | Rerunning the parent query when a child changes. |
| Returns a long-lived cursor over a changing list of IDs | `returnedCursorStrategy: 'incremental'` | Rebuilding observers for IDs that stay on the list. |

`Meteor.publishReactive(name, fn, options)` creates one implicit autorun for `fn`. Inside a regular `Meteor.publish`, each `this.autorun(fn, options)` chooses its own settings. For example, one autorun can track count membership while another uses `'onRead'` for a paginated list. A sibling or nested autorun that omits its options uses the defaults. [Count and list in one subscription](./README.md#infinite-scrolling-and-counts)

Standalone server `AsyncTracker.autorun(fn, options)` also supports `countDependencies` and `cursorDependencies`. The returned cursor strategy applies to publication autoruns.

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

Suppose a publication reads the IDs of the subscriber's posts and returns their comments. The function needs to run when a post starts or stops matching. A comment edit can reach the client through the returned cursor's observer.

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

With `'onRead'`, supported server Mongo reads such as `fetchAsync()`, `mapAsync()`, `forEachAsync()`, `countAsync()` and `fetch()` establish dependencies. A cursor that the function only returns still publishes live updates. If the function also reads comments to compute a value, relevant comment edits rerun it. Local collections keep their usual creation-time dependencies. Subscription data and reactive variables still invalidate their readers.

**Choosing parent fields.** The example explicitly selects `_id` because the child selector uses only the parent IDs. If the function also reads a post's title, include `title` in the projection. Use the default `'onFind'` when creating a cursor is itself the signal to recompute a raw aggregation or run another side effect.

**Expected gain.** Savings grow with the share of edits that only change returned documents. A posts-and-comments publication handling both parent and child writes ran **50% fewer times** with identical client traffic. In a deeper join that also read child documents, the observed CPU reduction per write was smaller. [Read-tracking measurements](./bench/PUBLICATION-MEASUREMENTS.md#read-tracking)

## Publish a changing list of IDs

For a list of saved posts, adding a single ID can otherwise replace the observer for the whole query. Incremental observation keeps work for groups of IDs that remain selected.

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

This option only changes how returned cursors are observed. It works with the default dependency settings. A join that both reads parents and returns a frequently changing child ID list can also set `cursorDependencies: 'onRead'` to skip reruns on edits to returned children.

Incremental observation supports native server Mongo queries with one top-level `$in` containing up to 256 distinct string IDs. Additional top-level filters can be scalar equality conditions, and simple field projections are supported. Other queries use standard observation, including sorted or paginated windows, nested selectors, ObjectID lists, transforms and custom cursors. Keep the default `'standard'` strategy for short-lived subscriptions or lists that rarely change.

**Expected gain.** On lists with small, frequent membership changes, the saved-post query used **about 61% less Meteor process CPU per write** and client update latency at p95 fell **about 52%**. A foreign-key join on `postId` used **about 24% less CPU**, with **about 17% shorter** p95 delivery. Both the standard and incremental runs used `cursorDependencies: 'onRead'`. Incremental observation opens more observers at subscription time. The foreign-key case also increased MongoDB reads to track documents that can move between groups. [Incremental observation measurements](./bench/PUBLICATION-MEASUREMENTS.md#incremental-observation)
