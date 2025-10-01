import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { Tinytest } from 'meteor/tinytest';
import { Random } from 'meteor/random';
import { check } from 'meteor/check';

// Collections used in our examples
const Posts = new Mongo.Collection('posts');

if (Meteor.isServer) {
  // Example 1: Server-side publication for infinite scrolling with counts
  Meteor.publish('posts.infiniteScroll', function () {
    // Reactive total count
    this.autorun(async () => {
      await this.setData('countAll', await Posts.find().countAsync());
    });

    // Reactive window of posts, adjustable by client
    this.autorun(async () => {
      const limit = Number(await this.data('limit')) || 10;
      check(limit, Number);

      await Posts.find(
        {},
        {
          limit,
          sort: { createdAt: -1 },
        }
      ).observeChangesAsync({
        addedBefore: (id, fields) => this.added('posts', id, fields),
        changed: (id, fields) => this.changed('posts', id, fields),
        removed: (id) => this.removed('posts', id),
      });

      this.ready();
    });
  });

  // Example 2: Server-side publication with external reactive source
  Meteor.publish('user.subscriptionTier', async function (userId) {
    check(userId, String);
    const pub = this;
    const id = Random.id(); // Generate a unique ID for our document
    let tier = 'free';

    // Simulate external updates (in real app, this could be an API call or database watch)
    const handle = setInterval(async () => {
      tier = tier === 'free' ? 'pro' : 'free';
      await pub.setData('tier', tier);
    }, 1000); // Using 1 seconds for faster test feedback

    // Clean up the interval when the subscription stops
    pub.onStop(() => clearInterval(handle));

    // Initial document
    // this.added('subscriptionTiers', id, { userId, tier });
    await pub.setData('tier', tier);

    this.ready();
  });

  // Helper methods for testing
  Meteor.methods({
    async clearPosts() {
      return Posts.removeAsync({});
    },
    async insertPost(post) {
      return Posts.insertAsync({
        ...post,
        createdAt: new Date(),
      });
    },
  });
}

if (Meteor.isClient) {
  // Example 1: Infinite scrolling and counts using Tracker
  Tinytest.addAsync(
    'ReactiveData Showcase - Infinite Scrolling',
    async (test, next) => {
      // Clear existing posts
      await Meteor.callAsync('clearPosts');

      // Insert some test posts
      for (let i = 0; i < 25; i++) {
        await Meteor.callAsync('insertPost', {
          title: `Post ${i}`,
          content: `This is post ${i} content`,
        });
      }

      // Subscribe to posts with infinite scrolling
      const sub = Meteor.subscribe('posts.infiniteScroll');

      // Wait for subscription to be ready
      await new Promise((resolve) =>
        Tracker.autorun((c) => {
          if (sub.ready()) {
            c.stop();
            resolve();
          }
        })
      );

      // Test initial state (default limit of 10)
      await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
      test.equal(
        await Posts.find().countAsync(),
        10,
        'Should initially load 10 posts'
      );
      test.equal(await sub.data('countAll'), 25, 'Total count should be 25');

      // Track reactive updates
      let countUpdates = 0;
      Tracker.autorun(() => {
        sub.data('countAll');
        countUpdates++;
      });

      // Increase the limit to load more posts
      await sub.setData('limit', 20);

      // Wait for the new limit to take effect
      await new Promise((resolve) => Meteor.setTimeout(resolve, 500));
      test.equal(
        await Posts.find().countAsync(),
        20,
        'Should now show 20 posts after increasing limit'
      );
      test.equal(
        await sub.data('countAll'),
        25,
        'Total count should still be 25'
      );
      test.isTrue(countUpdates >= 1, 'Count should update reactively');

      // Clean up
      await sub.stop();
      await Meteor.setTimeout(next, 500);
    }
  );

  // Example 2: External reactive source using Tracker
  Tinytest.addAsync(
    'ReactiveData Showcase - External Reactive Source',
    async (test, next) => {
      const userId = Random.id();

      // Subscribe to user subscription tier
      const sub = Meteor.subscribe('user.subscriptionTier', userId);

      // Wait for subscription to be ready
      await new Promise((resolve) =>
        Tracker.autorun((c) => {
          if (sub.ready()) {
            c.stop();
            resolve();
          }
        })
      );

      // Test initial state
      await new Promise((resolve) => Meteor.setTimeout(resolve, 250));
      test.equal(await sub.data('tier'), 'free', 'Initial tier should be free');

      // Track reactive updates
      let tierUpdates = 0;
      let currentTier = null;

      Tracker.autorun(async () => {
        currentTier = await sub.data('tier');
        tierUpdates++;
      });

      // Wait for the external source to update (should change to 'pro')
      await new Promise((resolve) => Meteor.setTimeout(resolve, 1250));
      test.equal(currentTier, 'pro', 'Tier should update to pro');
      test.isTrue(tierUpdates >= 2, 'Tier should update reactively');

      // Wait for another update (should change back to 'free')
      await new Promise((resolve) => Meteor.setTimeout(resolve, 1250));
      test.equal(currentTier, 'free', 'Tier should update back to free');
      test.isTrue(tierUpdates >= 3, 'Tier should continue updating reactively');

      // Clean up
      await sub.stop();
      await Meteor.setTimeout(next, 500);
    }
  );
}
