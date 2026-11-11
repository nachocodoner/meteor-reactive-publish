# Initial benchmark findings

The observations below describe the original package source. The follow-up lifecycle fixes and their validation are recorded at the end of this document.

These are correctness observations from implementing the suite, not a performance ranking or a completed root-cause investigation. Invalid workloads retain diagnostics and exit with code 2. Their timings must not enter library or revision comparisons.

The package source tested was revision `c99252d4f9ecfea8976b0407a279408b63e021ed`, content SHA-256 `91f90d43959cf4dde0289ec648f1f042694677504f808cf7e29b217e092e2821`. Package implementation files were unchanged. Local runs used Linux x64/WSL2, an Intel i9-13900K, Meteor 3.3.2 with its Node v22.18.0 and MongoDB 7.0.16, and publish-composite 1.9.0. Every new result records its actual configuration; these observations are not portable timing baselines.

**An autorun cursor can lose its documents after an insert.**

```sh
npm run bench -- run --scenario plain-cursor --adapter reactive --instrumentation basic --output bench/results/findings/plain.json
npm run bench -- run --scenario plain-cursor --adapter reactive --instrumentation basic --meteor 3.5.2 --output bench/results/findings/plain-3.5.2.json
```

With the default smoke fixture (seed 1, two subscribers, four posts, two warmup operations), the first insert was delivered and then the published posts disappeared. The post-method check found an empty collection where the two initial active posts and the inserted post were expected. A diagnostic snapshot 100 ms after failure remained empty. This reproduced with observer/computation wrapping disabled on both Meteor 3.3.2 and 3.5.2 (the latter supplied Node v24.15.0). Native, installed-but-unused, and composite cursor variants passed their corresponding CRUD smoke checks.

This narrows the investigation to the reactive publication path and its interaction with Meteor. It does not establish which component causes the removal. Instrumentation-disabled reproduction rules out the bench observer wrappers as a necessary trigger.

**Relationship changes can leave stale child documents.**

```sh
npm run bench -- run --scenario dependent-posts --adapter reactive --output bench/results/findings/dependent-reactive.json
npm run bench -- run --scenario dependent-posts --adapter composite --output bench/results/findings/dependent-composite.json
npm run bench -- run --scenario projection-sensitivity --adapter composite --output bench/results/findings/projection-composite.json
```

Replacing a reader's post IDs sometimes left a subscriber with both the old and new children, causing the exact-state delivery check to time out. Reactive dependent-posts passed an earlier run and failed another, so a single passing run is insufficient evidence of stability. Composite dependent-posts and projection-sensitivity also showed retained old posts. These should be reduced independently, with the raw client snapshots and actual observer drivers retained; shared symptoms do not prove a shared cause.

**Additional reactive workloads exposed readiness or convergence failures.**

```sh
npm run bench -- run --scenario multiple-autoruns --operations 6 --timeout 5000
npm run bench -- run --scenario infinite-scroll --operations 6 --timeout 5000
npm run bench -- run --scenario deep-join --operations 6 --timeout 5000
npm run bench -- run --scenario async-pressure --operations 6 --timeout 5000
```

The multiple-autoruns check observed `ready` with posts present and expected comments missing. Infinite-scroll, deep-join, and async-pressure encountered incomplete state transitions within the declared five-second deadline. These are invalid benchmark executions; the suite does not shorten the expected dataset or retry until one passes. The individual app, library, and harness paths still need a targeted root-cause investigation.

**Validated coverage is narrower than the available scenario matrix.**

The initial feature checks passed reactive sorted-window, subscription-churn, subscription-data, derived-count, derived-aggregate, external-source, and shared-children with six measured operations, plus the backend primitive suite and the actual Meteor browser subscription-data check. Native/installed/composite plain-cursor and composite one-to-many/churn also passed locally. These establish working small workloads, not large-scale capacity or universal correctness.

CI blocks on the protocol/reporting tests and the chosen smoke subset. The scheduled/manual extended matrix is explicitly non-blocking while the existing findings above are investigated. Its failed workloads remain invalid in artifacts and job summaries. Restore blocking extended coverage as each finding is resolved; do not turn correctness failures into timing regressions or bless them as baselines.

