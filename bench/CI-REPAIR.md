# CI repair and source verification — 2026-11-11

Ordinary cursor publications now leave the DDP stream unchanged until they use
subscription data. The core runner verifies the actual compiled package source,
and PR checks distinguish library regressions from an unmodified upstream
comparison library's failures.

## Subscription metadata

Previously every named publication inserted an empty `_subscriptionData` document.
The insert and later removal added three events when core replaced a subscription,
violating `livedata server - publish cursor is properly awaited`'s eight-message
contract. The original assertion is unchanged.

The server now initializes the document on the first `data` or `setData` call.
Client writes can still create it through the existing upsert. Read-only cursor
publications emit no metadata. Initialization is shared by concurrent data calls,
and cleanup is registered before invoking the publication. Existing field-level
reactivity checks remain unchanged. A new regression covers absent metadata,
client creation, and removal on stop across separate DDP connections.

A further controlled regression found that a server data read completing after
subscription stop could recreate that lazily initialized document. Initialization
now refuses to start after stop, and cleanup waits for initialization already in
progress before removing the document. The test keeps two DDP connections open,
stops their subscriptions, and then completes the delayed reads; it fails before
the fix and passes afterward.

An initial write-only initialization attempt failed two existing field-reactivity
checks. It is retained in the local logs, and was replaced by initialization on
server data access to preserve that behavior.

## Correction to earlier core evidence

The old runner set `METEOR_PACKAGE_DIRS` to a package root. Meteor expects a
parent directory whose children are packages, so it could load the published
1.1.1 version rather than the requested source. Checking `.meteor/versions` and
hashing local files did not catch the substitution. Earlier reports comparing
core runs with package revisions therefore **do not establish those revisions'
behavior**. The prior package-free baselines are unaffected by this selection bug.

The runner now creates an isolated package link and validates the build's
`isopack-buildinfo.json` watch set against every production source file's real path
and SHA-1 content hash. Registry fallback, another checkout, missing files and
mismatched contents cannot pass. The manifest is saved with the run. A regression
specifically rejects a different build with the same package version.

The full core workflow is enabled on both `changeStreams,polling` and
`oplog,polling`, pinned to Meteor `0f95d70340a99c55e3547932a6d7e85db4f47996`.
Each job runs a package-free baseline then the source-verified local package.
Core assertions and dependencies are unmodified.

The first hosted baseline failed during startup on Ubuntu 22.04: the pinned core's
uWebSockets binary requires `GLIBC_2.38`. Core jobs now use Ubuntu 24.04 with a
separate cache key. The benchmark/package jobs retain their released runtimes.
The source-discovery link also lives in a temporary directory outside artifacts
and is removed after cleanup, preventing artifact collection from following a
link back through the repository. The runner regression checks that cleanup too.

The next clean hosted run exposed an inherited npm prefix: Puppeteer installed
outside the core bundle when invoked through `npm run`. Installation now supplies
the bundle prefix explicitly and verifies the module loads before building the
test app. A cold-install regression reproduces the failure with a conflicting
prefix and passes with the fix.

## Native cursor behavior

The first full run with verified local source exposed another core failure:
`collection - calling find with a valid readPreference`. The async wrapper awaited
reactive observer setup even outside a computation, postponing Mongo's immediate
cursor initialization. It now delegates directly to the original method outside
active computations, preserving return values, synchronous setup, and thrown
errors. Local cursors also wrap their own original methods rather than Mongo's
already wrapped methods. A package regression checks both fetch entry points and
synchronous validation; the upstream assertion remains unchanged.

## Upstream comparison failures

The failing reference apps resolve `reywood:publish-composite@1.9.0` and do not
load reactive-publish. `dependent-posts` and `projection-sensitivity` can retain
old child documents after the parent changes. The latest upstream tagged release
and current source both retain the asynchronous replacement implementation:
[Publication at v1.9.0](https://github.com/Meteor-Community-Packages/meteor-publish-composite/blob/v1.9.0/lib/publication.js).

`bench/diagnostics/composite-race.mjs` loads that unmodified implementation with a
controlled observer scheduler. It starts an old child observer, allows a newer
replacement to complete, then releases the older initialization. The result
contains both `new` and obsolete `old`, and one observer remains after unpublish.
It records hashes of the loaded source files. This establishes an upstream race;
it does not prove that every hosted timeout has precisely that scheduling order.
A local real-Meteor run with 12 clients and 30 operations passed, reinforcing that
an intermittent upstream defect cannot be cleared by a single passing rerun.

```sh
node bench/diagnostics/composite-race.mjs /path/to/publish-composite/lib
```

The upstream package is not patched. All 39 variants still run on PRs:

- 29 reactive-publish, native and installed-control variants, including backend
  and browser checks, are blocking.
- Ten upstream composite variants run in an explicitly advisory reference job.
  Raw failures remain invalid and excluded from rankings; the job and artifacts
  show their failures. This is a CI responsibility change, not an upstream fix.

`bench:all` remains strict by default. `--adapters` selects an explicit subset;
reports record that selection. Tests ensure the two CI selections partition the
full matrix without omissions, and reference failures cannot become valid runs.

## Validation

Before the late-read cleanup follow-up, `be04337` passes all 141 package tests
and all 29 required benchmark variants on both Meteor 3.3.2 and 3.6, locally and
on GitHub, including backend and browser checks. The local 3.6 matrix enables
lifecycle instrumentation. Its full local core runs pass 2,645/2,645 with change
streams and 2,551/2,551 with oplog, exactly matching their baseline inventories.
The hosted oplog baseline and candidate also pass 2,551/2,551. These counts describe
that checkpoint; the late-read follow-up adds one package regression.
All 71 Node harness tests pass; lint reports zero errors and 18 existing warnings.
The source-verified focused core read-preference run passes on server and client.
The unchanged DDP message assertion also passes with verified local source.

The complete two-release package, benchmark and two-backend core results are
reported in [PR #10 checks](https://github.com/nachocodoner/meteor-reactive-publish/pull/10/checks)
and its validation summary. Raw local reports use the paths below. A successful
reference rerun does not erase previously observed upstream failures. No new
performance improvement is claimed for this follow-up; earlier cache measurements
describe their recorded source and harness snapshots.

Local evidence is preserved under ignored `bench/results/ci-repair-2026-11-11/`,
including failed/interrupted attempts. The earlier full-core attempt was stopped
when the package checks exposed the data-initialization regression; it is not
counted as a completed run. The subsequent verified run exposed the native-cursor
issue above; validations were stopped before changing source and restarted.
Neither interrupted attempt counts as a pass.
