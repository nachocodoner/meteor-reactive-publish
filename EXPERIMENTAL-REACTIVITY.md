# Tuning publication autoruns

Upgrading to 1.2.0-beta.0 automatically reuses observers for unchanged returned cursors, drops obsolete dependencies, and releases retired cursors' cleanup callbacks. The beta also adds two opt-in publication settings. You enable either one when registering a function with `Meteor.publishReactive` or `this.autorun`.

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

In a beta comparison with four subscribers and 120 mixed writes to posts and comments, changing only `'onFind'` to `'onRead'` cut autorun executions from **320 to 160 (50% fewer)**. Application CPU per write fell from 27.53 to 18.40 ms (**33.1% less**). Both runs used `'standard'` observation and delivered the same 1,240 DDP messages and 134,679 payload bytes. The timing comes from one run per mode.

An earlier experiment repeated each mode six times with ten subscribers and 200 writes per run. Read tracking reduced application CPU by **35.9%** for a one-to-many join (23.16 to 14.86 ms/write) and by **6.8%** for a three-collection join (25.02 to 23.31 ms/write). In the deeper join, the function *reads* comments to find their authors, so comment changes still rerun it. [Benchmark commands](./bench/README.md)

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

## What an upgrade gives you by default

**Direct upgrade from 1.1.1 to 1.2.0-beta.0.** Four subscribers watched the two highest-scoring posts from a collection of 200 on Meteor 3.6. The publication used default settings throughout. Five alternating pairs each ran 12 warmup writes and 120 measured writes per version.

| Metric | 1.1.1 | Beta | Change on this workload |
| --- | ---: | ---: | --- |
| Application CPU per write | 8.46 ms | 5.94 ms | **29.7% less CPU** |
| Time for a client update to arrive, p95 | 4.36 ms | 3.17 ms | **27.3% shorter** |
| Observer handles created per measured write | 8 | 0 | The beta reused the existing observers |
| Cleanup callbacks retained after 120 writes | 977 | 17 | **98.3% fewer** |

