# Reactive publish benchmarks

This suite measures real Meteor publications over DDP without rendering a UI. It builds separate production apps for each library, starts a private Mongo replica set, validates client data, and writes JSON and Markdown reports. It also provides backend primitive measurements and an optional check of the actual Meteor browser client.

Some workloads currently expose publication correctness failures. Such runs exit nonzero and are excluded from performance comparisons. See [FINDINGS.md](./FINDINGS.md) for reproduction commands and the distinction between tested smoke coverage and the extended matrix.

Install the bench dependencies and run a small validated scenario from the repository root:

```sh
npm run bench:setup
npm run bench -- doctor
npm run bench:test
npm run bench:smoke
```

Use Node 22.12 or newer and an installed Meteor command, or select a Meteor checkout with `--meteor-cli` as described below. By default, the initial run downloads/builds the pinned Meteor 3.3.2 release if necessary. MongoDB and the application Node executable come from the selected runtime's dev bundle. Docker and a system Mongo installation are unnecessary. Each invocation owns its Mongo process and temporary database; it does not connect to an existing application database.

Builds are cached outside the checkout under the operating system's temporary directory. The cache includes package source, app files, runtime, package manifests, and resolved version locks. `--rebuild` discards the selected cached build. The first build needs network access to fetch Atmosphere/npm packages. Ordinary runs reuse the cache.

**Choose the run that answers your question.**

All commands below run from the repository root. `reactive` uses the local library, including uncommitted package changes; `composite` uses the pinned `reywood:publish-composite@1.9.0`.

| Goal                                                    | Command to start with                                                  | Scope and output                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Check that reactive-publish works                       | `npm run bench:smoke`                                                  | One small DDP scenario; individual JSON/Markdown results                                   |
| Measure a reactive-publish feature independently        | `npm run bench -- run --adapter reactive --scenario multiple-autoruns` | One selected scenario, including correctness and server resource measurements              |
| Measure backend primitives without DDP roundtrip timing | `npm run bench -- backend --profile standard`                          | Reactive-only AsyncTracker, reactive variables, cursor, and derived-value measurements     |
| Compare reactive-publish with publish-composite         | `npm run bench:libraries -- --suite compatible`                        | Nine equivalent cases; `comparison.md`/`comparison.json` and raw runs                      |
| Compare runtime costs, load, retention, and Mongo work  | `npm run bench:comprehensive`                                          | Repeated two-library experiments; `report.html`, `report.md`, and `report.json`            |
| Run the focused experiment batch                        | `npm run bench:experiments -- --meteor 3.5.2`                           | Four shared cases, seven reactive-only cases, backend primitives, and a combined report   |
| Validate every implemented scenario and adapter         | `npm run bench:all`                                                    | Shared and package-specific scenarios plus backend checks; consolidated HTML/Markdown/JSON |
| Check a library change against a Git revision           | `npm run bench -- paired --base master --scenario sorted-window`       | Reactive-only baseline/candidate pairs; `comparison.md`/`comparison.json` and raw runs     |

These starting commands have different defaults: `run`, `libraries`, and `all` use small smoke workloads; `paired` defaults to five pairs of smoke workloads; `comprehensive` defaults to the larger full experiment. Use the repeated-measurement recipes below for performance conclusions. `--operations` increases observations within a run; `--pairs` increases independent runs in the comparison commands. A single `run` does not repeat itself with `--pairs`.

`all` and `comprehensive` select their adapters automatically and reject `--adapter`. There is currently no single command that combines every reactive-only scenario and all diagnostic stages. Use `run --adapter reactive` for a specific feature, `backend` for primitives, or the limited reactive-only `matrix` shown below.

**Repeat the focused experiment batch using Node.**

```sh
# Inspect the fixed plan without starting Meteor or writing results.
npm run bench:experiments -- --meteor 3.5.2 --dry-run

# Run later, once other heavy work finishes. Use a fresh directory each time.
npm run bench:experiments -- --meteor 3.5.2 \
  --output bench/results/meteor-3.5.2-idle

# Regenerate the combined report from saved data; no measurements run.
npm run bench:experiments -- report --output bench/results/meteor-3.5.2-idle

# The same fixed experiment with a Meteor checkout.
npm run bench:experiments -- --meteor-cli /path/to/meteor/meteor \
  --output bench/results/checkout-experiments
```

