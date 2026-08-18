import assert from 'node:assert/strict';
import { appendFile, chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OperationConflictError, WalCorruptionError } from '../src/errors.js';
import { ReplicaStore } from '../src/replica-store.js';
import { createVersion } from '../src/version.js';

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), 'quorum-kv-store-'));
}

function version(operationId, value) {
  return createVersion({ operationId, writerId: 'writer-a', value });
}

test('durable apply replays after reopening and duplicate retry adds no WAL record', async () => {
  const directory = await temporaryDirectory();
  const store = await ReplicaStore.open({ id: 'node-a', directory });
  const item = version('op-one', { answer: 42 });
  assert.deepEqual(await store.putVersion('key', item), { applied: true, versionId: item.id });
  assert.deepEqual(await store.putVersion('key', item), { applied: false, versionId: item.id });
  assert.equal(store.stats().walRecords, 1);

  const reopened = await ReplicaStore.open({ id: 'node-a', directory });
  assert.equal(reopened.getVersions('key')[0].id, item.id);
  assert.equal(reopened.stats().walRecords, 1);
});

test('opening a replica restricts an existing WAL to owner read and write', async () => {
  const directory = await temporaryDirectory();
  const walPath = join(directory, 'replica.wal');
  await writeFile(walPath, '', { mode: 0o644 });
  await chmod(walPath, 0o644);
  await ReplicaStore.open({ id: 'node-a', directory });
  assert.equal((await stat(walPath)).mode & 0o777, 0o600);
});

test('same operation ID with different content fails closed', async () => {
  const directory = await temporaryDirectory();
  const store = await ReplicaStore.open({ id: 'node-a', directory });
  await store.putVersion('key', version('op-same', 'left'));
  await assert.rejects(
    store.putVersion('key', version('op-same', 'right')),
    OperationConflictError,
  );
  assert.equal(store.getVersions('key').length, 1);
});

test('concurrent append calls serialize into complete durable frames', async () => {
  const directory = await temporaryDirectory();
  const store = await ReplicaStore.open({ id: 'node-a', directory });
  await Promise.all(Array.from({ length: 50 }, (_, index) => (
    store.putVersion(`key-${index}`, version(`op-${index}`, index))
  )));
  const reopened = await ReplicaStore.open({ id: 'node-a', directory });
  assert.equal(reopened.stats().walRecords, 50);
  assert.equal(reopened.getVersions('key-49')[0].value, 49);
});

test('truncated and checksum-corrupt WALs refuse startup', async () => {
  const truncatedDirectory = await temporaryDirectory();
  await appendFile(join(truncatedDirectory, 'replica.wal'), '{"incomplete":', 'utf8');
  await assert.rejects(
    ReplicaStore.open({ id: 'node-a', directory: truncatedDirectory }),
    WalCorruptionError,
  );

  const corruptDirectory = await temporaryDirectory();
  const store = await ReplicaStore.open({ id: 'node-a', directory: corruptDirectory });
  await store.putVersion('key', version('op-good', 'value'));
  const walPath = join(corruptDirectory, 'replica.wal');
  const wal = await readFile(walPath, 'utf8');
  await writeFile(walPath, wal.replace(/"checksum":"[a-f0-9]+"/, '"checksum":"bad"'), 'utf8');
  await assert.rejects(ReplicaStore.open({ id: 'node-a', directory: corruptDirectory }), /checksum mismatch/);
});
