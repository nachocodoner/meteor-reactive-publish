import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './AsyncTracker.js';
import { ReactiveVarAsync } from './ReactiveVarAsync.js';

// Tests for AsyncTrackerDependency
Tinytest.addAsync(
  'AsyncTracker - AsyncTrackerDependency - depend, changed, hasDependents',
  async function (test) {
    const dep = new AsyncTracker.Dependency();

    // Initially should have no dependents
    test.isFalse(
      dep.hasDependents(),
      'Dependency should start with no dependents'
    );

    // Create a computation that depends on this dependency
    let dependencyChanged = false;
    const computation = AsyncTracker.autorun(async () => {
      dep.depend();
      dependencyChanged = true;
    });

    // Wait for the computation to run
    await Meteor._sleepForMs(50);

    // Should now have dependents
    test.isTrue(
      dep.hasDependents(),
      'Dependency should have dependents after depend() is called'
    );

    // Reset the flag
    dependencyChanged = false;

    // Trigger the dependency to change
    dep.changed();

    // Wait for the computation to rerun
    await Meteor._sleepForMs(50);

    // The computation should have rerun
    test.isTrue(
      dependencyChanged,
      'Computation should rerun when dependency is changed'
    );

    // Stop the computation
    computation.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Should no longer have dependents
    test.isFalse(
      dep.hasDependents(),
      'Dependency should not have dependents after computation is stopped'
    );
  }
);

// Test for changedSync method
Tinytest.addAsync(
  'AsyncTracker - AsyncTrackerDependency - changedSync',
  async function (test) {
    const dep = new AsyncTracker.Dependency();

    // Create a computation that depends on this dependency
    let dependencyChanged = false;
    const computation = AsyncTracker.autorun(async () => {
      dep.depend();
      dependencyChanged = true;
    });

    // Wait for the computation to run
    await Meteor._sleepForMs(50);

    // Reset the flag
    dependencyChanged = false;

    // Trigger the dependency to change synchronously
    dep.changedSync();

    // Wait for the deferred execution to complete
    await Meteor._sleepForMs(100);

    // The computation should have rerun
    test.isTrue(
      dependencyChanged,
      'Computation should rerun when dependency is changed synchronously'
    );

    // Clean up
    computation.stop();
  }
);

