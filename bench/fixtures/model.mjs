export const collectionNames = [
  'bench_users',
  'bench_posts',
  'bench_comments',
  'bench_authors',
];
export const publicFields = {
  bench_users: ['name', 'postIds', 'active', 'revision'],
  bench_posts: ['title', 'active', 'score', 'authorId', 'revision', 'optional'],
  bench_comments: ['postId', 'authorId', 'text', 'revision'],
  bench_authors: ['name', 'revision'],
};

export function fixture(config, seed = 1) {
  let state = seed >>> 0;
  const random = () =>
    (state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296;
  const posts = Array.from({ length: config.parents }, (_, i) => ({
    _id: `post-${i}`,
    title: `Post ${i}`,
    active: i % 2 === 0,
    score: Math.floor(random() * 10000),
    authorId: `author-${i % 3}`,
    revision: 0,
    optional: 'present',
    noise: 'hidden',
  }));
  return {
    bench_users: [
      {
        _id: 'user-0',
        name: 'Reader',
        postIds: posts.filter((p) => p.active).map((p) => p._id),
        active: true,
        revision: 0,
        noise: 'hidden',
      },
    ],
    bench_posts: posts,
    bench_comments: posts.flatMap((p, i) =>
      Array.from({ length: config.children }, (_, j) => ({
        _id: `comment-${i}-${j}`,
        postId: p._id,
        authorId: `author-${j % 3}`,
        text: `Comment ${j}`,
        revision: 0,
      }))
    ),
    bench_authors: Array.from({ length: 3 }, (_, i) => ({
      _id: `author-${i}`,
      name: `Author ${i}`,
      revision: 0,
    })),
  };
}

export function project(name, doc) {
  return Object.fromEntries(
    ['_id', ...publicFields[name]]
      .filter((key) => key in doc)
      .map((key) => [key, structuredClone(doc[key])])
  );
}

export function applyOperation(model, operation) {
  if (!operation.collection) return;
  const docs = model[operation.collection];
  if (!docs) throw new Error(`Unknown collection: ${operation.collection}`);
  const index = docs.findIndex((doc) => doc._id === operation.id);
  if (operation.kind === 'insert') {
    if (index !== -1) throw new Error('Duplicate fixture ID');
    docs.push(structuredClone(operation.doc));
  } else if (operation.kind === 'remove') {
    if (index !== -1) docs.splice(index, 1);
  } else {
    if (index === -1)
      throw new Error(`Missing fixture document: ${operation.id}`);
    Object.assign(docs[index], structuredClone(operation.set || {}));
    for (const key of operation.unset || []) delete docs[index][key];
  }
}
