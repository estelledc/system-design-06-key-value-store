export class QuorumUnavailableError extends Error {
  constructor(operation, receipt) {
    super(`${operation} quorum unavailable: ${receipt.acknowledged}/${receipt.required} replicas`);
    this.name = 'QuorumUnavailableError';
    this.code = 'QUORUM_UNAVAILABLE';
    this.operation = operation;
    this.receipt = Object.freeze(receipt);
  }
}

export class OperationConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OperationConflictError';
    this.code = 'OPERATION_CONFLICT';
  }
}

export class WalCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WalCorruptionError';
    this.code = 'WAL_CORRUPT';
  }
}
