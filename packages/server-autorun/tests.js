import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker, ReactiveVarAsync } from './server.js';

// Tests for AsyncTrackerDependency
Tinytest.addAsync(
  'server-autorun - AsyncTrackerDependency - depend, changed, hasDependents',
  async function (test) {
    const dep = new AsyncTracker.Dependency();

    // Initially should have no dependents
    test.isFalse(dep.hasDependents(), 'Dependency should start with no dependents');

    // Create a computation that depends on this dependency
    let dependencyChanged = false;
    const computation = AsyncTracker.autorun(async () => {
      dep.depend();
      dependencyChanged = true;
    });

    // Wait for the computation to run
    await Meteor._sleepForMs(50);

    // Should now have dependents
    test.isTrue(dep.hasDependents(), 'Dependency should have dependents after depend() is called');

    // Reset the flag
    dependencyChanged = false;

    // Trigger the dependency to change
    dep.changed();

    // Wait for the computation to rerun
    await Meteor._sleepForMs(50);

    // The computation should have rerun
    test.isTrue(dependencyChanged, 'Computation should rerun when dependency is changed');

    // Stop the computation
    computation.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Should no longer have dependents
    test.isFalse(dep.hasDependents(), 'Dependency should not have dependents after computation is stopped');
  }
);

// Tests for AsyncTrackerComputation
Tinytest.addAsync(
  'server-autorun - AsyncTrackerComputation - autorun, invalidate, stop',
  async function (test) {
    let runCount = 0;
    let invalidateCallbackCalled = false;
    let stopCallbackCalled = false;

    // Create a computation
    const computation = AsyncTracker.autorun(async (comp) => {
      runCount++;
      test.isTrue(comp.firstRun === (runCount === 1), 'firstRun should be true only on first run');
    });

    // Set up invalidate callback
    computation.onInvalidate(() => {
      invalidateCallbackCalled = true;
    });

    // Set up stop callback
    computation.onStop(() => {
      stopCallbackCalled = true;
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(runCount, 1, 'Computation should run once initially');
    test.isFalse(invalidateCallbackCalled, 'Invalidate callback should not be called initially');
    test.isFalse(stopCallbackCalled, 'Stop callback should not be called initially');

    // Invalidate the computation
    await computation.invalidate();

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check state after invalidation
    test.equal(runCount, 2, 'Computation should run again after invalidation');
    test.isTrue(invalidateCallbackCalled, 'Invalidate callback should be called');
    test.isFalse(stopCallbackCalled, 'Stop callback should not be called yet');

    // Stop the computation
    computation.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Check state after stopping
    test.isTrue(stopCallbackCalled, 'Stop callback should be called after stopping');

    // Invalidate again (should not cause a rerun)
    invalidateCallbackCalled = false;
    await computation.invalidate();

    // Wait to ensure no rerun happens
    await Meteor._sleepForMs(50);

    // Check that no rerun occurred
    test.equal(runCount, 2, 'Computation should not rerun after being stopped');
    test.isFalse(invalidateCallbackCalled, 'Invalidate callback should not be called after stopping');
  }
);

// Tests for AsyncTracker.nonreactive
Tinytest.addAsync(
  'server-autorun - AsyncTracker.nonreactive',
  async function (test) {
    const dep = new AsyncTracker.Dependency();
    let nonreactiveRan = false;
    let outerRunCount = 0;
    let innerRunCount = 0;

    // Create an outer computation
    const outerComputation = AsyncTracker.autorun(async () => {
      outerRunCount++;

      // This should depend on the dependency
      dep.depend();

      // Run a non-reactive function
      await AsyncTracker.nonreactive(async () => {
        nonreactiveRan = true;
        innerRunCount++;

        // This should not establish a dependency
        dep.depend();
      });
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(outerRunCount, 1, 'Outer computation should run once initially');
    test.equal(innerRunCount, 1, 'Inner nonreactive function should run once initially');
    test.isTrue(nonreactiveRan, 'Nonreactive function should have run');

    // Reset flag
    nonreactiveRan = false;

    // Trigger the dependency to change
    dep.changed();

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check state after dependency change
    test.equal(outerRunCount, 2, 'Outer computation should rerun after dependency change');
    test.equal(innerRunCount, 2, 'Inner nonreactive function should run again as part of outer computation');
    test.isTrue(nonreactiveRan, 'Nonreactive function should have run again');

    // Clean up
    outerComputation.stop();
  }
);

// Tests for AsyncTrackerComputation - beforeRun and afterRun
Tinytest.addAsync(
  'server-autorun - AsyncTrackerComputation - beforeRun and afterRun',
  async function (test) {
    let runCount = 0;
    let beforeRunCount = 0;
    let afterRunCount = 0;

    // Create a computation
    const computation = AsyncTracker.autorun(async () => {
      runCount++;
    });

    // Set up beforeRun callback
    computation.beforeRun(() => {
      beforeRunCount++;
    });

    // Set up afterRun callback
    computation.afterRun(() => {
      afterRunCount++;
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(runCount, 1, 'Computation should run once initially');
    test.equal(beforeRunCount, 0, 'beforeRun should not be called for initial run');
    test.equal(afterRunCount, 1, 'afterRun should be called after initial run');

    // Invalidate the computation
    await computation.invalidate();

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check state after invalidation
    test.equal(runCount, 2, 'Computation should run again after invalidation');
    test.equal(beforeRunCount, 1, 'beforeRun should be called before rerun');
    test.equal(afterRunCount, 2, 'afterRun should be called after rerun');

    // Manually run the computation
    await computation.run();

    // Wait for run to complete
    await Meteor._sleepForMs(50);

    // Check state after manual run
    test.equal(runCount, 3, 'Computation should run again after manual run');
    test.equal(beforeRunCount, 2, 'beforeRun should be called before manual run');
    test.equal(afterRunCount, 3, 'afterRun should be called after manual run');

    // Clean up
    computation.stop();
  }
);

// Tests for AsyncTrackerComputation - flush
Tinytest.addAsync(
  'server-autorun - AsyncTrackerComputation - flush',
  async function (test) {
    let runCount = 0;

    // Create a computation
    const computation = AsyncTracker.autorun(async () => {
      runCount++;
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(runCount, 1, 'Computation should run once initially');

    // Flush the computation (should not cause a rerun if not invalidated)
    await computation.flush();

    // Wait to ensure no rerun happens
    await Meteor._sleepForMs(50);

    // Check that no rerun occurred
    test.equal(runCount, 1, 'Computation should not rerun after flush if not invalidated');

    // Invalidate but don't let it rerun automatically
    computation.invalidated = true;

    // Flush the computation (should cause a rerun now)
    await computation.flush();

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check that a rerun occurred
    test.equal(runCount, 2, 'Computation should rerun after flush if invalidated');

    // Clean up
    computation.stop();
  }
);

// Tests for ReactiveVarAsync
Tinytest.addAsync(
  'server-autorun - ReactiveVarAsync - constructor and get',
  async function (test) {
    // Test constructor with initial value
    const reactiveVar = new ReactiveVarAsync('initial value');

    // Test get method
    test.equal(reactiveVar.get(), 'initial value', 'get() should return the initial value');

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
    test.equal(value, 'initial value', 'Computation should get the initial value');

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
    test.equal(value, 'initial value', 'Computation should get the initial value');

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
    test.equal(runCount, 2, 'Computation should not rerun when setting the same value');

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
    test.isTrue(ReactiveVarAsync._isEqual(true, true), 'Booleans should be equal');
    test.isTrue(ReactiveVarAsync._isEqual(null, null), 'Null values should be equal');

    // Test _isEqual with different values
    test.isFalse(ReactiveVarAsync._isEqual(1, 2), 'Different numbers should not be equal');
    test.isFalse(ReactiveVarAsync._isEqual('a', 'b'), 'Different strings should not be equal');
    test.isFalse(ReactiveVarAsync._isEqual(true, false), 'Different booleans should not be equal');

    // Test _isEqual with objects (should return false even for identical objects)
    const obj1 = { a: 1 };
    const obj2 = { a: 1 };
    test.isFalse(ReactiveVarAsync._isEqual(obj1, obj2), 'Objects should not be equal even with same content');
    test.isFalse(ReactiveVarAsync._isEqual(obj1, obj1), 'Same object reference should not be equal (not primitive)');

    // Test _isEqual with arrays (should return false even for identical arrays)
    const arr1 = [1, 2, 3];
    const arr2 = [1, 2, 3];
    test.isFalse(ReactiveVarAsync._isEqual(arr1, arr2), 'Arrays should not be equal even with same content');
    test.isFalse(ReactiveVarAsync._isEqual(arr1, arr1), 'Same array reference should not be equal (not primitive)');
  }
);

Tinytest.addAsync(
  'server-autorun - ReactiveVarAsync - custom equals function',
  async function (test) {
    // Custom equals function that compares objects by their 'id' property
    const customEquals = (a, b) => a && b && a.id === b.id;

    // Create reactive var with custom equals function
    const reactiveVar = new ReactiveVarAsync({ id: 1, value: 'a' }, customEquals);

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
    test.equal(runCount, 1, 'Computation should not rerun when setting object with same id');

    // Set a new object with different id (should cause a rerun)
    reactiveVar.set({ id: 2, value: 'c' });

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check state after set
    test.equal(runCount, 2, 'Computation should rerun when setting object with different id');
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
    test.equal(reactiveVar.toString(), 'ReactiveVarAsync{test value}', 'toString should format correctly');

    // Test _numListeners
    test.equal(reactiveVar._numListeners(), 0, 'Should have no listeners initially');

    // Add a listener
    const computation = AsyncTracker.autorun(async () => {
      reactiveVar.get();
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check listener count
    test.equal(reactiveVar._numListeners(), 1, 'Should have one listener after computation runs');

    // Stop the computation
    computation.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Check listener count after stopping
    test.equal(reactiveVar._numListeners(), 0, 'Should have no listeners after computation stops');
  }
);
