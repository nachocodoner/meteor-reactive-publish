# Changelog

All changes to `nachocodoner:reactive-publish` are documented here.

---

## [1.2.0-beta.0]

### Publication lifecycle

Publication readiness waits for the initial asynchronous queries. Each subscriber keeps its own documents when cursors change. If a returned cursor and a second autorun publish the same document, the client receives its removal when the last owner releases it.

Unchanged cursors reuse their observers. Replaced cursors release their observers and cleanup callbacks, and stale dependencies are cleared on rerun. User callbacks registered with `this.onStop` in the publication keep their subscription lifetime. Callbacks registered inside a custom private `_publishCursor` hook run when that cursor retires. Subscription metadata is created on the first use of the data API.

Nested publication autoruns keep their own dependencies across `await` and reuse a child's cursor when the query stays the same. When a parent changes during startup, readiness waits for the replacement child. Documents the replacement still publishes stay on the client, and documents leave once their last owner releases them. [Nested publication example](./README.md#nest-an-autorun-inside-a-lookup)

### Per-autorun options

- Use `countDependencies: 'membership'` for counters such as the number of open tickets. This one option enables read tracking and skips recounts on field edits that leave the matching IDs unchanged.
- Use `cursorDependencies: 'onRead'` for a join that reads parent documents and returns a live child cursor. Child edits reach the client through the cursor. The default `'onFind'` also tracks cursor creation.
- Use `returnedCursorStrategy: 'incremental'` for a long-lived publication over a changing list of IDs. Eligible queries reuse observers for IDs that remain selected. The default is `'standard'`. [Examples and measured tradeoffs](./PUBLICATION-OPTIONS.md)

### TypeScript

Meteor 3.6 apps can load this package's declarations with `meteor types`. This includes autocomplete for all three autorun options and types for the data a client reads from its subscription. Earlier Meteor 3 apps can continue using `zodern:types`. [TypeScript setup](./README.md#typescript-support)

### Benchmarks and testing

The repository includes a reproducible benchmark for reactive publications. It checks what each DDP client receives and whether resources are released after unsubscribe. Reports cover Meteor process CPU, delivery latency, traffic and observer activity. Ordinary package tests run on Meteor 3.3.2 and 3.6 in pull requests. [Benchmark commands](./bench/README.md)

---

## [1.1.1]

### Fixes

- Fixed reactivity preservation with skipped 'added' callbacks in ReactiveMongoServer ([#8](https://github.com/nachocodoner/meteor-reactive-publish/pull/8))

---

## [1.1.0] Reactive Derived Data Publish

This release introduces **derived data publishing** ([peerlibrary:subscription-data](https://github.com/peerlibrary/meteor-subscription-data)), a way to push arbitrary reactive values to clients alongside (or instead of) cursor data, without restarting subscriptions.

### What's New

**`pub.setData(key, value)` / `pub.data(key)`**

Publish any value: counts, stats, aggregation results, external state, directly to the client as reactive subscription data. Clients read it with `sub.data(key)`, which is reactive via `Tracker`.

**Client-to-server data flow**

Clients can also push data back to the server via `sub.setData(key, value)`. The publication reacts to it (e.g. a `limit` for pagination), enabling patterns like infinite scroll without restarting the subscription.

**Works inside `autorun`**

Call `pub.setData()` inside `this.autorun()` to make derived values reactive, they recalculate whenever their dependencies change.

### Highlights

- **Infinite scroll with reactive count**: publish a paginated window and a live total count; clients adjust the limit on the fly.
- **External reactive sources**: push data from APIs, intervals, or third-party services to clients using `setData`.
- **Derived stats via aggregation**: run Mongo aggregation pipelines reactively and stream results as subscription data.

See [examples in README →](./README.md#reactive-derived-data-publish)

---

## [1.0.0] Reactive Composed Data Publish

Initial release. Brings reactive publishing with async support to **Meteor 3**, reviving and modernizing the work from [peerlibrary:reactive-publish](https://github.com/peerlibrary/meteor-reactive-publish) for the fiber-free environment.

### What's New

**`this.autorun(fn)` in publications**

Run an autorun block inside a publication. When reactive dependencies change, the block reruns and the published cursors update, without restarting the subscription. Supports `async` functions.

**`Meteor.publishReactive(name, fn)`**

Shorthand for publications with a single autorun. Cleaner syntax for the most common reactive publish pattern.

**`AsyncTracker` and `ReactiveVarAsync`**

Async-safe reactivity primitives for the server. `ReactiveVarAsync` lets you drive autoruns from external async sources (e.g. timed intervals, API polling).

**Unique cursors per computation**

Cursors are deduplicated per autorun computation to avoid redundant re-instantiation on rerun.

### Highlights

- **Reactive composed data**: publish related collections that update when foreign keys change (e.g. user's subscribed posts).
- **Time-based queries**: use `ReactiveVarAsync` with `setInterval` to republish data on a schedule.
- **Multiple autoruns**: define independent autorun blocks in one publication for fine-grained reactive triggers per collection.

See [examples in README →](./README.md#reactive-composed-data-publish)
