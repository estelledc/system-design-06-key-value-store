import assert from 'node:assert/strict';
import test from 'node:test';

import { createVersion, mergeClocks, mergeVersions } from '../src/version.js';

function combinations(values, size, start = 0, prefix = []) {
  if (prefix.length === size) return [prefix];
  const output = [];
  for (let index = start; index < values.length; index += 1) {
    output.push(...combinations(values, size, index + 1, [...prefix, values[index]]));
  }
  return output;
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((tail) => [value, ...tail]));
}

test('every W=2 and R=2 subset intersects inside one fixed N=3 replica set', () => {
  const replicas = ['a', 'b', 'c'];
  const writes = combinations(replicas, 2);
  const reads = combinations(replicas, 2);
  for (const writeSet of writes) {
    for (const readSet of reads) {
      assert.ok(writeSet.some((nodeId) => readSet.includes(nodeId)));
    }
  }
});

test('causal leaf reduction is permutation-invariant and idempotent', () => {
  for (let seed = 0; seed < 25; seed += 1) {
    const base = createVersion({
      operationId: `base-${seed}`,
      writerId: 'writer-a',
      value: { seed },
    });
    const left = createVersion({
      operationId: `left-${seed}`,
      writerId: 'writer-a',
      context: base.clock,
      value: { branch: 'left', seed },
    });
    const right = createVersion({
      operationId: `right-${seed}`,
      writerId: 'writer-b',
      context: base.clock,
      value: { branch: 'right', seed },
    });
    const expected = mergeVersions([base, left, right]).map((version) => version.id);
    for (const order of permutations([base, left, right])) {
      assert.deepEqual(mergeVersions(order).map((version) => version.id), expected);
    }
    assert.deepEqual(mergeVersions([left, right, left, right]).map((version) => version.id), expected);

    const resolved = createVersion({
      operationId: `resolved-${seed}`,
      writerId: 'writer-c',
      context: mergeClocks([left.clock, right.clock]),
      value: { branch: 'merged', seed },
    });
    assert.deepEqual(
      mergeVersions([base, left, right, resolved]).map((version) => version.id),
      [resolved.id],
    );
  }
});
