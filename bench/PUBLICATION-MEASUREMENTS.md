# Publication performance measurements

These comparisons cover default upgrades, cursor reads, incremental observation, nested autoruns and application-level tuning. Each percentage applies to the workload and baseline in its section. [Publication options](../PUBLICATION-OPTIONS.md) · [Reactive count measurements](./COUNT-MEMBERSHIP.md#measured-effect)

## What an upgrade gives you by default

**Direct upgrade from 1.1.1 to 1.2.0-beta.0.** Four subscribers watched the two highest-scoring posts from a collection of 200 on Meteor 3.6. The publication used default settings throughout. Five alternating pairs each ran 12 warmup writes and 120 measured writes per version.

| Metric | 1.1.1 | Beta | Change on this workload |
| --- | ---: | ---: | --- |
| Application CPU per write | 8.46 ms | 5.94 ms | **29.7% less CPU** |
| Time for a client update to arrive, p95 | 4.36 ms | 3.17 ms | **27.3% shorter** |
| Observer handles created per measured write | 8 | 0 | The beta reused the existing observers |
| Cleanup callbacks retained after 120 writes | 977 | 17 | **98.3% fewer** |

Both versions began with 17 callbacks. Every run executed the autoruns 960 times, delivered the same 1,320 DDP messages and 148,632 payload bytes, and released resources on unsubscribe. The saving came from doing less work during the same reruns. [Reproduce the upgrade comparison](./README.md#reproduce-the-default-upgrade-comparison)

**How individual changes contributed.** Earlier release checkpoints compared each change with its immediate predecessor. Each row below used five alternating pairs and 25 subscribers. The workloads and baselines differ, so each percentage applies to its own row.

| Change | Workload | Application CPU per write | Other measured effect |
| --- | --- | ---: | --- |
| Release unused dependencies and reuse unchanged returned observers | Sorted window, 1,000 writes, Meteor 3.3.2 | 14.35 → 8.42 ms (**41.3% less**) | Sampled peak JS heap fell **63.2%**. [Report](./FINDINGS.md) |
| Look up an already cached cursor directly | Sorted window, 1,000 writes, Meteor 3.6 | 6.45 → 6.05 ms (**6.1% less**) | Client update p95 rose 0.055 ms. [Report](./INSTRUMENTED-OPTIMIZATION.md#repeated-revision-comparison) |
| Release cleanup callbacks as returned cursors are replaced | Three-collection join, 300 writes, Meteor 3.6 | 207.10 → 175.12 ms (**15.4% less**) | Sampled peak process memory fell **75.4%**, from 2.745 to 0.675 GB. [PR measurements](https://github.com/nachocodoner/meteor-reactive-publish/pull/10) |

In a separate check with both beta options omitted, the beta retained 21 cleanup callbacks after 120 mixed writes, compared with 181 on the PR head before cursor cleanup (**88.4% fewer**). Both delivered the same 1,240 DDP messages. Plain cursor publications also send **zero subscription-metadata messages** until the data API is used. The newer document-ownership and selector-option cache changes have no isolated timing measurement. [Metadata verification](./CI-REPAIR.md#subscription-metadata)

## Read tracking

In a beta comparison with four subscribers and 120 mixed writes to posts and comments, changing only `'onFind'` to `'onRead'` cut autorun executions from **320 to 160 (50% fewer)**. Application CPU per write fell from 27.53 to 18.40 ms (**33.1% less**). Both runs used `'standard'` observation and delivered the same 1,240 DDP messages and 134,679 payload bytes. The timing comes from one run per mode.

An earlier experiment repeated each mode six times with ten subscribers and 200 writes per run. Read tracking reduced application CPU by **35.9%** for a one-to-many join (23.16 to 14.86 ms/write) and by **6.8%** for a three-collection join (25.02 to 23.31 ms/write). In the deeper join, the function *reads* comments to find their authors, so comment changes still rerun it. [Benchmark commands](./README.md)

## Incremental observation

Four subscribers watched the same data on Meteor 3.6. Each run changed one selected ID at a time for 120 writes. The table shows means from five pairs of runs, alternating strategy order and keeping `cursorDependencies: 'onRead'` on both sides. Both strategies delivered the same DDP messages and payload bytes, and released their observers after unsubscribe.

| Returned query | App CPU per write, standard → incremental | Client update p95 | Initial ready time | Initial observer handles across four clients |
| --- | ---: | ---: | ---: | ---: |
| Saved posts selected by `_id` | 20.83 → 8.14 ms (**60.9% less**) | 17.25 → 8.23 ms (**52.3% shorter**) | 5.33 → 7.22 ms | 12 → 36 |
| Comments selected by `postId` | 36.01 → 27.39 ms (**23.9% less**) | 30.77 → 25.47 ms (**17.2% shorter**) | 14.24 → 15.79 ms | 12 → 40 |

In a separate 36-write Mongo profile, the saved-posts case used **40% fewer reads** per write (10 to 6). For the foreign-key query, the extra membership observer increased reads **13.8%** (14.5 to 16.5). Start with the saved-ID case if repeated changes to a long-lived list are expensive. Measure both application and database costs for foreign-key queries. [Reproduce the benchmark](./README.md)

## Nested autoruns

One Meteor 3.6 DDP subscriber watched an item selected by two inputs. A Mongo lookup supplied the group ID, and a reactive filter selected the item within that group. The flat publication read both inputs in one autorun. The nested publication read the group in the parent and applied the filter in one child. Both used `cursorDependencies: 'onRead'` and standard cursor observation.

Four paired trials alternated the two publications. Each group had one item for each filter value, 0 or 1. The same-selector check changed the input while clamping the effective filter to 1. Each row shows the server work for 20 updates of the indicated kind. The client received the same documents in both versions.

| Update | Flat publication | Nested publication |
| --- | --- | --- |
| Change the child filter | 20 group lookups | 0 group lookups |
| Switch the selected group | 20 runs of the single autorun | 20 parent runs, each stopping the old child and starting a new one |
| Edit a field on the published item | 0 autorun executions | 0 autorun executions |
| Change the filter input but keep the same effective selector | 0 new observer handles | 0 new observer handles |

Nesting saved the parent lookup when the child filter changed independently. A frequently changing parent paid for child setup on every switch. Each child now reuses its own cursor when the selector and options stay the same. The previous beta candidate (`f95cf57`) created 20 observer handles on that last workload. [Complete nested publication](../README.md#nest-an-autorun-inside-a-lookup)

The default sorted-window workload also ran against `f95cf57` and the nested lifecycle changes. With four subscribers and 120 measured writes, both builds executed 960 autoruns, created zero observer handles during those writes, retained 17 cleanup callbacks and sent the same 1,320 DDP messages and 148,632 payload bytes. The four short pairs averaged 7.0% more Meteor CPU per write on the candidate.

Four longer pairs compared the final runtime (`3bc939f`) with the same baseline, using 60 warmup writes and 400 measured writes per run. Both builds executed 3,200 autoruns, opened zero new observer handles during those writes, and sent identical DDP traffic. The candidate averaged **4.5% more CPU per write** and **3.7% longer p95 client update time**. Three CPU pairs differed by about 2% or less. The fourth measured 20.8% more CPU per write. The harness classifies the timing result as inconclusive. To repeat these runs from `3bc939f`, use the sorted-window command with `--base f95cf57 --warmup 60 --operations 400 --pairs 4`. [Benchmark command](./README.md#reproduce-the-default-upgrade-comparison)

## Application-level tuning

The parent-projection and comparator checks used application-level changes with the beta publication options left at their defaults. Eight title changes triggered eight reruns when the parent query fetched full posts and zero when it selected only post IDs. Both readers reacted to a change of owner. [Projection test](../lib/CursorDependencyModes.tests.js)

With a fresh filter object on each refresh, eight equivalent refreshes followed by a category change caused nine reruns with default equality and one with `EJSON.equals`. Both readers saw the final category. [Equality test](../lib/ReactiveAsync/ReactiveVarAsync.tests.js)

Four subscribers watched comments on posts selected by a shared `{ active }` filter. Each run used 200 posts, four comments per post and 120 operations. Every four operations included an equivalent filter refresh, a parent title edit, a real filter switch and a comment edit. Five rounds on Meteor 3.6 compared the same publication in all four configurations, with both autorun options at their defaults.

| Application code | Autorun executions per run | Application CPU per operation | CPU reduction from default |
| --- | ---: | ---: | ---: |
| Full parent documents, default filter equality | 480 | 22.96 ms | Baseline |
| Project parent IDs only | 360 | 21.16 ms | **7.8%** |
| Use `EJSON.equals` for the filter only | 360 | 21.81 ms | **5.0%** |
| Use both | 240 | 20.71 ms | **9.8%** |

With both tunings, the publication skipped **half its executions**. The 60 operations that changed visible comments still had to reach all four clients. Every run delivered the same 96,480 DDP messages and 10,478,825 payload bytes. Client update p95 was 61.03 ms with the defaults and 60.86 ms with both choices. This workload showed a server CPU saving with similar client latency. [Run the four-way comparison](./README.md#compare-parent-projections-and-filter-equality)
