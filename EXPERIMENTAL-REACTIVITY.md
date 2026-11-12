# Experimental cursor dependency modes

This is a local performance exploration, separate from the next release
candidate. Existing behavior is the default. No global setting is changed.

```js
Meteor.publish('postsWithComments', function () {
  return this.autorun(
    async () => {
      const parents = Posts.find({ active: true });
      const rows = await parents.fetchAsync();
      return [
        parents,
        Comments.find({ postId: { $in: rows.map((row) => row._id) } }),
      ];
    },
    { cursorDependencies: 'reads' }
  );
});

Meteor.publishReactive(
  'activePosts',
  function () {
    return Posts.find({ active: true });
  },
  { cursorDependencies: 'reads' }
);
```

`cursorDependencies: 'find'` (or omitting the option) preserves the existing
contract: constructing a cursor establishes an autorun dependency. `reads` is an
explicitly different contract for Mongo-backed cursors: `fetchAsync`, `mapAsync`,
`forEachAsync`, `fetch`, and `countAsync` establish dependencies; cursor creation
alone does not. Returned cursors continue publishing live document changes.

Local in-memory collections retain their existing cursor-creation dependencies,
including synchronous `fetch()`/`count()` behavior. The optimization is scoped to
Mongo-backed cursors; this fallback avoids making a local read nonreactive.

In the example, changing a returned comment updates the client without rerunning
the entire function. Changing the fetched parent result still reruns it and
selects the correct comment query. No projection is automatically narrowed, no
database result is cached, and no intermediate notification is intentionally
coalesced. Reads still use the normal database cursor implementation.

Opt in only when the function does not rely on an unconsumed cursor to trigger
side effects or other derived work. Code that creates a cursor, then sends a
notification or computes unrelated state on every document change will observe
fewer executions in this mode. Getting the same final documents is not a promise
of identical execution behavior. A `countAsync` read remains reactive, including
insertions and removals.

The setting is per invocation of `this.autorun`, `Meteor.publishReactive`, or
`AsyncTracker.autorun`. Nested autoruns keep the default unless explicitly given
their own option. Other concurrent publications keep their own settings.
Unrecognized modes fail validation rather than silently selecting a behavior.

The prototype includes exact DDP-data checks, default-vs-opt-in rerun checks,
reactive counts, projected ordering/field removal across awaits, cache cleanup,
scope isolation, and removed-document membership cleanup without reruns.
This is not yet a general release recommendation: broader
core compatibility and application-specific side effects still need evaluation.

For local DDP experiments, the harness accepts `--cursor-dependencies find|reads`.
Raw results record the mode, and ordinary revision comparison refuses to mix
modes. The explicit `cursor-dependencies` comparison mode requires the same
reactive source on both sides. Library comparison permits this declared
implementation choice but rejects changing the mode within one set of repeats.
Invalid data and cleanup results remain excluded from performance comparisons.

Measurements and conclusions stay in ignored `bench/results/` and `bench/private/`.