This Node-only helper replaces the temporary Python scripts used for the first local investigation. It calls the existing benchmark CLI sequentially: five alternating pairs for `plain-cursor`, `one-to-many`, `deep-join`, and `sorted-window`; one reactive-only run for each of `multiple-autoruns`, `subscription-data`, `infinite-scroll`, `derived-count`, `derived-aggregate`, `external-source`, and `async-pressure`; then one backend run. The fixed workload is 1,000 measured operations, 100 DDP warmup operations, 25 clients, 100 parents, and 10 children per parent, with seed 1. Up to 48 app runs are planned. Reactive-only and backend results are descriptive single repetitions. Use the other commands below to customize workloads or add load, retention, query profiling, or broader coverage.

Open `<output>/index.html` for the combined report. JSON, CSV, Markdown, execution status, per-job logs, and links to individual comparison reports are generated automatically after each job and on interruption. `report` also reads the original Python-generated result directory. Failed and incomplete measurements remain visible and are excluded from ranking; individual failures do not prevent independent jobs from running. Ctrl+C forwards interruption to the active CLI, allowing it to clean up its server and MongoDB processes, and marks remaining jobs as not run.

The helper records host load and memory every five seconds, plus available Linux CPU/memory/I/O pressure and swap counters. It does not automatically wait for an idle machine or stop other processes. Let other heavy work finish and memory/I/O pressure settle before starting a fresh batch. Source, harness, and runtime identities must remain unchanged; prepare version locks first for a new Meteor release or checkout using the commands below. The helper uses the same default Meteor release as the main CLI when neither runtime option is supplied. No Python or additional npm dependency is required.

**Compare both libraries across runtime costs, sustained load, retention, and database work.**

```sh
# Inspect the exact workload and run count without starting any processes.
npm run bench:comprehensive -- --dry-run

# Recommended complete comparison; no browser/UI required.
npm run bench:comprehensive -- --output bench/results/comprehensive

# Validate the complete pipeline with small, descriptive measurements.
npm run bench:comprehensive -- --preset quick --output bench/results/comprehensive-quick

# Focus a larger repeated comparison on one common case.
npm run bench:comprehensive -- --stages core --scenario deep-join --pairs 10

# Extend the offered-load experiment. Both duration and operation minima apply.
npm run bench:comprehensive -- --stages load --rates 10,50,100,200 --duration 60
```

Open `bench/results/comprehensive/report.html`. It includes comparable per-metric results, uncertainty/sample explanations, tested load points, a post-GC retention chart, correctness failures, and links to raw data. Markdown and JSON are written alongside it after each run. Default output directories are unique when `--output` is omitted. Use an idle machine and run one benchmark invocation at a time; other CPU-intensive work changes the experiment.

The default `full` preset uses **five independent pairs, 100 warmup operations, 1,000 measured operations, 25 clients, 100 parents, and 10 children per parent** for the core cases. These are minimum useful repetitions, not a guarantee of statistical power. Increase `--pairs` for noisy results. `quick` uses one pair and a small fixture to verify execution; it cannot establish a performance advantage.

| Stage       | Same experiment for both libraries                                                                                  | Full preset                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `core`      | All nine equivalent publication contracts, normal GC, profiling disabled                                            | 1,000 operations per run                                                    |
| `load`      | Fanout at independently scheduled write rates; latency includes scheduling delay                                    | 10, 50, 100 writes/s; at least 30 seconds **and** 1,000 writes per rate/run |
| `retention` | Stable fixture, repeated subscribe/unsubscribe, cleanup checks and forced GC with no active benchmark subscriptions | 1,000 cycles; checkpoint every 100 cycles plus baseline/final               |
| `queries`   | All nine common contracts with Mongo profiling enabled in a fresh process/database                                  | 100 operations per run; query and document/index work                       |

