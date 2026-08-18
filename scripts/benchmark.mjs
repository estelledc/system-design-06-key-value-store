import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { openService } from '../src/service.js';

const durableWrites = 300;
const reads = 20_000;
const dataDirectory = await mkdtemp(join(tmpdir(), 'quorum-kv-benchmark-'));
const { cluster, stores } = await openService({ dataDirectory });
const value = { payload: 'x'.repeat(128) };

const writeStartedAt = performance.now();
for (let index = 0; index < durableWrites; index += 1) {
  const result = await cluster.put({
    key: `benchmark-${index}`,
    value,
    operationId: `benchmark-write-${index}`,
  });
  assert.equal(result.receipt.acknowledged, 3);
}
const writeElapsedMs = performance.now() - writeStartedAt;

let checksum = 0;
const readStartedAt = performance.now();
for (let index = 0; index < reads; index += 1) {
  const result = await cluster.get(`benchmark-${index % durableWrites}`);
  assert.equal(result.versions.length, 1);
  checksum += result.versions[0].id.charCodeAt(index % result.versions[0].id.length);
}
const readElapsedMs = performance.now() - readStartedAt;
assert.ok(checksum > 0);

process.stdout.write(`${JSON.stringify({
  kind: 'local_durable_protocol_receipt',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  replicaCount: cluster.config().replicaCount,
  readQuorum: cluster.config().readQuorum,
  writeQuorum: cluster.config().writeQuorum,
  durableWrites,
  writeElapsedMs: Number(writeElapsedMs.toFixed(3)),
  durableWritesPerSecond: Math.round(durableWrites / (writeElapsedMs / 1000)),
  reads,
  readElapsedMs: Number(readElapsedMs.toFixed(3)),
  readsPerSecond: Math.round(reads / (readElapsedMs / 1000)),
  walRecords: [...stores.values()].reduce((sum, store) => sum + store.stats().walRecords, 0),
  checksum,
  claimBoundary: 'single-process three-replica WAL fsync and in-memory reads on a temporary local filesystem; not production capacity',
})}\n`);
