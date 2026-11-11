# Instrumentation-guided optimization — 2026-11-11

The cursor cache now returns an exact hit before scanning and parsing the other
cache keys. Cache misses retain the existing selector/options eviction logic.
Observer ordering, dependency invalidation, publication ownership and readiness
are unchanged. This is the only production change in this iteration.

## Measurement

The benchmark continues to use Meteor 3.6's optional `instrumentation@0.0.1` for
method, publication and connection events. Its public API reports server
lifecycle events, not client acknowledgment latency; see the
[Meteor instrumentation documentation](https://docs.meteor.com/packages/instrumentation).
The production package still has no instrumentation dependency.

Metrics version 3 adds client timing for `updated`, completion of both `result`
and `updated`, and the remaining wait after that same call's result. It stores
paired timestamps, handles either acknowledgment order, and validates the exact
expected method count. It never derives a wait by subtracting two aggregate
percentiles. These metrics appear in raw results, Markdown, HTML and comparisons.
Protocol tests cover delayed/reversed acknowledgments, concurrent calls with a
batched `updated`, and a missing acknowledgment that must still fail.

A CPU profile of the baseline identified cursor-cache work. The sorted-window
workload also uses both polling and oplog observers: its ordered dependency
observer falls back to polling. In the first profiled run, server method p95 was
23 ms, client result p95 23.424 ms, and complete-call p95 74.680 ms. These are
distinct intervals. The profile is diagnostic, not a comparison baseline.

## Repeated revision comparison

Five alternating pairs compared package checkpoint `be74b3f` with the cache
change on the same Intel Mac, Meteor 3.6, Node 26.13.0 and MongoDB 8.0.29. Each
run used 25 clients, 100 parents, ten children per parent, 100 warmup operations
and 1,000 measured operations, with lifecycle and observer instrumentation
enabled on both sides. All ten runs passed exact state, event coverage and
resource cleanup; each side recorded 5,000 successful measured method calls.

The table shows means of per-run summaries, not pooled percentiles.

| Metric | Baseline | Cache change | Change |
| --- | ---: | ---: | ---: |
| CPU per operation | 6.445 ms | 6.054 ms | -6.1% |
| Completed operations per second | 24.581 | 24.701 | +0.5% |
| Server method p95 | 23 ms | 23 ms | unchanged |
| Client result p95 | 23.389 ms | 23.548 ms | +0.159 ms |
| Client complete-call p95 | 60.604 ms | 61.863 ms | +1.260 ms |
| Client update convergence p95 | 3.673 ms | 3.728 ms | +0.055 ms |
| Sampled peak RSS | 206.206 MB | 204.484 MB | -0.8% |
| DDP bytes per operation | 6,098.529 | 6,098.529 | unchanged |

The paired CPU delta interval was **-0.736 to -0.033 ms/operation**. Throughput
(-0.009 to +0.254 operations/s) and complete-call p95 (-10.852 to +11.601 ms)
do not establish an improvement. Delivery p95 increased slightly, with a delta
interval of +0.024 to +0.094 ms. All metrics remained within the existing
provisional budgets. The result supports a modest CPU saving in this workload,
not a universal speedup or capacity claim.

Separate profiles sampled approximately 283 ms of self time in the package's
`Mongo.Collection.find` wrapper before and 100 ms after. Sampling and startup
make these supporting diagnostics; the repeated unprofiled runs above establish
the reported CPU comparison. See [Node's CPU profiling documentation](https://nodejs.org/api/inspector.html#cpu-profiler).

A shorter unchanged-source calibration used five pairs with 300 measured
operations. Its CPU delta interval crossed zero (-0.794 to +0.240 ms/operation),
and completion timing varied materially. It is not a calibrated timing gate for
the longer workload. An earlier calibration was interrupted by laptop sleep:
the system recorded 5,383 seconds asleep during the failed run. That invalid
run and all earlier successful attempts remain saved and are excluded from
the comparison. Subsequent batches used command-scoped `caffeinate -i`.

## CI findings and test contracts

The previously pushed checkpoint had two failed hosted jobs:
[the harness](https://github.com/nachocodoner/meteor-reactive-publish/actions/runs/42993810680/job/130432792595)
and [Meteor 3.6 package tests](https://github.com/nachocodoner/meteor-reactive-publish/actions/runs/42993810708/job/130432792466).
Meteor 3.3.2 and lint passed; the dependent benchmark job was skipped. Local
passes did not establish that all hosted checks were green.

- The core runner imported root Puppeteer even when a browser executable was
  supplied. CI installs only `bench` dependencies for its harness job. An
  isolated installation reproduced all four orchestration failures; optional
  browser discovery now imports Puppeteer only when needed. The same four tests
  then passed without root dependencies or changed assertions.
- The nested-Mongo test failed on CI with a stale removal result but passed an
  unchanged-source local rerun. A completion-wait-only repair still failed a
  full local run (137 passed, one failed): it observed 11 child runs versus an
  expectation of ten. Separate Mongo observers can notify the child before the
  parent replaces it. A controlled real-Mongo probe, using independent polling
  throttles, passed on **both pre-optimization `be74b3f` and the candidate** with
  three parent runs, four child runs, exact final data and a stopped old child.
  The fixture now waits for completion and indexes child snapshots by parent
  generation. Four incorrect child-run equalities (6, 7, 9, 10) become lower
  bounds, allowing legitimate independent reruns. Exact parent counts, child
  creation counts, document lengths and all result arrays remain unchanged.
  Additional checks require exactly one active child after replacement; the
  controlled child-first probe is retained as another regression test.
- An additional package test checks cache hits, changing sort options, cleanup,
  and reordering when the changed sort field is excluded from the projection.
  This also protects behavior that an unordered-observer shortcut could break.

An AST audit against `be74b3f` finds 100 existing test registrations, no removals,
one corrected test and two added tests. **630 of 634 original direct assertion
calls and values** from branch base `c99252d` remain unchanged. The four exceptions
are the child-run assumptions explained above; they are not performance-budget
changes or allowances for incorrect published data.
No core expectation is rewritten. PR benchmark checks now cover both Meteor
3.3.2 and 3.6, including focused 3.6 instrumentation coverage. The complete
39-check scenario/browser matrix also runs on every PR and fails the job on a
correctness error; its former manual/scheduled-only, nonblocking setting was a
coverage gap. Repeated timing experiments remain scheduled/manual and advisory.

## Verification

At this code checkpoint, both complete package suites pass **139/139**, on Meteor
3.3.2 and 3.6, with no assertions after completion. All **67 Node harness tests**
pass. Lint reports zero errors and 18 existing warnings. The isolated benchmark-only
installation also passes all four core-runner orchestration tests.

Hosted CI on code checkpoint `3751037` passes all six active jobs: harness, lint,
both package releases (139/139 each) and both benchmark smoke jobs, including
focused 3.6 instrumentation. Full-core CI remains disabled; long lifecycle and
comprehensive experiments are scheduled/manual, so their skipped PR jobs are
not counted as passes. A follow-up makes the full scenario/browser matrix a
required PR check too.

The local 3.6 matrix passed all 38 DDP/backend checks. Its browser check initially
could not start because the Mac Chrome executable was not supplied; the focused
rerun with `--executable` passed. All 39 planned cases are covered across those
attempts; the initial report remains 38/39, with the failed startup retained.
The full 3.3.2 smoke matrix and change-stream core run are still in progress.
Oplog core completed with 2550 passes and the same one raw DDP metadata-message
failure, identical test inventory and identical failure details. Final outcomes
will be recorded below after completion.

The performance snapshot predates the nested-test correction. All twelve
production package files match that measured snapshot byte for byte; the package
hash differs because of test-only edits. Raw identities distinguish both snapshots.

## Remaining optimization opportunities

1. Investigate the ordered dependency observer and its polling fallback. A
   faster strategy must retain changes in result order even when sort fields
   are projected out. Simply switching to unordered observation changes that
   contract and was not applied.
2. Separate single-writer method queuing from publication cost in offered-load
   experiments. Complete-call timing now exposes the final acknowledgment, but
   does not itself identify every source of waiting or a sustainable write rate.
3. Profile document-ownership reconciliation with larger results and multiple
   autoruns before introducing ownership indexes. Preserve overlap, removal,
   stopped-child and asynchronous replacement semantics.

The full-core workflow still needs an explicit policy for the pre-existing raw
DDP metadata-message test failure; see [CORE-TESTING.md](./CORE-TESTING.md).
Meteor CLI self-tests, unrelated application E2E groups and other browser/platform
matrices are outside this library iteration. No claim is made that every possible
Meteor test or runtime configuration has run.

## Reproduction and artifacts

```sh
npm run bench -- paired --meteor 3.6 --lifecycle --base be74b3f \
  --scenario sorted-window --profile standard --warmup 100 --operations 1000 \
  --pairs 5 --output bench/results/cache-comparison
npm run bench:all -- --meteor 3.6 --lifecycle --browser \
  --output bench/results/cache-smoke-36
npm run test:ci -- --release 3.6
```

Ignored evidence is under `bench/results/instrumented-optimization-2026-11-11/`:
`before-after/comparison.{json,md}`, raw runs/profiles, calibration attempts,
hosted logs, test-contract audits and validation job records. The comparison's
harness hash is `1a30acc82e3fbf1929768e3d5b778ca15170b886b23354d3466f90554759c51e`;
baseline package hash is `699d193821c3b80083721f75fafbd5bfc25eaf03835a82d84ebe3847cc99ca1f`
and measured candidate hash is `c68c0c40993fc34242b43fee01994caea9917129ba4360dc1bce20490181e72b`.
