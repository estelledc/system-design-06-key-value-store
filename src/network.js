import { validateId } from './version.js';

export class FaultNetwork {
  #blocked = new Set();

  block(coordinatorId, nodeId) {
    this.#blocked.add(this.#edge(coordinatorId, nodeId));
  }

  unblock(coordinatorId, nodeId) {
    this.#blocked.delete(this.#edge(coordinatorId, nodeId));
  }

  heal() {
    this.#blocked.clear();
  }

  canReach(coordinatorId, nodeId) {
    return !this.#blocked.has(this.#edge(coordinatorId, nodeId));
  }

  #edge(coordinatorId, nodeId) {
    validateId(coordinatorId, 'coordinatorId');
    validateId(nodeId, 'nodeId');
    return `${coordinatorId}\0${nodeId}`;
  }
}
