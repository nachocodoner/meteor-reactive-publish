# Meteor-core package-suite verification

The portable runner uses Meteor's own `test-in-console` driver and Puppeteer
runner. It passes the package through the supported `--extra-packages` CLI option.
It never rewrites core assertions, modifies Tinytest's dependencies, or resets a
checkout. Use a separate Meteor worktree and initialize its submodules first.

```sh
npm run test:core -- --checkout /path/to/meteor --mode baseline \
  --reactivity changeStreams,polling --output bench/results/core/baseline-cs
npm run test:core -- --checkout /path/to/meteor --mode package \
  --reactivity changeStreams,polling --output bench/results/core/package-cs
npm run test:core -- --checkout /path/to/meteor --mode baseline \
  --reactivity oplog,polling --output bench/results/core/baseline-oplog
npm run test:core -- --checkout /path/to/meteor --mode package \
  --reactivity oplog,polling --output bench/results/core/package-oplog
```

Omitting `--packages` and `--filter` selects the complete local Meteor package
suite, including deprecated packages. No core package is excluded by default.
Meteor CI currently excludes `stylus`; `--exclude stylus` can reproduce that
configuration, but the verification below includes its tests. The package being
compared is excluded from test discovery in both modes, while its production
code is loaded only in `package` mode. Its own 137 tests were verified separately.

`--source /path/to/snapshot` selects another reactive-publish revision.
`--packages mongo,ddp-server` and `--filter 'case name fragment'` are explicit
focused diagnostics. Package paths should be absolute because Meteor runs from
the selected core checkout. `--executable` selects Chrome; `--timeout` is the
overall millisecond deadline (default 90 minutes).

Each run preserves the resolved versions, core/submodule identities, package
source hash, upstream output, completed case names and `summary.json`. A failed
assertion remains failed. Startup errors, empty selections and missing package
graphs cannot count as passes. The runner checks source identities again after
stopping the app and browser; it leaves the generated app available for diagnosis.

The current Meteor tool upgrades five tracked Blaze shrinkwrap files from format
4 to 5 during dependency preparation. Only that exact metadata migration is
accepted, with the entire resolved dependency graph unchanged. Other local source,
test, dependency or submodule revisions are rejected. These generated metadata
changes stay confined to the disposable worktree.

## Correction and current behavior — 2026-11-11

The earlier package-loaded results below are superseded. The runner passed a
package root to `METEOR_PACKAGE_DIRS`, which expects a directory containing
packages. Meteor could therefore load the published 1.1.1 package while the
report recorded a hash of the local checkout. Those runs do **not** establish
the behavior of the recorded candidate or base revisions.

The runner now creates an isolated package link and verifies every production
source file against Meteor's compiled-package watch set, including its content
hash. A matching version string alone is insufficient. The build manifest is
saved as `package-buildinfo.json`; missing or different source fails validation.

Ordinary publications no longer create empty subscription metadata. A server
publication initializes that document when it first calls `data` or `setData`;
client writes still upsert it, and stopping the subscription removes it. The
original upstream eight-message assertion passes without rewriting or filtering
core tests. The wire probe now requires zero metadata messages for plain cursors.

The core workflow is enabled for PRs, master and manual runs, pinned to the
checkout below. Each Mongo backend runs the unmodified baseline followed by the
verified local package. See [CI repair](./CI-REPAIR.md) for current results.

## Historical results (source selection was not verified)

## Revision selection on 2026-11-11

After fetching both branches, `origin/devel` was
`0f95d70340a99c55e3547932a6d7e85db4f47996` and `origin/release-3.6` was
`ee46fd8981bed883c459ef693e9b86511d7231ff`. Merge `d4260f9c8c` integrated
`release-3.6` into `devel` on 2026-11-10. The branch tips differ only in four
`v3-docs` files. Their packages, tests, CLI, scripts, submodules and required dev
bundle are identical, so one pinned core checkout covers both current source
states. This does not equate every historical release or package graph.

