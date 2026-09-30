import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import EJSON from 'ejson';
import { DDPClient } from '../clients/ddp-client.mjs';
import {
  DocumentStore,
  statesEqual,
  prepareState,
} from '../clients/document-store.mjs';

async function serverFor(t, handler) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const message = EJSON.parse(raw.toString());
      const send = (value) => socket.send(EJSON.stringify(value));
      if (message.msg === 'connect')
        send({ msg: 'connected', session: 'session' });
      else handler(message, send, socket);
    })
  );
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const client = new DDPClient(`http://127.0.0.1:${server.address().port}`, {
    timeout: 500,
  });
  t.after(() => client.disconnect());
  await client.connect();
  return client;
}

test('document store applies replacement fields, clearing, removal, and EJSON values', () => {
  const store = new DocumentStore();
  store.apply({
    msg: 'added',
    collection: 'docs',
    id: 'one',
    fields: { object: { a: 1, b: 2 }, date: new Date(0) },
  });
  store.apply({
    msg: 'changed',
    collection: 'docs',
    id: 'one',
    fields: { object: { a: 3 } },
    cleared: ['date'],
  });
  assert.ok(
    statesEqual(store.snapshot(), { docs: [{ _id: 'one', object: { a: 3 } }] })
  );
  store.apply({ msg: 'removed', collection: 'docs', id: 'one' });
  assert.ok(statesEqual(store.snapshot(), {}));
  assert.throws(
    () => store.apply({ msg: 'changed', collection: 'docs', id: 'one' }),
    /missing document/
  );
});

test('prepared oracle retains exact EJSON, missing/extra document and cleared-field checks', () => {
  const store = new DocumentStore();
  const expected = {
    docs: [{ _id: 'a', nested: { a: 1, b: 2 }, date: new Date(0) }],
  };
  const prepared = prepareState(expected, ['docs', 'other']);
  assert.throws(
    () => prepareState({ docs: [{ _id: 'same' }, { _id: 'same' }] }),
    /Duplicate expected/
  );
  const assertSame = () =>
    assert.equal(
      store.matches(prepared),
      statesEqual(store.snapshot(['docs', 'other']), expected)
    );
  assertSame();
  store.apply({
    msg: 'added',
    collection: 'docs',
    id: 'a',
    fields: { date: new Date(0), nested: { b: 2, a: 1 } },
  });
  assertSame();
  assert.equal(store.matches(prepared), true);
  store.apply({ msg: 'added', collection: 'other', id: 'extra', fields: {} });
  assertSame();
  assert.equal(store.matches(prepared), false);
  store.apply({ msg: 'removed', collection: 'other', id: 'extra' });
  store.apply({
    msg: 'changed',
    collection: 'docs',
    id: 'a',
    cleared: ['date'],
  });
  assertSame();
  assert.equal(store.matches(prepared), false);
  store.apply({
    msg: 'changed',
    collection: 'docs',
    id: 'a',
    fields: { date: new Date(0), nested: { a: 1, b: 2, stale: true } },
  });
  assertSame();
  assert.equal(store.matches(prepared), false);
});

test('DDP readiness, ping, EJSON, updated-before-result, and unsubscribe', async (t) => {
  let pong = false;
  const client = await serverFor(t, (msg, send) => {
    if (msg.msg === 'sub') {
      send({ msg: 'ping', id: 'heartbeat' });
      send({
        msg: 'added',
        collection: 'docs',
        id: 'one',
        fields: { date: new Date(1000), remove: true },
      });
      send({
        msg: 'changed',
        collection: 'docs',
        id: 'one',
        cleared: ['remove'],
      });
      send({ msg: 'ready', subs: [msg.id] });
    }
    if (msg.msg === 'pong') pong = msg.id === 'heartbeat';
    if (msg.msg === 'method') {
      send({ msg: 'updated', methods: [msg.id] });
      send({ msg: 'result', id: msg.id, result: msg.params[0] });
    }
    if (msg.msg === 'unsub') {
      send({ msg: 'removed', collection: 'docs', id: 'one' });
      send({ msg: 'nosub', id: msg.id });
    }
  });
  const sub = await client.subscribe('test');
  assert.deepEqual(client.store.snapshot(), {
    docs: [{ _id: 'one', date: new Date(1000) }],
  });
  assert.deepEqual(await client.call('echo', [new Date(2000)]), new Date(2000));
  assert.ok(pong);
  await client.unsubscribe(sub.id);
  assert.ok(statesEqual(client.store.snapshot(), {}));
  assert.ok(client.traffic.messages > 0);
});

test('injected delay is measured; suppressed update times out despite method result', async (t) => {
  const client = await serverFor(t, (msg, send) => {
    if (msg.msg === 'method')
      setTimeout(() => {
        send({ msg: 'result', id: msg.id, result: true });
        send({ msg: 'updated', methods: [msg.id] });
      }, 40);
  });
  await client.call('delayed');
  assert.ok(client.methodLatencies[0] >= 30);
  const delivery = client.waitFor(
    () => client.store.collections.has('missing'),
    'suppressed update',
    50
  );
  await client.call('ack-without-update');
  await assert.rejects(delivery, /suppressed update/);
});

test('subscription failure and unexpected disconnect reject pending work', async (t) => {
  const client = await serverFor(t, (msg, send) => {
    if (msg.msg === 'sub')
      send({ msg: 'nosub', id: msg.id, error: { error: 'denied' } });
  });
  await assert.rejects(client.subscribe('denied'), /stopped unexpectedly/);
  assert.equal(client.listenerCount('message'), 0);
  const second = await serverFor(t, (msg, _send, socket) => {
    if (msg.msg === 'method') socket.close();
  });
  await assert.rejects(second.call('disconnect'), /disconnect/);
  await delay(1);
  assert.equal(second.listenerCount('message'), 0);
});

test('method acknowledgement without updated cannot complete a call', async (t) => {
  const client = await serverFor(t, (msg, send) => {
    if (msg.msg === 'method') send({ msg: 'result', id: msg.id, result: true });
  });
  client.timeout = 30;
  await assert.rejects(client.call('incomplete'), /Timeout/);
});
