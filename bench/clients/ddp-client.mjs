import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import EJSON from 'ejson';
import { DocumentStore } from './document-store.mjs';

const blankTraffic = () => ({
  in: {},
  out: {},
  payload_bytes: 0,
  messages: 0,
  application_bytes: 0,
  metadata_bytes: 0,
});

export class DDPClient extends EventEmitter {
  constructor(url, { timeout = 15000 } = {}) {
    super();
    this.setMaxListeners(0);
    this.url = url.replace(/^http/, 'ws').replace(/\/$/, '') + '/websocket';
    this.timeout = timeout;
    this.store = new DocumentStore();
    this.sequence = 0;
    this.traffic = blankTraffic();
    this.methodLatencies = [];
    this.subscriptions = new Set();
    this.unsubscribing = new Set();
    this.closed = false;
    this.failure = null;
  }

  resetMetrics() {
    this.traffic = blankTraffic();
    this.methodLatencies = [];
  }

  count(direction, message, bytes) {
    const type = message.msg || 'unknown';
    const row = (this.traffic[direction][type] ||= { count: 0, bytes: 0 });
    row.count++;
    row.bytes += bytes;
    this.traffic.messages++;
    this.traffic.payload_bytes += bytes;
    this.traffic[
      message.collection?.startsWith('bench_')
        ? 'application_bytes'
        : 'metadata_bytes'
    ] += bytes;
  }

  fail(error) {
    if (this.failure || this.closed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.emit('failure', this.failure);
  }

  waitFor(predicate, label, timeout = this.timeout) {
    let timer;
    let onMessage;
    let onFailure;
    const promise = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('message', onMessage);
        this.off('failure', onFailure);
      };
      onFailure = (error) => {
        cleanup();
        reject(error);
      };
      onMessage = (message) => {
        try {
          if (predicate(message)) {
            cleanup();
            resolve(performance.now());
          }
        } catch (error) {
          onFailure(error);
        }
      };
      this.on('message', onMessage);
      this.on('failure', onFailure);
      timer = setTimeout(
        () => onFailure(new Error(`Timeout: ${label}`)),
        timeout
      );
      if (this.failure) onFailure(this.failure);
      else onMessage(null);
    });
    // Callers arm waits before dispatching work. Keep an early rejection handled
    // while they await dispatch; awaiting this same promise still throws.
    promise.catch(() => {});
    return promise;
  }

  async connect() {
    if (this.socket) throw new Error('DDP client already connected');
    const ready = this.waitFor(
      (msg) => msg?.msg === 'connected',
      'DDP connect'
    );
    this.socket = new WebSocket(this.url, { perMessageDeflate: false });
    this.socket.on('open', () =>
      this.send({ msg: 'connect', version: '1', support: ['1'] })
    );
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', () =>
      this.fail(new Error('Unexpected DDP disconnect'))
    );
    this.socket.on('message', (raw) => {
      try {
        const message = EJSON.parse(raw.toString());
        this.count('in', message, raw.length);
        if (message.msg === 'failed' || message.msg === 'error')
          throw new Error(`DDP error: ${JSON.stringify(message)}`);
        if (message.msg === 'ping')
          this.send({
            msg: 'pong',
            ...(message.id !== undefined ? { id: message.id } : {}),
          });
        if (message.msg === 'connected') this.session = message.session;
        if (message.msg === 'nosub' && !this.unsubscribing.has(message.id)) {
          throw new Error(
            `Subscription stopped unexpectedly: ${JSON.stringify(message)}`
          );
        }
        this.store.apply(message);
        this.emit('message', message);
      } catch (error) {
        this.fail(error);
      }
    });
    await ready;
    return this;
  }

  send(message) {
    if (this.failure) throw this.failure;
    const raw = EJSON.stringify(message);
    this.count('out', message, Buffer.byteLength(raw));
    this.socket.send(raw);
  }

  async subscribe(name, params = []) {
    const id = `sub-${++this.sequence}`;
    this.subscriptions.add(id);
    const ready = this.waitFor(
      (message) => message?.msg === 'ready' && message.subs.includes(id),
      `ready ${name}`
    );
    const start = performance.now();
    this.send({ msg: 'sub', id, name, params });
    const received = await ready;
    return { id, readyMs: received - start };
  }

  async unsubscribe(id) {
    this.unsubscribing.add(id);
    const done = this.waitFor((message) => {
      if (message?.msg !== 'nosub' || message.id !== id) return false;
      if (message.error)
        throw new Error(`Unsubscribe failed: ${JSON.stringify(message.error)}`);
      return true;
    }, `unsubscribe ${id}`);
    this.send({ msg: 'unsub', id });
    await done;
    this.subscriptions.delete(id);
    this.unsubscribing.delete(id);
  }

  async call(method, params = []) {
    const id = `method-${++this.sequence}`;
    let result;
    let gotResult = false;
    let updated = false;
    const start = performance.now();
    const complete = this.waitFor((message) => {
      if (message?.msg === 'result' && message.id === id) {
        if (message.error)
          throw new Error(`Method ${method}: ${JSON.stringify(message.error)}`);
        result = message.result;
        gotResult = true;
        this.methodLatencies.push(performance.now() - start);
      }
      if (message?.msg === 'updated' && message.methods.includes(id))
        updated = true;
      return gotResult && updated;
    }, `method ${method}`);
    this.send({ msg: 'method', id, method, params });
    await complete;
    return result;
  }

  async disconnect() {
    if (!this.socket || this.closed) return;
    this.fail(new Error('Client closed with pending work'));
    this.closed = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 500);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }
}
