import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalStringify, sha256Hex } from './canonical.js';
import { OperationConflictError, WalCorruptionError } from './errors.js';
import { mergeVersions, publicVersion, validateId, validateKey, validateVersion } from './version.js';

function encodeFrame(payload) {
  const canonicalPayload = canonicalStringify(payload);
  return `${JSON.stringify({ checksum: sha256Hex(`wal\0${canonicalPayload}`), payload })}\n`;
}

function decodeFrame(line, lineNumber) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    throw new WalCorruptionError(`invalid JSON at WAL line ${lineNumber}`);
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new WalCorruptionError(`invalid frame at WAL line ${lineNumber}`);
  }
  const canonicalPayload = canonicalStringify(frame.payload);
  const expected = sha256Hex(`wal\0${canonicalPayload}`);
  if (frame.checksum !== expected) throw new WalCorruptionError(`checksum mismatch at WAL line ${lineNumber}`);
  return frame.payload;
}

export class ReplicaStore {
  #id;
  #walPath;
  #versions = new Map();
  #operations = new Map();
  #tail = Promise.resolve();
  #ioFault = null;
  #recordCount = 0;

  static async open({ id, directory }) {
    validateId(id, 'replica id');
    if (typeof directory !== 'string' || directory.length === 0) {
      throw new TypeError('replica directory is required');
    }
    await mkdir(directory, { recursive: true });
    const walPath = join(directory, 'replica.wal');
    const handle = await open(walPath, 'a', 0o600);
    try {
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    const store = new ReplicaStore(id, walPath);
    await store.#replay();
    return store;
  }

  constructor(id, walPath) {
    this.#id = id;
    this.#walPath = walPath;
  }

  id() {
    return this.#id;
  }

  getVersions(key) {
    validateKey(key);
    return (this.#versions.get(key) ?? []).map(publicVersion);
  }

  async putVersion(key, rawVersion) {
    validateKey(key);
    const version = validateVersion(rawVersion);
    const job = this.#tail.then(() => this.#putLocked(key, version));
    this.#tail = job.catch(() => undefined);
    return job;
  }

  stats() {
    return {
      id: this.#id,
      keys: this.#versions.size,
      operations: this.#operations.size,
      walRecords: this.#recordCount,
      ioFaulted: this.#ioFault !== null,
    };
  }

  async #putLocked(key, version) {
    if (this.#ioFault) throw this.#ioFault;
    const priorVersionId = this.#operations.get(version.operationId);
    if (priorVersionId && priorVersionId !== version.id) {
      throw new OperationConflictError(`operationId reused with different content: ${version.operationId}`);
    }
    if (priorVersionId === version.id) return { applied: false, versionId: version.id };

    const payload = { type: 'put', key, version: publicVersion(version) };
    try {
      const handle = await open(this.#walPath, 'a', 0o600);
      try {
        await handle.writeFile(encodeFrame(payload), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.#ioFault = error;
      throw error;
    }
    this.#apply(payload);
    return { applied: true, versionId: version.id };
  }

  async #replay() {
    let text;
    try {
      text = await readFile(this.#walPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (text.length > 0 && !text.endsWith('\n')) {
      throw new WalCorruptionError('WAL ends with an incomplete frame');
    }
    const lines = text.split('\n');
    for (let index = 0; index < lines.length - 1; index += 1) {
      const payload = decodeFrame(lines[index], index + 1);
      this.#apply(payload);
    }
  }

  #apply(payload) {
    if (payload?.type !== 'put') throw new WalCorruptionError('unsupported WAL record type');
    validateKey(payload.key);
    const version = validateVersion(payload.version);
    const priorVersionId = this.#operations.get(version.operationId);
    if (priorVersionId && priorVersionId !== version.id) {
      throw new WalCorruptionError(`conflicting operationId in WAL: ${version.operationId}`);
    }
    if (priorVersionId === version.id) return;
    const versions = mergeVersions([...(this.#versions.get(payload.key) ?? []), version]);
    this.#versions.set(payload.key, versions);
    this.#operations.set(version.operationId, version.id);
    this.#recordCount += 1;
  }
}
