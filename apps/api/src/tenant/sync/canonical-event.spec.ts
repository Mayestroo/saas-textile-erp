import { describe, expect, it } from 'vitest';
import { canonicalizeJson, fingerprintSyncEvent } from './canonical-event.js';

describe('canonical sync event fingerprint', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalizeJson({ z: 1, a: { y: 2, b: 3 }, rows: [2, 1] })).toBe(
      '{"a":{"b":3,"y":2},"rows":[2,1],"z":1}',
    );
  });

  it('uses JSON-compatible Unicode and ECMAScript number serialization', () => {
    expect(
      canonicalizeJson({ text: 'atlas 🧵', price: 4.5, negativeZero: -0 }),
    ).toBe('{"negativeZero":0,"price":4.5,"text":"atlas 🧵"}');
    expect(canonicalizeJson({ value: Number('333333333.33333329') })).toBe(
      '{"value":333333333.3333333}',
    );
  });

  it('fingerprints equivalent key orders identically and binds identity to device', () => {
    const firstEvent = { event_id: 'evt', payload: { b: 2, a: 1 } };
    const reorderedEvent = { payload: { a: 1, b: 2 }, event_id: 'evt' };

    expect(fingerprintSyncEvent(firstEvent, 'device-a')).toBe(
      fingerprintSyncEvent(reorderedEvent, 'device-a'),
    );
    expect(fingerprintSyncEvent(firstEvent, 'device-a')).not.toBe(
      fingerprintSyncEvent(firstEvent, 'device-b'),
    );
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    undefined,
    new Date('2026-09-26T00:00:00.000Z'),
  ])(
    'rejects values which cannot appear in an RFC 8785 JSON event',
    (value) => {
      expect(() => canonicalizeJson({ value })).toThrow('canonical JSON');
    },
  );

  it('rejects cyclic event payloads', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow('canonical JSON');
  });
});
