import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { QuorumCluster } from '../src/cluster.js';
import { QuorumUnavailableError } from '../src/errors.js';
import { FaultNetwork } from '../src/network.js';
import { ReplicaStore } from '../src/replica-store.js';
import { openService } from '../src/service.js';
import { mergeClocks } from '../src/version.js';

async function directory(label) {
  return mkdtemp(join(tmpdir(), `quorum-kv-${label}-`));
}

async function service(options = {}) {
  return openService({ dataDirectory: await directory('cluster'), ...options });
}

test('completed quorum write is readable with its causal context', async () => {
  const { cluster } = await service();
  const write = await cluster.put({ key: 'cart', value: ['book'], operationId: 'op-create' });
  assert.equal(write.receipt.acknowledged, 3);
  const read = await cluster.get('cart');
  assert.deepEqual(read.versions[0].value, ['book']);
  assert.deepEqual(read.context, write.context);
});

test('failed write reports partial durability and an identical retry is idempotent', async () => {
  const network = new FaultNetwork();
  const { cluster, placement, stores } = await service({ network });
  const owners = placement.preferenceList('cart', 3);
  network.block('coordinator-a', owners[1]);
  network.block('coordinator-a', owners[2]);
  await assert.rejects(
    cluster.put({ key: 'cart', value: ['book'], operationId: 'op-partial' }),
    (error) => {
      assert.ok(error instanceof QuorumUnavailableError);
      assert.equal(error.receipt.acknowledged, 1);
      assert.equal(error.receipt.partial, true);
      return true;
    },
  );
  network.heal();
  const retried = await cluster.put({ key: 'cart', value: ['book'], operationId: 'op-partial' });
  assert.equal(retried.receipt.acknowledged, 3);
  for (const nodeId of owners) assert.equal(stores.get(nodeId).stats().operations, 1);
});

test('read quorum failure does not fabricate a value', async () => {
  const network = new FaultNetwork();
  const { cluster, placement } = await service({ network });
  const owners = placement.preferenceList('cart', 3);
  network.block('coordinator-a', owners[1]);
  network.block('coordinator-a', owners[2]);
  await assert.rejects(cluster.get('cart'), QuorumUnavailableError);
});

test('read repair converges a replica that missed an acknowledged write', async () => {
  const network = new FaultNetwork();
  const { cluster, placement, stores } = await service({ network });
  const owners = placement.preferenceList('cart', 3);
  network.block('coordinator-a', owners[2]);
  const write = await cluster.put({ key: 'cart', value: ['book'], operationId: 'op-repair' });
  assert.equal(write.receipt.acknowledged, 2);
  assert.equal(stores.get(owners[2]).getVersions('cart').length, 0);
  network.heal();
  const read = await cluster.get('cart');
  assert.equal(read.receipt.repairApplied, 1);
  assert.equal(stores.get(owners[2]).getVersions('cart')[0].id, write.version.id);
});

test('concurrent causal branches survive and a client merge resolves them', async () => {
  const shared = await service();
  const clusterA = shared.cluster;
  const clusterB = new QuorumCluster({
    coordinatorId: 'coordinator-b',
    stores: shared.stores,
    placement: shared.placement,
    network: shared.network,
  });
  const base = await clusterA.put({ key: 'cart', value: ['book'], operationId: 'op-base' });
  const [left, right] = await Promise.all([
    clusterA.put({ key: 'cart', value: ['book', 'pen'], context: base.context, operationId: 'op-left' }),
    clusterB.put({ key: 'cart', value: ['book', 'cup'], context: base.context, operationId: 'op-right' }),
  ]);
  const conflict = await clusterA.get('cart');
  assert.deepEqual(
    new Set(conflict.versions.map((version) => version.id)),
    new Set([left.version.id, right.version.id]),
  );
  const resolved = await clusterA.put({
    key: 'cart',
    value: ['book', 'cup', 'pen'],
    context: mergeClocks(conflict.versions.map((version) => version.clock)),
    operationId: 'op-resolved',
  });
  const finalRead = await clusterB.get('cart');
  assert.deepEqual(finalRead.versions.map((version) => version.id), [resolved.version.id]);
});

test('tombstone is causal state, not an immediate physical deletion', async () => {
  const { cluster, stores } = await service();
  const created = await cluster.put({ key: 'cart', value: ['book'], operationId: 'op-create' });
  const deleted = await cluster.delete({ key: 'cart', context: created.context, operationId: 'op-delete' });
  const read = await cluster.get('cart');
  assert.equal(read.versions.length, 1);
  assert.equal(read.versions[0].tombstone, true);
  assert.equal(read.versions[0].id, deleted.version.id);
  for (const store of stores.values()) assert.equal(store.stats().keys, 1);
});

test('numeric quorum overlap is insufficient when coordinators disagree on replica membership', async () => {
  const root = await directory('drift');
  const stores = new Map();
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    stores.set(id, await ReplicaStore.open({ id, directory: join(root, id) }));
  }
  const fixedPlacement = (preference, fingerprint) => ({
    nodes: () => [...stores.keys()],
    fingerprint: () => fingerprint,
    preferenceList: (_key, count) => preference.slice(0, count),
  });
  const networkA = new FaultNetwork();
  const networkB = new FaultNetwork();
  networkA.block('writer-a', 'c');
  networkB.block('reader-b', 'c');
  const writer = new QuorumCluster({
    coordinatorId: 'writer-a', stores, network: networkA,
    placement: fixedPlacement(['a', 'b', 'c', 'd', 'e'], 'config-a'),
  });
  const reader = new QuorumCluster({
    coordinatorId: 'reader-b', stores, network: networkB,
    placement: fixedPlacement(['c', 'd', 'e', 'a', 'b'], 'config-b'),
  });
  assert.equal(writer.config().overlap, true);
  assert.equal(reader.config().overlap, true);
  await writer.put({ key: 'key', value: 'new', operationId: 'op-drift' });
  const stale = await reader.get('key');
  assert.equal(stale.versions.length, 0);
  assert.notEqual(writer.config().placementFingerprint, reader.config().placementFingerprint);
});
