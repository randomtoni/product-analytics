import type { NeutralEvent } from 'analytics-kit';
import { expect, test } from 'vitest';
import {
  assembleBatchEnvelope,
  mapEventToWire,
  SET_GROUP_TRAITS_EVENT,
  SET_TRAITS_EVENT,
} from './wire-mapper';

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
    neutral({
      isPageView: true,
      sessionId: 's-1',
      enrichmentProfile: { page: true },
      internalKind: 'set_traits',
    })
  );
  const serialized = JSON.stringify(wire);
  expect(serialized).not.toContain('isPageView');
  expect(serialized).not.toContain('sessionId');
  expect(serialized).not.toContain('enrichmentProfile');
  expect(serialized).not.toContain('internalKind');
  expect(serialized).not.toContain('geoip');
});

// The trait/group normalization is recognized by the STRUCTURAL `internalKind` discriminant
// the trait verbs mint — NOT the event NAME. The wire event NAME is still SET_TRAITS_EVENT etc.

test('a set-traits event maps its stashed bag to the nested wire `set` key', () => {
  const wire = mapEventToWire(
    neutral({
      event: SET_TRAITS_EVENT,
      internalKind: 'set_traits',
      properties: { set: { plan: 'pro', seats: 5 } },
    })
  );

  expect(wire.properties).toEqual({ set: { plan: 'pro', seats: 5 } });
  expect(wire.event).toBe(SET_TRAITS_EVENT);
});

test('a set-once traits event maps its stashed bag to the nested wire `set_once` key', () => {
  const wire = mapEventToWire(
    neutral({
      event: SET_TRAITS_EVENT,
      internalKind: 'set_traits',
      properties: { set_once: { first_seen: 'today' } },
    })
  );

  expect(wire.properties).toEqual({ set_once: { first_seen: 'today' } });
  expect(wire.properties).not.toHaveProperty('set');
});

test('trait bags nest inside wire properties — never lifted to the top level (node, not browser)', () => {
  const wire = mapEventToWire(
    neutral({ event: SET_TRAITS_EVENT, internalKind: 'set_traits', properties: { set: { plan: 'pro' } } })
  );

  expect(wire).not.toHaveProperty('set');
  expect(wire).not.toHaveProperty('set_traits');
  expect(wire.properties?.set).toEqual({ plan: 'pro' });
});

test('a group-traits event maps to the nested group_type/group_key/group_set wire keys', () => {
  const wire = mapEventToWire(
    neutral({
      event: SET_GROUP_TRAITS_EVENT,
      internalKind: 'set_group_traits',
      distinctId: 'company_acme',
      properties: {
        group_type: 'company',
        group_key: 'acme',
        group_set: { name: 'Acme', size: 200 },
      },
    })
  );

  expect(wire.properties).toEqual({
    group_type: 'company',
    group_key: 'acme',
    group_set: { name: 'Acme', size: 200 },
  });
});

test('no $-prefixed vocab and no browser top-level lift key appears on trait/group wire events', () => {
  const traitWire = mapEventToWire(
    neutral({ event: SET_TRAITS_EVENT, internalKind: 'set_traits', properties: { set: { plan: 'pro' } } })
  );
  const groupWire = mapEventToWire(
    neutral({
      event: SET_GROUP_TRAITS_EVENT,
      internalKind: 'set_group_traits',
      properties: { group_type: 'company', group_key: 'acme', group_set: {} },
    })
  );

  for (const wire of [traitWire, groupWire]) {
    const serialized = JSON.stringify(wire);
    // No de-branded `$`-vocabulary leaks (the ported posthog tokens are stripped).
    expect(serialized).not.toContain('$set');
    expect(serialized).not.toContain('$group');
    // The browser's TOP-LEVEL lift keys must NOT appear at the wire root — node nests.
    expect(wire).not.toHaveProperty('set_traits');
    expect(wire).not.toHaveProperty('set_traits_once');
    expect(wire).not.toHaveProperty('set');
    expect(wire).not.toHaveProperty('group_set');
  }
});

test('a consumer event named like a trait bag key is NOT mapped as a trait event (structural recognizer)', () => {
  const wire = mapEventToWire(
    neutral({ event: 'order_placed', properties: { set: 'a real consumer prop' } })
  );

  expect(wire.properties).toEqual({ set: 'a real consumer prop' });
});

// DEFECT #14 fix (structural discriminant): a consumer event literally named `set_traits`
// (only reachable via the untyped-taxonomy escape hatch, since a typed taxonomy never
// declares a reserved-name event) has `internalKind === undefined`, so it is NOT recognized
// as a trait event — the mapper matches the STRUCTURAL discriminant, not the NAME. The
// consumer's real props survive intact; nothing is stripped to wrapper keys.
test('a consumer event named set_traits (untyped hatch, no internalKind) passes through with props INTACT', () => {
  const wire = mapEventToWire(
    neutral({ event: SET_TRAITS_EVENT, properties: { realProp: 1, another: 'x' } })
  );

  // Plain pass-through: the event name is `set_traits` AND the real props are all present,
  // NOT stripped to only `set`/`set_once` wrapper keys.
  expect(wire.event).toBe('set_traits');
  expect(wire.properties).toEqual({ realProp: 1, another: 'x' });
  expect(wire.properties?.realProp).toBe(1);
});

test('a consumer event named set_group_traits (untyped hatch, no internalKind) passes through with props INTACT', () => {
  const wire = mapEventToWire(
    neutral({ event: SET_GROUP_TRAITS_EVENT, properties: { realProp: 2 } })
  );

  expect(wire.event).toBe('set_group_traits');
  expect(wire.properties).toEqual({ realProp: 2 });
});

// Regression guard: the REAL trait verb (internalKind set) still normalizes to the nested
// wrapper shape — the fix moved recognition off the name but left the wire output unchanged.
test('a REAL set-traits event (internalKind set) still normalizes to the nested `set` wrapper — regression guard', () => {
  const wire = mapEventToWire(
    neutral({
      event: SET_TRAITS_EVENT,
      internalKind: 'set_traits',
      properties: { set: { plan: 'pro' } },
    })
  );

  expect(wire.event).toBe(SET_TRAITS_EVENT);
  expect(wire.properties).toEqual({ set: { plan: 'pro' } });
});

// The structural discriminant is NEVER wire-visible: the mapper builds WireEvent from
// explicit fields, so internalKind is dropped automatically.
test('internalKind is never emitted on the wire (dropped by the explicit-field mapping)', () => {
  const traitWire = mapEventToWire(
    neutral({ event: SET_TRAITS_EVENT, internalKind: 'set_traits', properties: { set: { plan: 'pro' } } })
  );
  const groupWire = mapEventToWire(
    neutral({
      event: SET_GROUP_TRAITS_EVENT,
      internalKind: 'set_group_traits',
      properties: { group_type: 'company', group_key: 'acme', group_set: {} },
    })
  );

  for (const wire of [traitWire, groupWire]) {
    expect(wire).not.toHaveProperty('internalKind');
    expect(JSON.stringify(wire)).not.toContain('internalKind');
  }
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