Both versions began with 17 callbacks. Every run executed the autoruns 960 times, delivered the same 1,320 DDP messages and 148,632 payload bytes, and released resources on unsubscribe. The saving came from doing less work during the same reruns. [Reproduce the upgrade comparison](./bench/README.md#reproduce-the-default-upgrade-comparison)

**How individual changes contributed.** Earlier release checkpoints compared each change with its immediate predecessor. Each row below used five alternating pairs and 25 subscribers. The workloads and baselines differ, so each percentage applies to its own row.

| Change | Workload | Application CPU per write | Other measured effect |
| --- | --- | ---: | --- |
| Release unused dependencies and reuse unchanged returned observers | Sorted window, 1,000 writes, Meteor 3.3.2 | 14.35 → 8.42 ms (**41.3% less**) | Sampled peak JS heap fell **63.2%**. [Report](./bench/FINDINGS.md) |
| Look up an already cached cursor directly | Sorted window, 1,000 writes, Meteor 3.6 | 6.45 → 6.05 ms (**6.1% less**) | Client update p95 rose 0.055 ms. [Report](./bench/INSTRUMENTED-OPTIMIZATION.md#repeated-revision-comparison) |
| Release cleanup callbacks as returned cursors are replaced | Three-collection join, 300 writes, Meteor 3.6 | 207.10 → 175.12 ms (**15.4% less**) | Sampled peak process memory fell **75.4%**, from 2.745 to 0.675 GB. [PR measurements](https://github.com/nachocodoner/meteor-reactive-publish/pull/10) |

In a separate check with both beta options omitted, the beta retained 21 cleanup callbacks after 120 mixed writes, compared with 181 on the PR head before cursor cleanup (**88.4% fewer**). Both delivered the same 1,240 DDP messages. Plain cursor publications also send **zero subscription-metadata messages** until the data API is used. The newer document-ownership and selector-option cache changes have no isolated timing measurement. [Metadata verification](./bench/CI-REPAIR.md#subscription-metadata)

## What incremental observation costs and saves

Four subscribers watched the same data on Meteor 3.6. Each run changed one selected ID at a time for 120 writes. The table shows means from five pairs of runs, alternating strategy order and keeping `cursorDependencies: 'onRead'` on both sides. Both strategies delivered the same DDP messages and payload bytes, and released their observers after unsubscribe.

| Returned query | App CPU per write, standard → incremental | Client update p95 | Initial ready time | Initial observer handles across four clients |
| --- | ---: | ---: | ---: | ---: |
| Saved posts selected by `_id` | 20.83 → 8.14 ms (**60.9% less**) | 17.25 → 8.23 ms (**52.3% shorter**) | 5.33 → 7.22 ms | 12 → 36 |
| Comments selected by `postId` | 36.01 → 27.39 ms (**23.9% less**) | 30.77 → 25.47 ms (**17.2% shorter**) | 14.24 → 15.79 ms | 12 → 40 |

In a separate 36-write Mongo profile, the saved-posts case used **40% fewer reads** per write (10 to 6). For the foreign-key query, the extra membership observer increased reads **13.8%** (14.5 to 16.5). Start with the saved-ID case if repeated changes to a long-lived list are expensive. Measure both application and database costs for foreign-key queries. [Reproduce the benchmark](./bench/README.md)

## Optional application code changes

These are application tuning suggestions. Both APIs were already available in 1.1.1. To use the first, edit the parent query inside your publication function. To use the second, edit the code that constructs your reactive variable. The comparison rule applies to all subscribers reading that variable. You can use either beta publication setting without making these edits.

**Read only the parent fields that affect the join.** In `commentsOnMyPosts`, the parent query uses `{ fields: { _id: 1 } }` because the child selector needs only post IDs. If a title changes, the IDs are still the same. If a post changes owner, the selector's membership changes and the comments update. A regression compares the same parent read with and without this projection using default package settings. Eight successive title edits cause eight extra executions with full documents and zero with the ID projection. Both readers rerun on the ownership change. A function that uses the title must include it in the projection. [Projection test](./lib/CursorDependencyModes.tests.js)

**Skip duplicate values from an external source.** Suppose a settings service refreshes the category of a site-wide public feed. It sends a fresh object on every poll. Set an equality function on the `ReactiveVarAsync` that holds that filter.

```js
import { EJSON } from 'meteor/ejson';
import { ReactiveVarAsync } from 'meteor/nachocodoner:reactive-publish';

const feedFilter = new ReactiveVarAsync({ category: 'news' }, EJSON.equals);

Meteor.publishReactive('publicFeed', () => {
  const { category } = feedFilter.get();
  return Posts.find({ visibility: 'public', category });
});

async function applyFeedSettings({ category }) {
  await feedFilter.set({ category });
}
```

The default equality check treats an object assignment as a change. With this comparator, receiving `'news'` again keeps the current value and skips every dependent autorun. Receiving `'events'` updates the feed. Pass a fresh object for each refresh and compare every field your consumers need. In the package test, eight equivalent refreshes plus one real category change caused **nine reruns by default and one with `EJSON.equals`**. Both readers saw the new category. [Equality test](./lib/ReactiveAsync/ReactiveVarAsync.tests.js)

### What these choices saved on a live feed

Four subscribers watched comments on posts selected by a shared `{ active }` filter. Each run used 200 posts, four comments per post and 120 operations. Every four operations included an equivalent filter refresh, a parent title edit, a real filter switch and a comment edit. Five rounds on Meteor 3.6 compared the same publication in all four configurations, with both autorun options at their defaults.

| Application code | Autorun executions per run | Application CPU per operation | CPU reduction from default |
| --- | ---: | ---: | ---: |
| Full parent documents, default filter equality | 480 | 22.96 ms | Baseline |
| Project parent IDs only | 360 | 21.16 ms | **7.8%** |
| Use `EJSON.equals` for the filter only | 360 | 21.81 ms | **5.0%** |
| Use both | 240 | 20.71 ms | **9.8%** |

With both tunings, the publication skipped **half its executions**. The 60 operations that changed visible comments still had to reach all four clients. Every run delivered the same 96,480 DDP messages and 10,478,825 payload bytes. Client update p95 was 61.03 ms with the defaults and 60.86 ms with both choices. This workload showed a server CPU saving with similar client latency. [Run the four-way comparison](./bench/README.md#compare-parent-projections-and-filter-equality)
