import { project } from '../fixtures/model.mjs';

const all = ['native', 'installed', 'reactive', 'composite'];
const joins = ['reactive', 'composite'];
export const scenarios = {
  'plain-cursor': {
    adapters: all,
    description: 'Projected cursor CRUD and field clearing',
  },
  'dependent-posts': {
    adapters: joins,
    description: 'A reader changes the IDs of subscribed posts',
  },
  'one-to-many': {
    adapters: joins,
    description: 'Active posts and their comments',
  },
  'deep-join': {
    adapters: joins,
    description: 'Posts, comments, and shared comment authors',
  },
  'shared-children': {
    adapters: joins,
    description: 'Posts sharing author documents',
  },
  'projection-sensitivity': {
    adapters: joins,
    description: 'Relevant, excluded, and equal-value dependency changes',
  },
  'sorted-window': {
    adapters: all,
    description: 'Ranked documents entering and leaving a limited window',
  },
  'subscription-churn': {
    adapters: all,
    description: 'Repeated readiness and unsubscribe cleanup',
  },
  fanout: {
    adapters: all,
    description:
      'Immutable writes to persistent subscribers, optionally at an independent offered rate',
  },
  'multiple-autoruns': {
    adapters: ['reactive'],
    description: 'Independent reactive posts and comments',
  },
  'subscription-data': {
    adapters: ['reactive'],
    description: 'Nested subscription data updates and unsets',
  },
  'infinite-scroll': {
    adapters: ['reactive'],
    description: 'Client-controlled window without resubscribing',
  },
  'derived-count': {
    adapters: ['reactive'],
    description: 'Reactive count through subscription data',
  },
  'derived-aggregate': {
    adapters: ['reactive'],
    description: 'Reactive counts grouped by author',
  },
  'external-source': {
    adapters: ['reactive'],
    description: 'ReactiveVarAsync independent of Mongo',
  },
  'async-pressure': {
    adapters: ['reactive'],
    description: 'Reactive dependency with controlled awaited work',
  },
};
export const scenarioVersion = 1;
export const isDataScenario = (name) =>
  [
    'subscription-data',
    'derived-count',
    'derived-aggregate',
    'external-source',
  ].includes(name);

export function validateScenario(name, adapter) {
  if (!scenarios[name]) throw new Error(`Unknown scenario: ${name}`);
  if (!scenarios[name].adapters.includes(adapter))
    throw new Error(`${name} does not support ${adapter}`);
}

// Independent oracle: operates on fixture arrays, never on Mongo queries or publication output.
export function expectedState(name, model, context = {}) {
  const result = {};
  const add = (collection, docs) => {
    result[collection] = docs.map((doc) => project(collection, doc));
  };
  const active = model.bench_posts.filter((doc) => doc.active);
  if (isDataScenario(name)) return result;
  if (
    ['dependent-posts', 'projection-sensitivity', 'async-pressure'].includes(
      name
    )
  ) {
    const users = model.bench_users.filter((doc) => doc.active);
    add('bench_users', users);
    const ids = new Set(users.flatMap((doc) => doc.postIds));
    add(
      'bench_posts',
      model.bench_posts.filter((doc) => ids.has(doc._id))
    );
  } else if (['sorted-window', 'infinite-scroll'].includes(name)) {
    add(
      'bench_posts',
      [...model.bench_posts]
        .sort((a, b) => b.score - a.score || a._id.localeCompare(b._id))
        .slice(0, context.limit || 2)
    );
  } else {
    add('bench_posts', active);
    if (['one-to-many', 'deep-join', 'multiple-autoruns'].includes(name)) {
      const ids = new Set(active.map((doc) => doc._id));
      const comments = model.bench_comments.filter((doc) =>
        ids.has(doc.postId)
      );
      add('bench_comments', comments);
      if (name === 'deep-join') {
        const authors = new Set(comments.map((doc) => doc.authorId));
        add(
          'bench_authors',
          model.bench_authors.filter((doc) => authors.has(doc._id))
        );
      }
    }
    if (name === 'shared-children') {
      const ids = new Set(active.map((doc) => doc.authorId));
      add(
        'bench_authors',
        model.bench_authors.filter((doc) => ids.has(doc._id))
      );
    }
  }
  return result;
}

