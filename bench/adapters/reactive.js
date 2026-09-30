import { Meteor } from 'meteor/meteor';
import {
  AsyncTracker,
  ReactiveVarAsync,
} from 'meteor/nachocodoner:reactive-publish';
import { ComputedField } from 'meteor/nachocodoner:reactive-publish/lib/ReactiveAsync/ComputedField';
import { DataLookup } from 'meteor/nachocodoner:reactive-publish/lib/ReactiveAsync/DataLookup';
import { posts, users, comments, authors, options } from './collections.js';

export { AsyncTracker, ReactiveVarAsync, ComputedField, DataLookup };
const external = new ReactiveVarAsync(0);
export const setExternal = (value) => external.set(value);

export function register(config, authorize) {
  Meteor.publish('bench', function (token) {
    authorize(token);
    const pub = this;
    const scenario = config.scenario;
    if (
      [
        'plain-cursor',
        'subscription-churn',
        'sorted-window',
        'fanout',
      ].includes(scenario)
    ) {
      pub.autorun(() =>
        scenario === 'sorted-window'
          ? posts.find(
              {},
              {
                ...options('bench_posts'),
                sort: { score: -1, _id: 1 },
                limit: 2,
              }
            )
          : posts.find({ active: true }, options('bench_posts'))
      );
      return;
    }
    if (scenario === 'subscription-data') {
      return (async () => {
        await pub.setData('value', { count: 0, label: 'initial' });
        pub.ready();
      })();
    }
    if (scenario === 'multiple-autoruns') {
      pub.autorun(() => posts.find({ active: true }, options('bench_posts')));
      pub.autorun(async () => {
        const parents = await posts
          .find({ active: true }, { fields: { _id: 1 } })
          .fetchAsync();
        return comments.find(
          { postId: { $in: parents.map((post) => post._id) } },
          options('bench_comments')
        );
      });
      return;
    }
    pub.autorun(async () => {
      if (scenario === 'external-source') {
        await pub.setData('value', external.get());
        pub.ready();
        return;
      }
      if (scenario === 'derived-count') {
        await pub.setData(
          'value',
          await posts.find({ active: true }).countAsync()
        );
        pub.ready();
        return;
      }
      if (scenario === 'derived-aggregate') {
        await posts.find({}, { fields: { authorId: 1 } }).fetchAsync();
        const value = await posts
          .rawCollection()
          .aggregate([
            { $group: { _id: '$authorId', count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, authorId: '$_id', count: 1 } },
          ])
          .toArray();
        await pub.setData('value', value);
        pub.ready();
        return;
      }
      if (
        [
          'dependent-posts',
          'projection-sensitivity',
          'async-pressure',
        ].includes(scenario)
      ) {
        const cursor = users.find({ active: true }, options('bench_users'));
        const parents = await cursor.fetchAsync();
        if (scenario === 'async-pressure')
          await new Promise((resolve) => setTimeout(resolve, 2));
        return [
          cursor,
          posts.find(
            { _id: { $in: parents.flatMap((user) => user.postIds) } },
            options('bench_posts')
          ),
        ];
      }
      if (['sorted-window', 'infinite-scroll'].includes(scenario)) {
        const limit =
          scenario === 'infinite-scroll' ? (await pub.data('limit')) || 2 : 2;
        return posts.find(
          {},
          { ...options('bench_posts'), sort: { score: -1, _id: 1 }, limit }
        );
      }
      const cursor = posts.find({ active: true }, options('bench_posts'));
      if (!['one-to-many', 'deep-join', 'shared-children'].includes(scenario))
        return cursor;
      const parents = await cursor.fetchAsync();
      if (scenario === 'shared-children')
        return [
          cursor,
          authors.find(
            {
              _id: { $in: [...new Set(parents.map((post) => post.authorId))] },
            },
            options('bench_authors')
          ),
        ];
      const children = comments.find(
        { postId: { $in: parents.map((post) => post._id) } },
        options('bench_comments')
      );
      if (scenario === 'one-to-many') return [cursor, children];
      const docs = await children.fetchAsync();
      return [
        cursor,
        children,
        authors.find(
          {
            _id: { $in: [...new Set(docs.map((comment) => comment.authorId))] },
          },
          options('bench_authors')
        ),
      ];
    });
  });
}
