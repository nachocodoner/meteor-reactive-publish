import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { Tinytest } from 'meteor/tinytest';
import { Random } from 'meteor/random';
import { check } from 'meteor/check';
import { SubscriptionData } from './ReactiveData.js';

// Collections used in our examples
const Posts = new Mongo.Collection('posts');
const Likes = new Mongo.Collection('likes'); // { postId, userId, ... }

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

    pub.ready();
  });

  // Example 3: Derived stats via aggregation (reactive setData)
  Meteor.publish('stats.authorActivity', function () {
    const pub = this;

    pub.autorun(async () => {
      // Reactive deps: touching cursors makes autorun rerun on changes
      await Posts.find({}, { fields: { authorId: 1 } }).countAsync();
      await Likes.find({}, { fields: { postId: 1 } }).countAsync();

      // Aggregation: posts + likes per author
      const pipeline = [
        {
          $lookup: {
            from: 'likes',
            localField: '_id',
            foreignField: 'postId',
            as: 'likes',
          },
        },
        {
          $group: {
            _id: '$authorId',
            postsCount: { $sum: 1 },
            likesCount: { $sum: { $size: '$likes' } },
          },
        },
        {
          $project: { _id: 0, authorId: '$_id', postsCount: 1, likesCount: 1 },
        },
      ];

      const stats = await Posts.rawCollection().aggregate(pipeline).toArray();
      await pub.setData('authorStats', stats); // publish derived data only

      pub.ready();
    });
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
    async clearLikes() {
      return Likes.removeAsync({});
    },
    async insertLike(like) {
      return Likes.insertAsync({
        ...like,
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

  // Example 3: Derived stats via aggregation using Tracker
  Tinytest.addAsync(
    'ReactiveData Showcase - Derived Stats via Aggregation',
    async (test, next) => {
      // Clear existing data
      await Meteor.callAsync('clearPosts');
      await Meteor.callAsync('clearLikes');

      // Create test authors
      const authorId1 = Random.id();
      const authorId2 = Random.id();

      // Insert some test posts
      const postId1 = await Meteor.callAsync('insertPost', {
        title: 'Post 1',
        content: 'Content 1',
        authorId: authorId1,
      });

      const postId2 = await Meteor.callAsync('insertPost', {
        title: 'Post 2',
        content: 'Content 2',
        authorId: authorId1,
      });

      const postId3 = await Meteor.callAsync('insertPost', {
        title: 'Post 3',
        content: 'Content 3',
        authorId: authorId2,
      });

      // Insert some test likes
      await Meteor.callAsync('insertLike', {
        postId: postId1,
        userId: Random.id(),
      });

      await Meteor.callAsync('insertLike', {
        postId: postId1,
        userId: Random.id(),
      });

      await Meteor.callAsync('insertLike', {
        postId: postId3,
        userId: Random.id(),
      });

      // Subscribe to author stats
      const sub = Meteor.subscribe('stats.authorActivity');

      // Wait for subscription to be ready
      await new Promise((resolve) =>
        Tracker.autorun((c) => {
          if (sub.ready()) {
            c.stop();
            resolve();
          }
        })
      );

      // Wait for data to be available
      await new Promise((resolve) => Meteor.setTimeout(resolve, 500));

      // Test initial state
      let stats = await sub.data('authorStats');
      test.isTrue(Array.isArray(stats), 'Stats should be an array');

      // Find stats for each author
      const author1Stats = stats.find((s) => s.authorId === authorId1);
      const author2Stats = stats.find((s) => s.authorId === authorId2);

      test.equal(author1Stats.postsCount, 2, 'Author 1 should have 2 posts');
      test.equal(author1Stats.likesCount, 2, 'Author 1 should have 2 likes');
      test.equal(author2Stats.postsCount, 1, 'Author 2 should have 1 post');
      test.equal(author2Stats.likesCount, 1, 'Author 2 should have 1 like');

      // Track reactive updates
      let statsUpdates = 0;
      let currentStats = null;

      Tracker.autorun(async () => {
        currentStats = await sub.data('authorStats');
        statsUpdates++;
      });

      // Add another post and like to test reactivity
      const postId4 = await Meteor.callAsync('insertPost', {
        title: 'Post 4',
        content: 'Content 4',
        authorId: authorId2,
      });

      await Meteor.callAsync('insertLike', {
        postId: postId4,
        userId: Random.id(),
      });

      // Wait for the reactive update
      await new Promise((resolve) => Meteor.setTimeout(resolve, 500));

      // Verify the stats have updated
      const updatedAuthor2Stats = currentStats.find(
        (s) => s.authorId === authorId2
      );
      test.equal(
        updatedAuthor2Stats.postsCount,
        2,
        'Author 2 should now have 2 posts'
      );
      test.equal(
        updatedAuthor2Stats.likesCount,
        2,
        'Author 2 should now have 2 likes'
      );
      test.isTrue(statsUpdates >= 2, 'Stats should update reactively');

      // Clean up
      await sub.stop();
      await Meteor.setTimeout(next, 500);
    }
  );

  // Test: Verify _subscriptionData livecollection is cleared when subscription is stopped
  Tinytest.addAsync(
    'ReactiveData Showcase - Subscription Data Cleared on Stop',
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

      // Wait for data to be available
      await new Promise((resolve) => Meteor.setTimeout(resolve, 250));

      // Verify initial data exists
      const initialTier = await sub.data('tier');
      test.equal(initialTier, 'free', 'Initial tier should be free');

      // Get the _subscriptionData collection from the module export
      const subscriptionDataCollection = SubscriptionData;
      test.isTrue(
        subscriptionDataCollection,
        '_subscriptionData collection should exist'
      );

      // Verify subscription data exists in the collection before stopping
      const subscriptionId = sub.subscriptionId;
      const dataBeforeStop = await subscriptionDataCollection.findOneAsync({
        _id: subscriptionId,
      });
      test.isTrue(
        dataBeforeStop,
        'Subscription data should exist before stopping'
      );

      // Stop the subscription
      await sub.stop();

      // Wait for the cleanup to complete
      await new Promise((resolve) => Meteor.setTimeout(resolve, 500));

      // Verify subscription data is cleared from the collection after stopping
      const dataAfterStop = await subscriptionDataCollection.findOneAsync({
        _id: subscriptionId,
      });
      test.equal(
        dataAfterStop,
        undefined,
        '_subscriptionData collection should be cleared after subscription is stopped'
      );

      await Meteor.setTimeout(next, 500);
    }
  );
}