Use `paired --base <revision>` on a validated affected scenario when fixing a library issue. For a previously invalid scenario, first demonstrate that it becomes correct; a before/after speedup cannot be calculated against an incorrect baseline.

**Final local harness validation.**

- All 18 protocol, oracle, reporting, scheduling, and process-cleanup tests passed.
- All four pinned app variants built and passed runtime package-isolation checks.
- The CI smoke commands passed with the full default smoke profile: native/installed/composite plain cursors and reactive sorted-window, subscription-data, and subscription-churn.
- Backend primitives, the Chrome subscription-data check, CPU profile generation, and native fanout at 20 offered writes/second passed. The CPU profile contained recorded nodes and samples.
- Five alternating A/A pairs on reactive sorted-window completed: all ten runs passed correctness and resource cleanup. Evaluated metrics stayed within provisional budgets; readiness and fanout p95 comparisons remained inconclusive because each run had fewer than 20 observations. This small local calibration does not establish hosted-CI timing thresholds.
- Library-mode comparison, baseline promotion/readback, and local meteor/performance export completed successfully.

The GitHub workflow is configured but has not been executed on GitHub during this implementation. Existing Tinytest/package tests were not rerun; package implementation files were unchanged. Raw local validation artifacts are under ignored `bench/results/validation/` and `bench/results/calibration/`.

**Cross-library compatibility audit (2026-09-30).**

After checking that publish-composite 1.9.0 remained the latest published Meteor 3.x-compatible release, the dedicated `libraries --suite compatible --pairs 1` command ran all nine common cases with the full smoke profile on Meteor 3.3.2. Results were:

| Case                   | publish-composite 1.9.0 | reactive-publish  | Timing comparison                   |
| ---------------------- | ----------------------- | ----------------- | ----------------------------------- |
| plain-cursor           | Valid                   | Invalid           | Blocked                             |
| dependent-posts        | Invalid                 | Valid in this run | Blocked                             |
| one-to-many            | Valid                   | Invalid           | Blocked                             |
| deep-join              | Valid                   | Invalid           | Blocked                             |
| shared-children        | Valid                   | Valid             | Available, one pair is inconclusive |
| projection-sensitivity | Invalid                 | Valid in this run | Blocked                             |
| sorted-window          | Valid                   | Valid             | Available, one pair is inconclusive |
| subscription-churn     | Valid                   | Valid             | Available, one pair is inconclusive |
| fanout                 | Valid                   | Invalid           | Blocked                             |

This audit is saved under ignored `bench/results/libraries-compatible/`. A compatible workload means both libraries can express the same output contract; it does not mean both implementations currently satisfy it. The three passing common cases form the initial `libraries --suite smoke` subset. Package-specific APIs remain explicitly excluded; see [COMPARISONS.md](./COMPARISONS.md).

The follow-up `libraries --suite smoke --pairs 5` run completed all 30 app runs successfully. A separate `libraries --scenario sorted-window --profile standard --pairs 5` comparison also passed all ten runs with 25 clients, 100 parents, 10 children per parent, and 100 measured operations per run. Their reports are under ignored `bench/results/libraries-repeated/` and `bench/results/libraries-standard/`. These remain workload-specific local measurements, not a general ranking.

The expanded harness test suite has 23 passing tests, including alternating library order, preserving invalid pairs, exclusion of unsupported cases, and rejection of mixed source/package repetitions. CI now includes the common library smoke subset and an explicitly non-blocking full compatible audit on scheduled/manual runs; it has not yet been executed remotely.

**Unattended full-suite validation.**

`npm run bench:all -- --profile smoke --pairs 1 --browser --output bench/results/full-validation` completed all 35 requested runs: 33 DDP variants across all 16 implemented scenarios, the backend suite, and the optional browser check. It recorded 26 valid runs and 9 invalid runs, produced 13 valid comparisons, and blocked 8 comparisons involving invalid variants. Exit code 2 reflected the recorded correctness findings; it did not prevent later scenarios or report generation.

The single-run audit is descriptive, with timing comparisons marked inconclusive. Its HTML, Markdown, JSON, raw samples, and logs are retained under ignored `bench/results/full-validation/`. The HTML was opened in Chrome and checked for working scenario/status filters, expansion controls, valid artifact links, and absence of page errors. The harness now has 27 passing tests, including complete scenario enumeration, independent continuation after failure, and report preservation on interruption. Scheduled/manual CI now uses the full-suite command in its non-blocking diagnostic step.

