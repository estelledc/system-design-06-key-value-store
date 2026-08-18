import { createHash } from 'node:crypto';

import { canonicalStringify, sha256Hex } from './canonical.js';
import { validateId, validateKey } from './version.js';

export const PLACEMENT_VERSION = 'rendezvous-sha256-v1';

function score(key, nodeId) {
  return createHash('sha256')
    .update(`placement\0${key}\0${nodeId}`, 'utf8')
    .digest()
    .readBigUInt64BE(0);
}

export class RendezvousPlacement {
  #nodes;
  #fingerprint;

  constructor(rawNodes) {
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
      throw new TypeError('at least one physical node is required');
    }
    const nodes = rawNodes.map((nodeId) => validateId(nodeId, 'nodeId')).sort();
    if (new Set(nodes).size !== nodes.length) throw new TypeError('node IDs must be unique');
    this.#nodes = Object.freeze(nodes);
    this.#fingerprint = sha256Hex(canonicalStringify({
      nodes,
      placementVersion: PLACEMENT_VERSION,
    }));
  }

  preferenceList(key, count = this.#nodes.length) {
    validateKey(key);
    if (!Number.isSafeInteger(count) || count < 1 || count > this.#nodes.length) {
      throw new TypeError(`count must be between 1 and ${this.#nodes.length}`);
    }
    return Object.freeze(this.#nodes.map((nodeId) => ({ nodeId, score: score(key, nodeId) }))
      .sort((left, right) => {
        if (left.score > right.score) return -1;
        if (left.score < right.score) return 1;
        return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
      })
      .slice(0, count)
      .map((entry) => entry.nodeId));
  }

  nodes() {
    return [...this.#nodes];
  }

  fingerprint() {
    return this.#fingerprint;
  }
}
