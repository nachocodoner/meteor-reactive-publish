# Reactive publish benchmark implementation plan

Create a repository-owned benchmark suite that measures publication correctness, latency, resource use, and scaling. The primary workload uses real Meteor servers, MongoDB, and Node DDP clients without a UI. Add backend benchmarks for diagnosis and a small browser suite for the actual Meteor client APIs.

The initial implementation now lives in this directory. See [README.md](./README.md) for commands and measurement boundaries and [FINDINGS.md](./FINDINGS.md) for observed correctness failures. Reproducible app variants, DDP validation, backend measurements, sixteen scenario definitions, paired comparisons, local diagnostics, and CI configuration are implemented. There is no approved timing baseline or universal library ranking.

The milestones below retain the broader roadmap. Full acceptance of the library matrix is pending the documented correctness investigations. CI blocks on a validated smoke subset and retains an explicitly non-blocking extended matrix. Comprehensive paired comparisons now cover Node runtime costs, offered-rate load points, post-GC subscription-retention checkpoints, and separate Mongo process/query diagnostics. Remaining extensions include stop-during-initialization/reconnect benchmark workloads, personalized/overlapping selectors, async bursts and cancellation, adaptive capacity searches, longer multi-workload retention studies, heap snapshots, and dashboard views. The small browser check currently covers subscription data, not client async context or reconnection.

Implementation adjustments: infrastructure uses the pinned Meteor release's bundled MongoDB in an owned loopback replica set instead of Docker; this records the actual Mongo patch version and removes a container prerequisite. Node collectors run directly inside the application; an optional local meteor/performance exporter is implemented without copying its collectors or requiring a dashboard deployment.

The suite should answer two distinct questions: whether a change regresses reactive-publish, and how equivalent workloads behave across libraries. Keep those reports separate. A library comparison must state the scenario, scale, runtime, correctness contract, and resource tradeoffs rather than produce a universal winner.

**Implementation decisions are as follows.**

| Area            | Decision                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership       | Keep workloads, fixtures, adapters, validation, results schema, and regression policy in this repository.                                                               |
| Main execution  | Use Node DDP clients against production Meteor builds and a dedicated Mongo replica set.                                                                                |
| Isolation       | Build separate app variants for native Meteor, native publications with reactive-publish installed, reactive-publish, and publish-composite. Run variants sequentially. |
| Local package   | Build the package from the selected checkout. Record its revision and content hash, including local modifications.                                                      |
| Initial runtime | Pin Meteor 3.3.2 to match the existing package CI. Use its bundled MongoDB and Node executables and record their actual versions.                                       |
| Harness runtime | Use Node 22 initially, matching the repository's existing tooling. Maintain a separate bench dependency lockfile.                                                       |
| Competitor      | Start with publish-composite 1.9.0, subject to its compatibility smoke check. Commit resolved Meteor package versions.                                                  |
| Monitoring      | Collect lightweight measurements locally. Add selected revision-pinned meteor/performance instrumentation after validating its semantics and overhead.                  |
| CI policy       | Block on correctness and invalid execution. Begin with advisory performance reports; enable timing gates after calibration.                                             |
| Scope           | First measure one server. Add alternative observer drivers, transports, browser behavior, and additional libraries in later milestones.                                 |

The isolation requirement comes from the package's global publication, cursor, and subscription-data wrappers in [ReactivePublishServer.js](../lib/ReactivePublishServer.js), [ReactiveMongoServer.js](../lib/ReactiveMongo/ReactiveMongoServer.js), and [ReactiveData.js](../lib/ReactiveData/ReactiveData.js). Selecting a different publication inside one app would not provide a clean native or competitor baseline.

**Use the following repository layout.** Generated workspaces and outputs stay outside the source app templates, so building a benchmark cannot recursively include the benchmark workspace through the local package.

