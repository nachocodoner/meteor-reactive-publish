import EJSON from 'ejson';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

export function normalizeState(state) {
  return canonical(
    Object.fromEntries(
      Object.entries(state)
        .filter(([, docs]) => docs.length)
        .map(([name, docs]) => [
          name,
          docs
            .map(canonical)
            .sort((a, b) => String(a._id).localeCompare(String(b._id))),
        ])
    )
  );
}

export function statesEqual(actual, expected) {
  return EJSON.equals(normalizeState(actual), normalizeState(expected));
}

// Build the independent expected state once per mutation, shared by all
// clients. Comparing by identity avoids cloning/sorting the complete dataset
// for every DDP message while retaining exact document/field validation.
export function prepareState(state, names = Object.keys(state)) {
  return new Map(
    names.map((name) => {
      const rows = state[name] || [];
      const docs = new Map(rows.map((doc) => [doc._id, doc]));
      if (docs.size !== rows.length)
        throw new Error(`Duplicate expected document identity in ${name}`);
      return [name, docs];
    })
  );
}

export class DocumentStore {
  collections = new Map();

  apply(message) {
    const { msg, collection, id } = message;
    if (!['added', 'changed', 'removed'].includes(msg)) return false;
    if (typeof collection !== 'string' || typeof id !== 'string')
      throw new Error('Invalid DDP document identity');
    if (!this.collections.has(collection))
      this.collections.set(collection, new Map());
    const docs = this.collections.get(collection);
    if (msg === 'added') {
      if (docs.has(id))
        throw new Error(`Duplicate DDP added: ${collection}/${id}`);
      docs.set(id, { ...EJSON.clone(message.fields || {}), _id: id });
    } else {
      if (!docs.has(id))
        throw new Error(`DDP ${msg} for missing document: ${collection}/${id}`);
      if (msg === 'removed') docs.delete(id);
      else {
        const doc = docs.get(id);
        Object.assign(doc, EJSON.clone(message.fields || {}));
        for (const field of message.cleared || []) delete doc[field];
        doc._id = id;
      }
    }
    return true;
  }

  snapshot(names = [...this.collections.keys()]) {
    return Object.fromEntries(
      names.map((name) => [
        name,
        [...(this.collections.get(name)?.values() || [])].map((doc) =>
          EJSON.clone(doc)
        ),
      ])
    );
  }

  matches(prepared) {
    for (const [name, expected] of prepared) {
      const actual = this.collections.get(name);
      if ((actual?.size || 0) !== expected.size) return false;
      for (const [id, doc] of expected) {
        if (!actual?.has(id) || !EJSON.equals(actual.get(id), doc))
          return false;
      }
    }
    return true;
  }

  data(id) {
    const doc = this.collections.get('_subscriptionData')?.get(id);
    if (!doc) return null;
    const { _id, ...data } = EJSON.clone(doc);
    return data;
  }
}
