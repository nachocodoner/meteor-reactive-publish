import { Tinytest } from 'meteor/tinytest';
import { AsyncTracker } from './ReactiveAsync/AsyncTracker';
import { extendPublish } from './ReactivePublishServer';

Tinytest.addAsync(
  'ReactivePublish lifecycle - stop during returned cursor setup releases late callbacks',
  async (test) => {
    let resume;
    const paused = new Promise((resolve) => {
      resume = resolve;
    });
    let computation;
    let firstStops = 0;
    let secondStarts = 0;
    const first = {
      _getCollectionName: () => 'first',
      async _publishCursor(sub) {
        await paused;
        sub.onStop(() => {
          firstStops++;
        });
      },
    };
    const second = {
      _getCollectionName: () => 'second',
      _publishCursor() {
        secondStarts++;
      },
    };
    const subscription = {
      _documents: new Map(),
      _stopCallbacks: [],
      _isDeactivated: () => false,
      onStop(callback) {
        this._stopCallbacks.push(callback);
      },
      ready() {},
      added() {},
      async _publishHandlerResult(cursor) {
        await cursor._publishCursor(this);
        this.ready();
      },
    };
    const [, publish] = extendPublish('late-cursor-test', async function () {
      computation = await this.autorun(() => [first, second]);
    });
    try {
      await publish.call(subscription);
      computation.stop();
      resume();
      await AsyncTracker.drainReactions();
      test.equal(firstStops, 1, 'Late cursor cleanup must run exactly once');
      test.equal(
        secondStarts,
        0,
        'A stopped computation must not start another cursor'
      );
      test.equal(computation._publicationCursorStops.size, 0);
      test.equal(
        subscription._stopCallbacks.length,
        1,
        'Only subscription cleanup remains registered'
      );
    } finally {
      resume();
      computation?.stop();
      for (const callback of subscription._stopCallbacks) await callback();
    }
  }
);
