import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './AsyncTracker.js';
import { ReactiveVarAsync } from './ReactiveVarAsync.js';
import { ComputedField } from './ComputedField.js';

// ComputedField

Tinytest.addAsync('ComputedField - basic', async function (test, done) {
  const foo = new ComputedField(async () => 42);

  test.equal(await foo(), 42);
  test.instanceOf(foo, ComputedField);
  test.equal(foo.constructor, ComputedField);
  test.equal(typeof foo, 'function');

  test.equal(await foo.apply(), 42);
  test.equal(await foo.call(), 42);
  test.equal(`${foo}`, 'ComputedField{42}');

  done();
});

Tinytest.addAsync('ComputedField - reactive', async function (test, done) {
  const internal = new ReactiveVarAsync(42);

  const foo = new ComputedField(async () => await internal.get());

  const changes = [];
  const handle = await AsyncTracker.autorun(async () => {
    const value = await foo();
    changes.push(value);
  });

  await internal.set(43);
  await handle.flush();

  await internal.set(44);
  await handle.flush();

  await internal.set(44); // no change
  await handle.flush();

  await internal.set(43);
  await handle.flush();

  test.equal(changes, [42, 43, 44, 43]);

  await handle.stop();
  done();
});

Tinytest.addAsync('ComputedField - nested', async function (test, done) {
  const internal = new ReactiveVarAsync(42);
  let outside = null;

  const changes = [];
  const handle = await AsyncTracker.autorun(async () => {
    outside = new ComputedField(async () => await internal.get());
    changes.push(await outside());
  });

  await internal.set(43);
  await handle.flush();

  await handle.stop();

  await internal.set(44);
  await internal.set(45);

  test.equal(await outside(), 45);

  test.equal(changes, [42, 43]);

  await outside.stop();
  done();
});

Tinytest.addAsync('ComputedField - dontStop', async function (test, done) {
  const internal = new ReactiveVarAsync(42);

  let run = [];
  let foo = new ComputedField(async () => {
    const value = await internal.get();
    run.push(value);
    return value;
  }, true); // keepRunning = true

  await foo();
  test.isTrue(foo._isRunning());

  await foo.flush();
  test.isTrue(foo._isRunning());

  await foo();
  test.isTrue(foo._isRunning());

  await foo.flush();
  test.isTrue(foo._isRunning());

  await foo();
  test.isTrue(foo._isRunning());

  test.equal(run, [42]);

  await foo.stop();
  done();
});
