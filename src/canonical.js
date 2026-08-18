import { createHash } from 'node:crypto';

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 16;
const MAX_VALUE_BYTES = 10 * 1024;

function normalize(value, depth) {
  if (depth > MAX_DEPTH) throw new TypeError(`JSON value cannot exceed ${MAX_DEPTH} levels`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, depth + 1));
  if (typeof value !== 'object') throw new TypeError('value must be JSON-compatible');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('value objects must have a plain prototype');
  }
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (BLOCKED_KEYS.has(key)) throw new TypeError(`unsafe object key: ${key}`);
    output[key] = normalize(value[key], depth + 1);
  }
  return output;
}

export function canonicalize(value) {
  return normalize(value, 0);
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function validateValue(value) {
  const normalized = canonicalize(value);
  const encoded = JSON.stringify(normalized);
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > MAX_VALUE_BYTES) {
    throw new TypeError(`value cannot exceed ${MAX_VALUE_BYTES} encoded bytes`);
  }
  return { normalized, bytes };
}

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export const limits = Object.freeze({ maxDepth: MAX_DEPTH, maxValueBytes: MAX_VALUE_BYTES });