```text
bench/
  PLAN.md
  README.md
  package.json
  package-lock.json
  cli.mjs
  config/
    profiles.mjs
    runtime-lock.json
  app/                         # template, in-process metrics and backend checks
  variants/                    # resolved Meteor package version locks
    native/
    installed/
    reactive/
    composite/
  fixtures/
  scenarios/
  adapters/
  clients/
    ddp-client.mjs
    document-store.mjs
  runner/                      # builds, owned Mongo, lifecycle and measurements
  reporting/                   # validation, metric registry and comparisons
  tests/
  baselines/                   # policies and reviewed baseline references
  results/                     # ignored raw outputs and reports
```

Add root npm entrypoints for `bench`, `bench:smoke`, `bench:compare`, and `bench:profile` as their implementations land. Add `bench/` to `.meteorignore`, ignore benchmark artifacts and nested Meteor build caches, and link the benchmark README from the existing Performance roadmap. Preserve the current package tests and keep benchmark dependencies under `bench/`.

**Milestone 1 establishes reproducible app execution.**

Implement the CLI, manifests, fixture loader, dedicated Mongo replica set, build cache, and process lifecycle. Support `doctor`, `list`, and `run`; reject unknown scenarios, unsupported adapter combinations, and missing prerequisites before starting measurement.

Generate app workspaces in a temporary directory. Copy or link the selected local package into each applicable workspace and verify the resolved package identity before building. Native and composite variants must not resolve reactive-publish. Exclude benchmark output and build directories when computing the package source hash.

Launch a production bundle with the Node runtime supplied by the pinned Meteor release. Cache builds by package source hash, template hash, manifests, lockfiles, runtime, and instrumentation version. Compilation, package downloads, seeding, and index creation remain outside measured phases.

Create an isolated database per run. Use a seeded generator with fixed IDs, projections, document sizes, and indexes. Record fixture checksums. Restrict reset operations to the database provisioned by the runner. Track child PIDs directly and tear down clients, app processes, and owned infrastructure on success, error, signal, or timeout.

Provide a loopback-only benchmark control surface, protected with a per-run token. It exposes application readiness after seeding, runtime/package metadata, phase start/stop, and a final metrics snapshot. Ordinary HTTP readiness alone is insufficient. Disable unrelated example features such as autopublish, insecure, and accounts unless a scenario explicitly requires them.

Acceptance: a fresh checkout can install bench dependencies, start the pinned infrastructure, build all four variants, verify package isolation, seed identical fixtures, and terminate without orphan processes. The app reports its actual runtime and resolved package graph. Existing package tests continue to pass.

**Milestone 2 implements trustworthy DDP measurement.**

