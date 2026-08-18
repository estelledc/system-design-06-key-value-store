import { QuorumUnavailableError } from './errors.js';
import { FaultNetwork } from './network.js';
import { RendezvousPlacement } from './placement.js';
import {
  createVersion,
  mergeClocks,
  mergeVersions,
  publicVersion,
  validateId,
  validateKey,
} from './version.js';

function validateQuorum({ replicaCount, readQuorum, writeQuorum, physicalNodes }) {
  for (const [label, value] of Object.entries({ replicaCount, readQuorum, writeQuorum })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  }
  if (replicaCount > physicalNodes) throw new TypeError('replicaCount cannot exceed physical nodes');
  if (readQuorum > replicaCount || writeQuorum > replicaCount) {
    throw new TypeError('readQuorum and writeQuorum cannot exceed replicaCount');
  }
}

function sortedIds(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export class QuorumCluster {
  #coordinatorId;
  #stores;
  #placement;
  #network;
  #replicaCount;
  #readQuorum;
  #writeQuorum;

  constructor({
    coordinatorId,
    stores,
    placement = null,
    network = new FaultNetwork(),
    replicaCount = 3,
    readQuorum = 2,
    writeQuorum = 2,
  }) {
    validateId(coordinatorId, 'coordinatorId');
    if (!(stores instanceof Map) || stores.size === 0) throw new TypeError('stores must be a non-empty Map');
    for (const [nodeId, store] of stores) {
      validateId(nodeId, 'store nodeId');
      if (store?.id() !== nodeId) throw new TypeError(`store identity mismatch: ${nodeId}`);
    }
    const effectivePlacement = placement ?? new RendezvousPlacement([...stores.keys()]);
    for (const nodeId of effectivePlacement.nodes()) {
      if (!stores.has(nodeId)) throw new TypeError(`placement references missing store: ${nodeId}`);
    }
    validateQuorum({ replicaCount, readQuorum, writeQuorum, physicalNodes: effectivePlacement.nodes().length });
    this.#coordinatorId = coordinatorId;
    this.#stores = stores;
    this.#placement = effectivePlacement;
    this.#network = network;
    this.#replicaCount = replicaCount;
    this.#readQuorum = readQuorum;
    this.#writeQuorum = writeQuorum;
  }

  config() {
    return {
      coordinatorId: this.#coordinatorId,
      placementFingerprint: this.#placement.fingerprint(),
      physicalNodes: this.#placement.nodes(),
      replicaCount: this.#replicaCount,
      readQuorum: this.#readQuorum,
      writeQuorum: this.#writeQuorum,
      overlap: this.#readQuorum + this.#writeQuorum > this.#replicaCount,
      mode: 'strict-preference-list',
    };
  }

  async put({ key, value, context = {}, operationId }) {
    return this.#write({ key, value, context, operationId, tombstone: false });
  }

  async delete({ key, context = {}, operationId }) {
    return this.#write({ key, value: null, context, operationId, tombstone: true });
  }

  async get(key) {
    validateKey(key);
    const preferenceList = this.#placement.preferenceList(key, this.#replicaCount);
    const responses = [];
    const failed = [];
    await Promise.all(preferenceList.map(async (nodeId) => {
      if (!this.#network.canReach(this.#coordinatorId, nodeId)) {
        failed.push(nodeId);
        return;
      }
      try {
        responses.push({ nodeId, versions: this.#stores.get(nodeId).getVersions(key) });
      } catch {
        failed.push(nodeId);
      }
    }));
    if (responses.length < this.#readQuorum) {
      throw new QuorumUnavailableError('read', {
        acknowledged: responses.length,
        failed: sortedIds(failed),
        partial: responses.length > 0,
        preferenceList,
        required: this.#readQuorum,
      });
    }

    const versions = mergeVersions(responses.flatMap((response) => response.versions));
    const repairs = [];
    for (const response of responses) {
      for (const version of versions) {
        if (!response.versions.some((candidate) => candidate.id === version.id)) {
          repairs.push({ nodeId: response.nodeId, version });
        }
      }
    }
    const repairResults = await Promise.allSettled(repairs.map(({ nodeId, version }) => (
      this.#stores.get(nodeId).putVersion(key, version)
    )));
    const repairApplied = repairResults.filter(
      (result) => result.status === 'fulfilled' && result.value.applied,
    ).length;
    const repairFailed = repairResults.filter((result) => result.status === 'rejected').length;

    return {
      key,
      versions: versions.map(publicVersion),
      context: { ...mergeClocks(versions.map((version) => version.clock)) },
      receipt: {
        preferenceList,
        responded: sortedIds(responses.map((response) => response.nodeId)),
        failed: sortedIds(failed),
        required: this.#readQuorum,
        repairAttempted: repairs.length,
        repairApplied,
        repairFailed,
      },
    };
  }

  async #write({ key, value, context, operationId, tombstone }) {
    validateKey(key);
    const version = createVersion({
      operationId,
      writerId: this.#coordinatorId,
      context,
      value,
      tombstone,
    });
    const preferenceList = this.#placement.preferenceList(key, this.#replicaCount);
    const acknowledged = [];
    const failed = [];
    await Promise.all(preferenceList.map(async (nodeId) => {
      if (!this.#network.canReach(this.#coordinatorId, nodeId)) {
        failed.push(nodeId);
        return;
      }
      try {
        await this.#stores.get(nodeId).putVersion(key, version);
        acknowledged.push(nodeId);
      } catch (error) {
        failed.push(nodeId);
        if (error?.code === 'OPERATION_CONFLICT') throw error;
      }
    }));
    const receipt = {
      acknowledged: acknowledged.length,
      acknowledgedNodes: sortedIds(acknowledged),
      failed: sortedIds(failed),
      partial: acknowledged.length > 0 && acknowledged.length < this.#writeQuorum,
      preferenceList,
      required: this.#writeQuorum,
      versionId: version.id,
    };
    if (acknowledged.length < this.#writeQuorum) {
      throw new QuorumUnavailableError('write', receipt);
    }
    return {
      version: publicVersion(version),
      context: { ...version.clock },
      receipt,
    };
  }
}