The complete default plan has up to **220 app runs** and about **27 minutes of scheduled load alone**, plus builds, warmup, core, retention, query stages, and drains. It is intentionally a longer experiment. `--dry-run` prints the resolved plan. Select stages with `--stages core,load`; `--scenario` filters core/query cases and includes load or retention only when the selected scenario supports it. Override fixture size and operations using the existing profile options. `--retention-cycles`, `--retention-every`, and `--latency-budget` (scheduled-delivery p95 in ms, default 100) adjust the other experiments. Query diagnostics cap operations at 100 in `full`, 20 in `quick`.

Each case runs the same resolved settings on isolated composite/reactive builds, reversing order between pairs. Both sides of a failed pair are retained; subsequent pairs of that case are skipped and its comparison is blocked. Other cases continue. Package-specific APIs are excluded from this mode and remain in `bench:all`. Source, dependencies, and harness identity must remain constant throughout the comprehensive run. The comparison rejects different profiling, forced-GC, fixture, rate, sample, runtime, or instrumentation settings.

CPU/op, RSS, JS heap, external/ArrayBuffer memory, event-loop delay, GC cost, observer churn, DDP traffic, and completed operations/s receive per-metric comparisons. Higher throughput is preferable; event-loop utilization is contextual because lower utilization can reflect more waiting and less completed work. Client latency and throughput comparisons become inconclusive if the generator reaches 90% utilization. Node CPU user/system splits, GC major/minor/max durations, V8 heap-space statistics, and bounded memory/resource time series remain available in raw results. Database CPU/op and sampled peak RSS are collected separately on Linux using the owned mongod's `/proc` counters; unsupported platforms explicitly report them unavailable. Mongo query diagnostics include reads, documents/keys examined, collection scans, and namespace/operation counts. The profiler is scoped to benchmark collections and checks start/end markers to reject incomplete or overwritten history.

Profiler costs and forced GC affect execution, so their results are separate comparison contexts. Heap retention compares post-GC checkpoints and reports signed growth and growth per 100 cycles. It does not label positive growth as a proven leak, and RSS need not return to baseline. This initial retention case exercises subscription churn; longer multi-workload soaks and heap snapshots remain extensions.

Offered-load reports show completed operations/s and scheduled-delivery latency against the chosen budget. They report tested load points, not a universal maximum capacity. Generator schedule misses invalidate the run; generator utilization of 90% or above prevents a capacity claim. Default load uses one writer connection and shared selectors. Application CPU, Mongo CPU, and generator CPU are separate processes; all run on the same machine. Raw memory sampling is every 50 ms (not an exact allocation high-water mark), with a 1-second time series capped at 600 points. Event-loop histograms have 10 ms resolution. Five pairs are required for comparisons; p95 requires 20 observations and p99 requires 1,000 in **every** run. Sparse tails remain unavailable/inconclusive, including readiness when there are few subscribers.

Failed attempts retain partial server CPU/RAM/event-loop snapshots, completed/requested counts at failure, and generator utilization/scheduling lag when operation measurement started. These appear in a separate diagnostic table and are never ranked against completed runs. Raw results also retain available Mongo failure diagnostics. A timeout under offered load establishes that the run could not finish within its configured deadline; it does not alone distinguish a publication bug from overload.

**Run everything and receive one consolidated report.**

```sh
# All implemented DDP scenarios/adapters and backend primitives, unattended.
npm run bench:all -- --output bench/results/full

# Repeated performance measurements at the standard workload size.
npm run bench:all -- --profile standard --pairs 5 --output bench/results/full-standard

# Also exercise the actual Meteor browser client (requires Chrome).
npm run bench:all -- --browser --executable /usr/bin/google-chrome --output bench/results/full-browser
```

`bench:all` discovers every declared supported scenario/adapter combination: currently 16 DDP scenarios, 33 DDP variants, and one backend suite. Browser validation is explicitly shown as skipped unless `--browser` is supplied. The default is the small `smoke` profile with one repetition per variant; `--pairs 5` gives repeated comparisons. One profile and seed apply to the entire invocation. `--rate` applies only to fanout; it is zero (completion-paced writes) by default.

