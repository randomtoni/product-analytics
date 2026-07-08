import type { NeutralEvent } from 'analytics-kit';
import { expect, test } from 'vitest';
import { assembleBatchEnvelope, mapEventToWire } from './wire-mapper';

function neutral(overrides: Partial<NeutralEvent> = {}): NeutralEvent {
  return {
    event: 'order_placed',
    distinctId: 'user-1',
    properties: { amount: 42 },
    timestamp: new Date('2026-07-08T00:00:00.000Z'),
    dedupeId: 'dd-1',
    ...overrides,
  };
}

test('maps a NeutralEvent to the wire shape with distinct_id/event/properties/timestamp', () => {
  const wire = mapEventToWire(neutral());

  expect(wire.event).toBe('order_placed');
  expect(wire.distinct_id).toBe('user-1');
  expect(wire.properties).toEqual({ amount: 42 });
  expect(wire.timestamp).toBe('2026-07-08T00:00:00.000Z');
});

test('carries the neutral dedupeId to the top-level wire uuid verbatim', () => {
  const wire = mapEventToWire(neutral({ dedupeId: 'caller-supplied-key' }));
  expect(wire.uuid).toBe('caller-supplied-key');
});

test('same caller dedupeId → same wire uuid (idempotent at the backend)', () => {
  const a = mapEventToWire(neutral({ dedupeId: 'retry-key' }));
  const b = mapEventToWire(neutral({ dedupeId: 'retry-key', properties: { amount: 99 } }));
  expect(a.uuid).toBe(b.uuid);
});

test('does NOT emit $insert_id (uuid is the only dedup key)', () => {
  const wire = mapEventToWire(neutral());
  expect(JSON.stringify(wire)).not.toContain('$insert_id');
  expect(wire.properties).not.toHaveProperty('$insert_id');
});

test('a no-properties event maps to a wire event with no properties bag', () => {
  const wire = mapEventToWire(neutral({ properties: undefined }));
  expect(wire.properties).toBeUndefined();
});

test('a no-timestamp event maps to a wire event with no timestamp', () => {
  const wire = mapEventToWire(neutral({ timestamp: undefined }));
  expect(wire.timestamp).toBeUndefined();
});

test('browser-only NeutralEvent fields never leak onto the wire (plain pass-through)', () => {
  const wire = mapEventToWire(
    neutral({ isPageView: true, sessionId: 's-1', enrichmentProfile: { page: true } })
  );
  const serialized = JSON.stringify(wire);
  expect(serialized).not.toContain('isPageView');
  expect(serialized).not.toContain('sessionId');
  expect(serialized).not.toContain('enrichmentProfile');
  expect(serialized).not.toContain('geoip');
});

test('assembleBatchEnvelope wraps mapped events in { api_key, batch, sent_at }', () => {
  const now = new Date('2026-07-08T12:00:00.000Z');
  const envelope = assembleBatchEnvelope('proj-key', [neutral(), neutral({ dedupeId: 'dd-2' })], now);

  expect(envelope.api_key).toBe('proj-key');
  expect(envelope.sent_at).toBe('2026-07-08T12:00:00.000Z');
  expect(envelope.batch).toHaveLength(2);
  expect(envelope.batch[0].uuid).toBe('dd-1');
  expect(envelope.batch[1].uuid).toBe('dd-2');
});