// Tests for AsyncTracker
Tinytest.addAsync(
  'AsyncTracker - autorun, invalidate, stop',
  async function (test) {
    let runCount = 0;
    let invalidateCallbackCalled = false;
    let stopCallbackCalled = false;

    // Create a computation
    const computation = AsyncTracker.autorun(async (comp) => {
      runCount++;
      test.isTrue(
        comp.firstRun === (runCount === 1),
        'firstRun should be true only on first run'
      );
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
    test.isFalse(
      invalidateCallbackCalled,
      'Invalidate callback should not be called initially'
    );
    test.isFalse(
      stopCallbackCalled,
      'Stop callback should not be called initially'
    );

    // Invalidate the computation
    computation.invalidate();
    await computation.flush();

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check state after invalidation
    test.equal(runCount, 2, 'Computation should run again after invalidation');
    test.isTrue(
      invalidateCallbackCalled,
      'Invalidate callback should be called'
    );
    test.isFalse(stopCallbackCalled, 'Stop callback should not be called yet');

    // Stop the computation
    computation.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Check state after stopping
    test.isTrue(
      stopCallbackCalled,
      'Stop callback should be called after stopping'
    );

    // Invalidate again (should not cause a rerun)
    invalidateCallbackCalled = false;
    computation.invalidate();
    await computation.flush();

    // Wait to ensure no rerun happens
    await Meteor._sleepForMs(50);

    // Check that no rerun occurred
    test.equal(runCount, 2, 'Computation should not rerun after being stopped');
    test.isFalse(
      invalidateCallbackCalled,
      'Invalidate callback should not be called after stopping'
    );
  }
);

// Tests for AsyncTracker.nonreactive
Tinytest.addAsync(
  'AsyncTracker - AsyncTracker.nonreactive',
  async function (test) {
    const dep = new AsyncTracker.Dependency();
    let nonreactiveRan = false;
    let outerRunCount = 0;
    let innerRunCount = 0;

    // Outer computation
    const outer = AsyncTracker.autorun(async () => {
      outerRunCount++;
      dep.depend();

      // run without tracking
      await AsyncTracker.nonreactive(async () => {
        nonreactiveRan = true;
        innerRunCount++;
        // should *not* re-trigger the outer dep
        dep.depend();
      });
    });

    // initial pass
    await Meteor._sleepForMs(50);
    test.equal(outerRunCount, 1);
    test.equal(innerRunCount, 1);
    test.isTrue(nonreactiveRan);

    nonreactiveRan = false;
    // flip the dep; should auto‐run outer (and inner via await nonreactive)
    dep.changed();

    await Meteor._sleepForMs(50);
    test.equal(outerRunCount, 2);
    test.equal(innerRunCount, 2);
    test.isTrue(nonreactiveRan);

    outer.stop();
  }
);

// Tests for AsyncTracker - beforeRun and afterRun
Tinytest.addAsync(
  'AsyncTracker - beforeRun and afterRun',
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
    test.equal(
      beforeRunCount,
      0,
      'beforeRun should not be called for initial run'
    );
    test.equal(afterRunCount, 1, 'afterRun should be called after initial run');

    // Invalidate the computation
    computation.invalidate();
    await computation.flush();

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
    test.equal(
      beforeRunCount,
      2,
      'beforeRun should be called before manual run'
    );
    test.equal(afterRunCount, 3, 'afterRun should be called after manual run');

    // Clean up
    computation.stop();
  }
);

// Tests for AsyncTracker - flush
Tinytest.addAsync('AsyncTracker - flush', async function (test) {
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
  test.equal(
    runCount,
    1,
    'Computation should not rerun after flush if not invalidated'
  );

  // Invalidate but don't let it rerun automatically
  computation.invalidated = true;

  // Flush the computation (should cause a rerun now)
  await computation.flush();

  // Wait for rerun
  await Meteor._sleepForMs(50);

  // Check that a rerun occurred
  test.equal(
    runCount,
    2,
    'Computation should rerun after flush if invalidated'
  );

  // Clean up
  computation.stop();
});

// Tests for nested autoruns
Tinytest.addAsync('AsyncTracker - nested autoruns', async function (test) {
  // Create reactive variables to trigger reruns
  const outerVar = new ReactiveVarAsync('outer');
  const innerVar = new ReactiveVarAsync('inner');

  // Track run counts
  let outerRunCount = 0;
  let innerRunCount = 0;
  let innerComputationCount = 0;

  // Reference to the current inner computation
  let currentInnerComputation = null;

  // Create outer computation
  const outerComputation = AsyncTracker.autorun(async () => {
    outerRunCount++;
    outerVar.get(); // depend on outerVar

    // Create nested computation
    currentInnerComputation = AsyncTracker.autorun(async () => {
      innerRunCount++;
      innerVar.get(); // depend on innerVar
    });
    innerComputationCount++; // Increment when a new inner computation is created
  });

  // Wait for initial runs
  await Meteor._sleepForMs(50);

  // Check initial state
  test.equal(outerRunCount, 1, 'Outer computation should run once initially');
  test.equal(innerRunCount, 1, 'Inner computation should run once initially');
  test.equal(
    innerComputationCount,
    1,
    'Should have created one inner computation'
  );

  // Change inner reactive variable
  await innerVar.set('inner updated');

  // Wait for reruns
  await Meteor._sleepForMs(50);

  // Check state after inner change
  test.equal(
    outerRunCount,
    1,
    'Outer computation should not rerun when inner var changes'
  );
  test.equal(
    innerRunCount,
    2,
    'Inner computation should rerun when inner var changes'
  );
  test.equal(
    innerComputationCount,
    1,
    'Should still have the same inner computation'
  );

  // Change outer reactive variable
  await outerVar.set('outer updated');

  // Wait for reruns
  await Meteor._sleepForMs(50);

  // Check state after outer change
  test.equal(
    outerRunCount,
    2,
    'Outer computation should rerun when outer var changes'
  );
  test.equal(
    innerRunCount,
    3,
    'Inner computation should run again after outer rerun'
  );
  test.equal(
    innerComputationCount,
    2,
    'Should have created a new inner computation'
  );

  // Change inner reactive variable again
  await innerVar.set('inner updated again');

  // Wait for reruns
  await Meteor._sleepForMs(50);

  // Check state after second inner change
  test.equal(
    outerRunCount,
    2,
    'Outer computation should not rerun when inner var changes again'
  );
  test.equal(
    innerRunCount,
    4,
    'Inner computation should rerun when inner var changes again'
  );
  test.equal(
    innerComputationCount,
    2,
    'Should still have the same second inner computation'
  );

  // Re-run outer again and check the counts
  await outerVar.set('outer updated second time');

  // Wait for reruns
  await Meteor._sleepForMs(50);

  // Check state after second outer change
  test.equal(
    outerRunCount,
    3,
    'Outer computation should rerun when outer var changes again'
  );
  test.equal(
    innerRunCount,
    5,
    'Inner computation should run again after second outer rerun'
  );
  test.equal(
    innerComputationCount,
    3,
    'Should have created a third inner computation'
  );

  // Clean up
  outerComputation.stop();
  if (currentInnerComputation) {
    currentInnerComputation.stop();
  }
});

// Tests for stopped computation not rerunning after invalidate and flush
Tinytest.addAsync(
  'AsyncTracker - stopped computation does not rerun after invalidate and flush',
  async function (test) {
    let runCount = 0;
    let invalidateCallbackCalled = false;

    // Create a reactive variable to trigger reruns
    const reactiveVar = new ReactiveVarAsync('initial value');

    // Create a computation
    const computation = AsyncTracker.autorun(async () => {
      runCount++;
      reactiveVar.get(); // depend on reactiveVar
    });

    // Set up invalidate callback
    computation.onInvalidate(() => {
      invalidateCallbackCalled = true;
    });

    // Wait for initial run
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(runCount, 1, 'Computation should run once initially');
    test.isFalse(
      invalidateCallbackCalled,
      'Invalidate callback should not be called initially'
    );

    // Change reactive variable to trigger a rerun
    invalidateCallbackCalled = false;
    await reactiveVar.set('updated value');

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Check state after change
    test.equal(
      runCount,
      2,
      'Computation should rerun after reactive variable change'
    );
    test.isTrue(
      invalidateCallbackCalled,
      'Invalidate callback should be called after change'
    );

    // Stop the computation
    computation.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Reset flag and change reactive variable again
    invalidateCallbackCalled = false;
    await reactiveVar.set('another update');

    // Wait to ensure no rerun happens
    await Meteor._sleepForMs(50);

    // Check that no rerun occurred
    test.equal(runCount, 2, 'Computation should not rerun after being stopped');
    test.isFalse(
      invalidateCallbackCalled,
      'Invalidate callback should not be called after stopping'
    );

    // Explicitly invalidate and flush the computation
    computation.invalidate();
    await computation.flush();

    // Wait to ensure no rerun happens
    await Meteor._sleepForMs(50);

    // Check that no rerun occurred even after explicit invalidate and flush
    test.equal(
      runCount,
      2,
      'Computation should not rerun after being stopped, even with explicit invalidate and flush'
    );
    test.isFalse(
      invalidateCallbackCalled,
      'Invalidate callback should not be called after stopping, even with explicit invalidate'
    );
  }
);

// Test for error handling in computation
Tinytest.addAsync(
  'AsyncTracker - error handling in computation',
  async function (test) {
    let errorHandled = false;
    let errorMessage = null;

    // Create a computation that throws an error
    const computation = AsyncTracker.autorun(
      async () => {
        throw new Error('Test error');
      },
      {
        onError: (msg, err) => {
          errorHandled = true;
          errorMessage = err.message;
        },
      }
    );

    // Wait for the computation to run
    await Meteor._sleepForMs(50);

    // Check that the error was handled
    test.isTrue(errorHandled, 'Error should be handled by onError callback');
    test.equal(
      errorMessage,
      'Test error',
      'Error message should be passed to callback'
    );

    // Clean up
    computation.stop();
  }
);

// Test for validation in AsyncTracker.autorun
Tinytest.add('AsyncTracker - autorun validation', function (test) {
  // Test that autorun throws an error when passed a non-function
  test.throws(() => {
    AsyncTracker.autorun('not a function');
  }, /AsyncTracker.autorun requires a function argument/);

  // Test that autorun accepts a function
  let noErrorThrown = true;
  try {
    const comp = AsyncTracker.autorun(async () => {});
    comp.stop(); // Clean up
  } catch (e) {
    noErrorThrown = false;
  }
  test.isTrue(
    noErrorThrown,
    'AsyncTracker.autorun should not throw when passed a function'
  );
});

// Test for parent-child relationship between computations
Tinytest.addAsync(
  'AsyncTracker - parent-child relationship',
  async function (test) {
    let parentRunCount = 0;
    let childRunCount = 0;
    let childStopCallbackCalled = false;

    // Create parent computation
    const parentComputation = AsyncTracker.autorun(async () => {
      parentRunCount++;

      // Create child computation
      const childComputation = AsyncTracker.autorun(async () => {
        childRunCount++;
      });

      // Set up stop callback for child
      childComputation.onStop(() => {
        childStopCallbackCalled = true;
      });
    });

    // Wait for initial runs
    await Meteor._sleepForMs(50);

    // Check initial state
    test.equal(
      parentRunCount,
      1,
      'Parent computation should run once initially'
    );
    test.equal(childRunCount, 1, 'Child computation should run once initially');
    test.isFalse(
      childStopCallbackCalled,
      'Child stop callback should not be called initially'
    );

    // Invalidate parent computation
    parentComputation.invalidate();
    await parentComputation.flush();

    // Wait for reruns
    await Meteor._sleepForMs(50);

    // Check state after parent invalidation
    test.equal(
      parentRunCount,
      2,
      'Parent computation should rerun after invalidation'
    );
    test.equal(
      childRunCount,
      2,
      'A new child computation should be created and run'
    );
    test.isTrue(
      childStopCallbackCalled,
      'Previous child computation should be stopped'
    );

    // Clean up
    parentComputation.stop();
  }
);

// Test for edge cases in dependency tracking
Tinytest.addAsync(
  'AsyncTracker - dependency tracking edge cases',
  async function (test) {
    const dep = new AsyncTracker.Dependency();

    // Test depend() outside of a computation
    const dependResult = await AsyncTracker.nonreactive(() => {
      return dep.depend();
    });

    test.isFalse(
      dependResult,
      'depend() should return false when called outside a computation'
    );

    // Test hasDependents() with multiple dependents
    let computation1Count = 0;
    let computation2Count = 0;

    const computation1 = AsyncTracker.autorun(async () => {
      dep.depend();
      computation1Count++;
    });

    // Wait for first computation to run
    await Meteor._sleepForMs(50);

    const computation2 = AsyncTracker.autorun(async () => {
      dep.depend();
      computation2Count++;
    });

    // Wait for second computation to run
    await Meteor._sleepForMs(50);

    test.isTrue(dep.hasDependents(), 'Dependency should have dependents');

    // Trigger the dependency to change
    await dep.changed();

    // Wait for computations to rerun
    await Meteor._sleepForMs(50);

    // Both computations should have rerun
    test.equal(computation1Count, 2, 'First computation should have rerun');
    test.equal(computation2Count, 2, 'Second computation should have rerun');

    // Stop one computation
    computation1.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Dependency should still have dependents
    test.isTrue(
      dep.hasDependents(),
      'Dependency should still have dependents after one computation stops'
    );

    // Stop the other computation
    computation2.stop();

    // Wait for cleanup
    await Meteor._sleepForMs(50);

    // Dependency should no longer have dependents
    test.isFalse(
      dep.hasDependents(),
      'Dependency should not have dependents after all computations stop'
    );
  }
);

// Test for beforeRun and afterRun with errors
Tinytest.addAsync(
  'AsyncTracker - beforeRun and afterRun with errors',
  async function (test) {
    let runCount = 0;
    let beforeRunErrorCaught = false;
    let afterRunErrorCaught = false;

    // Create a computation
    const computation = AsyncTracker.autorun(async () => {
      runCount++;
    });

    // Set up beforeRun callback that throws an error
    computation.beforeRun(() => {
      throw new Error('beforeRun error');
    });

    // Set up afterRun callback that throws an error
    computation.afterRun(() => {
      throw new Error('afterRun error');
    });

    // Capture console.error calls
    const originalConsoleError = console.error;
    console.error = (msg) => {
      if (msg instanceof Error) {
        if (msg.message === 'beforeRun error') beforeRunErrorCaught = true;
        if (msg.message === 'afterRun error') afterRunErrorCaught = true;
      }
    };

    // Invalidate the computation
    computation.invalidate();
    await computation.flush();

    // Wait for rerun
    await Meteor._sleepForMs(50);

    // Restore console.error
    console.error = originalConsoleError;

    // Check that errors were caught
    test.isTrue(
      beforeRunErrorCaught,
      'Error in beforeRun callback should be caught'
    );
    test.isTrue(
      afterRunErrorCaught,
      'Error in afterRun callback should be caught'
    );

    // Check that the computation still ran despite the errors
    test.equal(
      runCount,
      2,
      'Computation should still run despite errors in callbacks'
    );

    // Clean up
    computation.stop();
  }
);
