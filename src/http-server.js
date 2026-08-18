import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

import { OperationConflictError, QuorumUnavailableError } from './errors.js';
import { validateId } from './version.js';

const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

async function readJson(request, { optional = false } = {}) {
  const contentType = request.headers['content-type'];
  if (contentType && !contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body is too large');
    chunks.push(chunk);
  }
  if (bytes === 0 && optional) return {};
  if (bytes === 0) throw new HttpError(400, 'INVALID_JSON', 'request body is required');
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'request body must be valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_JSON', 'request body must be a JSON object');
  }
  return value;
}

function operationId(request) {
  const raw = request.headers['idempotency-key'];
  if (Array.isArray(raw) || raw === undefined) {
    throw new HttpError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
  }
  return validateId(raw, 'Idempotency-Key');
}

function publicReceipt(receipt) {
  return {
    acknowledged: receipt.acknowledged,
    required: receipt.required,
    partial: receipt.partial,
    failedCount: receipt.failed?.length ?? 0,
  };
}

function metricText(metrics) {
  const lines = [
    '# TYPE quorum_kv_requests_total counter',
    `quorum_kv_requests_total ${metrics.requests}`,
    '# TYPE quorum_kv_errors_total counter',
    `quorum_kv_errors_total ${metrics.errors}`,
    '# TYPE quorum_kv_quorum_failures_total counter',
    `quorum_kv_quorum_failures_total ${metrics.quorumFailures}`,
    '# TYPE quorum_kv_conflicts_total counter',
    `quorum_kv_conflicts_total ${metrics.conflicts}`,
    '# TYPE quorum_kv_read_repairs_total counter',
    `quorum_kv_read_repairs_total ${metrics.readRepairs}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function createHttpService({ cluster, stores, logHmacSecret, logger = console.log }) {
  if (typeof logHmacSecret !== 'string' || Buffer.byteLength(logHmacSecret) < 32) {
    throw new TypeError('logHmacSecret must contain at least 32 bytes');
  }
  if (typeof logger !== 'function') throw new TypeError('logger must be a function');
  const metrics = { requests: 0, errors: 0, quorumFailures: 0, conflicts: 0, readRepairs: 0 };

  function keyTag(key) {
    return createHmac('sha256', logHmacSecret).update(key, 'utf8').digest('hex').slice(0, 16);
  }

  const server = createServer(async (request, response) => {
    const startedAt = performance.now();
    metrics.requests += 1;
    let status = 500;
    let event = 'request_failed';
    let tag = null;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health/live') {
        status = 200;
        event = 'health_live';
        sendJson(response, status, { ok: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        status = 200;
        event = 'health_ready';
        sendJson(response, status, {
          ok: true,
          config: cluster.config(),
          replicas: [...stores.values()].map((store) => store.stats()),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        status = 200;
        event = 'metrics_read';
        const payload = metricText(metrics);
        response.writeHead(status, {
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(payload),
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        response.end(payload);
        return;
      }

      const prefix = '/v1/kv/';
      if (!url.pathname.startsWith(prefix) || url.pathname.length === prefix.length) {
        throw new HttpError(404, 'NOT_FOUND', 'route not found');
      }
      let key;
      try {
        key = decodeURIComponent(url.pathname.slice(prefix.length));
      } catch {
        throw new HttpError(400, 'INVALID_KEY_ENCODING', 'key path must use valid percent encoding');
      }
      tag = keyTag(key);

      if (request.method === 'GET') {
        const result = await cluster.get(key);
        metrics.readRepairs += result.receipt.repairApplied;
        if (result.versions.length === 0 || (result.versions.length === 1 && result.versions[0].tombstone)) {
          status = 404;
          event = 'key_not_found';
          sendJson(response, status, { ok: false, error: { code: 'KEY_NOT_FOUND' }, context: result.context });
          return;
        }
        if (result.versions.length > 1) {
          status = 409;
          event = 'siblings_returned';
          metrics.conflicts += 1;
          sendJson(response, status, {
            ok: false,
            error: { code: 'SIBLING_CONFLICT' },
            context: result.context,
            siblings: result.versions,
            receipt: { responded: result.receipt.responded.length, required: result.receipt.required },
          });
          return;
        }
        status = 200;
        event = 'key_read';
        sendJson(response, status, {
          ok: true,
          context: result.context,
          version: result.versions[0],
          receipt: { responded: result.receipt.responded.length, required: result.receipt.required },
        });
        return;
      }

      if (request.method === 'PUT') {
        const body = await readJson(request);
        if (!Object.hasOwn(body, 'value')) throw new HttpError(400, 'MISSING_VALUE', 'body.value is required');
        const result = await cluster.put({
          key,
          value: body.value,
          context: body.context ?? {},
          operationId: operationId(request),
        });
        status = 200;
        event = 'key_written';
        sendJson(response, status, {
          ok: true,
          context: result.context,
          versionId: result.version.id,
          receipt: publicReceipt(result.receipt),
        });
        return;
      }

      if (request.method === 'DELETE') {
        const body = await readJson(request, { optional: true });
        const result = await cluster.delete({
          key,
          context: body.context ?? {},
          operationId: operationId(request),
        });
        status = 200;
        event = 'key_deleted';
        sendJson(response, status, {
          ok: true,
          context: result.context,
          versionId: result.version.id,
          receipt: publicReceipt(result.receipt),
        });
        return;
      }

      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    } catch (error) {
      metrics.errors += 1;
      if (error instanceof QuorumUnavailableError) {
        metrics.quorumFailures += 1;
        status = 503;
        event = 'quorum_unavailable';
        sendJson(response, status, {
          ok: false,
          error: { code: error.code, operation: error.operation },
          receipt: publicReceipt(error.receipt),
        });
      } else if (error instanceof OperationConflictError || error?.code === 'OPERATION_CONFLICT') {
        status = 409;
        event = 'operation_conflict';
        metrics.conflicts += 1;
        sendJson(response, status, { ok: false, error: { code: 'OPERATION_CONFLICT' } });
      } else if (error instanceof HttpError) {
        status = error.status;
        event = 'request_rejected';
        sendJson(response, status, { ok: false, error: { code: error.code, message: error.message } });
      } else if (error instanceof TypeError) {
        status = 400;
        event = 'request_rejected';
        sendJson(response, status, { ok: false, error: { code: 'INVALID_INPUT', message: error.message } });
      } else {
        status = 500;
        event = 'internal_error';
        sendJson(response, status, { ok: false, error: { code: 'INTERNAL_ERROR' } });
      }
    } finally {
      logger(JSON.stringify({
        event,
        method: request.method,
        status,
        keyTag: tag,
        elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      }));
    }
  });

  return { server, metrics };
}

export const httpLimits = Object.freeze({ maxBodyBytes: MAX_BODY_BYTES });