**Lifecycle fixes on `fix/reactive-publication-lifecycle`.**

The validated fixed package content SHA-256 is `bf259188e4f2084c7675f6d28eb7f3a712e8f875293505858d074aff6ee88bf1`. This identifies the package source independently of the commits used to organize the fixes and benchmark changes.

Tracing the failing workloads established several distinct causes. Mongo callbacks could run without their owning computation, or under another subscriber's computation. Consequently, reconciliation either removed valid documents or retained obsolete documents under the wrong owner. Previous cursor observers also remained active after an autorun changed its query. Multiple autoruns independently requested readiness before all their initial results had arrived. The traces are retained under ignored `bench/results/diagnosis/`.

The fixes restore the observer's computation context, preserve callback return values, stop publication observers before their next run, and reconcile documents synchronously at run boundaries. A run that is already delivering its initial results can finish before the next rerun; frequent invalidation must not starve a moving time-window publication. Dependency observers survive while their queries remain in use, and unused queries and cursor-cache entries are retired. Observers whose handles resolve after their computation stops are stopped as well. Ordinary AsyncTracker autoruns retain their existing explicit-observer behavior across reruns.

Readiness now waits for all initial publication autoruns, nested autoruns, and normally returned cursors. Stopping a parent computation releases its active children. Connection-isolation tests additionally exposed the exported subscription-data collection being replaced by an extra DDP connection; the export now stays attached to Meteor's default connection.

Validation on Meteor 3.3.2:

- The unchanged master snapshot passed 120 of 121 existing package tests; the cursor-autorun test failed. Four new lifecycle regression tests all failed against that snapshot.
- The fixed source passed all 129 client/server package tests, including the existing failure, four original regressions, stop-during-initialization and mixed-cursor readiness cases, and parent-stop tests on both client and server. The test log is `bench/results/lifecycle-fix/package-tests.log`.
- The 27 harness tests passed. Formatting and targeted ESLint checks passed with three existing unused-variable warnings.
- The final full smoke matrix passed all 16 reactive DDP scenarios plus backend and browser checks. Across all adapters it recorded 33 valid runs out of 35, with only composite dependent-posts and projection-sensitivity invalid. All seven previously invalid reactive variants passed. The report is `bench/results/lifecycle-fix/full/report.html`; it contains 19 available comparisons and two blocked comparisons. This single-run audit establishes correctness for the tested workload, not a performance ranking.
- Eight larger reactive runs also passed: plain-cursor, dependent-posts, one-to-many, deep-join, fanout, multiple-autoruns, infinite-scroll, and async-pressure. Each used the standard profile (25 clients, 100 parents, 10 children per parent, 10 warmup operations, and 100 measured operations), with cleanup verified. Results are under `bench/results/lifecycle-fix/standard/`. These runs validate correctness under a larger workload; their timings are not a paired performance comparison.
- CI now blocks on the affected reactive publication benchmark cases. The full comparison remains diagnostic because publish-composite 1.9.0 has a separate overlapping-child-refresh race. Its adapter and package remain unpatched, and invalid comparisons remain excluded.

The disabled Meteor-core workflow was not run. The updated workflows have not been executed on GitHub during this local validation.

**Comprehensive resource comparisons (2026-09-30).**

The `comprehensive` command adds matched core, offered-load, retention, and Mongo query stages for composite/reactive. Its full preset uses five independent pairs and 100 warmup plus 1,000 measured operations in the core cases. Query profiling and forced GC run in separate contexts. The collector records additional Node/V8 diagnostics; comparisons now include heap, GC, event-loop delay, throughput, and separate Mongo process/query costs. Utilization is contextual, and generator saturation makes client timings inconclusive.

