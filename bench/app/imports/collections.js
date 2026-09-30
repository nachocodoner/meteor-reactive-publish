import { Mongo } from 'meteor/mongo';
import { publicFields } from './model.js';

export const collections = Object.fromEntries(
  Object.keys(publicFields).map((name) => [name, new Mongo.Collection(name)])
);
export const fields = (name) =>
  Object.fromEntries(publicFields[name].map((key) => [key, 1]));
export const posts = collections.bench_posts;
export const users = collections.bench_users;
export const comments = collections.bench_comments;
export const authors = collections.bench_authors;
export const options = (name) => ({ fields: fields(name) });
