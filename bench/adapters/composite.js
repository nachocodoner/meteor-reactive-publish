import { publishComposite } from 'meteor/reywood:publish-composite';
import { posts, users, comments, authors, options } from './collections.js';

export function register(config, authorize) {
  publishComposite('bench', function (token) {
    authorize(token);
    const scenario = config.scenario;
    if (['dependent-posts', 'projection-sensitivity'].includes(scenario))
      return {
        find: () => users.find({ active: true }, options('bench_users')),
        children: [
          {
            find: (user) =>
              posts.find(
                { _id: { $in: user.postIds } },
                options('bench_posts')
              ),
          },
        ],
      };
    const children = [];
    if (['one-to-many', 'deep-join'].includes(scenario))
      children.push({
        find: (post) =>
          comments.find({ postId: post._id }, options('bench_comments')),
        children:
          scenario === 'deep-join'
            ? [
                {
                  find: (comment) =>
                    authors.find(comment.authorId, options('bench_authors')),
                },
              ]
            : [],
      });
    if (scenario === 'shared-children')
      children.push({
        find: (post) => authors.find(post.authorId, options('bench_authors')),
      });
    return {
      find: () =>
        scenario === 'sorted-window'
          ? posts.find(
              {},
              {
                ...options('bench_posts'),
                sort: { score: -1, _id: 1 },
                limit: 2,
              }
            )
          : posts.find({ active: true }, options('bench_posts')),
      children,
    };
  });
}
