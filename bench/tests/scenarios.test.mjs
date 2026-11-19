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

test('parent membership operations add and remove one parent with all its children', () => {
  const model = fixture({ parents: 200, children: 2 });
  const initial = expectedState('one-to-many', model);
  assert.equal(initial.bench_posts.length, 100);
  for (let i = 0; i < 6; i++) {
    applyOperation(
      model,
      operationFor('one-to-many', i, model, 'membership-only')
    );
    const result = expectedState('one-to-many', model);
    const added = i % 2 === 0;
    assert.equal(result.bench_posts.length, 100 + Number(added));
    assert.equal(result.bench_comments.length, 200 + (added ? 2 : 0));
    assert.deepEqual(
      result.bench_comments.filter((c) => c.postId !== 'post-1'),
      initial.bench_comments
    );
    assert.equal(
      result.bench_posts.some((p) => p._id === 'post-1'),
      added
    );
  }
});

test('membership-only dependent posts preserve the selected hundred IDs', () => {
  const model = fixture({ parents: 200, children: 1 });
  const initial = expectedState('dependent-posts', model).bench_posts;
  for (let i = 0; i < 6; i++) {
    applyOperation(
      model,
      operationFor('dependent-posts', i, model, 'membership-only')
    );
    const docs = expectedState('dependent-posts', model).bench_posts;
    assert.deepEqual(
      docs.filter((p) => p._id !== 'post-1'),
      initial
    );
    assert.equal(docs.length, 100 + Number(i % 2 === 0));
  }
});

test('filtered comments skip duplicate filter and parent edits, then deliver the new selection and child update', () => {
  const model = fixture({ parents: 4, children: 1 });
  const context = {};
  const state = () => expectedState('filtered-comments', model, context);
  const apply = (index) => {
    const operation = operationFor('filtered-comments', index, model);
    if (operation.kind === 'external') context.external = operation.value;
    applyOperation(model, operation);
    return operation;
  };

  for (let cycle = 0; cycle < 2; cycle++) {
    const offset = cycle * 4;
    const before = state();
    const active = cycle === 0;
    const previousFilter = context.external || { active };
    const duplicate = apply(offset);
    assert.deepEqual(duplicate.value, previousFilter);
    assert.notEqual(duplicate.value, previousFilter);
    assert.deepEqual(state(), before);

    const edit = apply(offset + 1);
    assert.equal(edit.id, active ? 'post-0' : 'post-1');
    assert.deepEqual(state(), before);

    apply(offset + 2);
    const after = state();
    assert.deepEqual(Object.keys(after), ['bench_comments']);
    assert.deepEqual(
      after.bench_comments.map((doc) => doc._id),
      active ? ['comment-1-0', 'comment-3-0'] : ['comment-0-0', 'comment-2-0']
    );
    const childEdit = apply(offset + 3);
    assert.equal(childEdit.id, after.bench_comments[0]._id);
    assert.deepEqual(state().bench_comments, [
      { ...after.bench_comments[0], ...childEdit.set },
      after.bench_comments[1],
    ]);
  }
});

test('every workload generates a valid operation sequence across warmup boundaries', () => {
  for (const name of Object.keys(scenarios)) {
    if (name === 'subscription-churn') continue;
    const model = fixture(resolveProfile('smoke'));
    for (let i = 0; i < 50; i++)
      applyOperation(model, operationFor(name, i, model));
  }
});