Build a small Node client on `ws` with Meteor-compatible EJSON parsing. Implement DDP connection negotiation, ping/pong, subscriptions, unsubscription, method results and update acknowledgements, errors, and disconnection. Use the direct WebSocket endpoint. Unexpected reconnects invalidate ordinary latency runs; reconnect is an explicit later scenario. Follow the [Meteor DDP specification](https://github.com/meteor/meteor/blob/devel/packages/ddp/DDP.md).

Maintain an incremental document store keyed by collection and document ID. Apply `added`, `changed`, `cleared`, and `removed` correctly. Include anonymous subscription messages, particularly reactive-publish's subscription-data collection. Count total traffic and separate application data from package metadata; do not discard metadata costs from total overhead.

Define a scenario contract containing its version, supported adapters, fixture parameters, publication arguments, operation generator, expected client state, convergence rule, required metrics, and cleanup checks. The expected-state calculation must be independent of publication implementation. Adapters register publications against the common collections and return capability information.

Use explicit phases: prepare, warm up, initialize measurement, exercise, drain, validate, unsubscribe, and clean up. Flush metrics through an acknowledged control call before shutdown. All timing uses monotonic clocks. The controller hosts the writer and observer clients in the initial implementation, so dispatch-to-receipt measurements share one clock.

| Metric                                      | Definition                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `subscription_ready_ms`                     | Client sends `sub` until the matching `ready` arrives. Validate the initial dataset at readiness.                          |
| `update_convergence_ms`                     | Client dispatches a uniquely identified mutation until the expected state is observed.                                     |
| `fanout_completion_ms`                      | Mutation dispatch until every intended subscriber converges. Also report delivery coverage.                                |
| `method_roundtrip_ms`                       | Method dispatch until its result arrives, reported independently of publication delivery.                                  |
| `app_cpu_ms`                                | Application user and system CPU consumed during the measured phase.                                                        |
| `app_rss_bytes`, `app_heap_used_bytes`      | Sampled application memory with peak and end values.                                                                       |
| `ddp_messages`, `ddp_payload_bytes`         | Counts by direction and message type, including package overhead. Payload bytes exclude transport framing and compression. |
| `completed_operations`, `failed_operations` | Actual workload outcomes, used for normalization and validity.                                                             |

Register listeners before mutations. For update/removal operations, correlate expected IDs and revisions; a method result alone does not prove subscriber convergence. For no-output mutations, validate unchanged state at an explicit drain/checkpoint with a bounded observation period and relevant server counters. Report that observation window separately from delivery latency; no absence-of-message latency can be inferred.

Use deadlines rather than arbitrary sleeps to await expected output. Serialized scenarios require every expected transition; later burst scenarios explicitly allow coalescing and validate final state and freshness. Treat timeout, unexpected data, client disconnect, server error, and missing required measurements as failed or invalid runs. Preserve diagnostics even when the process exits nonzero.

Acceptance: protocol tests cover cleared fields, removals, readiness, errors, and unsubscription. Inject a delayed response and confirm the latency measurement increases; suppress an expected update and confirm the run fails. A missing required metric cannot produce a passing result. A plain cursor run produces raw JSON and a readable report with phase boundaries and operation counts.

**Milestone 3 delivers equivalent library scenarios.**

Implement the following small matrix first. `installed` means native publication behavior with reactive-publish loaded; native/installed join cells require explicit manual reactive logic and are outside the initial join comparison.

| Scenario                 | Initial adapters                       | Required mutations and checks                                                                    |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `plain-cursor`           | Native, installed, reactive, composite | Subscribe, insert, change a visible field, clear a field, remove, unsubscribe.                   |
| `dependent-posts`        | Reactive, composite                    | Change a user's post IDs, replace the relationship entirely, change a post, remove a dependency. |
| `one-to-many`            | Reactive, composite                    | Add/remove parent or child, move a child between parents, change parent membership.              |
| `projection-sensitivity` | Reactive, composite                    | Change included fields, excluded fields, relationship fields, and equal values.                  |
| `subscription-churn`     | All applicable adapters                | Repeated subscribe/unsubscribe and disconnect cycles, including stop during initialization.      |

Publish identical public parent and child fields in the join scenarios. The specification must not compare a child-only reactive publication with a composite tree that also publishes parents. Verify shared children remain visible until the last applicable relationship disappears.

Use idiomatic implementations. Reactive-publish may consolidate related IDs into a cursor; publish-composite may use its tree API. Measure the resulting query and observer work instead of forcing identical algorithms. If per-parent limits or another feature cannot be represented equivalently, mark the cell unsupported and implement a distinct scenario later.

Start with explicit, overridable profiles: smoke uses 1–5 clients and a few dozen operations; standard uses 25 clients, 100 parents, and 10 children per parent. These are proposed workload sizes, not validated capacity claims. Vary one dimension at a time and calibrate larger profiles against runner capacity.

Add lightweight observer create/stop/active counts and cleanup checkpoints. Distinguish observer handles from shared Mongo observer multiplexers, and subtract the known infrastructure baseline. Use version-checked instrumentation with an explicit unavailable state. Memory is sampled after drain over repeated cycles; require stable resource counts and analyze memory trends rather than demanding an exact RSS reset.

Acceptance: every adapter passes the same scenario oracle, all expected deliveries occur, and stopped subscriptions release tracked resources within a deadline. Produce a local report comparing correctness, readiness, update latency, CPU, memory, and DDP traffic. Repeat the same adapter to estimate measurement noise before interpreting library differences.

**Milestone 4 adds reliable regression reporting and CI.**

Create a versioned result schema and metric registry. Each metric declares units, whether higher or lower is better, required/optional status, aggregation, and eventual absolute/relative budgets. Record sample counts, timeout counts, raw samples or mergeable histograms, and per-phase summaries. Keep execution validity, correctness, and performance comparison outcomes separate.

Record package revision and content hash, harness/scenario version, adapter, seed, fixture dimensions, locks, Meteor/Node/Mongo versions, build mode, runner CPU/OS, transport, and actual observer-driver counts for the workload. A probe of an unrelated cursor is insufficient to establish the driver used by every scenario query.

Check compatibility before comparing runs. Default regression comparison varies the reactive-publish source while holding harness, scenarios, fixtures, runtime, and hardware class fixed. Library comparisons explicitly permit a different adapter. Runtime experiments explicitly permit a selected runtime change. Reject accidental mismatches.

For PR comparisons, run the current benchmark harness against package snapshots of the base and candidate revisions. This also handles a base revision that predates `bench/`. Use the same workload implementation on both sides and reject unsupported source/runtime combinations. A harness change requires recalibration of historical comparisons.

Begin with five independent paired repetitions of representative scenarios, alternating baseline/candidate order. Exclude warmup and retain all measured repetitions. Compare per-run summaries and report uncertainty; do not treat dependent updates within one run as independent repetitions. Small samples show insufficient evidence for tail statistics. Add more repetitions when observed variance warrants them.

Run an A/A calibration with identical source snapshots before selecting timing budgets. Define both an absolute and relative practical threshold. Zero baselines require absolute comparison; missing data is not zero. Initial CI reports timing differences without failing on them. Later gates require sufficient evidence and a budget violation, with metric-specific policy committed to the repository.

| Workflow            | Behavior                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request        | Run harness validation and a small scenario subset. Block on correctness or invalid execution; publish advisory performance results as job summaries and artifacts. |
| Default branch      | Record successful results with immutable source/configuration metadata.                                                                                             |
| Scheduled or manual | Run paired comparisons, larger profiles, and resource retention checks on a controlled runner.                                                                      |
| Release             | Run the supported library/runtime matrix and retain the report with its reproducible configuration.                                                                 |

Add `.github/workflows/bench.yml` and keep it independent of the existing Tinytest workflow. Measure one app variant at a time per runner. Shared hosted CI provides smoke coverage and advisory measurements; stable timing gates use a calibrated runner. Use artifacts for raw results, logs, and profiles. Store reviewed baseline references and policies in git, with an explicit baseline-promotion command.

Acceptance: known delays and intentionally missing data are correctly classified, metric direction is respected, incompatible results are rejected, and base/candidate package resolution is verified. CI uploads diagnostics on failures. Timing gates remain advisory until A/A calibration supports the selected budgets.

**Milestone 5 covers the remaining public use cases and scale dimensions.**

| Scenario family       | Coverage                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Deep and shared joins | Posts → comments → authors, shared children, multiple subscriptions overlapping documents, per-parent limits where supported.          |
| Multiple autoruns     | Separate versus combined computations for independent related collections.                                                             |
| Sorted windows        | Ranking changes, stable tie-breaking, filters, limit/skip changes, and boundary insertions/removals.                                   |
| Subscription data     | `data`/`setData`, nested values, equal-value suppression, unsets, two-way changes, and isolation between subscribers.                  |
| Infinite scrolling    | Growing and shrinking windows while retaining the subscription; compare resubscription as a separately identified strategy.            |
| Derived data          | Counts and aggregations, including grouping-field changes that leave document counts unchanged.                                        |
| External dependencies | Controlled reactive variables and time-window changes without external API variability.                                                |
| Async pressure        | Invalidation during awaited work, burst coalescing, pending-work cancellation, and error cleanup.                                      |
| Fanout and retention  | Shared/overlapping/unique selectors, persistent clients, write-rate sweeps, selector churn, reconnect, and long-running memory trends. |

Separate equivalent native capabilities from emulations requiring additional application code. Unsupported cells are visible in the report. Extend the adapter interface to optional manual-observer implementations and other libraries only when their semantics match a defined workload.

For capacity tests, hold subscriber count fixed while an independent scheduler offers writes at a configured rate. Record scheduled, dispatched, completed, dropped, and timed-out operations plus generator scheduling lag. Measure from scheduled time as well as dispatch time so queuing cannot disappear from the report. Invalidate capacity claims when the load generator saturates. Add distributed clients only when a single generator becomes the bottleneck, with an explicit clock/acknowledgement strategy.

Add backend benchmarks inside the real Meteor runtime for AsyncTracker dependency fanout, async context across awaits, reactive-variable equality, nested computations, cursor-cache reuse and churn, ComputedField, DataLookup, and stop behavior. Keep primitive timings separate from DDP comparisons.

Add a small headless browser suite using the actual Meteor client and Minimongo, without application rendering. Exercise subscription data helpers, client async context, and reconnection. Node DDP client timings cannot substitute for these client-code measurements.

Acceptance: the README's composed and derived publication examples each map to a validated scenario. Reports show scaling curves and sustainable load under declared correctness/latency targets. Each library's unsupported or emulated capabilities are explicit.

**Milestone 6 adds deeper diagnostics and Meteor performance integration.**

Reuse selected collectors from the researched [meteor/performance revision](https://github.com/meteor/performance/tree/b72b47dda3dc1f0c8ba81c9809526334d764b3cc), recording source revision, license, and local adaptations. Keep this optional integration behind a small adapter so its runtime requirements and internal API changes do not control the local suite.

Prioritize in-process event-loop delay/utilization and GC, Mongo command counts and query diagnostics, observer-driver fallbacks, CPU profiles, and heap snapshots. Measure instrumentation overhead with enabled/disabled runs. Keep expensive tracing and profiling in separate diagnostic runs. Report unavailable instrumentation explicitly and never substitute a collector process's event-loop measurements for the server's.

Export compatible results to the Meteor dashboard after preserving library, workload, and runtime dimensions. The local JSON schema remains authoritative. Extract shared improvements upstream when useful; this work does not depend on a dashboard deployment or an upstream merge.

Source review found integration gaps in the existing [fanout script](https://github.com/meteor/performance/blob/b72b47dda3dc1f0c8ba81c9809526334d764b3cc/tests/fanout-bench.js), [propagation monitor](https://github.com/meteor/performance/blob/b72b47dda3dc1f0c8ba81c9809526334d764b3cc/apps/tasks-3.x/packages/bench-monitors/propagation-timing.server.js), and [regression comparator](https://github.com/meteor/performance/blob/b72b47dda3dc1f0c8ba81c9809526334d764b3cc/reporters/regression-detector.js). Unique operation correlation, client convergence, required metrics, and failure propagation belong to the local contract. Synthetic comparisons during research confirmed that a tenfold nested subscription-p95 increase, or its removal, could pass the existing comparator.

Acceptance: a regression report can link to diagnostic artifacts explaining excess reruns, observer churn, query amplification, serialization, GC, or retained resources. The core benchmark continues to run with external reporting disabled.

**The first implementation should stop at a complete milestone, with usable artifacts.** Start with milestone 1, then deliver the plain-cursor workload through milestone 2 before broadening the scenario matrix. Milestones 1–4 establish the repository's initial performance workflow; milestones 5–6 expand coverage and help guide optimization. Make performance changes to reactive-publish in separate changesets with before/after evidence from the relevant scenario.
