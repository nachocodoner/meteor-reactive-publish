import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './AsyncTracker.js';
import { ReactiveVarAsync } from './ReactiveVarAsync.js';

// Tests for ReactiveVarAsync
Tinytest.addAsync(
  'server-autorun - ReactiveVarAsync - constructor and get',
  async function (test) {
    // Test constructor with initial value
    const reactiveVar = new ReactiveVarAsync('initial value');

    // Test get method
    test.equal(
      reactiveVar.get(),
      'initial value',
      'get() should return the initial value'
    );

    // Test dependency tracking
    let value;
    let runCount = 0;

    const computation = AsyncTracker.autorun(async () => {
      runCount++;
      value = reactiveVar.get();
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(runCount, 1, 'Computation should run once initially');
    test.equal(
      value,
      'initial value',
      'Computation should get the initial value'
    );

    // Clean up
    computation.stop();
  }
);

Tinytest.addAsync(
  'server-autorun - ReactiveVarAsync - set and reactivity',
  async function (test) {
    // Test constructor with initial value
    const reactiveVar = new ReactiveVarAsync('initial value');

    let value;
    let runCount = 0;

    const computation = AsyncTracker.autorun(async () => {
      runCount++;
      value = reactiveVar.get();
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(runCount, 1, 'Computation should run once initially');
    test.equal(
      value,
      'initial value',
      'Computation should get the initial value'
    );

    // Set a new value
    reactiveVar.set('new value');

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check state after set
    test.equal(runCount, 2, 'Computation should rerun after set');
    test.equal(value, 'new value', 'Computation should get the new value');

    // Set the same value again (should not cause a rerun)
    reactiveVar.set('new value');

    // Wait to ensure no rerun happens
    await Meteor._sleepForMs(50);

    // Check that no rerun occurred
    test.equal(
      runCount,
      2,
      'Computation should not rerun when setting the same value'
    );

    // Clean up
    computation.stop();
  }
);

Tinytest.addAsync(
  'server-autorun - ReactiveVarAsync - _isEqual',
  async function (test) {
    // Test _isEqual with primitive values
    test.isTrue(ReactiveVarAsync._isEqual(1, 1), 'Numbers should be equal');
    test.isTrue(ReactiveVarAsync._isEqual('a', 'a'), 'Strings should be equal');
    test.isTrue(
      ReactiveVarAsync._isEqual(true, true),
      'Booleans should be equal'
    );
    test.isTrue(
      ReactiveVarAsync._isEqual(null, null),
      'Null values should be equal'
    );

    // Test _isEqual with different values
    test.isFalse(
      ReactiveVarAsync._isEqual(1, 2),
      'Different numbers should not be equal'
    );
    test.isFalse(
      ReactiveVarAsync._isEqual('a', 'b'),
      'Different strings should not be equal'
    );
    test.isFalse(
      ReactiveVarAsync._isEqual(true, false),
      'Different booleans should not be equal'
    );

    // Test _isEqual with objects (should return false even for identical objects)
    const obj1 = { a: 1 };
    const obj2 = { a: 1 };
    test.isFalse(
      ReactiveVarAsync._isEqual(obj1, obj2),
      'Objects should not be equal even with same content'
    );
    test.isFalse(
      ReactiveVarAsync._isEqual(obj1, obj1),
      'Same object reference should not be equal (not primitive)'
    );

    // Test _isEqual with arrays (should return false even for identical arrays)
    const arr1 = [1, 2, 3];
    const arr2 = [1, 2, 3];
    test.isFalse(
      ReactiveVarAsync._isEqual(arr1, arr2),
      'Arrays should not be equal even with same content'
    );
    test.isFalse(
      ReactiveVarAsync._isEqual(arr1, arr1),
      'Same array reference should not be equal (not primitive)'
    );
  }
);

Tinytest.addAsync(
  'server-autorun - ReactiveVarAsync - custom equals function',
  async function (test) {
    // Custom equals function that compares objects by their 'id' property
    const customEquals = (a, b) => a && b && a.id === b.id;

    // Create reactive var with custom equals function
    const reactiveVar = new ReactiveVarAsync(
      { id: 1, value: 'a' },
      customEquals
    );

    let value;
    let runCount = 0;

    const computation = AsyncTracker.autorun(async () => {
      runCount++;
      value = reactiveVar.get();
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(runCount, 1, 'Computation should run once initially');
    test.equal(value.id, 1, 'Computation should get the initial value');

    // Set a new object with same id but different value (should not cause a rerun)
    reactiveVar.set({ id: 1, value: 'b' });

    // Wait to ensure no rerun happens
    await Meteor._sleepForMs(50);

    // Check that no rerun occurred
    test.equal(
      runCount,
      1,
      'Computation should not rerun when setting object with same id'
    );

    // Set a new object with different id (should cause a rerun)
    reactiveVar.set({ id: 2, value: 'c' });

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check state after set
    test.equal(
      runCount,
      2,
      'Computation should rerun when setting object with different id'
    );
    test.equal(value.id, 2, 'Computation should get the new value');

    // Clean up
    computation.stop();
  }
);

Tinytest.addAsync(
  'server-autorun - ReactiveVarAsync - toString and _numListeners',
  async function (test) {
    // Test toString
    const reactiveVar = new ReactiveVarAsync('test value');
    test.equal(
      reactiveVar.toString(),
      'ReactiveVarAsync{test value}',
      'toString should format correctly'
    );

    // Test _numListeners
    test.equal(
      reactiveVar._numListeners(),
      0,
      'Should have no listeners initially'
    );

    // Add a listener
    const computation = AsyncTracker.autorun(async () => {
      reactiveVar.get();
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check listener count
    test.equal(
      reactiveVar._numListeners(),
      1,
      'Should have one listener after computation runs'
    );

    // Stop the computation
    computation.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Check listener count after stopping
    test.equal(
      reactiveVar._numListeners(),
      0,
      'Should have no listeners after computation stops'
    );
  }
);
