import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, applyOperation } from '../fixtures/model.mjs';
import {
  scenarios,
  expectedState,
  expectedData,
  operationFor,
  validateScenario,
} from '../scenarios/index.mjs';
import { resolveProfile } from '../config/profiles.mjs';

test('seed controls fixtures and invalid workload dimensions fail early', () => {
  const profile = resolveProfile('smoke');
  assert.deepEqual(fixture(profile, 42), fixture(profile, 42));
  assert.notDeepEqual(fixture(profile, 42), fixture(profile, 43));
  assert.throws(() => resolveProfile('smoke', { clients: 'NaN' }));
  assert.throws(
    () => validateScenario('dependent-posts', 'native'),
    /does not support/
  );
});

test('dependent oracle excludes unreferenced documents and hidden fields', () => {
  const model = fixture(resolveProfile('smoke'));
  const result = expectedState('dependent-posts', model);
  assert.deepEqual(
    result.bench_posts.map((p) => p._id),
    ['post-0', 'post-2']
  );
  assert.ok(!('noise' in result.bench_users[0]));
  applyOperation(model, {
    kind: 'update',
    collection: 'bench_users',
    id: 'user-0',
    set: { postIds: ['post-1'] },
  });
  assert.deepEqual(
    expectedState('dependent-posts', model).bench_posts.map((p) => p._id),
    ['post-1']
  );
});

test('personalized selectors retain separate client oracles and shared field clearing', () => {
  const model = fixture(resolveProfile('standard'));
  const state = (clientIndex) =>
    expectedState('personalized-selectors', model, { clientIndex });
  const initial = [0, 1, 2].map(state);
  assert.notDeepEqual(initial[0], initial[1]);
  assert.notDeepEqual(initial[1], initial[2]);
  assert.deepEqual(initial[0], state(3));
  for (let index = 0; index < 12; index++) {
    const before = [0, 1, 2].map(state);
    applyOperation(model, operationFor('personalized-selectors', index, model));
    for (let clientIndex = 0; clientIndex < 3; clientIndex++) {
      const after = state(clientIndex);
      assert.notDeepEqual(
        after,
        before[clientIndex],
        'Every addressed client must change'
      );
      const shared = after.bench_posts.find((post) => post._id === 'post-0');
      assert.equal(shared.revision, index + 1);
      assert.equal(Object.hasOwn(shared, 'optional'), !!(index % 2));
      assert.ok(
        after.bench_posts.every(
          (post) =>
            post._id === 'post-0' || post.authorId === `author-${clientIndex}`
        )
      );
      assert.ok(after.bench_posts.every((post) => !('noise' in post)));
    }
  }
});

test('shared children remain while referenced and aggregates react to grouping-field updates', () => {
  const model = fixture(resolveProfile('smoke'));
  const before = expectedData('derived-aggregate', model);
  applyOperation(model, operationFor('derived-aggregate', 0, model));
  assert.notDeepEqual(expectedData('derived-aggregate', model), before);
  model.bench_posts.forEach((post) => {
    post.authorId = 'author-0';
  });
  assert.equal(expectedState('shared-children', model).bench_authors.length, 1);
  model.bench_posts[0].active = false;
  assert.equal(expectedState('shared-children', model).bench_authors.length, 1);
});

test('every workload generates a valid operation sequence across warmup boundaries', () => {
  for (const name of Object.keys(scenarios)) {
    if (name === 'subscription-churn') continue;
    const model = fixture(resolveProfile('smoke'));
    for (let i = 0; i < 50; i++)
      applyOperation(model, operationFor(name, i, model));
  }
});
