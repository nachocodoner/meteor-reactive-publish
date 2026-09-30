import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';
import { timingSafeEqual } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { collections } from '../imports/collections.js';
import { fixture } from '../imports/model.js';
import * as adapter from '../imports/adapter.js';
import { createMetrics } from '../imports/metrics.js';
import { backendBench } from '../imports/backend.js';

const config = JSON.parse(process.env.BENCH_CONFIG);
const token = process.env.BENCH_TOKEN;
const authorize = (value) => {
  const input = Buffer.from(typeof value === 'string' ? value : '');
  const expected = Buffer.from(token);
  if (input.length !== expected.length || !timingSafeEqual(input, expected))
    throw new Meteor.Error('unauthorized');
};
const metrics = createMetrics(
  adapter.AsyncTracker,
  config.instrumentation !== 'basic'
);
let ready = false;
const metadata = {
  meteor: Meteor.release,
  node: process.version,
  adapter: config.adapter,
  reactiveLoaded: !!Package['nachocodoner:reactive-publish'],
  compositeLoaded: !!Package['reywood:publish-composite'],
  sourceHash: config.sourceHash,
};

Meteor.methods({
  async 'bench.mutate'(credential, operation) {
    authorize(credential);
    if (operation.kind === 'external') {
      await adapter.setExternal(operation.value);
      return;
    }
    const collection = collections[operation.collection];
    if (!collection || typeof operation.id !== 'string')
      throw new Meteor.Error('invalid-operation');
    if (operation.kind === 'insert')
      return collection.insertAsync(operation.doc);
    if (operation.kind === 'remove')
      return collection.removeAsync(operation.id);
    const modifier = {};
    if (Object.keys(operation.set || {}).length) modifier.$set = operation.set;
    if (operation.unset?.length)
      modifier.$unset = Object.fromEntries(
        operation.unset.map((key) => [key, ''])
      );
    return collection.updateAsync(operation.id, modifier);
  },
});

WebApp.connectHandlers.use('/__bench', async (request, response) => {
  const reply = (status, data) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data));
  };
  try {
    authorize(request.headers.authorization?.replace(/^Bearer /, ''));
    if (request.method !== 'POST')
      return reply(405, { error: 'POST required' });
    const action = request.url.split('?')[0];
    if (action === '/status')
      return reply(ready ? 200 : 503, {
        ready,
        metadata,
        resources: metrics.resources(),
      });
    if (!ready) return reply(503, { error: 'Not seeded' });
    if (action === '/start') return reply(200, metrics.reset());
    if (action === '/snapshot') return reply(200, metrics.snapshot());
    if (action === '/retention') {
      if (!config.retention || typeof global.gc !== 'function')
        throw new Error(
          'Retention measurement requires the dedicated forced-GC mode'
        );
      for (let pass = 0; pass < config.retention.forcedGcPasses; pass++) {
        global.gc();
        await nextTurn();
      }
      return reply(200, { ...process.memoryUsage(), ...metrics.resources() });
    }
    if (action === '/backend')
      return reply(200, await backendBench(adapter, config));
    return reply(404, { error: 'Unknown control action' });
  } catch (error) {
    return reply(403, { error: error.message });
  }
});

process.on('SIGTERM', () => process.exit(0));

Meteor.startup(async () => {
  const model = fixture(config.profile, config.seed);
  for (const [name, docs] of Object.entries(model)) {
    if (await collections[name].find().countAsync())
      throw new Error('Benchmark database must be empty');
    await collections[name].rawCollection().insertMany(docs);
  }
  await collections.bench_posts.rawCollection().createIndex({ active: 1 });
  await collections.bench_posts
    .rawCollection()
    .createIndex({ score: -1, _id: 1 });
  await collections.bench_comments.rawCollection().createIndex({ postId: 1 });
  adapter.register(config, authorize);
  ready = true;
  console.log('[bench] ready');
});