The command owns preparation, sequential app execution, cleanup, and reporting without prompting. It continues after individual failures, retains their evidence, and stops further repetitions of a failed variant while the other variants finish. It automatically compares composite versus reactive and, where supported, native versus installed/reactive/composite. Comparisons involving invalid or incomplete variants are blocked; package-specific cases still receive their own measurements. This command compares libraries on the selected source; use `paired --base` separately for revision regressions.

Open **`bench/results/full/report.html`** for a self-contained report with scenario/status filters, expandable measurements, library comparisons, failures, and raw-result links. The same directory contains `report.md`, `report.json`, per-variant manifests, and logs. Reports are saved after each attempt, so completed work remains available during a run or after an interrupt. Without `--output`, the runner chooses a unique directory and prints its path.

Known correctness findings mean a complete run can finish with status `completed-with-failures` and exit code 2 while still producing all reports. That is different from an interrupted run, which marks unfinished cases `not-run`. HTML/Markdown tables average per-run summaries and label them accordingly; the comparison engine uses the individual repetitions. One repetition is descriptive and cannot establish a performance difference.

**Choose a scenario and an isolated adapter.**

```sh
# Show supported scenarios and adapters.
npm run bench -- list

# One substantial reactive-only measurement, with no competitor loaded.
npm run bench -- run --adapter reactive --scenario multiple-autoruns \
  --profile standard --warmup 100 --operations 1000 \
  --output bench/results/reactive-multiple-autoruns.json

# Test the subscription-data API independently with the same workload size.
npm run bench -- run --adapter reactive --scenario subscription-data \
  --profile standard --warmup 100 --operations 1000 \
  --output bench/results/reactive-subscription-data.json

# Reactive-only smoke coverage of the five foundational matrix scenarios.
npm run bench -- matrix --adapter reactive --profile smoke \
  --output bench/results/reactive-matrix

# Native Meteor control, with reactive-publish absent.
npm run bench -- run --scenario plain-cursor --adapter native

# One scenario across every adapter that supports it.
npm run bench -- matrix --scenario dependent-posts
```

| Adapter     | Package set and publication behavior                                  |
| ----------- | --------------------------------------------------------------------- |
| `native`    | Meteor cursor publications, reactive-publish absent                   |
| `installed` | The same native publications with reactive-publish loaded             |
| `reactive`  | Local reactive-publish source with autorun and subscription-data APIs |
| `composite` | Pinned publish-composite, reactive-publish absent                     |

The runner verifies package isolation at build and startup. Join adapters publish the same public parent and child documents. Their query implementations remain idiomatic. Unsupported scenario/adapter combinations fail before execution.

Scenarios cover plain cursors, dependent posts, one-to-many and deep joins, shared authors, field projection, sorted windows, multiple autoruns, subscription data, infinite scrolling, counts, aggregates, external reactive variables, awaited computations, fanout, and subscription churn. The default matrix runs the five foundational scenario families; `list` shows all capabilities.

Profiles provide repeatable fixture and load sizes. Override `--clients`, `--parents`, `--children`, `--operations`, `--warmup`, `--timeout` in milliseconds, and `--observation` in milliseconds. `--seed` controls fixture generation. Warmup operations are excluded from samples, but their deterministic final dataset becomes the initial measured dataset. Subscription data resets when warmup subscriptions are replaced.

The current workload topology uses one server and clients with shared selectors. Personalization/overlapping-selector profiles, multi-server runs, and reconnect stress remain extensions. The current `async-pressure` scenario serializes mutations with a controlled awaited computation; it does not claim to measure burst coalescing.

**Compare the same workload across libraries or revisions.**

The prepared reactive-publish/publish-composite comparison alternates isolated apps, validates both sides, and produces a combined report. The `compatible` suite covers all nine shared cases and preserves blocked cases. See [COMPARISONS.md](./COMPARISONS.md) for the Meteor 3.x-compatible release pin, exact common semantics, and exclusions.