- All 40 harness tests passed, including exact prepared-state validation, instrumentation mismatches, missing collector coverage, sample sufficiency, signed retention growth, throughput direction, generator saturation, and paired failure handling.
- The final quick comprehensive matrix completed all 42 runs across 21 stage/case combinations: 38 valid runs, 17 available comparisons, and four blocked comparisons. Only composite dependent-posts and projection-sensitivity failed, once in core and once in query diagnostics. All load and retention runs passed, and all successful query runs verified profiler coverage. Artifacts: `bench/results/comprehensive-validation/report.html`.
- The full-preset sorted-window comparison completed all ten runs successfully: five alternating pairs, 25 clients, 100 parents, 10 children per parent, 100 warmup operations, and 1,000 measured operations per run. Artifacts: `bench/results/comprehensive-final-repeated/report.html`. The report distinguishes CPU/heap/throughput differences even where delivery p95 has no clear difference. Event-loop p99 remains inconclusive because the faster runs have fewer than 1,000 histogram observations; more operations alone do not guarantee enough samples for every metric.
- The existing full smoke matrix was rerun after the collector/oracle changes: 33 of 35 variants valid, all 16 reactive scenarios plus backend and browser checks passing, and only the same two composite correctness failures. Artifacts: `bench/results/comprehensive-regressions/report.html`.
- The comprehensive HTML report was checked in Chrome: all 21 cases, four failure filters, retention search/expansion, both charts, and all 44 artifact links worked with no page errors.

A larger offered-load experiment used 25 clients, 1,501 writes, 50 writes/second, and a 30-second scheduling window. Composite completed the workload; reactive-publish hit a method timeout after 1,182 completed operations in the first run. The reactive server snapshot showed approximately 55.3 CPU seconds over 53.7 elapsed seconds, 570 MB sampled peak RSS, and 85.7 ms event-loop p99. The run is invalid and excluded from cost comparisons. This is a capacity/timeout finding under the declared workload, not proof of a new publication-correctness bug. Artifacts: `bench/results/comprehensive-load-validation/report.html`. Failed-run reporting was extended to preserve generator and database diagnostics as well as server snapshots, without ranking incomplete work.

The diagnostic rerun reproduced the reactive timeout after 1,248 of 1,501 operations at the failure checkpoint. Generator utilization was 6.1%, scheduling-lag p95 1.19 ms, server CPU 56.3 seconds over 55.0 elapsed seconds, and sampled server RSS 612 MB. Mongo used 1.72 CPU seconds. Composite again completed all operations. This evidence points to application-side saturation rather than a late load generator in this experiment. The final failure table and raw diagnostics are in `bench/results/comprehensive-load-diagnostics/report.html`; these one-pair experiments do not establish a universal capacity threshold.

These experiments validate the new mode and its larger iteration counts. They do not constitute a completed 220-run full-preset experiment, a universal ranking, or evidence of a memory leak. The expanded scheduled/manual workflow is configured but has not been run on GitHub.

**Runtime selection and the Meteor 3.5.2 investigation (2026-09-30).**

Benchmark commands accept a released Meteor version with `--meteor`, or a Git checkout/worktree with `--meteor-cli`. The checkout identity includes tracked changes, relevant untracked source, and recursive submodule contents. Runtime identities select separate builds and package locks; changed or mixed runtime identities invalidate comparisons. The default benchmark and CI release remains Meteor 3.3.2. Reactive/composite locks for Meteor 3.5.2 are also included.

The initial focused 3.5.2 experiment used application Node 24.15.0, MongoDB 7.0.16, and publish-composite 1.9.0. Both resolved package graphs matched the local Meteor 3.5.2 release manifest. The plan requested five alternating pairs per shared case, 100 warmup operations, 1,000 measured operations, and 25 clients, followed by descriptive reactive-only and backend runs.

Plain-cursor and one-to-many each completed all ten valid runs. Deep-join recorded one valid composite run and a reactive `bench.mutate` timeout. The batch was stopped after substantial host memory/I/O pressure was observed; remaining work was deferred. The 21 valid results out of 22 recorded attempts remain preliminary. The timeout's cause is unresolved on that pressured host, and these measurements must not become a regression baseline or support a universal library ranking. Local artifacts are under ignored `bench/results/meteor-3.5.2-experiments/`.

The temporary Python helpers were replaced with the repository's Node-only `bench:experiments` runner. It generates the combined HTML/Markdown/JSON/CSV reports automatically, samples host conditions, preserves interruptions and failures, and refuses existing output directories. Its reporter was checked against the saved batch: run counts, metric means/ranges/sample deviations, and comparison evidence were preserved. All 52 Node harness tests pass, including interruption, mixed-identity rejection, invalid-result reporting, and serial execution after individual failures. The README documents dry runs, fresh measurements, and report regeneration without executing workloads. Quiet-machine measurements remain deferred.

