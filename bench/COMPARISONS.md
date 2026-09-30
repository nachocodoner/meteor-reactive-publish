# Comparing reactive-publish with publish-composite

The suite pins `reywood:publish-composite@1.9.0`. On 2026-09-30, both `meteor show reywood:publish-composite --show-all` and the [upstream latest release](https://github.com/Meteor-Community-Packages/meteor-publish-composite/releases/latest) identified 1.9.0 as the latest published stable release. Its [versioned package manifest](https://github.com/Meteor-Community-Packages/meteor-publish-composite/blob/v1.9.0/package.js) declares Meteor 3.0 compatibility alongside older Meteor releases. The benchmark builds and runs this release on the pinned Meteor 3.3.2 runtime; package compatibility does not imply that every workload passes correctness.

The runtime pin and resolved Meteor graph stay fixed during measurements. There is no floating `latest` dependency or automatic package update during a comparison. Refresh the catalog and review `config/runtime-lock.json` plus the variant version locks when deliberately updating a competitor.

From the repository root:

For the recommended full resource comparison, run **`npm run bench:comprehensive -- --output bench/results/comprehensive`**. Its default uses five pairs, 100 warmup and 1,000 measured operations in each core run, plus separate sustained-load, post-GC retention, and Mongo query diagnostic stages. It generates a single HTML/Markdown/JSON report. Use `--dry-run` to inspect the workload or `--preset quick` to validate setup. Detailed boundaries and override examples are in [README.md](./README.md).

For all implemented scenarios, native controls, backend primitives, and automatic comparisons in one HTML/Markdown/JSON report, use `npm run bench:all -- --output bench/results/full`. The `libraries` commands below focus specifically on the shared composite/reactive workload contracts.

```sh
npm run bench:setup

# Quick comparison of the small validated common subset (six app runs).
npm run bench:libraries -- --suite smoke --pairs 1 --output bench/results/libraries-smoke

# Audit all nine semantically equivalent workloads, including known failures.
npm run bench:libraries -- --suite compatible --pairs 1 --output bench/results/libraries-compatible

# Repeated measurements of one case at a larger scale.
npm run bench:libraries -- --scenario sorted-window --profile standard --pairs 5 --output bench/results/libraries-sorted

# Offered-rate comparison; only the fanout workload accepts --rate.
npm run bench:libraries -- --scenario fanout --clients 25 --operations 100 --rate 20 --pairs 5
```

The default is `--suite smoke --profile smoke --pairs 1`. `--scenario` selects one compatible case instead of the suite. One pair tests execution and produces descriptive numbers; it cannot establish a speed difference. At least five pairs are required for uncertainty estimates, and each run needs at least 20 observations for a p95 comparison. Use `standard` for fuller sample counts and calibrate the available machine before escalating load.

Each pair runs composite then reactive, reversing that order on the next pair. The runner starts fresh isolated production apps and databases sequentially. Both sides share the seed, fixture, operations, projections, client count, warmup, observation windows, runtime, and independent expected-state oracle. It permits idiomatic query implementations: composite can create child publications per parent while reactive-publish consolidates dependency IDs. Measuring those different algorithms is part of the comparison.

| Case                     | Common observable behavior                                                                   | Included in smoke |
| ------------------------ | -------------------------------------------------------------------------------------------- | ----------------- |
| `plain-cursor`           | Active-post CRUD, membership changes, projected fields and field clearing                    | No                |
| `dependent-posts`        | Reader document and exactly its referenced posts after replacing IDs                         | No                |
| `one-to-many`            | Active posts and their comments after child moves, parent membership changes and child edits | No                |
| `deep-join`              | Posts → comments → deduplicated authors through relationship changes                         | No                |
| `shared-children`        | Posts sharing author documents; removal only after the final reference disappears            | Yes               |
| `projection-sensitivity` | Included projection with excluded-field, equal-value and relationship writes                 | No                |
| `sorted-window`          | Two highest-ranked posts with stable ID tie-breaking and changing membership                 | Yes               |
| `subscription-churn`     | Identical data after readiness and empty publication data after unsubscribe                  | Yes               |
| `fanout`                 | Uniquely identified inserts delivered to all persistent subscribers                          | No                |

These are _semantically comparable_ cases. Current correctness findings prevent some of them from producing valid timing comparisons; see [FINDINGS.md](./FINDINGS.md). On the first invalid pair, the runner retains both sides, stops further repetitions of that case, and continues to the other cases. It does not retry or filter away failures to obtain passing timing samples.

Reactive-only subscription data, infinite scrolling without resubscription, derived values, external dependencies, multiple autoruns and async-pressure cases are explicitly listed as excluded. Equivalent application-level emulations could be added later with separate workload names; no unsupported cell is treated as zero cost. Backend primitives and browser-specific package APIs also remain separate from this cross-library DDP comparison.

Each output directory contains an aggregate `comparison.md`/`comparison.json`, raw per-run results, logs, and per-library manifests. The report labels publish-composite as the baseline and reactive-publish as the candidate. Positive percentages mean the metric increased: lower costs and higher throughput are preferable; event-loop utilization is contextual. `compared` means the data and configuration were valid, not that a statistically supported winner exists. Timing remains advisory. Exit 2 means at least one case was blocked by correctness, execution, or incompatible measurements.

The comparator rejects mismatched runtime/fixtures/harness, different versions of shared Meteor packages, and mixed source or package versions within repetitions. Each library's additional dependencies and metadata traffic remain part of its measured cost. For repeated comparisons, the report distinguishes higher cost, lower cost, and no clear difference per metric instead of assigning an overall library ranking.

Saved manifests can also be compared directly:

```sh
npm run bench:compare -- --mode library \
  --baseline bench/results/libraries-sorted/sorted-window/composite.json \
  --target bench/results/libraries-sorted/sorted-window/reactive.json
```
