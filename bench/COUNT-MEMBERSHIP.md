# Track changes to a reactive count

This experiment starts at the `1.2.0-beta.0` candidate, commit `5b5b2f5`. The new option lives on the `experiment/count-membership` branch.

An open-ticket badge needs a new count when a ticket opens or closes. Editing an open ticket's title leaves the badge unchanged. Set `countDependencies: 'membership'` on the autorun that publishes the badge to skip rerunning it for title edits.

```js
Meteor.publish('myOpenTicketCount', function () {
  if (!this.userId) return this.ready();
  this.autorun(
    async () => {
      const count = await Tickets.find({
        assigneeId: this.userId,
        open: true,
      }).countAsync();
      await this.setData('count', count);
      this.ready();
    },
    { cursorDependencies: 'onRead', countDependencies: 'membership' }
  );
});
```

The option belongs to one autorun. You can also pass the same options as the third argument to `Meteor.publishReactive` for its implicit autorun, or as the second argument to `AsyncTracker.autorun`. Nested autoruns choose their own options. The existing defaults are `cursorDependencies: 'onFind'` and `countDependencies: 'documents'`.

In membership mode, a plain named server Mongo cursor observes matching IDs and runs the original Mongo count whenever the autorun executes. An insert, delete, or selector-field edit that moves a document into or out of the set invalidates the computation. Edits within the set leave the count dependency alone. Other dependencies in the same function still trigger reruns. For example, calling `fetchAsync()` on the same cursor also observes document changes. Use ordinary document tracking if your function needs to run on edits to matching documents even when the count stays the same.

Sorted, paginated, projected, transformed, local, and custom cursors keep their ordinary observation behavior. Membership tracking requires `cursorDependencies: 'onRead'` so that creating the cursor does not already observe every field.

Choose this mode for a count-only autorun. If you count and fetch the same query in one autorun, the full fetch still wakes the function on field edits, and the ID-only count can add a second observer.

## Getting the same behavior on the beta

If you control the query, you can already project just the ID on the count cursor. This works on the beta with its default options as well as with `cursorDependencies: 'onRead'`.

```js
const count = await Tickets.find(
  { assigneeId: this.userId, open: true },
  { fields: { _id: 1 } }
).countAsync();
```

A focused check against the beta's production code on Meteor 3.3.2 and 3.6 started with one matching ticket, changed its title, inserted another, closed the first, and deleted the second. Both projected readers ran four times with counts `1, 2, 1, 0`. An unprojected reader also reran on the title edit. The experimental option is most useful when the count cursor comes from a reusable query helper and callers want to leave that helper's projection intact.

The experimental implementation (`b113173`) passed the full 164-test package suite on each Meteor release, including a mixed count-and-fetch autorun, sorted and limited fallback, invalid options, and observer cleanup after stop.

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

Run both modes from this branch with the same Meteor release, fixture, and client count. This example runs one pair. For repeated pairs, use fresh output directories and alternate which mode runs first.

```sh
trial=$(mktemp -d)
for mode in documents membership; do
  npm run bench -- run --meteor 3.6 --scenario derived-count --adapter reactive \
    --cursor-dependencies onRead --count-dependencies "$mode" \
    --mutations metadata-edits --clients 4 --parents 200 --children 1 \
    --warmup 10 --operations 100 --observation 30 --timeout 30000 \
    --output "$trial/$mode.json"
done
npm run bench -- compare --mode count-dependencies \
  --baseline "$trial/documents.json" --target "$trial/membership.json"
```