```sh
# Quick two-library validation; descriptive numbers, not a supported winner.
npm run bench:libraries -- --suite smoke --pairs 1 \
  --output bench/results/libraries-smoke

# All nine equivalent cases with substantial samples and independent pairs.
npm run bench:libraries -- --suite compatible --profile standard \
  --warmup 100 --operations 1000 --pairs 5 \
  --output bench/results/libraries-compatible

# Focus the same comparison on one shared contract.
npm run bench:libraries -- --scenario sorted-window --profile standard \
  --warmup 100 --operations 1000 --pairs 5 \
  --output bench/results/libraries-sorted-window

# Compare working reactive-publish against master on one fixed Meteor runtime.
npm run bench -- paired --base master --adapter reactive \
  --scenario sorted-window --profile standard --warmup 100 --operations 1000 \
  --pairs 5 --output bench/results/paired

# Re-read the recorded pairs without executing the workload again.
npm run bench:compare -- --baseline bench/results/paired/baseline.json \
  --target bench/results/paired/target.json
```

`paired` uses the current harness against an archived base package and the current working package, alternating execution order. The base revision can predate this suite. Replace `master` with a commit or tag to pin the baseline, or use `HEAD` to measure uncommitted package changes. Both versions must pass correctness; an invalid baseline cannot produce a performance comparison. `--source /path/to/checkout` selects another package checkout. Source content hashes include local package modifications; harness/scenario fingerprints are recorded separately.

Comparisons reject invalid runs and mismatched fixtures, runtime, harness, hardware, or instrumentation. Library mode explicitly permits different adapters and additional package dependencies, while requiring identical versions of shared Meteor packages. Repetitions on each side must use the same package/source identity. Actual observer-driver changes remain visible in result metadata, including fallbacks caused by a candidate change.

Timing reports are advisory by default. Fewer than five independent run pairs are inconclusive. Larger comparisons use a deterministic paired bootstrap of run summaries. The budgets in `reporting/results.mjs` are provisional practical thresholds, not calibrated guarantees. Use A/A runs of identical source, inspect sample counts and variability, then use `--gate` only after choosing suitable budgets for the runner. Sparse smoke p95 values are descriptive; p95 comparisons require at least 20 observations in every run and p99 is omitted below 1,000 samples. Never compare the raw magnitude of measurements from different machines as if hardware were controlled.

`promote --target result.json --output bench/baselines/reference.json` stores a validated result as a portable baseline. A promoted baseline can be passed to `compare`. New measurements and paired comparisons are preferable when the machine or harness changes.

**Use additional execution modes when diagnosing a workload.**

```sh
# Offered writes are scheduled independently of completion; clients stay connected.
npm run bench -- run --scenario fanout --adapter native --clients 50 --operations 200 --rate 20

# Primitive timings execute inside Meteor, excluding DDP roundtrip time.
npm run bench -- backend --profile standard --operations 1000 \
  --output bench/results/reactive-backend.json

# Real Meteor client/Minimongo, without an application UI; Chrome is optional.
npm run bench -- browser --executable /usr/bin/google-chrome

# Node CPU profile alongside normal results; separate comparison coordinates.
npm run bench:profile -- --adapter reactive --scenario sorted-window \
  --profile standard --warmup 100 --operations 1000 \
  --output bench/results/reactive-cpu.json

# Check instrumentation sensitivity.
npm run bench -- run --scenario plain-cursor --instrumentation basic
```

Fanout operations are immutable, uniquely identified inserts. Results include dispatch-to-delivery latency, samples measured from the intended schedule, generator scheduling lag, CPU, and event-loop utilization. A generator that misses its schedule invalidates the run. Sweep client count and offered rate to find capacity for a separately chosen latency target. This mode does not automatically choose a sustainable rate or generate a capacity chart.

Backend measurements cover dependency fanout across awaits, equal-value suppression, cursor-selector churn, ComputedField, and DataLookup. Browser checks exercise initial subscription data, updates, nested field removal, and cleanup using the package's actual client helpers. Browser timings include client method/Minimongo behavior and must be compared separately from Node DDP measurements. The `warmup` option currently applies to DDP workloads; backend and browser modes validate initialization and retain their first measured iteration.

