import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareClocks,
  createVersion,
  mergeClocks,
  mergeVersions,
  validateVersion,
} from '../src/version.js';

function version(operationId, writerId, context, value) {
  return createVersion({ operationId, writerId, context, value });
}

test('vector clocks distinguish ancestor, descendant, equal, and concurrent', () => {
  assert.equal(compareClocks({ a: 1 }, { a: 2 }), 'ancestor');
  assert.equal(compareClocks({ a: 2 }, { a: 1 }), 'descendant');
  assert.equal(compareClocks({ a: 1 }, { a: 1 }), 'equal');
  assert.equal(compareClocks({ a: 2 }, { a: 1, b: 1 }), 'concurrent');
});

test('a child replaces its ancestor while concurrent siblings survive', () => {
  const base = version('op-base', 'a', {}, { cart: ['book'] });
  const left = version('op-left', 'a', base.clock, { cart: ['book', 'pen'] });
  const right = version('op-right', 'b', base.clock, { cart: ['book', 'cup'] });
  const leaves = mergeVersions([base, left, right]);
  assert.deepEqual(new Set(leaves.map((entry) => entry.id)), new Set([left.id, right.id]));
  const resolved = version('op-resolve', 'a', mergeClocks(leaves.map((entry) => entry.clock)), {
    cart: ['book', 'cup', 'pen'],
  });
  assert.deepEqual(mergeVersions([...leaves, resolved]).map((entry) => entry.id), [resolved.id]);
});

test('equal clocks with different event identities are preserved conservatively', () => {
  const left = version('op-left', 'a', {}, 'left');
  const right = version('op-right', 'a', {}, 'right');
  assert.equal(compareClocks(left.clock, right.clock), 'equal');
  assert.equal(mergeVersions([left, right]).length, 2);
});

test('operation identity cannot be reused for different content', () => {
  const left = version('same-operation', 'a', {}, 'left');
  const right = version('same-operation', 'a', {}, 'right');
  assert.throws(() => mergeVersions([left, right]), /reused with different content/);
});

test('version validation detects content and identity tampering', () => {
  const valid = version('op-valid', 'a', {}, { ok: true });
  assert.equal(validateVersion(valid).id, valid.id);
  assert.throws(() => validateVersion({ ...valid, value: { ok: false } }), /identity/);
  assert.throws(() => validateVersion({ ...valid, tombstone: 'false' }), /boolean/);
});