export function expectedData(name, model, context = {}) {
  if (name === 'derived-count')
    return { value: model.bench_posts.filter((p) => p.active).length };
  if (name === 'derived-aggregate') {
    const counts = {};
    for (const p of model.bench_posts)
      counts[p.authorId] = (counts[p.authorId] || 0) + 1;
    return {
      value: Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([authorId, count]) => ({ authorId, count })),
    };
  }
  if (name === 'subscription-data')
    return context.data || { value: { count: 0, label: 'initial' } };
  if (name === 'external-source') return { value: context.external || 0 };
  return null;
}

export function operationFor(name, index, model) {
  const revision = index + 1;
  const update = (collection, id, set, unset = []) => ({
    kind: 'update',
    collection,
    id,
    set,
    unset,
  });
  const post = model.bench_posts[0];
  if (name === 'fanout')
    return {
      kind: 'insert',
      collection: 'bench_posts',
      id: `fanout-${revision}`,
      doc: {
        _id: `fanout-${revision}`,
        title: `Event ${revision}`,
        active: true,
        score: revision,
        authorId: 'author-0',
        revision,
      },
    };
  if (name === 'subscription-data')
    return {
      kind: 'data',
      value:
        index % 3 === 2
          ? { count: revision }
          : { count: revision, label: `value-${revision}` },
    };
  if (name === 'infinite-scroll')
    return { kind: 'limit', value: 1 + (index % model.bench_posts.length) };
  if (name === 'external-source') return { kind: 'external', value: revision };
  if (name === 'derived-aggregate')
    return update('bench_posts', post._id, {
      authorId: `author-${revision % 3}`,
      revision,
    });
  if (name === 'sorted-window')
    return update('bench_posts', `post-${index % model.bench_posts.length}`, {
      score: 10001 + revision,
      revision,
    });
  if (
    ['dependent-posts', 'projection-sensitivity', 'async-pressure'].includes(
      name
    )
  ) {
    if (name === 'projection-sensitivity' && index % 4 === 0)
      return update('bench_users', 'user-0', { noise: `ignored-${revision}` });
    if (name === 'projection-sensitivity' && index % 4 === 1)
      return update('bench_users', 'user-0', {
        name: model.bench_users[0].name,
      });
    return update('bench_users', 'user-0', {
      postIds: model.bench_posts
        .filter((_, i) => i % 2 === index % 2)
        .map((p) => p._id),
      revision,
    });
  }
  if (['one-to-many', 'deep-join', 'multiple-autoruns'].includes(name)) {
    if (index % 3 === 0)
      return update('bench_comments', 'comment-0-0', {
        postId: `post-${revision % 2}`,
        authorId: `author-${revision % 3}`,
        revision,
      });
    if (index % 3 === 1)
      return update('bench_posts', post._id, {
        active: !post.active,
        revision,
      });
    return update('bench_comments', 'comment-0-0', {
      text: `Updated ${revision}`,
      revision,
    });
  }
  if (name === 'shared-children')
    return update('bench_posts', post._id, {
      authorId: `author-${revision % 3}`,
      revision,
    });
  if (name === 'derived-count')
    return update('bench_posts', post._id, { active: !post.active, revision });
  const id = 'transient';
  switch (index % 6) {
    case 0:
      return {
        kind: 'insert',
        collection: 'bench_posts',
        id,
        doc: {
          _id: id,
          title: `Transient ${revision}`,
          active: true,
          score: revision,
          authorId: 'author-0',
          revision,
          optional: 'present',
        },
      };
    case 1:
      return update('bench_posts', id, {
        title: `Changed ${revision}`,
        revision,
      });
    case 2:
      return update('bench_posts', id, { revision }, ['optional']);
    case 3:
      return { kind: 'remove', collection: 'bench_posts', id };
    default:
      return update('bench_posts', post._id, {
        active: !post.active,
        revision,
      });
  }
}
