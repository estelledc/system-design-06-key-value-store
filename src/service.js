import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { QuorumCluster } from './cluster.js';
import { FaultNetwork } from './network.js';
import { RendezvousPlacement } from './placement.js';
import { ReplicaStore } from './replica-store.js';
import { validateId } from './version.js';

export async function openService({
  dataDirectory,
  nodeIds = ['node-a', 'node-b', 'node-c'],
  coordinatorId = 'coordinator-a',
  replicaCount = 3,
  readQuorum = 2,
  writeQuorum = 2,
  network = new FaultNetwork(),
} = {}) {
  if (typeof dataDirectory !== 'string' || dataDirectory.length === 0) {
    throw new TypeError('dataDirectory is required');
  }
  await mkdir(dataDirectory, { recursive: true });
  const stores = new Map();
  for (const nodeId of nodeIds) {
    validateId(nodeId, 'nodeId');
    stores.set(nodeId, await ReplicaStore.open({
      id: nodeId,
      directory: join(dataDirectory, nodeId),
    }));
  }
  const placement = new RendezvousPlacement(nodeIds);
  const cluster = new QuorumCluster({
    coordinatorId,
    stores,
    placement,
    network,
    replicaCount,
    readQuorum,
    writeQuorum,
  });
  return { cluster, network, placement, stores };
}
