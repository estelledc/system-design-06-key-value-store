import assert from 'node:assert/strict';
import test from 'node:test';

import { RendezvousPlacement } from '../src/placement.js';

test('preference lists are deterministic, distinct, and input-order independent', () => {
  const left = new RendezvousPlacement(['node-c', 'node-a', 'node-b']);
  const right = new RendezvousPlacement(['node-b', 'node-c', 'node-a']);
  assert.equal(left.fingerprint(), right.fingerprint());
  for (let index = 0; index < 1000; index += 1) {
    const leftList = left.preferenceList(`key-${index}`, 3);
    assert.deepEqual(leftList, right.preferenceList(`key-${index}`, 3));
    assert.equal(new Set(leftList).size, 3);
  }
});

test('adding a rendezvous node only moves sampled primaries to that node', () => {
  const before = new RendezvousPlacement(['a', 'b', 'c', 'd']);
  const after = new RendezvousPlacement(['a', 'b', 'c', 'd', 'e']);
  let moved = 0;
  for (let index = 0; index < 50_000; index += 1) {
    const key = `sample-${index}`;
    const source = before.preferenceList(key, 1)[0];
    const destination = after.preferenceList(key, 1)[0];
    if (source === destination) continue;
    moved += 1;
    assert.equal(destination, 'e');
  }
  assert.ok(moved > 0);
});

test('placement rejects duplicates and invalid preference sizes', () => {
  assert.throws(() => new RendezvousPlacement(['a', 'a']), /unique/);
  const placement = new RendezvousPlacement(['a', 'b']);
  assert.throws(() => placement.preferenceList('key', 3), /between 1 and 2/);
});
