import { canonicalStringify, sha256Hex, validateValue } from './canonical.js';
import { OperationConflictError } from './errors.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CLOCK_ENTRIES = 32;

export function validateId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must be a 1-128 character safe identifier`);
  }
  return value;
}

export function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || Buffer.byteLength(key, 'utf8') > 512) {
    throw new TypeError('key must contain 1-512 UTF-8 bytes');
  }
  if (/\p{Cc}/u.test(key)) throw new TypeError('key cannot contain control characters');
  return key;
}

export function normalizeClock(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('context clock must be an object');
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_CLOCK_ENTRIES) {
    throw new TypeError(`context clock cannot exceed ${MAX_CLOCK_ENTRIES} writers`);
  }
  const clock = Object.create(null);
  for (const [writerId, counter] of entries.sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))) {
    validateId(writerId, 'clock writer');
    if (!Number.isSafeInteger(counter) || counter < 1) {
      throw new TypeError('clock counters must be positive safe integers');
    }
    clock[writerId] = counter;
  }
  return Object.freeze(clock);
}

export function mergeClocks(clocks) {
  const merged = Object.create(null);
  for (const rawClock of clocks) {
    const clock = normalizeClock(rawClock);
    for (const [writerId, counter] of Object.entries(clock)) {
      merged[writerId] = Math.max(merged[writerId] ?? 0, counter);
    }
  }
  return normalizeClock(merged);
}

export function compareClocks(leftRaw, rightRaw) {
  const left = normalizeClock(leftRaw);
  const right = normalizeClock(rightRaw);
  const writers = new Set([...Object.keys(left), ...Object.keys(right)]);
  let leftGreater = false;
  let rightGreater = false;
  for (const writer of writers) {
    const leftCounter = left[writer] ?? 0;
    const rightCounter = right[writer] ?? 0;
    if (leftCounter > rightCounter) leftGreater = true;
    if (rightCounter > leftCounter) rightGreater = true;
  }
  if (leftGreater && rightGreater) return 'concurrent';
  if (leftGreater) return 'descendant';
  if (rightGreater) return 'ancestor';
  return 'equal';
}

export function createVersion({
  operationId,
  writerId,
  context = {},
  value = null,
  tombstone = false,
}) {
  validateId(operationId, 'operationId');
  validateId(writerId, 'writerId');
  const baseClock = normalizeClock(context);
  const clock = normalizeClock({
    ...baseClock,
    [writerId]: (baseClock[writerId] ?? 0) + 1,
  });
  if (typeof tombstone !== 'boolean') throw new TypeError('tombstone must be a boolean');
  const normalizedValue = tombstone ? null : validateValue(value).normalized;
  const identity = canonicalStringify({ clock, operationId, tombstone, value: normalizedValue, writerId });
  return Object.freeze({
    id: sha256Hex(`version\0${identity}`),
    operationId,
    writerId,
    clock,
    tombstone,
    value: normalizedValue,
  });
}

export function validateVersion(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('version must be an object');
  }
  if (typeof raw.tombstone !== 'boolean') throw new TypeError('version tombstone must be a boolean');
  const version = createVersion({
    operationId: raw.operationId,
    writerId: raw.writerId,
    context: Object.fromEntries(
      Object.entries(normalizeClock(raw.clock)).map(([writer, counter]) => (
        [writer, writer === raw.writerId ? counter - 1 : counter]
      )).filter(([, counter]) => counter > 0),
    ),
    value: raw.value,
    tombstone: raw.tombstone,
  });
  if (raw.id !== version.id) throw new TypeError('version identity does not match its content');
  return version;
}

export function mergeVersions(rawVersions) {
  const byId = new Map();
  const operations = new Map();
  for (const raw of rawVersions) {
    const version = validateVersion(raw);
    const existingOperation = operations.get(version.operationId);
    if (existingOperation && existingOperation !== version.id) {
      throw new OperationConflictError(`operationId reused with different content: ${version.operationId}`);
    }
    operations.set(version.operationId, version.id);
    byId.set(version.id, version);
  }

  const versions = [...byId.values()];
  return Object.freeze(versions.filter((candidate) => !versions.some((other) => {
    if (candidate.id === other.id) return false;
    return compareClocks(candidate.clock, other.clock) === 'ancestor';
  })).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)));
}

export function publicVersion(version) {
  const validated = validateVersion(version);
  return {
    id: validated.id,
    operationId: validated.operationId,
    writerId: validated.writerId,
    clock: { ...validated.clock },
    tombstone: validated.tombstone,
    value: structuredClone(validated.value),
  };
}

export const versionLimits = Object.freeze({ maxClockEntries: MAX_CLOCK_ENTRIES });
