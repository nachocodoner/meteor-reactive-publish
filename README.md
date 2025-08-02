## reactive-publish

`reactive-publish` is a Meteor package that adds **reactive publishing with async support**. It's based on [**peerlibrary:reactive-publish**](https://github.com/peerlibrary/meteor-reactive-publish), fully overhauled for compatibility with **Meteor 3** and its **fiber-free** environment.

- 🔄 Reactively publish data with related field changes across collections
    
- ⚙️ Supports `autorun` in publication functions for **realtime updates**
    
- 🧵 Integrates `AsyncTracker` and `ReactiveVarAsync` for **async-compatible reactivity**
    
- 🚀 Optimized with **unique cursors per computation** to avoid redundant re-instantiation
    
🔥 [**Learn about the motivation**](./MOTIVATION.md) for reviving this package for Meteor 3.  
🗺️ [**Explore the roadmap**](#roadmap) for future updates and support.
## Installation

``` bash
meteor add nachocodoner:reactive-publish@1.0.0-alpha.0
```

## Usage

### Basic

```javascript
Meteor.publish('subscribed-posts', function () {
  this.autorun(async () => {
    const user = await User.findOneAsync(this.userId, {
      fields: { subscribedPosts: 1 },
    });

    return Posts.find({ _id: { $in: user?.subscribedPosts || [] } });
  });
});
```

Since most use cases involve a single `autorun` block, you can use `Meteor.publishReactive` for cleaner syntax:

```javascript
Meteor.publishReactive('subscribed-posts', async function () {
  const user = await User.findOneAsync(this.userId, {
    fields: { subscribedPosts: 1 },
  });

  return Posts.find({ _id: { $in: user?.subscribedPosts || [] } });
});
```

### Time-based queries

```javascript
import { ReactiveVarAsync } from 'meteor/nachocodoner:reactive-publish';

const currentTime = new ReactiveVarAsync(Date.now());

Meteor.setInterval(() => {
  currentTime.set(Date.now());
}, 1000); // ms

Meteor.publish('recent-posts', function () {
  this.autorun(() => {
    return Posts.find({
      timestamp: {
        $exists: true,
        $gte: currentTime.get() - 60 * 1000,
      },
    }, {
      sort: { timestamp: 1 },
    });
  });
});
```

### Multiple autoruns

```javascript
Meteor.publish('users-posts-and-addresses', function (userId) {
  this.autorun(async () => {
    const user = await Users.findOneAsync(userId, {
      fields: { posts: 1 },
    });
    return Posts.find({ _id: { $in: user?.posts || [] } });
  });

  this.autorun(async () => {
    const user = await Users.findOneAsync(userId, {
      fields: { addresses: 1 },
    });
    return Addresses.find({ _id: { $in: user?.addresses || [] } });
  });
});
```

## Roadmap

- **Stability**
    - Ensure core changes in this package don't affect Meteor core tests
    - Release betas and RCs, with a feedback period for early adopters
        
- **Expansion**
    - Support for `AsyncTracker` and `ReactiveVarAsync` on the client
    - Migrate [`peerlibrary/meteor-subscription-data`](https://github.com/peerlibrary/meteor-subscription-data) to support publishing derived or external database data reactively

- **Performance**
    - [Run benchmarks](https://github.com/meteor/performance) to identify performance improvement opportunities
    - Compare results with [`reywood:publish-composite`](https://github.com/Meteor-Community-Packages/meteor-publish-composite) to ensure equal or better behavior

## Acknowledgments

This package builds on over a decade of work by [PeerLibrary](https://github.com/peerlibrary/meteor-reactive-publish) during the legacy Meteor era. Big thanks to everyone involved over those years, , especially [mitar](https://github.com/mitar).

The original idea came from the excellent work of [Diggory Blake](https://github.com/Diggsey/meteor-reactive-publish), who created the first implementation.
