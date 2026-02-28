# Changelog

All changes to `nachocodoner:reactive-publish` are documented here.

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
