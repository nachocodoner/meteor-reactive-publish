import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './AsyncTracker.js';
import { ReactiveVarAsync } from './ReactiveVarAsync.js';

// Tests for ReactiveVarAsync
Tinytest.addAsync(
  'ReactiveVarAsync - constructor and get',
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
  'ReactiveVarAsync - set and reactivity',
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

Tinytest.addAsync('ReactiveVarAsync - _isEqual', async function (test) {
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
});

Tinytest.addAsync(
  'ReactiveVarAsync - custom equals function',
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
  'ReactiveVarAsync - toString and _numListeners',
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

// Test for setSync method
Tinytest.addAsync(
  'ReactiveVarAsync - setSync and reactivity',
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

    // Set a new value synchronously
    reactiveVar.setSync('new value');

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check state after setSync
    test.equal(runCount, 2, 'Computation should rerun after setSync');
    test.equal(value, 'new value', 'Computation should get the new value');

    // Set the same value again (should not cause a rerun)
    reactiveVar.setSync('new value');

    // Wait to ensure no rerun happens
    await Meteor._sleepForMs(50);

    // Check that no rerun occurred
    test.equal(
      runCount,
      2,
      'Computation should not rerun when setting the same value synchronously'
    );

    // Clean up
    computation.stop();
  }
);

// Test for multiple dependent computations
Tinytest.addAsync(
  'ReactiveVarAsync - multiple dependent computations',
  async function (test) {
    const reactiveVar = new ReactiveVarAsync('initial value');

    // Track values and run counts for two separate computations
    let value1, value2;
    let runCount1 = 0,
      runCount2 = 0;

    // Create first computation
    const computation1 = AsyncTracker.autorun(async () => {
      runCount1++;
      value1 = reactiveVar.get();
    });

    // Create second computation
    const computation2 = AsyncTracker.autorun(async () => {
      runCount2++;
      value2 = reactiveVar.get();
    });

    // Wait for initial runs
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(runCount1, 1, 'First computation should run once initially');
    test.equal(runCount2, 1, 'Second computation should run once initially');
    test.equal(
      value1,
      'initial value',
      'First computation should get the initial value'
    );
    test.equal(
      value2,
      'initial value',
      'Second computation should get the initial value'
    );
    test.equal(
      reactiveVar._numListeners(),
      2,
      'ReactiveVar should have two listeners'
    );

    // Update the value
    await reactiveVar.set('new value');

    // Wait for reruns
    await Meteor._sleepForMs(50);

    // Check state after update
    test.equal(runCount1, 2, 'First computation should rerun after update');
    test.equal(runCount2, 2, 'Second computation should rerun after update');
    test.equal(
      value1,
      'new value',
      'First computation should get the new value'
    );
    test.equal(
      value2,
      'new value',
      'Second computation should get the new value'
    );

    // Stop the first computation
    computation1.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Check listener count
    test.equal(
      reactiveVar._numListeners(),
      1,
      'ReactiveVar should have one listener after stopping first computation'
    );

    // Update the value again
    await reactiveVar.set('another value');

    // Wait for reruns
    await Meteor._sleepForMs(50);

    // Check state after second update
    test.equal(
      runCount1,
      2,
      'First computation should not rerun after being stopped'
    );
    test.equal(
      runCount2,
      3,
      'Second computation should rerun after second update'
    );
    test.equal(
      value1,
      'new value',
      'First computation value should remain unchanged'
    );
    test.equal(
      value2,
      'another value',
      'Second computation should get the latest value'
    );

    // Clean up
    computation2.stop();
  }
);

// Test for edge cases
Tinytest.addAsync('ReactiveVarAsync - edge cases', async function (test) {
  // Test with undefined initial value
  const undefinedVar = new ReactiveVarAsync(undefined);
  test.isUndefined(undefinedVar.get(), 'Should handle undefined initial value');

  // Test setting to undefined
  const reactiveVar = new ReactiveVarAsync('initial');
  await reactiveVar.set(undefined);
  test.isUndefined(reactiveVar.get(), 'Should handle setting to undefined');

  // Test with NaN
  const nanVar = new ReactiveVarAsync(NaN);
  test.isTrue(isNaN(nanVar.get()), 'Should handle NaN initial value');

  // Test setting to NaN
  await nanVar.set(123);
  test.equal(nanVar.get(), 123, 'Should update from NaN to number');
  await nanVar.set(NaN);
  test.isTrue(isNaN(nanVar.get()), 'Should handle setting to NaN');

  // Test with special values that might affect equality comparison
  let runCount = 0;
  let value;

  const specialVar = new ReactiveVarAsync(0);
  const computation = AsyncTracker.autorun(async () => {
    runCount++;
    value = specialVar.get();
  });

  // Wait for initial run
  await Meteor._sleepForMs(50);
  test.equal(runCount, 1, 'Computation should run once initially');
  test.equal(value, 0, 'Should get initial value 0');

  // Test with falsy values
  await specialVar.set('');
  await Meteor._sleepForMs(50);
  test.equal(runCount, 2, 'Should detect change from 0 to empty string');
  test.equal(value, '', 'Should get updated empty string value');

  await specialVar.set(false);
  await Meteor._sleepForMs(50);
  test.equal(runCount, 3, 'Should detect change from empty string to false');
  test.equal(value, false, 'Should get updated false value');

  await specialVar.set(null);
  await Meteor._sleepForMs(50);
  test.equal(runCount, 4, 'Should detect change from false to null');
  test.equal(value, null, 'Should get updated null value');

  // Test with complex objects
  const obj1 = { a: 1, b: 2 };
  const obj2 = { a: 1, b: 2 }; // Same content but different reference

  await specialVar.set(obj1);
  await Meteor._sleepForMs(50);
  test.equal(runCount, 5, 'Should detect change from null to object');
  test.equal(value, obj1, 'Should get updated object value');

  await specialVar.set(obj2);
  await Meteor._sleepForMs(50);
  test.equal(
    runCount,
    6,
    'Should detect change between different object references'
  );
  test.equal(value, obj2, 'Should get updated object value');

  // Set the same object reference again (should cause a rerun with original _isEqual implementation)
  await specialVar.set(obj2);
  await Meteor._sleepForMs(50);
  test.equal(
    runCount,
    7,
    'Should rerun when setting the same object reference (objects are not primitives)'
  );

  // Clean up
  computation.stop();
});

// Test for error handling in computations
Tinytest.addAsync('ReactiveVarAsync - error handling', async function (test) {
  const reactiveVar = new ReactiveVarAsync('initial value');

  // Track if error handler was called
  let errorHandled = false;
  let errorMessage = null;

  // Create a computation that throws an error when the value is 'trigger error'
  const computation = AsyncTracker.autorun(
    async () => {
      const value = reactiveVar.get();
      if (value === 'trigger error') {
        throw new Error('Test error in computation');
      }
    },
    {
      onError: (msg, err) => {
        errorHandled = true;
        errorMessage = err.message;
      },
    }
  );

  // Wait for initial run
  await Meteor._sleepForMs(50);

  // Check initial state
  test.isFalse(errorHandled, 'Error should not be triggered initially');

  // Set a value that triggers the error
  await reactiveVar.set('trigger error');

  // Wait for rerun
  await Meteor._sleepForMs(50);

  // Check that the error was handled
  test.isTrue(errorHandled, 'Error should be handled by onError callback');
  test.equal(
    errorMessage,
    'Test error in computation',
    'Error message should be passed to callback'
  );

  // Set a value that doesn't trigger an error
  errorHandled = false;
  await reactiveVar.set('safe value');

  // Wait for rerun
  await Meteor._sleepForMs(50);

  // Check that no error was triggered
  test.isFalse(errorHandled, 'Error should not be triggered with safe value');

  // Clean up
  computation.stop();

  // Test error handling with custom equals function that throws
  let equalsErrorCaught = false;
  const problematicEquals = (a, b) => {
    if (a === 'trigger equals error' || b === 'trigger equals error') {
      throw new Error('Test error in equals function');
    }
    return a === b;
  };

  // Create reactive var with problematic equals function
  const problematicVar = new ReactiveVarAsync('initial', problematicEquals);

  // Try to set a value that triggers an error in equals function
  try {
    await problematicVar.set('trigger equals error');
  } catch (e) {
    equalsErrorCaught = true;
    test.equal(
      e.message,
      'Test error in equals function',
      'Error from equals function should be propagated'
    );
  }

  test.isTrue(equalsErrorCaught, 'Error in equals function should be caught');
});

// Test for nonreactive usage
Tinytest.addAsync(
  'ReactiveVarAsync - nonreactive usage',
  async function (test) {
    const reactiveVar = new ReactiveVarAsync('initial value');

    let runCount = 0;
    let nonreactiveValue = null;

    // Create a computation that uses nonreactive
    const computation = AsyncTracker.autorun(async () => {
      runCount++;

      // This should not establish a dependency
      nonreactiveValue = await AsyncTracker.nonreactive(async () => {
        return reactiveVar.get();
      });
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(runCount, 1, 'Computation should run once initially');
    test.equal(
      nonreactiveValue,
      'initial value',
      'Should get initial value in nonreactive context'
    );

    // Change the value
    await reactiveVar.set('new value');

    // Wait to ensure no rerun happens
    await Meteor._sleepForMs(50);

    // Check that no rerun occurred
    test.equal(
      runCount,
      1,
      'Computation should not rerun when value changes in nonreactive context'
    );
    test.equal(
      nonreactiveValue,
      'initial value',
      'Nonreactive value should not be updated'
    );

    // Manually run the computation again to get the new value
    await computation.run();

    // Wait for the run to complete
    await Meteor._sleepForMs(50);

    // Check that the computation ran and got the new value
    test.equal(runCount, 2, 'Computation should run after manual invalidation');
    test.equal(
      nonreactiveValue,
      'new value',
      'Should get new value after manual run'
    );

    // Clean up
    computation.stop();
  }
);
