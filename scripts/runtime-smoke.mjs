import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const main = join(root, 'src', 'main.js');
const dataDirectory = await mkdtemp(join(tmpdir(), 'quorum-kv-runtime-'));
const rawKey = 'runtime-private-key';
const secret = 'runtime-smoke-secret-with-32-bytes-minimum';

function start() {
  const child = spawn(process.execPath, [main], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIRECTORY: dataDirectory,
      HOST: '127.0.0.1',
      LOG_HMAC_SECRET: secret,
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  return {
    child,
    stderr: () => stderr,
    stdout: () => stdout,
    async started(timeoutMs = 5000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        for (const line of stdout.split('\n')) {
          if (line.includes('"event":"server_started"')) return JSON.parse(line);
        }
        if (child.exitCode !== null) throw new Error(`server exited during startup: ${child.exitCode}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('server startup timed out');
    },
    exited(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        const timeout = setTimeout(() => reject(new Error('server exit timed out')), timeoutMs);
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });
    },
  };
}

function put(baseUrl, operationId, value, context = {}) {
  return fetch(`${baseUrl}/v1/kv/${rawKey}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': operationId },
    body: JSON.stringify({ value, context }),
  });
}

let first;
let second;
try {
  first = start();
  const firstStarted = await first.started();
  const firstBaseUrl = `http://127.0.0.1:${firstStarted.port}`;
  const written = await put(firstBaseUrl, 'runtime-create', { durable: true });
  assert.equal(written.status, 200);
  const writtenBody = await written.json();
  assert.equal(writtenBody.receipt.acknowledged, 3);

  first.child.kill('SIGKILL');
  const killed = await first.exited();
  assert.equal(killed.signal, 'SIGKILL');

  second = start();
  const secondStarted = await second.started();
  const secondBaseUrl = `http://127.0.0.1:${secondStarted.port}`;
  const recovered = await fetch(`${secondBaseUrl}/v1/kv/${rawKey}`);
  assert.equal(recovered.status, 200);
  const recoveredBody = await recovered.json();
  assert.deepEqual(recoveredBody.version.value, { durable: true });
  assert.deepEqual(recoveredBody.context, writtenBody.context);

  const exitPromise = second.exited();
  second.child.kill('SIGTERM');
  assert.deepEqual(await exitPromise, { code: 0, signal: null });
  assert.match(second.stdout(), /"event":"server_stopped"/);
  assert.equal(first.stderr(), '');
  assert.equal(second.stderr(), '');
  assert.ok(!first.stdout().includes(rawKey));
  assert.ok(!second.stdout().includes(rawKey));

  process.stdout.write(`${JSON.stringify({
    kind: 'process_crash_recovery_receipt',
    node: process.version,
    acknowledgedReplicas: writtenBody.receipt.acknowledged,
    forcedTermination: 'SIGKILL',
    recoveredVersionId: recoveredBody.version.id,
    recoveredContext: recoveredBody.context,
    gracefulRestartShutdown: true,
    rawKeyLogged: false,
    claimBoundary: 'process crash after acknowledged fsync and WAL replay; not sudden power loss or multi-host durability',
  })}\n`);
} catch (error) {
  first?.child.kill('SIGKILL');
  second?.child.kill('SIGKILL');
  throw error;
}
