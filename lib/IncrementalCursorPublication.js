import { DiffSequence } from 'meteor/diff-sequence';
import { EJSON } from 'meteor/ejson';
import { Mongo, MongoInternals } from 'meteor/mongo';
import { AsyncTracker } from './ReactiveAsync/AsyncTracker';
import { observeUntracked } from './PublicationContext';

const cursorPrototype = Object.getPrototypeOf(
  MongoInternals.defaultRemoteCollectionDriver().mongo.find()
);
const publishCursor = cursorPrototype._publishCursor;
const collectionPublishCursor = Mongo.Collection._publishCursor;
const plain = (value) =>
  value != null && Object.getPrototypeOf(value) === Object.prototype;
const fieldName = (key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
const scalar = (value) =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  Number.isFinite(value);

// A few small queries can survive membership changes independently. Bound the
// number of observers per returned cursor, including after repeated additions.
const partitionSize = 16;
const maxPartitions = 16;

export function incrementalCursorPlan(cursor, observeChanges) {
  if (
    !cursor ||
    Object.getPrototypeOf(cursor) !== cursorPrototype ||
    cursor._publishCursor !== publishCursor ||
    Mongo.Collection._publishCursor !== collectionPublishCursor ||
    cursor.observeChanges !== observeChanges ||
    Object.hasOwn(cursor, '_getCollectionName')
  )
    return null;

  const { collectionName, selector, options } = cursor._cursorDescription;
  if (!plain(selector) || !plain(options)) return null;
  if (
    Object.keys(options).some(
      (key) => !['fields', 'projection', 'transform'].includes(key)
    ) ||
    options.transform != null
  )
    return null;
  if (options.fields && options.projection) return null;
  const projection = options.projection ?? options.fields ?? {};
  if (
    !plain(projection) ||
    projection._id === 0 ||
    projection._id === false ||
    Object.entries(projection).some(
      ([key, value]) => !fieldName(key) || ![0, 1, false, true].includes(value)
    )
  )
    return null;

  const inFields = Object.entries(selector).filter(
    ([, value]) => !scalar(value)
  );
  if (inFields.length !== 1 || !Object.keys(selector).every(fieldName))
    return null;
  const [field, expression] = inFields[0];
  if (
    !plain(expression) ||
    Object.keys(expression).length !== 1 ||
    !Array.isArray(expression.$in) ||
    !expression.$in.every((id) => typeof id === 'string')
  )
    return null;
  const ids = [...new Set(expression.$in)];
  if (ids.length > partitionSize * maxPartitions) return null;

  const fixed = Object.fromEntries(
    Object.entries(selector).filter(([key]) => key !== field)
  );
  return {
    cursor,
    collectionName,
    field,
    ids,
    signature: EJSON.stringify([field, fixed, options], { canonical: true }),
  };
}

export class IncrementalCursorPublication {
  constructor(plan, publish, computation) {
    this.mongo = plan.cursor._mongo;
    this.signature = plan.signature;
    this.name = plan.collectionName;
    this.publish = publish;
    this.computation = computation;
    this.sources = new Set();
    this.published = new Map();
    this.pending = new Set();
  }

  accepts(plan) {
    return (
      this.mongo === plan.cursor._mongo && this.signature === plan.signature
    );
  }

  stop() {
    this.stopped = true;
    this.guard?.handle?.stop();
    this.guard = undefined;
    for (const source of this.sources) source.handle?.stop();
    this.sources.clear();
    this.published.clear();
    this.pending.clear();
  }

  // All partitions have exactly the same projection. A multikey document may
  // belong to more than one, but the subscription owns just one DDP document.
  deliver(key, row) {
    const previous = this.published.get(key);
    if (previous === row) return;
    const pub = this.publish;
    AsyncTracker.runWith(this.computation, () => {
      if (!row) {
        this.published.delete(key);
        pub.removed(this.name, previous.id);
      } else if (!previous) {
        this.published.set(key, row);
        pub.added(this.name, row.id, row.fields);
      } else {
        this.published.set(key, row);
        const changes = DiffSequence.makeChangedFields(
          row.fields,
          previous.fields
        );
        if (Object.keys(changes).length)
          pub.changed(this.name, row.id, changes);
      }
    });
  }

  updateDocument(key) {
    if (this.stopped) return;
    if (this.initializing) {
      this.pending.add(key);
      return;
    }
    if (!this.guard || this.guard.members.has(key)) {
      for (const source of this.sources) {
        const row = source.rows.get(key);
        if (row) {
          this.deliver(key, row);
          return;
        }
      }
      // A document can move from one live partition to another. Keep its
      // last fields until the destination delivers the new projected row.
      if (this.guard) return;
    }
    this.deliver(key, undefined);
  }

  async startGuard(guard, cursor) {
    // Independent Mongo observers can deliver a foreign-key move in either
    // order. One ID-only union decides when the subscription actually loses
    // a document. All live callbacks stay synchronous within Mongo's fences.
    const change = (id, added) => {
      if (this.stopped || this.guard !== guard) return;
      const key = this.publish._idFilter.idStringify(id);
      if (added) {
        guard.members.add(key);
        if (this.initializing && this.published.has(key)) return;
      } else {
        guard.members.delete(key);
      }
      this.updateDocument(key);
    };
    const handle = await observeUntracked(() =>
      cursor.observeChanges(
        {
          added: (id) => change(id, true),
          removed: (id) => change(id, false),
        },
        { nonMutatingCallbacks: true }
      )
    );
    guard.handle = handle;
    if (this.stopped || this.guard !== guard) handle.stop();
  }

  async startSource(source, cursor) {
    const change = (id, fields, event) => {
      if (this.stopped || !this.sources.has(source)) return;
      const key = this.publish._idFilter.idStringify(id);
      if (event === 'removed') {
        source.rows.delete(key);
      } else if (event === 'added') {
        source.rows.set(key, { id, fields });
      } else {
        const values = Object.assign(
          Object.create(null),
          source.rows.get(key).fields
        );
        DiffSequence.applyChanges(values, fields);
        source.rows.set(key, { id, fields: values });
      }
      this.updateDocument(key);
    };
    // The group owns these handles, including handles that resolve after stop.
    // Its physical partitions must not create user computation dependencies.
    const handle = await observeUntracked(() =>
      cursor.observeChanges(
        {
          added: (id, fields) => change(id, fields, 'added'),
          changed: (id, fields) => change(id, fields, 'changed'),
          removed: (id) => change(id, undefined, 'removed'),
        },
        { nonMutatingCallbacks: true }
      )
    );
    source.handle = handle;
    if (this.stopped || !this.sources.has(source)) handle.stop();
  }

  fail(error) {
    if (this.stopped) return;
    this.stop();
    this.publish.error(error);
  }

  async update(plan) {
    const next = new Set();
    const remaining = new Set(plan.ids);
    for (const source of this.sources) {
      const retained = source.ids.length
        ? source.ids.every((id) => remaining.has(id))
        : !plan.ids.length;
      if (retained) {
        next.add(source);
        for (const id of source.ids) remaining.delete(id);
      }
    }
    if (next.size + Math.ceil(remaining.size / partitionSize) > maxPartitions) {
      next.clear();
      for (const id of plan.ids) remaining.add(id);
    }
    const { selector, options } = plan.cursor._cursorDescription;
    const fresh = [];
    const addSource = (ids, cursor) => {
      const source = { ids, rows: new Map() };
      fresh.push({ source, cursor });
      next.add(source);
    };
    const ids = [...remaining];
    for (let i = 0; i < ids.length; i += partitionSize) {
      const chunk = ids.slice(i, i + partitionSize);
      const query = { ...selector, [plan.field]: { $in: chunk } };
      addSource(chunk, this.mongo.find(this.name, query, options));
    }
    if (!plan.ids.length && !next.size) addSource([], plan.cursor);
    if (!this.initializing && !fresh.length && next.size === this.sources.size)
      return;
    const previous = this.sources;
    const previousGuard = this.guard;
    this.sources = next;
    const version = (this.version = (this.version || 0) + 1);
    this.initializing = true;
    for (const source of previous) {
      if (!next.has(source)) {
        source.handle?.stop();
        for (const key of source.rows.keys()) this.pending.add(key);
      }
    }
    try {
      const useGuard = plan.field !== '_id' && next.size > 1;
      const guardKey = useGuard
        ? JSON.stringify([...plan.ids].sort())
        : undefined;
      if (this.guard?.key !== guardKey) {
        this.guard?.handle?.stop();
        this.guard = undefined;
        if (useGuard) {
          const guard = (this.guard = { key: guardKey, members: new Set() });
          const cursor = this.mongo.find(this.name, selector, {
            projection: { _id: 1 },
          });
          guard.ready = this.startGuard(guard, cursor);
        }
      }
      for (const { source, cursor } of fresh) {
        source.ready = this.startSource(source, cursor);
      }
      await Promise.all([
        this.guard?.ready,
        ...[...next].map((source) => source.ready),
      ]);
    } catch (error) {
      if (!this.stopped && this.version === version) this.fail(error);
      return;
    }
    if (this.stopped || this.version !== version) return;
    this.initializing = false;
    // Retained partitions keep their projected rows. Reconsider documents
    // touched during setup, plus IDs whose union membership changed. A new
    // member of the $in set never requires copying every retained document.
    if (previousGuard !== this.guard) {
      for (const key of this.published.keys()) {
        if (!this.guard?.members.has(key)) this.pending.add(key);
      }
    }
    for (const key of this.pending) this.updateDocument(key);
    this.pending.clear();
  }
}
