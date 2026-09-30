import { Meteor } from 'meteor/meteor';
import { posts, options } from './collections.js';

export function register(config, authorize) {
  Meteor.publish('bench', function (token) {
    authorize(token);
    if (config.scenario === 'sorted-window')
      return posts.find(
        {},
        { ...options('bench_posts'), sort: { score: -1, _id: 1 }, limit: 2 }
      );
    return posts.find({ active: true }, options('bench_posts'));
  });
}
