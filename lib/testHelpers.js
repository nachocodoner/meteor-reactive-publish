import { Meteor } from 'meteor/meteor';

// Reactive observer callbacks can finish after a write's DDP acknowledgment.
// Wait for the state under test, keeping the exact assertions at the call site.
export async function waitFor(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => Meteor.setTimeout(resolve, 10));
  }
}
