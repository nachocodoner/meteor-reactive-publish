# Regression and test-contract audit — 2026-11-11

Audited `fix/reactive-publication-lifecycle` at `2b2a128` against its base,
`c99252d` (`origin/master`, verified by fetching the remote). This follow-up adds
the fixes described below.

## Were tests changed to accommodate the optimizations?

An AST comparison of all six branch commits with the base found no changed or
removed bodies among the 88 original Tinytest registrations in ten files.
The Mongo test edits already in the branch were formatting only. New dependency
and publication lifecycle regressions added coverage.

An adjacent-commit audit of the Node harness tests found one changed assertion:
the comprehensive plan's core scenario count increased from nine to ten when
`personalized-selectors` was added. No existing harness test was removed.

The inherited `scripts/test-core.sh` rewrites a core DDP message expectation.
That script and the disabled core workflow are identical on the branch and base;
this was not introduced by the optimizations.

## Failures reproduced before these fixes

| Source | Meteor | Passed | Failed |
| --- | --- | ---: | ---: |
| Untouched base `c99252d` | 3.6 | 116 | 5 |
| Branch `2b2a128` | 3.3.2 | 137 | 0 |
| Branch `2b2a128` | 3.6 | 133 | 4 |

The branch's 3.6 failures were single-document reactivity, recent posts, and two
ReactiveData count cases. The cache case passed this full run and a focused run,
but had failed in earlier recorded runs. The base also failed single-document
reactivity, recent posts and the two count cases, plus a field-removal case.
These are individual observations, not estimated failure rates. Initial full
runs overlapped on this host; baseline failures do not excuse candidate failures.

## Corrections and unchanged expectations

- ReactiveData cases mixed returned promises with completion callbacks.
  `await Meteor.setTimeout(next, ...)` does not await a timer; it allowed later
  tests to overlap unfinished assertions. Use awaited timer promises and a single
  completion mechanism. The earlier logs contained `event after complete!`.
- Mongo reactivity cases assumed observer callbacks settled within 100 ms.
  Await the expected completed rerun with a five-second failure deadline, then
  retain the exact rerun counts and cache assertions. ReactiveData likewise waits
  for the expected derived count before checking the entire data object.
- The recent-posts fixture performed ten sequential DDP calls inside a two-second
  publication window. Seed the same ten posts, spaced 91 ms apart, in one server
  method and stop the test observer afterward. Keep the two-second window, all
  twenty expected events, ID checks, and both timing assertions unchanged.

An additional AST audit confirms that all 634 original direct `test.*` assertion
calls, including their arguments and expected values, remain present in order.
The test bodies now contain synchronization and fixture corrections; they are
not claimed to be byte-for-byte unchanged. No production implementation changed
in this follow-up.

## Validation

The final full client/server package suite passed **137/137** on both Meteor
3.3.2 and Meteor 3.6, with no `event after complete!` messages. The focused repaired
recent-posts case also passed on 3.6. The 60 Node harness tests passed; lint passed
with zero errors and 18 existing unused-variable warnings. Workflow YAML parsing,
release forwarding, whitespace checks, and the assertion audit passed.

The complete Meteor 3.3.2 smoke matrix passed **39/39** real executions: 37 DDP
variants over 17 scenarios, backend primitives, and an actual browser check.
All correctness and resource-cleanup checks passed; 25 comparisons were available
and none blocked. This is smoke coverage, not a new performance or capacity claim.
The rendered report is `bench/results/regression-audit-2026-11-11/smoke/report.html`.

Raw logs, the AST audit scripts and JSON findings are under the ignored local
`bench/results/regression-audit-2026-11-11/` directory.

## Remaining verification

The full Meteor-core suite was not run. Its pre-existing runner needs portability
and cleanup work before use: it modifies the core checkout and its expectations,
uses GNU-specific `sed -i`, and restores files with `git checkout`. Its CI job
remains disabled. The package CI matrix now covers Meteor 3.3.2 and 3.6; it still
needs to execute on the final committed source before merging.


## Subsequent full-core verification

The [core verification report](./CORE-TESTING.md) records the later full runs on
pinned devel, whose runtime/tests match the current release-3.6 branch. Both
package-free baselines passed. Both package-enabled runs completed with the same
one pre-existing metadata-message assumption, reproduced on the package base;
no upstream assertion was rewritten. The legacy runner has been replaced by an
isolated CLI wrapper. The earlier remaining-verification paragraph above describes
the state at the original audit checkpoint.


## Instrumentation-guided optimization follow-up

The [subsequent optimization report](./INSTRUMENTED-OPTIMIZATION.md) records a
new cache-hit optimization and a further test-contract audit. The 634-assertion
statement above describes the earlier checkpoint. In the latest source, 618 of
those calls and values remain unchanged. Four child-run equalities in one nested
Mongo test were incorrect: independent observers can notify a child before its
parent replaces it. A controlled real-Mongo probe demonstrated the same ordering
on both pre-optimization `be74b3f` and the candidate. Those four expectations now
allow additional child reruns; exact parent/child creation counts, published data
and cleanup requirements remain checked. The probe and a projected-sort cache
case add coverage. A later CI run exposed another incidental rerun count in the
forEach fixture. It now settles each write before the next and checks exact totals
6/11/13 instead of 5/9/11, with the same result arrays; the repaired fixture passed
on both be74b3f and the candidate. These are the other three changed assertions.
A subsequent hosted run found the same removal coalescing in mapAsync. Map and
fetch fixtures now also settle each write, keeping exact totals and data. This
changes three map counts and six fetch counts; the full table of 16 corrections
is in the optimization report. An explicit mapped-result reorder assertion
preserves move coverage. All 12 Mongo-focused tests pass on base and candidate
on both releases. No original test registration was removed.

The previously pushed checkpoint's hosted harness and Meteor 3.6 jobs failed,
despite their local passes. The harness needed optional browser discovery without
root Puppeteer installed; the package failure exposed the observer-order assumption
above. Both failures and their controlled reproductions are retained. The new
full package runs pass 139/139 on both Meteor 3.3.2 and 3.6, with no late assertions.
See the follow-up report for complete smoke, full-core and hosted CI status.
