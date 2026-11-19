# Tuning publication autoruns

In 1.2.0-beta.0, existing publications reuse observers for unchanged returned cursors, drop obsolete dependencies, and release retired cursors' cleanup callbacks. Start with the defaults. Consider the following options when a busy publication repeatedly reads the same parents or changes a list of related IDs.

| Option | Default | When to opt in |
| --- | --- | --- |
| `cursorDependencies` | `'onFind'` | Choose `'onRead'` when edits to a cursor you only return should reach the client without executing your function again. |
| `returnedCursorStrategy` | `'standard'` | Try `'incremental'` when a long-lived publication changes a small part of a returned Mongo cursor's `$in` list at a time. |

## Keep the same publication function

Suppose each subscriber can read the comments on their own posts. The function reads post IDs and returns a live cursor for the comments.

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
  returnedCursorStrategy: 'incremental',
});
```

In a publication with several autoruns, pass the options to the one that needs them. The same function works with either API.

```js
Meteor.publish('myActivity', async function () {
  await this.autorun(commentsOnMyPosts, {
    cursorDependencies: 'onRead',
    returnedCursorStrategy: 'incremental',
  });
});
```

Each autorun gets its own options when it is created. Sibling and nested autoruns use their own defaults. You can enable either option by itself. A standalone server `AsyncTracker.autorun(fn, { cursorDependencies: 'onRead' })` supports read tracking too. The returned cursor strategy is specific to publications.

## Decide what should rerun

With `'onRead'`, editing a comment in the example updates the client through the publication observer. Adding a post for this subscriber reruns the function and selects the new set of comments. The projection only reads post IDs, so editing a post title alone leaves the parent result unchanged.

Supported server Mongo cursor reads include `fetchAsync`, `mapAsync`, `forEachAsync`, `countAsync`, and `fetch`. Reading the comments to derive another query makes their changes a dependency too. A raw Mongo aggregation does not establish an autorun dependency. Local in-memory collections keep their existing cursor-creation behavior. Other reactive inputs, such as `ReactiveVarAsync` and subscription data, retain their usual behavior.

Keep `'onFind'` when an unconsumed `find()` declares a dependency for an aggregation, a call to `setData`, or another side effect. Under `'onRead'`, the initial execution can produce the right value while later writes leave it stale.

## Decide how to observe a changing list

With standard observation, an unchanged cursor keeps its observer. Replacing the cursor with a new selector starts a new observation. Incremental observation lets the package retain observation work for IDs that still match across reruns.

For example, changing the selected posts from A and B to A, B and C can reuse work for A and B. The publication function still executes and produces its usual cursor. A global sort and limit, such as the latest ten comments across all posts, uses standard observation to preserve that window.

A saved-posts list is another candidate. Its returned cursor matches the posts directly by `_id`, which stays fixed for each document. This publication selects incremental observation and keeps the default cursor dependency behavior.

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

In this beta, an eligible selector has one top-level `$in` over at most 256 distinct string IDs. Other top-level filters can use string, boolean, or finite numeric equality. Simple top-level field projections work. Local collections, ObjectID lists, transforms, nested operators, sorted or paginated cursors, and cursors with their own publication hook use standard observation. Keep the standard strategy if another package patches Meteor’s native cursor publication methods. Your function can return a mix of eligible and ordinary cursors from different collections.

The observer works in small groups of IDs. It can keep a whole group when every ID in it is still selected. A document can match more than one group through an array-valued field and still appears once on the client. When a foreign-key query spans multiple groups, a separate observer tracks just the matching document IDs. This keeps a document on the client when its foreign key moves between groups. A query on immutable `_id` needs no additional membership observer.

Measure initial subscription readiness as well as update cost. Stable selectors, frequent replacement of the whole list, and short-lived subscriptions have less opportunity for reuse. Compare the strategies on the same data and write pattern, and check that removals, projected fields and readiness match.

## What changed in the beta benchmark

Four subscribers watched the same data on Meteor 3.6. Each run changed one selected ID at a time for 120 writes. The table shows means from five pairs of runs, alternating strategy order and keeping `cursorDependencies: 'onRead'` on both sides. Both strategies delivered the same DDP messages and payload bytes, and released their observers after unsubscribe.

| Returned query | App CPU per write, standard → incremental | Initial subscription ready, standard → incremental | Initial observer handles across four clients |
| --- | ---: | ---: | ---: |
| Saved posts selected by `_id` | 20.8 → 8.1 ms | 5.3 → 7.2 ms | 12 → 36 |
| Comments selected by `postId` | 36.0 → 27.4 ms | 14.2 → 15.8 ms | 12 → 40 |

The saved-posts case also did less database work. In a separate 36-write Mongo profile, reads per write fell from 10 to 6. For the foreign-key query, reads rose from 14.5 to 16.5 with the extra membership observer. Start with the saved-ID case if repeated changes to a long-lived list are expensive. Compare both application and database costs for foreign-key queries. [Reproduce the benchmark](./bench/README.md)
