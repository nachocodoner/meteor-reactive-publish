import { Tinytest } from 'meteor/tinytest';
import { Tracker } from 'meteor/tracker';
import { ReactiveVar } from 'meteor/reactive-var';
import { ComputedField } from '/path/to/computed_field.js'; // Adjust path as needed

Tinytest.add('computed-field - basic', function (test) {
  const foo = new ComputedField(() => 42);

  test.equal(foo(), 42);
  test.instanceOf(foo, ComputedField);
  test.equal(foo.constructor, ComputedField);
  test.equal(typeof foo, 'function');

  test.equal(foo.apply(), 42);
  test.equal(foo.call(), 42);
  test.equal(`${foo}`, 'ComputedField{42}');
});

Tinytest.add('computed-field - reactive', function (test) {
  const internal = new ReactiveVar(42);

  const foo = new ComputedField(() => internal.get());

  const changes = [];
  const handle = Tracker.autorun(() => {
    changes.push(foo());
  });

  internal.set(43);
  Tracker.flush();

  internal.set(44);
  Tracker.flush();

  internal.set(44); // no change
  Tracker.flush();

  internal.set(43);
  Tracker.flush();

  test.equal(changes, [42, 43, 44, 43]);

  handle.stop();
});

Tinytest.add('computed-field - nested', function (test) {
  const internal = new ReactiveVar(42);
  let outside = null;

  const changes = [];
  const handle = Tracker.autorun(() => {
    outside = new ComputedField(() => internal.get());
    changes.push(outside());
  });

  internal.set(43);
  Tracker.flush();

  handle.stop();
  Tracker.flush();

  internal.set(44);
  Tracker.flush();
  internal.set(45);

  test.equal(outside(), 45);
  Tracker.flush();

  test.equal(changes, [42, 43]);

  outside.stop();
});

Tinytest.add('computed-field - dontStop', function (test) {
  const internal = new ReactiveVar(42);

  let run = [];
  let foo = new ComputedField(() => {
    const value = internal.get();
    run.push(value);
    return value;
  });

  foo();
  test.isTrue(foo._isRunning());

  Tracker.flush();
  test.isFalse(foo._isRunning());

  foo();
  test.isTrue(foo._isRunning());

  Tracker.flush();
  test.isFalse(foo._isRunning());

  foo();
  test.isTrue(foo._isRunning());

  test.equal(run, [42, 42, 42]);

  foo.stop();

  run = [];
  foo = new ComputedField(() => {
    const value = internal.get();
    run.push(value);
    return value;
  }, true); // keepRunning = true

  foo();
  test.isTrue(foo._isRunning());

  Tracker.flush();
  test.isTrue(foo._isRunning());

  foo();
  test.isTrue(foo._isRunning());

  Tracker.flush();
  test.isTrue(foo._isRunning());

  foo();
  test.isTrue(foo._isRunning());

  test.equal(run, [42]);

  foo.stop();
});
