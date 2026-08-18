import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalStringify, validateValue } from '../src/canonical.js';

test('canonical JSON ignores object insertion order', () => {
  assert.equal(
    canonicalStringify({ z: 1, a: { y: 2, x: 3 } }),
    canonicalStringify({ a: { x: 3, y: 2 }, z: 1 }),
  );
});

test('JSON value validation rejects unsafe, deep, non-finite, and oversized values', () => {
  assert.throws(() => validateValue({ constructor: 'x' }), /unsafe object key/);
  assert.throws(() => validateValue(Number.POSITIVE_INFINITY), /finite/);
  let deep = null;
  for (let index = 0; index < 18; index += 1) deep = [deep];
  assert.throws(() => validateValue(deep), /16 levels/);
  assert.throws(() => validateValue('x'.repeat(11 * 1024)), /10240/);
});
