import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './AsyncTracker.js';
import { ReactiveVarAsync } from './ReactiveVarAsync.js';
import { DataLookup } from './DataLookup.js';

Tinytest.addAsync('DataLookup - basic lookup', async function (test, done) {
  test.equal(await DataLookup.lookup({}, 'foo'), undefined);
  test.equal(await DataLookup.lookup(null, 'foo'), undefined);
  test.equal(await DataLookup.lookup(undefined, 'foo'), undefined);
  test.equal(await DataLookup.lookup(1, 'foo'), undefined);

  test.equal(await DataLookup.lookup({}), {});
  test.equal(await DataLookup.lookup(null), null);
  test.equal(await DataLookup.lookup(undefined), undefined);
  test.equal(await DataLookup.lookup(1), 1);

  test.equal(await DataLookup.lookup({}, ''), undefined);
  test.equal(await DataLookup.lookup(null, ''), undefined);
  test.equal(await DataLookup.lookup(undefined, ''), undefined);
  test.equal(await DataLookup.lookup(1, ''), undefined);

  test.equal(await DataLookup.lookup({}, []), {});
  test.equal(await DataLookup.lookup(null, []), null);
  test.equal(await DataLookup.lookup(undefined, []), undefined);
  test.equal(await DataLookup.lookup(1, []), 1);

  test.equal(await DataLookup.lookup({ foo: 'bar' }, 'foo'), 'bar');
  test.equal(await DataLookup.lookup({ foo: { bar: 'baz' } }, 'foo'), {
    bar: 'baz',
  });
  test.equal(
    await DataLookup.lookup({ foo: { bar: 'baz' } }, 'faa'),
    undefined
  );
  test.equal(
    await DataLookup.lookup({ foo: { bar: 'baz' } }, 'foo.faa'),
    undefined
  );
  test.equal(
    await DataLookup.lookup({ foo: { bar: 'baz' } }, 'foo.bar'),
    'baz'
  );
  test.equal(await DataLookup.lookup({ foo: null }, 'foo.bar'), undefined);
  test.equal(await DataLookup.lookup({ foo: null }, 'foo'), null);

  test.equal(
    await DataLookup.lookup(async () => ({ foo: { bar: 'baz' } }), 'foo'),
    { bar: 'baz' }
  );
  test.equal(
    await DataLookup.lookup({ foo: async () => ({ bar: 'baz' }) }, 'foo'),
    {
      bar: 'baz',
    }
  );
  test.equal(
    await DataLookup.lookup(
      async () => ({ foo: async () => ({ bar: 'baz' }) }),
      'foo.bar'
    ),
    'baz'
  );

  done();
});

Tinytest.addAsync('DataLookup - reactive get', async function (test, done) {
  const testVar = new ReactiveVarAsync(null);
  let runs = [];

  const handle = await AsyncTracker.autorun(async () => {
    const value = await DataLookup.get(
      async () => await testVar.get(),
      'foo.bar'
    );
    runs.push(value);
  });

  // Utility to simulate flush and wait
  const flushAndAssert = async (valueToSet, expected) => {
    runs = [];
    await testVar.set(valueToSet);
    await handle.flush();
    await AsyncTracker.drainReactions();
    test.equal(runs, expected);
  };

  await flushAndAssert(null, [undefined]);
  await flushAndAssert('something', []);
  await flushAndAssert({ foo: { test: 'baz' } }, []);
  await flushAndAssert({ foo: { bar: 'baz' } }, ['baz']);
  await flushAndAssert({ foo: { bar: 'baz', test: 'baz' } }, []);
  await flushAndAssert({ foo: { test: 'baz' } }, [undefined]);
  await flushAndAssert({ foo: { bar: 'baz', test: 'baz' } }, ['baz']);
  await flushAndAssert({ foo: { bar: 'bak', test: 'baz' } }, ['bak']);

  // Nested reactive function case
  runs = [];
  const testVar2 = new ReactiveVarAsync(null);
  await testVar.set({ foo: async () => testVar2.get() });
  await handle.flush();
  await AsyncTracker.drainReactions();
  test.equal(runs, [undefined]);

  // To verify if truly needed
  // runs = [];
  // await testVar2.set({ bar: 'bak', test: 'baz' });
  // await handle.flush();
  // await AsyncTracker.drainReactions();
  // test.equal(runs, ['bak']);

  await handle.stop();
  done();
});
