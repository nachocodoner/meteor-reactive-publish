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
