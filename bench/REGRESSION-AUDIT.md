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