**Interpret the measurements using their recorded boundaries.**

Initial readiness is measured from sending `sub` to the matching `ready`; the initial projected dataset must be correct. Update latency ends when the expected state appears at a client. The runner checks it again after method acknowledgement and after the workload. A method response alone is not delivery evidence. Fanout completion is the last intended client's receipt. Missing updates, stale fields, extra documents, and timeouts invalidate a run.

For an unchanged expected state, the runner uses the declared observation window and validates the unchanged result. It records that interval separately from propagation latency. These cases do not prove the indefinite absence of a later update. DDP payload bytes include package metadata, but exclude WebSocket framing/compression. Initial traffic and steady-state traffic are stored separately.

Server metrics include CPU time, sampled peak/end RSS and heap, event-loop delay/utilization, GC, observer creation/stopping, active computations, cursor-cache entries, and actual driver classes. Mongo handles and shared multiplexers are separate counts. Observer counters cover the remote Mongo connection, not every in-memory Minimongo observer. The default instrumentation preserves the original observer and stop promises. `--instrumentation basic` disables observer/computation wrapping and marks full resource-cleanup verification unavailable; read-only Mongo sampling remains available.

The suite checks named publication data disappears on unsubscribe and tracked resources return to their pre-subscription baseline. Exact RSS recovery is not asserted because V8 retains allocated memory. The comprehensive mode adds post-GC retention checkpoints and Mongo query profiling. Longer multi-workload retention studies, heap snapshots, and observer-infrastructure comparisons remain follow-up diagnostics.

All outputs go under ignored `bench/results/` unless `--output` is provided. Each run retains raw samples, source/runtime metadata, phase snapshots, logs, and a readable report. Invalid runs also preserve a diagnostic client snapshot and server log tail. Exit codes are 0 for successful/advisory work, 1 for a gated performance regression, and 2 for invalid execution, incorrect data, or incompatible inputs.

**Know which Meteor version each test uses.**

| Test or benchmark                                                      | Current runtime selection                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DDP, backend, browser, library, revision, and comprehensive benchmarks | **Meteor 3.3.2**, from [`config/runtime-lock.json`](./config/runtime-lock.json); override explicitly with `--meteor <release>`                                                                                    |
| Benchmark CI                                                           | Installs Meteor **3.3.2** in [the benchmark workflow](../.github/workflows/bench.yml); harness Node is separately pinned to **22.22.0**                                                                           |
| `npm run bench:test`                                                   | Node-only harness tests; no Meteor application or Mongo server starts                                                                                                                                             |
| Package-test CI                                                        | Installs Meteor **3.3.2** in [the package-test workflow](../.github/workflows/test-package.yml), then runs `test:ci`                                                                                              |
| Local `npm test` / `npm run test:ci`                                   | The scripts do not explicitly select a release; pass `--release` as shown below to avoid relying on the local Meteor default                                                                                      |
| `npm run test:core`                                                    | Uses the repository's `meteor-core` submodule commit through [`scripts/test-core.sh`](../scripts/test-core.sh), not the benchmark release; [its CI job](../.github/workflows/test-core.yml) is currently disabled |

The recorded Meteor 3.3.2 benchmark runs use application **Node 22.18.0** and **MongoDB 7.0.16** from that release's dev bundle. The Node executable launching `bench/cli.mjs` is the separate harness/client generator process. `doctor` prints that harness Node version, the selected Meteor runtime, the application Node executable path and version, and the Mongo version. Actual run JSON records application `metadata.node`, `metadata.meteor`, `metadata.meteorRuntime`, `metadata.mongo`, resolved `metadata.packages`, hardware, and source/harness identities.

The `api.versionsFrom(['3.0.1'])` declaration in [`package.js`](../package.js) supplies package dependency version constraints; it does not select Meteor 3.0.1 for tests. Likewise, the submodule's `branch = devel` setting does not make ordinary `git submodule update --init --recursive` track the latest core: it checks out the recorded commit.