**Dependency cleanup and observer reuse (2026-11-10).**

The original PR head `b29755b5d610ccdb392c3de5de30d6009b5a371f` had a library bug: every dependency reread registered another persistent invalidation and stop callback. Long-lived computations retained obsolete dependency closures and repeated their cleanup on subsequent invalidations. A regression with 2,000 reruns grew the original callback arrays from 2/1 to 2,002/2,001. Two further regressions exposed dependencies being reattached after stop and late dependency reads surviving into a replacement run. All three fail against the original server implementation and pass after the fix; the final package suite also runs them in the browser.

Computations now own a set of current dependencies, clear those edges at invalidation/rerun/stop, and reject reads after stop. Public invalidation callbacks keep their existing persistent behavior. Publication autoruns also retain an observer when they return the same cursor object. Changed queries retire old observers; membership is reconciled after awaited results, including events from the previous cursor while the query changes. Tests cover both observer identity across repeated writes and that asynchronous query-change race across separate connections.

The measured candidate package SHA-256 is `b0ac8dc00138d9a1f9ac79705ae283bee44ceef84bd884e8e1fd9ca5ec07e69e`. Measurements ran serially on an Intel Mac with macOS 14.5, 16 logical CPUs and 32 GiB RAM, Meteor 3.3.2, application Node 22.18.0, and MongoDB 7.0.16. Harness Node was 22.14.0. Host load/memory samples and exact commands are retained in `bench/results/optimization/validation.json`. macOS does not provide the harness's Linux `/proc` Mongo process-cost metrics; these are explicitly unavailable.

A/A calibration used two identical snapshots of the candidate, with five alternating pairs, 25 clients, 100 parents, 10 children per parent, 100 warmup operations and 1,000 measured operations per run. All ten runs passed correctness and cleanup. Mean CPU differed by 1.64%, with a paired delta interval spanning zero; all evaluated metrics remained within provisional budgets. This local calibration does not establish hosted-CI thresholds.

The same settings then compared the original PR head with the candidate. All ten runs passed correctness and cleanup. Values below are means of per-run summaries; memory columns represent sampled peaks, not retained heap after GC.

| Metric | Original PR | Candidate | Change |
| --- | ---: | ---: | ---: |
| Application CPU per operation | 14.353 ms | 8.423 ms | -41.3% |
| Sampled peak heap used | 196.67 MB | 72.28 MB | -63.2% |
| Sampled peak RSS | 302.49 MB | 171.32 MB | -43.4% |
| GC time per operation | 0.278 ms | 0.080 ms | -71.1% |
| Observer creations per operation | 50 | 0 | -100% |
| Update convergence p95 | 4.542 ms | 4.969 ms | +9.4% |
| Completed operations per second | 21.611 | 23.516 | +8.8% |
| DDP bytes per operation | 6,098.529 | 6,098.529 | unchanged |

The CPU delta interval was -6.287 to -5.522 ms/operation. Delivery p95 increased by 0.427 ms (paired interval 0.287–0.612 ms), within the provisional budget; the improvement is in resource cost and completion rate, not every latency metric. These results measure the two fixes together in one workload and do not isolate their individual contributions or establish a cross-library ranking. Raw runs and uncertainty estimates are under `bench/results/optimization/{calibration,before-after}/`.

Reproduce the revision comparison from the candidate checkout:

```sh
npm run bench -- paired --base b29755b5d610ccdb392c3de5de30d6009b5a371f \
  --scenario sorted-window --profile standard --warmup 100 --operations 1000 \
  --pairs 5 --output bench/results/before-after-repeat
```

Validation and environment repairs:

