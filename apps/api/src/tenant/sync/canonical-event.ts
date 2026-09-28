import { createHash } from 'node:crypto';

const INVALID_CANONICAL_VALUE =
  'Sync event contains a value that cannot be canonical JSON';

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(INVALID_CANONICAL_VALUE);
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError(INVALID_CANONICAL_VALUE);
    }
    return serialized;
  }
  if (typeof value !== 'object') {
    throw new TypeError(INVALID_CANONICAL_VALUE);
  }
  if (ancestors.has(value)) {
    throw new TypeError(INVALID_CANONICAL_VALUE);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(INVALID_CANONICAL_VALUE);
        }
        items.push(canonicalize(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(INVALID_CANONICAL_VALUE);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(INVALID_CANONICAL_VALUE);
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const properties = keys.map((key) => {
      const encodedKey = JSON.stringify(key);
      const encodedValue = canonicalize(record[key], ancestors);
      return `${encodedKey}:${encodedValue}`;
    });
    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** RFC 8785 canonical JSON for values received as ordinary JSON data. */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

/** Bind idempotency to both the validated device and exact received event JSON. */
export function fingerprintSyncEvent(
  event: unknown,
  validatedDeviceId: string,
): string {
  if (!validatedDeviceId) {
    throw new TypeError(
      'A validated device ID is required for sync fingerprinting',
    );
  }
  const canonicalEvent = canonicalizeJson({
    device_id: validatedDeviceId,
    event,
  });
  return createHash('sha256').update(canonicalEvent, 'utf8').digest('hex');
}