```sh
# Inspect the default benchmark runtime without running a workload.
npm run bench -- doctor

# Explicitly select the release for local package tests.
npm test -- --release 3.3.2
npm run test:ci -- --release 3.3.2
```

**Evaluate a Meteor update as a separate runtime experiment.**

Installing a newer Meteor globally does not change the benchmark default. `--meteor` writes the requested release into the isolated app, selects that release's dev-bundle Node/Mongo, and uses a separate build-cache entry. Adapter package locks live at `variants/<adapter>/<release>.versions`; 3.3.2 has locks for all four adapters, and 3.5.2 has locks for reactive/composite. Without a lock for a candidate release, its initial build resolves a new package graph. Save and review those locks before collecting repeatable measurements.

```sh
# Example candidate release; replace this with the exact release under review.
BENCH_METEOR=3.5.2
npm run bench -- doctor --meteor "$BENCH_METEOR"

# Preparation: these commands build apps and WRITE candidate locks in this repo.
# Finish all lock changes before measuring either release.
for adapter in native installed reactive composite; do
  npm run bench -- lock --adapter "$adapter" --meteor "$BENCH_METEOR"
done

# Check package correctness on the candidate release too.
npm run test:ci -- --release "$BENCH_METEOR"

# Same library source, harness, fixture, and independent pairs on each release.
# Each report compares the two libraries WITHIN its selected Meteor runtime.
for release in 3.3.2 "$BENCH_METEOR"; do
  npm run bench:comprehensive -- --meteor "$release" --stages core \
    --scenario sorted-window --pairs 5 \
    --output "bench/results/meteor-$release"
done
```

The focused experiment above uses 100 warmup and 1,000 measured operations per run, with 25 clients. Remove `--scenario sorted-window` to exercise all nine shared contracts. Remove both `--scenario sorted-window` and `--stages core` for the full experiment including load, retention, and Mongo diagnostics. For a reactive-only release check, add `--meteor "$BENCH_METEOR"` to an independent `run` or `backend` recipe above. Run experiments sequentially on the same idle machine and keep the package source, harness, competitor pin, fixtures, seed, and instrumentation fixed.

Ordinary `compare` deliberately rejects different Meteor runtimes, checkout contents, Node, Mongo, or shared Meteor package versions. There is **no automated cross-runtime comparison mode** yet: inspect the separate reports as a runtime-upgrade study instead of bypassing compatibility checks or calling the difference a reactive-publish regression. A release change may include core package, Node, or Mongo changes, so it does not isolate a particular core patch.

After choosing a new default release, update `config/runtime-lock.json`, keep the reviewed locks for all four adapters, and align the Meteor install versions and release-specific cache keys in the benchmark workflow plus the package-test workflow's install version. Update npm locks only when npm dependencies change. Re-run package correctness, benchmark smoke checks, and repeated measurements, then establish new baselines. Current CI does not automatically test a matrix of Meteor releases or follow new core releases.

**Run against a local Meteor core checkout.**

Use `--meteor-cli /absolute/path/to/meteor/meteor` instead of `--meteor` to build with an unpublished core checkout. Git worktrees and local source edits are supported. This option selects the executable at the root of a Meteor Git checkout; it is not a shell command or a path to a released installation. `--source` still selects the reactive-publish package checkout independently.

```sh
# Inspect the core revision, source fingerprint, Node, and Mongo before running.
BENCH_METEOR_CLI=/path/to/meteor/meteor
npm run bench -- doctor --meteor-cli "$BENCH_METEOR_CLI"

# Reactive-publish only, built against this core checkout.
npm run bench -- run --meteor-cli "$BENCH_METEOR_CLI" \
  --adapter reactive --scenario multiple-autoruns --profile standard \
  --warmup 100 --operations 1000 --output bench/results/core-reactive.json

# Compare both libraries against exactly the same core checkout.
npm run bench:comprehensive -- --meteor-cli "$BENCH_METEOR_CLI" \
  --stages core --scenario sorted-window --pairs 5 \
  --output bench/results/core-library-comparison

# Backend primitives use the checkout's runtime too.
npm run bench -- backend --meteor-cli "$BENCH_METEOR_CLI" \
  --profile standard --operations 1000 --output bench/results/core-backend.json
```

