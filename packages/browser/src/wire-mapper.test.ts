import { describe, expect, test } from 'vitest';
import type { NeutralEvent } from 'analytics-kit';
import { mapEventToWire } from './wire-mapper';

function makeEvent(overrides: Partial<NeutralEvent> = {}): NeutralEvent {
  return {
    event: 'purchase',
    distinctId: 'user-1',
    dedupeId: 'dedupe-abc',
    timestamp: new Date('2026-07-08T00:00:00.000Z'),
    ...overrides,
  };
}

// A deep scan for the legacy random property name anywhere in the mapped shape —
// top-level or nested inside properties. $insert_id is a separate browser-enrichment
// property, NOT the dedup key; the de-branded mapper must never emit it.
function containsInsertId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsInsertId);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, v]) => key === '$insert_id' || key === 'insert_id' || containsInsertId(v)
    );
  }
  return false;
}

describe('wire-mapper — dedupeId → top-level uuid', () => {
  test('places NeutralEvent.dedupeId at the wire top-level uuid field', () => {
    const wire = mapEventToWire(makeEvent({ dedupeId: 'dedupe-abc' }));

    expect(wire.uuid).toBe('dedupe-abc');
    // Top-level, not nested inside properties.
    expect(wire.properties ?? {}).not.toHaveProperty('uuid');
  });

  test('is value-agnostic — it carries whatever dedupeId holds verbatim, never re-generating or re-versioning', () => {
    // A v4 dedupeId (track/page facade default) is carried through UNCHANGED — the
    // mapper does not upgrade it to v7 or mint a new id.
    const v4 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const arbitrary = 'not-even-a-uuid-just-stable';

    expect(mapEventToWire(makeEvent({ dedupeId: v4 })).uuid).toBe(v4);
    expect(mapEventToWire(makeEvent({ dedupeId: arbitrary })).uuid).toBe(arbitrary);
  });

  test('the same dedupeId maps to the same uuid across repeated mapping (stable-across-retry)', () => {
    const event = makeEvent({ dedupeId: 'stable-1' });

    expect(mapEventToWire(event).uuid).toBe(mapEventToWire(event).uuid);
  });
});

describe('wire-mapper — no random $insert_id', () => {
  test('the mapped wire shape emits no $insert_id (top-level or nested)', () => {
    const wire = mapEventToWire(makeEvent({ properties: { plan: 'pro', nested: { a: 1 } } }));

    expect(wire).not.toHaveProperty('$insert_id');
    expect(wire.properties ?? {}).not.toHaveProperty('$insert_id');
    expect(containsInsertId(wire)).toBe(false);
  });

  test('the uuid is the ONLY dedup identifier on the wire — no separate legacy id field', () => {
    const wire = mapEventToWire(makeEvent({ dedupeId: 'the-one-id' }));

    // The idempotency key is the top-level uuid; there is no insertId / $insert_id sibling.
    expect(wire.uuid).toBe('the-one-id');
    expect(wire).not.toHaveProperty('insertId');
    expect(wire).not.toHaveProperty('insert_id');
  });
});

describe('wire-mapper — the rest of the [WIRE] top-level shape', () => {
  test('maps the neutral event onto the top-level wire keys', () => {
    const wire = mapEventToWire(
      makeEvent({
        event: 'purchase',
        distinctId: 'user-1',
        properties: { plan: 'pro' },
        timestamp: new Date('2026-07-08T00:00:00.000Z'),
        dedupeId: 'dedupe-abc',
      })
    );

    expect(wire).toEqual({
      event: 'purchase',
      distinct_id: 'user-1',
      properties: { plan: 'pro' },
      timestamp: '2026-07-08T00:00:00.000Z',
      uuid: 'dedupe-abc',
    });
  });

  test('renames neutral distinctId to wire distinct_id', () => {
    const wire = mapEventToWire(makeEvent({ distinctId: 'abc-123' }));

    expect(wire.distinct_id).toBe('abc-123');
    expect(wire).not.toHaveProperty('distinctId');
  });

  test('an event without a timestamp maps to an undefined wire timestamp (still carries uuid)', () => {
    const wire = mapEventToWire(makeEvent({ timestamp: undefined }));

    expect(wire.timestamp).toBeUndefined();
    expect(wire.uuid).toBe('dedupe-abc');
  });

  test('an event without properties maps to an undefined wire properties bag', () => {
    const wire = mapEventToWire(makeEvent({ properties: undefined }));

    expect(wire.properties).toBeUndefined();
  });
});
