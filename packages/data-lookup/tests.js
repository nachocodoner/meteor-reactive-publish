import { Tinytest } from 'meteor/tinytest';
import { Tracker } from 'meteor/tracker';
import { ReactiveVar } from 'meteor/reactive-var';
import { DataLookup } from './lib.js'; // Adjust path as needed

Tinytest.add('data-lookup - basic lookup', function (test) {
  test.equal(DataLookup.lookup({}, 'foo'), undefined);
  test.equal(DataLookup.lookup(null, 'foo'), undefined);
  test.equal(DataLookup.lookup(undefined, 'foo'), undefined);
  test.equal(DataLookup.lookup(1, 'foo'), undefined);

  test.equal(DataLookup.lookup({}), {});
  test.equal(DataLookup.lookup(null), null);
  test.equal(DataLookup.lookup(undefined), undefined);
  test.equal(DataLookup.lookup(1), 1);

  test.equal(DataLookup.lookup({}, ''), undefined);
  test.equal(DataLookup.lookup(null, ''), undefined);
  test.equal(DataLookup.lookup(undefined, ''), undefined);
  test.equal(DataLookup.lookup(1, ''), undefined);

  test.equal(DataLookup.lookup({}, []), {});
  test.equal(DataLookup.lookup(null, []), null);
  test.equal(DataLookup.lookup(undefined, []), undefined);
  test.equal(DataLookup.lookup(1, []), 1);

  test.equal(DataLookup.lookup({ foo: 'bar' }, 'foo'), 'bar');
  test.equal(DataLookup.lookup({ foo: { bar: 'baz' } }, 'foo'), { bar: 'baz' });
  test.equal(DataLookup.lookup({ foo: { bar: 'baz' } }, 'faa'), undefined);
  test.equal(DataLookup.lookup({ foo: { bar: 'baz' } }, 'foo.faa'), undefined);
  test.equal(DataLookup.lookup({ foo: { bar: 'baz' } }, 'foo.bar'), 'baz');
  test.equal(DataLookup.lookup({ foo: null }, 'foo.bar'), undefined);
  test.equal(DataLookup.lookup({ foo: null }, 'foo'), null);

  test.equal(DataLookup.lookup(() => ({ foo: { bar: 'baz' } }), 'foo'), { bar: 'baz' });
  test.equal(DataLookup.lookup({ foo: () => ({ bar: 'baz' }) }, 'foo'), { bar: 'baz' });
  test.equal(DataLookup.lookup(() => ({ foo: () => ({ bar: 'baz' }) }), 'foo.bar'), 'baz');
});

Tinytest.addAsync('data-lookup - reactive get', function (test, next) {
  const testVar = new ReactiveVar(null);
  const runs = [];

  Tracker.autorun(() => {
    const value = DataLookup.get(() => testVar.get(), 'foo.bar');
    runs.push(value);
  });

  // Utility to simulate Tracker.flush and wait
  const flushAndAssert = (valueToSet, expected, done) => {
    runs.length = 0;
    testVar.set(valueToSet);
    Tracker.flush();
    test.equal(runs, expected);
    if (done) done();
  };

  flushAndAssert(null, [undefined]);
  flushAndAssert('something', []);
  flushAndAssert({ foo: { test: 'baz' } }, []);
  flushAndAssert({ foo: { bar: 'baz' } }, ['baz']);
  flushAndAssert({ foo: { bar: 'baz', test: 'baz' } }, []);
  flushAndAssert({ foo: { test: 'baz' } }, [undefined]);
  flushAndAssert({ foo: { bar: 'baz', test: 'baz' } }, ['baz']);
  flushAndAssert({ foo: { bar: 'bak', test: 'baz' } }, ['bak']);

  // Nested reactive function case
  const testVar2 = new ReactiveVar(null);
  testVar.set({ foo: () => testVar2.get() });
  Tracker.flush();
  test.equal(runs, [undefined]);

  runs.length = 0;
  testVar2.set({ bar: 'bak', test: 'baz' });
  Tracker.flush();
  test.equal(runs, ['bak']);

  next();
});
