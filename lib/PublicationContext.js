import { AsyncLocalStorage } from 'async_hooks';
import { AsyncTracker } from './ReactiveAsync/AsyncTracker';

export const publishContextStore = new AsyncLocalStorage();

// The library owns dependency and partition observers. Their callbacks manage
// their own lifetime and must not borrow a user's publication or computation.
export function observeUntracked(start) {
  return AsyncTracker.runWith(null, () =>
    publishContextStore.run(undefined, start)
  );
}
