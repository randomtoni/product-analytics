import { describe, expect, test } from 'vitest';
import type { NeutralEvent } from 'analytics-kit';
import { assembleBatchBody, mapEventToWire } from './wire-mapper';
import {
  ANONYMOUS_DISTINCT_ID_KEY,
  MERGE_EVENT,
  SET_TRAITS_KEY,
  SET_TRAITS_ONCE_KEY,
} from './persistence-keys';

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

describe('wire-mapper — MERGE_EVENT / traits normalization (S2, keyed off MERGE_EVENT)', () => {
  function makeMergeEvent(properties: Record<string, unknown>): NeutralEvent {
    return makeEvent({ event: MERGE_EVENT, distinctId: 'user-1', properties });
  }

  test('lifts set_traits / set_traits_once out of properties to top-level wire keys', () => {
    const wire = mapEventToWire(
      makeMergeEvent({
        [ANONYMOUS_DISTINCT_ID_KEY]: 'anon-9',
        [SET_TRAITS_KEY]: { plan: 'pro' },
        [SET_TRAITS_ONCE_KEY]: { signup_date: '2026-07-08' },
      })
    );

    // The two trait bags are now top-level, not nested in properties.
    expect(wire.set_traits).toEqual({ plan: 'pro' });
    expect(wire.set_traits_once).toEqual({ signup_date: '2026-07-08' });
    expect(wire.properties).not.toHaveProperty(SET_TRAITS_KEY);
    expect(wire.properties).not.toHaveProperty(SET_TRAITS_ONCE_KEY);
  });

  test('keeps the retained anonymous_distinct_id merge link INSIDE properties', () => {
    const wire = mapEventToWire(
      makeMergeEvent({ [ANONYMOUS_DISTINCT_ID_KEY]: 'anon-9', [SET_TRAITS_KEY]: { plan: 'pro' } })
    );

    expect(wire.properties?.[ANONYMOUS_DISTINCT_ID_KEY]).toBe('anon-9');
  });

  test('normalization is keyed off MERGE_EVENT — a consumer event named the same as a trait key is NOT normalized', () => {
    // A non-merge event whose properties happen to carry a `set_traits`-named key is
    // left untouched: the trait bag lift fires ONLY for the adapter-emitted MERGE_EVENT.
    const wire = mapEventToWire(
      makeEvent({ event: 'purchase', properties: { [SET_TRAITS_KEY]: { plan: 'pro' } } })
    );

    expect(wire.set_traits).toBeUndefined();
    expect(wire.properties?.[SET_TRAITS_KEY]).toEqual({ plan: 'pro' });
  });

  test('omits an absent trait bag rather than emitting an empty top-level key', () => {
    const wire = mapEventToWire(
      makeMergeEvent({ [ANONYMOUS_DISTINCT_ID_KEY]: 'anon-9', [SET_TRAITS_KEY]: { plan: 'pro' } })
    );

    expect(wire.set_traits).toEqual({ plan: 'pro' });
    expect(wire).not.toHaveProperty('set_traits_once');
  });

  test('a merge event carrying ONLY the anon link (no trait bags) keeps properties, adds no trait keys', () => {
    const wire = mapEventToWire(makeMergeEvent({ [ANONYMOUS_DISTINCT_ID_KEY]: 'anon-9' }));

    expect(wire.properties).toEqual({ [ANONYMOUS_DISTINCT_ID_KEY]: 'anon-9' });
    expect(wire).not.toHaveProperty('set_traits');
    expect(wire).not.toHaveProperty('set_traits_once');
  });

  test('a merge event with ONLY trait bags (no other props) drops properties to undefined', () => {
    const wire = mapEventToWire(makeMergeEvent({ [SET_TRAITS_KEY]: { plan: 'pro' } }));

    expect(wire.set_traits).toEqual({ plan: 'pro' });
    expect(wire.properties).toBeUndefined();
  });

  test('the merge dedupeId still rides the top-level uuid after normalization', () => {
    const wire = mapEventToWire(
      makeMergeEvent({ [SET_TRAITS_KEY]: { plan: 'pro' } })
    );

    expect(wire.uuid).toBe('dedupe-abc');
  });
});

describe('wire-mapper — data:[] batch envelope + timestamp→offset (S2)', () => {
  test('wraps the mapped wire events in a data:[] envelope as a JSON string', () => {
    const wire = mapEventToWire(makeEvent({ event: 'purchase', timestamp: undefined }));

    const body = assembleBatchBody([wire], Date.now());

    const parsed = JSON.parse(body) as { data: unknown[] };
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(1);
    expect((parsed.data[0] as { event: string }).event).toBe('purchase');
  });

  test('rewrites the per-event timestamp into an offset (ms age vs. send time) and drops timestamp', () => {
    const now = new Date('2026-07-08T00:00:10.000Z').getTime();
    const wire = mapEventToWire(
      makeEvent({ timestamp: new Date('2026-07-08T00:00:00.000Z') })
    );

    const body = assembleBatchBody([wire], now);

    const event = (JSON.parse(body) as { data: Record<string, unknown>[] }).data[0];
    expect(event.offset).toBe(10_000);
    expect(event).not.toHaveProperty('timestamp');
  });

  test('an event with no timestamp carries neither timestamp nor offset', () => {
    const wire = mapEventToWire(makeEvent({ timestamp: undefined }));

    const body = assembleBatchBody([wire], Date.now());

    const event = (JSON.parse(body) as { data: Record<string, unknown>[] }).data[0];
    expect(event).not.toHaveProperty('timestamp');
    expect(event).not.toHaveProperty('offset');
  });

  test('batches multiple events into one data array', () => {
    const a = mapEventToWire(makeEvent({ dedupeId: 'a', timestamp: undefined }));
    const b = mapEventToWire(makeEvent({ dedupeId: 'b', timestamp: undefined }));

    const body = assembleBatchBody([a, b], Date.now());

    const parsed = JSON.parse(body) as { data: { uuid: string }[] };
    expect(parsed.data.map((e) => e.uuid)).toEqual(['a', 'b']);
  });

  test('an empty batch serializes an empty data array', () => {
    expect(assembleBatchBody([], Date.now())).toBe('{"data":[]}');
  });
});