All runs below use that devel SHA, dev bundle `26.13.0.1`, Node 26 and Chrome 157
on the same Intel Mac. The two reactivity preferences match Meteor CI and permit
polling fallback. These are correctness runs, not performance comparisons. Test
inventories differ across backend configurations because of driver-specific cases.

## Results

| Reactivity preference | Without package | With package `1a3dbd9` |
| --- | --- | --- |
| `changeStreams,polling` | 2645 passed, 0 failed | 2644 passed, 1 failed |
| `oplog,polling` | 2551 passed, 0 failed | 2550 passed, 1 failed |

The change-stream baseline used the upstream shell runner directly and exited 0.
It logged module-resolution and Mongo disconnect errors during teardown after
reporting all 2645 tests complete; these remain in the raw log. Later runs use the
portable wrapper and retain their temporary app until after process cleanup.

Raw evidence, exact graphs and revisions are under ignored
`bench/results/core-suite-2026-11-11/`. A failed diagnostic attempt used a relative
probe path resolved under the core checkout and executed no tests; it is recorded
as incomplete and excluded from the results table.

## The existing DDP message-count assumption

The unmodified case `livedata server - publish cursor is properly awaited` expects
exactly eight messages and forbids any `removed` message in that captured interval.
Loading reactive-publish adds two `added` messages and one `removed` message for
its auxiliary `_subscriptionData` collection. The raw test therefore fails.
The same exact failure was reproduced against package base `c99252d` on the same
Meteor SHA in both backend configurations. The old core runner replaced this
expectation before execution; the new runner exposes it without modifying the test.

The additional test in `bench/tests/fixtures/core-wire-probe/` captures collection
names and verifies that the cursor itself still follows the original eight-message sequence with no
removed cursor documents, alongside exactly two metadata additions and one
metadata removal. It does not replace, skip or turn the upstream failure green.
This additional case passed with both the package base and candidate. A focused
invocation is:

```sh
npm run test:core -- --checkout /path/to/meteor --mode package \
  --packages /absolute/path/to/this/repo/bench/tests/fixtures/core-wire-probe \
  --output bench/results/core/wire-probe
```

The raw core suite with the package is not claimed to be entirely green merely
because an integration effect predates this branch. The full case inventories
match exactly within each backend configuration. The only failure has identical expected/actual values on the package base and candidate;
no new regression was identified in these executions. There are no source or test
changes in core, and the auxiliary traffic diagnostic confirms zero removals of
cursor documents. Existing late-assertion warnings in Blaze tests also occurred
in the package-free baseline and remain in the raw logs. This is evidence for the
selected package suite and configurations, not a claim about Meteor CLI self-tests
or end-to-end suites.

The four new runner orchestration tests, all 64 Node harness tests, lint and
whitespace checks pass. The performance harness and package source hashes still
match the prior 39-check smoke run; this follow-up changes testing infrastructure
and documentation only. The core workflow remains disabled: it still needs a
pinned checkout/configuration update and an explicit policy for the pre-existing
raw-message test failure, rather than silently rewriting its expectation.


## Cache-optimization follow-up

The [instrumentation-guided iteration](./INSTRUMENTED-OPTIMIZATION.md) reran both
complete core configurations with the cache-hit optimization. Change streams
again completed 2644 passed/1 failed; oplog completed 2550 passed/1 failed. Both
inventories and complete failure details match the earlier checkpoint exactly.
Core and package source-integrity checks passed. The final wire diagnostic passed
1/1, with the original eight cursor events, no cursor removals, and the separate
metadata messages. No upstream assertion was rewritten. Later edits affect only
package-test fixtures; production files remain byte-identical to these core runs.

Run the backend commands sequentially on a host. An initial concurrent launch
selected overlapping HTTP/MongoDB port pairs and its browser opened MongoDB's
HTTP diagnostic instead of Tinytest. It executed no cases and remains recorded
as incomplete; the completed change-stream run followed oplog. Raw evidence and
inventory comparisons are under ignored
`bench/results/instrumented-optimization-2026-11-11/`.
