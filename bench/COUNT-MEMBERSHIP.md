# Reactive count measurements

This comparison measured the CPU cost of publishing a count when most writes edit fields on documents already in the result. The original implementation at `b113173` enabled `cursorDependencies: 'onRead'` on both sides. It varied only the count dependency. The public option `countDependencies: 'membership'` now selects read tracking automatically. [Publication options](../PUBLICATION-OPTIONS.md)

## Projection control

A separate check on the beta at `5b5b2f5` used a count cursor with `{ fields: { _id: 1 } }`. On Meteor 3.3.2 and 3.6, both the default and read-tracking autoruns ran four times with counts `1, 2, 1, 0` across an initial read, title edit, insert, selector exit and delete. The unprojected count also ran on the title edit. This control measured reruns only.

## Measured effect

Four DDP subscribers watched the same count on Meteor 3.6 with the MongoDB oplog observer. Each run started with 200 documents, warmed up with ten writes, and measured 100 writes. Eighty changed the title of a matching document. Twenty toggled whether another document matched. The table gives the mean of five runs per mode, alternating which mode ran first.

| Per run                                | Document tracking | Membership tracking |             Difference |
| -------------------------------------- | ----------------: | ------------------: | ---------------------: |
| Autorun executions across four clients |               400 |                  80 |              80% fewer |
| Meteor process CPU per write           |          6.342 ms |            4.462 ms |            29.6% lower |
| p95 delivery time for a changed count  |          6.554 ms |            7.151 ms | 0.597 ms slower (9.1%) |
| DDP messages / bytes                   |      380 / 37,011 |        380 / 37,011 |              Identical |

Every subscriber received all 20 count changes, and the observers and computations were released after unsubscribe. CPU fell and p95 delivery time rose in all five pairs. A separate run on the unmodified beta also executed the autoruns 400 times and sent the same traffic. The CPU measurement covers the Meteor process. The benchmark waits 30 ms after each expected no-output write. The separate projection check on the beta measured rerun behavior only.

## Reproduce the comparison

Both calls below use read tracking on the same reactive source. The control explicitly selects `onRead` and keeps document tracking for counts. The candidate selects membership tracking with one option. Keeping the cursor dependency mode equal isolates the effect of skipping edits within the matching set.

Run from the repository root. For repeated pairs, alternate the order and save each pair in a fresh directory.

```sh
trial=$(mktemp -d)
run_count() {
  npm run bench -- run --meteor 3.6 --scenario derived-count --adapter reactive \
    --mutations metadata-edits --clients 4 --parents 200 --children 1 \
    --warmup 10 --operations 100 --observation 30 --timeout 30000 "$@"
}
run_count --cursor-dependencies onRead --output "$trial/documents.json"
run_count --count-dependencies membership --output "$trial/membership.json"
npm run bench -- compare --mode count-dependencies \
  --baseline "$trial/documents.json" --target "$trial/membership.json"
```
