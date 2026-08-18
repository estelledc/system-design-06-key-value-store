import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHttpService } from '../src/http-server.js';
import { openService } from '../src/service.js';

test('HTTP service refuses to start without a sufficiently long log secret', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'quorum-kv-http-secret-'));
  const { cluster, stores } = await openService({ dataDirectory });
  assert.throws(() => createHttpService({ cluster, stores, logHmacSecret: 'short' }), /at least 32/);
});

async function fixture(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'quorum-kv-http-'));
  const { cluster, stores } = await openService({ dataDirectory });
  const logs = [];
  const { server } = createHttpService({
    cluster,
    stores,
    logHmacSecret: 'test-secret-that-is-at-least-32-bytes',
    logger: (line) => logs.push(line),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, logs };
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

function mutation(url, method, operationId, body) {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': operationId },
    body: JSON.stringify(body),
  });
}

test('HTTP lifecycle preserves conflicts, resolves them, and retains tombstone context', async (t) => {
  const { baseUrl, logs } = await fixture(t);
  const rawKey = 'private-cart-42';
  const url = `${baseUrl}/v1/kv/${rawKey}`;
  const created = await json(await mutation(url, 'PUT', 'op-create', { value: ['book'] }));
  assert.equal(created.status, 200);

  const initial = await json(await fetch(url));
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.version.value, ['book']);

  await mutation(url, 'PUT', 'op-left', { value: ['book', 'pen'], context: initial.body.context });
  await mutation(url, 'PUT', 'op-right', { value: ['book', 'cup'], context: initial.body.context });
  const conflict = await json(await fetch(url));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.siblings.length, 2);

  const resolved = await json(await mutation(url, 'PUT', 'op-resolve', {
    value: ['book', 'cup', 'pen'],
    context: conflict.body.context,
  }));
  assert.equal(resolved.status, 200);
  assert.deepEqual((await json(await fetch(url))).body.version.value, ['book', 'cup', 'pen']);

  assert.equal((await json(await mutation(url, 'DELETE', 'op-delete', {
    context: resolved.body.context,
  }))).status, 200);
  const missing = await json(await fetch(url));
  assert.equal(missing.status, 404);
  assert.ok(Object.keys(missing.body.context).length > 0);
  assert.ok(!logs.join('\n').includes(rawKey));
});

test('HTTP idempotency retries reuse a version and changed content is rejected', async (t) => {
  const { baseUrl } = await fixture(t);
  const url = `${baseUrl}/v1/kv/key`;
  const first = await json(await mutation(url, 'PUT', 'op-same', { value: 'left' }));
  const retry = await json(await mutation(url, 'PUT', 'op-same', { value: 'left' }));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.versionId, first.body.versionId);
  const conflict = await json(await mutation(url, 'PUT', 'op-same', { value: 'right' }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'OPERATION_CONFLICT');
});

test('HTTP boundary rejects missing idempotency, malformed JSON, and oversized bodies', async (t) => {
  const { baseUrl } = await fixture(t);
  const url = `${baseUrl}/v1/kv/key`;
  const missing = await json(await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'x' }),
  }));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'MISSING_IDEMPOTENCY_KEY');

  const malformed = await json(await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'op-bad-json' },
    body: '{',
  }));
  assert.equal(malformed.status, 400);

  const oversized = await json(await mutation(url, 'PUT', 'op-large', { value: 'x'.repeat(20_000) }));
  assert.equal(oversized.status, 413);
});

test('health and metrics surfaces are machine-readable', async (t) => {
  const { baseUrl } = await fixture(t);
  const ready = await json(await fetch(`${baseUrl}/health/ready`));
  assert.equal(ready.status, 200);
  assert.equal(ready.body.config.overlap, true);
  const metrics = await fetch(`${baseUrl}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /quorum_kv_requests_total/);
});
