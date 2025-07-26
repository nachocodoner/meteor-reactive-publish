import { Tinytest } from 'meteor/tinytest';
import { Tracker } from 'meteor/tracker';
import { ReactiveVar } from 'meteor/reactive-var';
import { DataLookup, ComputedField } from './lib-client.js'; // Adjust path as needed

Tinytest.addAsync('computed-field - basic', async function (test, done) {
  const foo = new ComputedField(() => 42);

  test.equal(foo(), 42);
  test.instanceOf(foo, ComputedField);
  test.equal(foo.constructor, ComputedField);
  test.equal(typeof foo, 'function');

  test.equal(foo.apply(), 42);
  test.equal(foo.call(), 42);
  test.equal(`${foo}`, 'ComputedField{42}');

  done();
});

Tinytest.addAsync('computed-field - reactive', async function (test, done) {
  const internal = new ReactiveVar(42);

  const foo = new ComputedField(() => internal.get());

  const changes = [];
  const handle = Tracker.autorun(() => {
    console.log('--> (tests-client.js-Line: 29)\n entro foo(): ', foo());
    changes.push(foo());
  });

  internal.set(43);
  handle.flush();

  internal.set(44);
  handle.flush();

  internal.set(44); // no change
  handle.flush();

  internal.set(43);
  handle.flush();

  test.equal(changes, [42, 43, 44, 43]);

  handle.stop();
  done();
});

Tinytest.addAsync('computed-field - nested', async function (test, done) {
  const internal = new ReactiveVar(42);
  let outside = null;

  const changes = [];
  const handle = Tracker.autorun(() => {
    outside = new ComputedField(() => internal.get());
    changes.push(outside());
  });

  internal.set(43);
  handle.flush();

  handle.stop();

  internal.set(44);
  internal.set(45);

  test.equal(outside(), 45);

  test.equal(changes, [42, 43]);

  outside.stop();
  done();
});
//
// Tinytest.addAsync('computed-field - dontStop', async function (test, done) {
//   const internal = new ReactiveVar(42);
//
//   let run = [];
//   let foo = new ComputedField(async () => {
//     const value = await internal.get();
//     run.push(value);
//     return value;
//   }, false);
//
//   await foo();
//   test.isTrue(foo._isRunning());
//
//   await foo.flush();
//   test.isFalse(foo._isRunning());
//
//   await foo();
//   test.isTrue(foo._isRunning());
//
//   await foo.flush();
//   test.isFalse(foo._isRunning());
//
//   await foo();
//   test.isTrue(foo._isRunning());
//
//   test.equal(run, [42, 42, 42]);
//
//   await foo.stop();
//
//   run = [];
//   foo = new ComputedField(async () => {
//     const value = await internal.get();
//     run.push(value);
//     return value;
//   }, true); // keepRunning = true
//
//   await foo();
//   test.isTrue(foo._isRunning());
//
//   await foo.flush();
//   test.isTrue(foo._isRunning());
//
//   await foo();
//   test.isTrue(foo._isRunning());
//
//   await foo.flush();
//   test.isTrue(foo._isRunning());
//
//   await foo();
//   test.isTrue(foo._isRunning());
//
//   test.equal(run, [42]);
//
//   await foo.stop();
//   done();
// });
//
// Tinytest.addAsync('data-lookup - basic lookup', async function (test, done) {
//   test.equal(await DataLookup.lookup({}, 'foo'), undefined);
//   test.equal(await DataLookup.lookup(null, 'foo'), undefined);
//   test.equal(await DataLookup.lookup(undefined, 'foo'), undefined);
//   test.equal(await DataLookup.lookup(1, 'foo'), undefined);
//
//   test.equal(await DataLookup.lookup({}), {});
//   test.equal(await DataLookup.lookup(null), null);
//   test.equal(await DataLookup.lookup(undefined), undefined);
//   test.equal(await DataLookup.lookup(1), 1);
//
//   test.equal(await DataLookup.lookup({}, ''), undefined);
//   test.equal(await DataLookup.lookup(null, ''), undefined);
//   test.equal(await DataLookup.lookup(undefined, ''), undefined);
//   test.equal(await DataLookup.lookup(1, ''), undefined);
//
//   test.equal(await DataLookup.lookup({}, []), {});
//   test.equal(await DataLookup.lookup(null, []), null);
//   test.equal(await DataLookup.lookup(undefined, []), undefined);
//   test.equal(await DataLookup.lookup(1, []), 1);
//
//   test.equal(await DataLookup.lookup({ foo: 'bar' }, 'foo'), 'bar');
//   test.equal(await DataLookup.lookup({ foo: { bar: 'baz' } }, 'foo'), {
//     bar: 'baz',
//   });
//   test.equal(
//     await DataLookup.lookup({ foo: { bar: 'baz' } }, 'faa'),
//     undefined
//   );
//   test.equal(
//     await DataLookup.lookup({ foo: { bar: 'baz' } }, 'foo.faa'),
//     undefined
//   );
//   test.equal(
//     await DataLookup.lookup({ foo: { bar: 'baz' } }, 'foo.bar'),
//     'baz'
//   );
//   test.equal(await DataLookup.lookup({ foo: null }, 'foo.bar'), undefined);
//   test.equal(await DataLookup.lookup({ foo: null }, 'foo'), null);
//
//   test.equal(
//     await DataLookup.lookup(async () => ({ foo: { bar: 'baz' } }), 'foo'),
//     { bar: 'baz' }
//   );
//   test.equal(
//     await DataLookup.lookup({ foo: async () => ({ bar: 'baz' }) }, 'foo'),
//     {
//       bar: 'baz',
//     }
//   );
//   test.equal(
//     await DataLookup.lookup(
//       async () => ({ foo: async () => ({ bar: 'baz' }) }),
//       'foo.bar'
//     ),
//     'baz'
//   );
//
//   done();
// });
//
// Tinytest.addAsync('data-lookup - reactive get', async function (test, done) {
//   const testVar = new ReactiveVar(null);
//   let runs = [];
//
//   const handle = Tracker.autorun(async () => {
//     const value = await DataLookup.get(
//       async () => await testVar.get(),
//       'foo.bar'
//     );
//     runs.push(value);
//   });
//
//   // Utility to simulate flush and wait
//   const flushAndAssert = async (valueToSet, expected) => {
//     runs = [];
//     await testVar.set(valueToSet);
//     await handle.flush();
//     test.equal(runs, expected);
//   };
//
//   await flushAndAssert(null, [undefined]);
//   await flushAndAssert('something', []);
//   await flushAndAssert({ foo: { test: 'baz' } }, []);
//   await flushAndAssert({ foo: { bar: 'baz' } }, ['baz']);
//   await flushAndAssert({ foo: { bar: 'baz', test: 'baz' } }, []);
//   await flushAndAssert({ foo: { test: 'baz' } }, [undefined]);
//   await flushAndAssert({ foo: { bar: 'baz', test: 'baz' } }, ['baz']);
//   await flushAndAssert({ foo: { bar: 'bak', test: 'baz' } }, ['bak']);
//
//   // Nested reactive function case
//   const testVar2 = new ReactiveVar(null);
//   await testVar.set({ foo: async () => testVar2.get() });
//   await handle.flush();
//   test.equal(runs, [undefined]);
//
//   runs = [];
//   await testVar2.set({ bar: 'bak', test: 'baz' });
//   await handle.flush();
//   test.equal(runs, ['bak']);
//
//   await handle.stop();
//   done();
// });
