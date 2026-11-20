import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

// Optional browser checks exercise Meteor/Minimongo without rendering a UI.
const collections = Object.fromEntries(
  ['bench_posts', 'bench_users', 'bench_comments', 'bench_authors'].map(
    (name) => [name, new Mongo.Collection(name)]
  )
);
window.bench = { Meteor, collections };