- All 137 client/server package tests and 54 Node harness tests passed. Lint passed with zero errors and 18 existing unused-variable warnings. Root clean installs passed both with strict peer resolution and this machine's `legacy-peer-deps=true` setting.
- The full smoke suite passed all 39 requested checks: 37 DDP variants across 17 scenarios, backend primitives, and the browser check. It produced 25 available comparisons and no blocked comparisons. The earliest plain-cursor runs preceded the final awaited-query fix, so all four plain-cursor adapters were rerun successfully against the final source. Artifacts are `bench/results/optimization/full-smoke/` and `plain-final/`.
- `personalized-selectors` adds three overlapping author groups and independent exact per-client data validation across all four adapters. Mutations affect the common post, including field clearing. Targeted private writes remain an extension.
- The root lockfile now matches the declared dependencies, including required lint peers. Package tests explicitly select this checkout, the pinned Meteor release, and an available Chrome executable. Runtime detection prepares a cold Meteor release before resolving its Node executable; older cached bundles are validated before reuse.
- Package CI now includes lint and a clean lockfile install. Scheduled/manual A/A uses 100 warmup operations, 1,000 measured operations and five pairs by default. Timing remains advisory. The separate Meteor-core workflow remains disabled; these workflow edits have not yet run on GitHub.

The larger personalized-selector check also passed for composite and reactive with 25 clients and the standard profile. Its single pair validates this workload; its timing comparison remains inconclusive. Artifacts: `bench/results/optimization/personalized-standard/`.

The offered-load follow-up completed all 1,501 inserted posts for both libraries at 50 offered writes/second over a 30-second scheduling window, with 25 clients and 100 warmup writes. Both passed exact final-state and resource-cleanup checks. The earlier recorded reactive timeout did not recur, but both exceeded the declared 100 ms scheduled-delivery p95 budget: composite 5,702 ms and reactive 5,417 ms, with roughly 42 completed operations/second including drain. Generator utilization stayed below 16% and scheduling-lag p95 was about 2 ms. This is a valid execution above the tested setup's latency target, not evidence of sustainable 50-writes/second capacity. It is one pair, and the older timeout was not a controlled same-host baseline for this experiment. Artifacts: `bench/results/optimization/load/report.html`.

The load path currently uses one writer connection and ordinary Meteor methods. Investigate method queuing alongside publication work before interpreting that workload as a library capacity ceiling. The inserted dataset also grows throughout the run; its peak memory is not a fixed-dataset retention measurement. Separate writer-concurrency experiments and repeated lower-rate measurements are useful next steps.

The separate fixed-fixture retention run completed 1,000 subscribe/unsubscribe cycles for both libraries, each with 25 clients after 100 warmup cycles. All 11 forced-GC checkpoints had zero active observers and computations. Reactive heap used went from 49.23 MB at baseline to 47.71 MB at the final checkpoint; composite went from 47.64 MB to 45.41 MB. Reactive's later checkpoints drifted upward from 46.68 MB at cycle 100 to 47.71 MB at cycle 1,000, so the lower final value alone does not prove a long-term plateau or absence of leaks. The one-pair comparison is descriptive; longer repeated studies remain useful. Artifacts: `bench/results/optimization/retention/report.html`.

The serial validation batch finished with all seven jobs successful and unchanged candidate/harness hashes throughout. All raw artifacts described in this section are local ignored files; this document preserves the findings without promoting a timing baseline.

**Meteor 3.6 release-readiness check (2026-11-10).**

The successful package/performance validation above used Meteor 3.3.2. A subsequent compatibility check on the newly released Meteor 3.6, resolving `ddp-server@3.6.0` and `mongo@2.6.0`, completed with **133 passing and four failing package tests**. The candidate source hash was unchanged. The failures were the existing cursor-cache reactivity test, the recent-posts time-window test, and the two ReactiveData count tests (expected 10/20, received 9/19). A stable release should wait for this compatibility investigation.

Focused runs retained the original assertions and used matching Meteor 3.6 runtimes:

| Existing test | Original PR `b29755b` | Optimized candidate |
| --- | --- | --- |
| Cursor cache clearing | Passed | Failed again: expected two runs after update, observed one |
| ReactiveData suite | 4 passed, 2 count failures | Same 4 passed, 2 count failures |
| Recent-posts time window | Passed in isolation | Passed in isolation; failed in the full suite |