The same runtime options work with `run`, `profile`, `backend`, `browser`, `matrix`, `libraries`, `all`, `comprehensive`, `paired`, `lock`, and `doctor`. For example, `paired --base master --meteor-cli "$BENCH_METEOR_CLI"` compares two reactive-publish revisions on one fixed Meteor checkout; it does not compare two core revisions. `--meteor` and `--meteor-cli` are mutually exclusive. `comprehensive --dry-run` shows the selected release or CLI path without building or validating the checkout.

Checkout apps use `.meteor/release = none`, which keeps both the build and `meteor node` on the checkout instead of borrowing a released dev bundle. The selected Node executable is checked against the checkout's `dev_bundle/bin/node`; Mongo comes from that bundle unless explicitly overridden with `--mongod`. Meteor may download/bootstrap its own dependencies on first use. The harness writes benchmark apps outside the checkout and does not switch its branch or reset source files.

Results include the Git revision, a content fingerprint, dirty status, and recursive submodule identities in `metadata.meteorRuntime`. The fingerprint covers tracked diffs, non-ignored untracked files in `meteor`, `tools`, `packages`, `scripts`, and `npm-packages`, and initialized submodule contents. Ignored caches/dependencies and unrelated untracked root notes are excluded; edits to ignored dependencies are outside this source fingerprint. Core edits select another build-cache entry, and changes detected during a build or between runs invalidate execution instead of mixing revisions. Keep the checkout fixed throughout an invocation.

`lock --meteor-cli "$BENCH_METEOR_CLI" --adapter <name>` saves resolved package versions as `variants/<adapter>/checkout-<source-hash>.versions`, separately from release locks. Generate and review the locks for all four adapters before collecting a repeatable comparison. A different core revision or source fingerprint needs its own locks. For separate core branches, point the same benchmark recipe at each worktree's `meteor` executable and use different output directories; each report compares libraries within that core runtime. Cross-core performance attribution still requires inspecting those separate experiments.

**CI blocks on publication regressions and retains external-library failures.**

[The workflow](../.github/workflows/bench.yml) runs protocol/reporting tests, native/installed/composite cursor checks, reactive subscription-data, and paired library smoke checks for sorted-window, churn, and shared authors. A blocking regression step also exercises reactive plain-cursor, dependent-posts, one-to-many, deep-join, fanout, multiple-autoruns, infinite-scroll, and async-pressure. The separate package-test workflow includes the client/server lifecycle regression tests.

PRs get a one-pair advisory comparison against the base package. Scheduled/manual runs perform repeated revision comparisons and `bench:all`, publishing the full HTML/Markdown/JSON report in artifacts. The full-suite step remains non-blocking because the pinned composite release still fails relationship-refresh cases; its invalid results remain visible in job summaries and artifacts. Timing gates are opt-in. See [FINDINGS.md](./FINDINGS.md) for the lifecycle fixes and their local validation.

A separate scheduled/manual `comprehensive` job runs the full resource comparison and uploads `comprehensive-library-comparison`. Manual dispatch can select `full`, `quick`, or `disabled`. It has its own longer timeout and remains advisory because competitor correctness failures are retained. Hosted-runner measurements should be confirmed on a controlled machine before making small performance claims.

**Meteor performance integration is optional and local.**

```sh
npm run bench -- export --target bench/results/reactive-multiple-autoruns.json \
  --output bench/results/performance.json
```

The exporter writes the envelope used by the researched meteor/performance revision, with complete benchmark coordinates and the original result attached. It does not upload results. The existing dashboard will need views for the custom `reactive_publish` metric group; this suite does not claim those views have been implemented. In-process metrics use Node APIs directly, so running this suite does not require cloning meteor/performance.

Treat a lock, scenario, runtime, or instrumentation update as a new comparison context. Use the release-update procedure above for Meteor changes. The broader implementation roadmap is in [PLAN.md](./PLAN.md).