The count failures therefore also affect the original PR on this runtime. The cursor-cache difference needs regression investigation, while the time-window result requires investigation of timing or suite interaction. These focused results do not erase the full-suite failures. The clean candidate snapshot had the exact same package hash as the working checkout and excluded development `node_modules`. Earlier diagnostic attempts hit separate setup problems: placing a test app under the ESM benchmark directory, and rebuilding the checkout's nested development Puppeteer dependency. Those attempts did not execute tests and are excluded from the table.

An AST audit compared all 95 existing Tinytest registrations at the original PR head and all 88 registrations on its base with the candidate. No existing test body was changed or removed; shared client/server registrations explain why these counts differ from executed test totals. Existing Mongo test edits were formatting only. The sole changed existing harness expectation was nine to ten common scenarios after adding personalized selectors. Logs, source hashes, focused comparisons and the audit are under `bench/results/instrumentation-review/`.

Release preparation also needs a new version in `package.js`, a working documented publish command (`npm run publish` currently references the missing `scripts/publish.sh`), and CI on the final committed source. Meteor 3.6 instrumentation can be an optional benchmark collector in a separate change; it is not required to repair these failures.

**Optional Meteor lifecycle collector (2026-11-10).**

The harness now accepts `--meteor 3.6 --lifecycle`, with separate dependency locks pinning `instrumentation@0.0.1`. It consumes the public events in memory, verifies a successful and deliberately failing method before measurement, and checks event coverage against client calls and publication lifecycles. Timing storage is bounded without truncating totals/errors; capped percentiles are explicitly unavailable. Neither the production package nor its existing test assertions changed during this addition; its content hash remains `b0ac8dc00138d9a1f9ac79705ae283bee44ceef84bd884e8e1fd9ca5ec07e69e`.

Actual runs used Meteor 3.6, application Node 26.13.0, MongoDB 8.0.29, and publish-composite 1.9.0 on the same Intel Mac. These are different runtime coordinates from the earlier 3.3.2 optimization experiment and cannot be compared as a before/after speedup. The native control passed 100 measured method calls with 25 subscriptions, including complete readiness/stop coverage and zero collector faults.

Five alternating composite/reactive pairs used the sorted-window contract, 25 clients, 100 parents, 10 children per parent, 100 warmup operations and 1,000 measured operations per run. All ten passed exact-state, resource cleanup and lifecycle checks, with 5,000 measured method completions per library and no measured errors. Means of per-run summaries:

| Metric | Composite | Reactive |
| --- | ---: | ---: |
| Server method p95 | 24.4 ms | 23.0 ms |
| Client method-result p95 | 24.843 ms | 23.505 ms |
| Client update convergence p95 | 4.098 ms | 3.683 ms |
| Initial server publication-ready p95 | 1 ms | 1 ms |
| CPU per operation | 4.370 ms | 6.058 ms |
| Completed operations per second | 41.088 | 24.593 |

The CPU difference is +38.6% (paired delta interval +1.523 to +1.812 ms/operation); completed throughput is -40.1% (interval -16.632 to -16.285 operations/s). This is one workload, not a universal ranking. Raw runs, coverage snapshots, package graphs and full comparison details are in `bench/results/lifecycle/libraries/`.

The timing layers expose an investigation target: method-end events and receipt of the client method result are not the final DDP `updated` acknowledgment. The workload requires both acknowledgments and validates state before issuing the next operation. Lower method p95 therefore does not guarantee higher completed throughput. Measure acknowledgment/completion timing and profile the additional work before attributing the difference to a specific library operation; do not subtract independent percentiles to estimate a queue. Publication stop also precedes asynchronous cleanup, so the existing resource checks remain necessary.

The weekly/manual lifecycle CI job runs a native control, five library pairs and subscription churn, retaining reports for 30 days. Correctness and event-coverage failures block that job; performance remains advisory. This workflow is configured locally and has not yet run on GitHub. The four full-suite Meteor 3.6 compatibility failures above remain unresolved; successful benchmark coverage does not make the branch release-ready.

A separate overhead diagnostic used five alternating on/off pairs of the candidate on Meteor 3.6, with 25 clients, 100 warmup operations and 300 measured operations after explicit preflights. Both package graphs differ only by `instrumentation@0.0.1`; the source, harness, runtime, hardware and fixture identities matched. All twelve executions passed. Mean CPU was 6.870 ms/operation off and 7.062 on (+2.8%); sampled peak heap increased 0.5%, method-result p95 increased 1.1%, and update-convergence p95 decreased 0.4%. CPU changes across individual pairs ranged from -2.0% to +12.4%, so these short runs do not establish a precise fixed overhead or zero cost. This experiment deliberately compares different instrumentation settings outside the normal library/revision comparator, which continues to reject that mismatch. Raw runs and its reproduction script are in `bench/results/lifecycle/overhead/`.

A short offered-load diagnostic used 25 clients, 20 warmup writes and 301 measured writes scheduled at 50/s over six seconds. All writes and final states passed; server method p95 was 25 ms, client result p95 1,134.4 ms, and scheduled delivery p95 1,116.4 ms. Completion throughput including drain was 41.85 operations/s. Generator utilization was 9.0% and scheduling-lag p95 2.13 ms. This exposes substantial waiting outside the server's dispatch-to-result interval, consistent with queuing in the one-writer setup; it does not isolate every source of delay or establish sustained capacity. A dedicated complete-call/`updated` latency metric and controlled writer-concurrency experiment are useful next steps. Raw evidence: `bench/results/lifecycle/fanout.json`.

Final validation passed all 60 Node harness tests and lint with zero errors (18 pre-existing unused-variable warnings). All 29 real executions passed: the native control; ten repeated library runs; twelve overhead runs including preflights; churn, subscription-data, basic observer mode, backend primitives, offered load, and the unchanged default Meteor 3.3.2 path. Churn recorded all 42 stops across initial subscriptions plus 20 cycles for two clients; subscription-data observed all 80 method calls. An additional negative check correctly rejected `--lifecycle --meteor 3.3.2` before starting an app. Workflow YAML and whitespace checks passed. The rendered focused comparison is `bench/results/lifecycle/report.html`; these artifacts are local ignored files. Existing package tests were not modified or rerun for this harness-only addition; their prior 3.3.2 pass and 3.6 failures remain the relevant release evidence.


**Regression audit follow-up (2026-11-11).**

The [branch/base regression audit](./REGRESSION-AUDIT.md) resolves the package-test
failures recorded above. The follow-up changes test completion, observer waits,
and the recent-posts fixture; production implementation and all 634 original
direct assertion calls and expected values remain unchanged. The final package
suite passed 137/137 on both Meteor 3.3.2 and Meteor 3.6, with no assertions arriving
after test completion. All 60 Node harness tests and lint passed (zero errors,
18 existing warnings). The complete smoke matrix passed all 39 real executions,
including 37 DDP variants, backend primitives and the browser; all resource cleanup
checks passed and no comparisons were blocked. This does not establish new timing
or capacity claims. Raw evidence is under ignored
`bench/results/regression-audit-2026-11-11/`.

Package CI now covers both releases. CI on the final committed source and safe
execution of the inherited, disabled Meteor-core suite remain outstanding.


**Full Meteor-core verification (2026-11-11).**

The [full-core report](./CORE-TESTING.md) records four complete local package-suite
runs on devel `0f95d70340`, including deprecated packages and stylus. The runtime
and tests are identical to the current release-3.6 branch; their differences are
documentation only. Without this package, change streams passed 2645/2645 and
oplog passed 2551/2551. With package checkpoint `1a3dbd9`, the respective results
were 2644 passed/1 failed and 2550 passed/1 failed, with identical case inventories.

The sole failing case counts all DDP packets and sees the package's intentional
_subscriptionData traffic. It fails identically against package base `c99252d` in
both backend configurations. The old shell runner rewrote this assertion; the
replacement leaves it intact and reports failure. An additional wire-level case
passes on base and candidate, preserving the original eight cursor events with
zero cursor removals and separately verifying two metadata additions/one removal.
No new regression was identified in these configurations. Raw evidence, comparison
JSON and graphs are under `bench/results/core-suite-2026-11-11/`. Core's existing
Blaze late-assertion warnings and the upstream shell runner's post-summary teardown
warnings remain recorded. CLI self-tests and E2E suites are outside these runs.

The replacement runner checks source identities, uses the supported extra-package
option, preserves failed/incomplete outcomes, and never restores checkout files.
All 64 Node harness tests pass, including four new orchestration cases. Package
and performance-harness source hashes match the previous validated smoke run.
