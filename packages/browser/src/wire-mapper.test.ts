import { describe, expect, test } from 'vitest';
import { RESERVED_PAGELEAVE_EVENT, RESERVED_PAGE_EVENT, type NeutralEvent } from 'analytics-kit';
import { assembleBatchBody, mapEventToWire } from './wire-mapper';
import { containsInsertId } from './wire-scan.test-helper';
import {
  ANONYMOUS_DISTINCT_ID_KEY,
  AUTOCAPTURE_EVENT,
  AUTOCAPTURE_WIRE_EVENT,
  GROUP_IDENTIFY_EVENT,
  GROUP_IDENTIFY_WIRE_EVENT,
  GROUP_KEY_KEY,
  GROUP_SET_KEY,
  GROUP_TYPE_KEY,
  GROUPS_KEY,
  GROUPS_WIRE_KEY,
  MERGE_EVENT,
  PAGELEAVE_WIRE_EVENT,
  PAGEVIEW_WIRE_EVENT,
  SET_TRAITS_KEY,
  SET_TRAITS_ONCE_KEY,
  TOKEN_WIRE_KEY,
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

describe('wire-mapper — merge / traits normalization (S2, keyed off internalKind === "merge")', () => {
  function makeMergeEvent(properties: Record<string, unknown>): NeutralEvent {
    return makeEvent({ event: MERGE_EVENT, internalKind: 'merge', distinctId: 'user-1', properties });
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

  test('normalization is keyed off internalKind — a non-merge event carrying a trait-named key is NOT normalized', () => {
    // A non-merge event whose properties happen to carry a `set_traits`-named key is
    // left untouched: the trait bag lift fires ONLY for an adapter-minted `internalKind: merge`.
    const wire = mapEventToWire(
      makeEvent({ event: 'purchase', properties: { [SET_TRAITS_KEY]: { plan: 'pro' } } })
    );

    expect(wire.set_traits).toBeUndefined();
    expect(wire.properties?.[SET_TRAITS_KEY]).toEqual({ plan: 'pro' });
  });

  // DEFECT #14 fix (structural discriminant): a consumer event literally named `identify`
  // (= MERGE_EVENT, reachable only via the untyped-taxonomy escape hatch) has no internalKind,
  // so it is NOT misrouted through the merge normalization — its real props survive intact and
  // its own event name is preserved (never swapped to a wire merge name).
  test('a consumer event named identify (untyped hatch, no internalKind) passes through with props INTACT', () => {
    const wire = mapEventToWire(
      makeEvent({ event: MERGE_EVENT, properties: { [SET_TRAITS_KEY]: { plan: 'pro' }, real: 1 } })
    );

    // No lift: the `set_traits`-named key stays a plain consumer prop inside properties, the
    // sibling `real` prop is kept, and the event name is the consumer's own `identify`.
    expect(wire.event).toBe(MERGE_EVENT);
    expect(wire.set_traits).toBeUndefined();
    expect(wire.properties).toEqual({ [SET_TRAITS_KEY]: { plan: 'pro' }, real: 1 });
  });

  // Regression guard: a REAL merge event (internalKind set) still lifts the trait bags.
  test('a REAL merge event (internalKind: merge) still lifts the trait bags — regression guard', () => {
    const wire = mapEventToWire(makeMergeEvent({ [SET_TRAITS_KEY]: { plan: 'pro' } }));

    expect(wire.set_traits).toEqual({ plan: 'pro' });
    expect(wire.properties).toBeUndefined();
  });

  // The structural discriminant is never wire-visible.
  test('internalKind is never emitted on a merge wire event (dropped by the explicit-field mapping)', () => {
    const wire = mapEventToWire(makeMergeEvent({ [SET_TRAITS_KEY]: { plan: 'pro' } }));

    expect(wire).not.toHaveProperty('internalKind');
    expect(JSON.stringify(wire)).not.toContain('internalKind');
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

describe('wire-mapper — pageview / pageleave [WIRE] event names (E6-S2)', () => {
  test('a page-marked event maps to the [WIRE] $pageview name (keyed off the isPageView marker, NOT the event name)', () => {
    // A named page carries the router path as its neutral event name; the marker, not
    // the name, drives the mapping to $pageview.
    const wire = mapEventToWire(makeEvent({ event: '/dashboard', isPageView: true }));

    expect(wire.event).toBe(PAGEVIEW_WIRE_EVENT);
    expect(wire.event).toBe('$pageview');
  });

  test('a nameless-page-marked event (neutral name "page") also maps to $pageview', () => {
    const wire = mapEventToWire(makeEvent({ event: RESERVED_PAGE_EVENT, isPageView: true }));

    expect(wire.event).toBe('$pageview');
  });

  test('a plain event named "page" WITHOUT the marker is NOT mapped to $pageview (marker-keyed)', () => {
    // The name is not the discriminator: a track('page') with no marker stays 'page'.
    const wire = mapEventToWire(makeEvent({ event: RESERVED_PAGE_EVENT }));

    expect(wire.event).toBe('page');
  });

  test('the adapter-minted pageleave (internalKind: pageleave) maps to the [WIRE] $pageleave name (FIX #2, keyed off internalKind)', () => {
    const wire = mapEventToWire(
      makeEvent({ event: RESERVED_PAGELEAVE_EVENT, internalKind: 'pageleave' })
    );

    expect(wire.event).toBe(PAGELEAVE_WIRE_EVENT);
    expect(wire.event).toBe('$pageleave');
  });

  test('FIX #2: a consumer event literally named "pageleave" (untyped hatch, NO internalKind) is NOT renamed to $pageleave', () => {
    // Before the fix wireEventName matched the event NAME, so a consumer track('pageleave')
    // was silently renamed to the wire $pageleave. Now the rename keys off internalKind, so a
    // consumer-minted pageleave (no internalKind) keeps its own name and its props intact.
    const wire = mapEventToWire(
      makeEvent({ event: RESERVED_PAGELEAVE_EVENT, properties: { x: 1 } })
    );

    expect(wire.event).toBe('pageleave');
    expect(wire.event).not.toContain('$');
    expect(wire.properties).toMatchObject({ x: 1 });
  });

  test('the adapter-minted autocapture event maps to the [WIRE] $autocapture name (E6-S7, keyed off internalKind)', () => {
    const wire = mapEventToWire(makeEvent({ event: AUTOCAPTURE_EVENT, internalKind: 'autocapture' }));

    expect(wire.event).toBe(AUTOCAPTURE_WIRE_EVENT);
    expect(wire.event).toBe('$autocapture');
    // The neutral event name carries no vendor `$`-prefix.
    expect(AUTOCAPTURE_EVENT).not.toContain('$');
  });

  test('an autocapture event carries its element-metadata properties + uuid through unchanged', () => {
    const wire = mapEventToWire(
      makeEvent({
        event: AUTOCAPTURE_EVENT,
        internalKind: 'autocapture',
        properties: { event_type: 'click', el_text: 'Buy', elements_chain: 'button:...' },
        dedupeId: 'ac-1',
      })
    );

    expect(wire.event).toBe('$autocapture');
    expect(wire.properties).toEqual({
      event_type: 'click',
      el_text: 'Buy',
      elements_chain: 'button:...',
    });
    expect(wire.uuid).toBe('ac-1');
  });

  // DEFECT #14 fix: a consumer event literally named `autocapture` (untyped hatch, no
  // internalKind) is NOT swapped to $autocapture — it keeps its own name and props.
  test('a consumer event named autocapture (no internalKind) keeps its own name + props', () => {
    const wire = mapEventToWire(
      makeEvent({ event: AUTOCAPTURE_EVENT, properties: { real: 1 } })
    );

    expect(wire.event).toBe(AUTOCAPTURE_EVENT);
    expect(wire.event).not.toBe('$autocapture');
    expect(wire.properties).toEqual({ real: 1 });
  });

  test('a pageview carries its properties + uuid through unchanged — only the event name is swapped', () => {
    const wire = mapEventToWire(
      makeEvent({ event: '/pricing', isPageView: true, properties: { ref: 'nav' }, dedupeId: 'pv-1' })
    );

    expect(wire.event).toBe('$pageview');
    expect(wire.properties).toEqual({ ref: 'nav' });
    expect(wire.uuid).toBe('pv-1');
    // The isPageView marker is a pipeline discriminator, never a wire key — belt-and-braces
    // the closed-WireEvent guarantee against a future refactor that spreads the event into base.
    expect(wire).not.toHaveProperty('isPageView');
  });

  test('an ordinary event name is carried through verbatim (no accidental $-mapping)', () => {
    expect(mapEventToWire(makeEvent({ event: 'purchase' })).event).toBe('purchase');
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

describe('wire-mapper — token stamps the [WIRE] auth key in-body on EVERY event (FIX #1)', () => {
  const KEY = 'proj-key-abc';

  test('stamps properties.token === the key on a plain event, alongside existing properties', () => {
    const wire = mapEventToWire(makeEvent({ properties: { plan: 'pro' } }), { token: KEY });

    expect(wire.properties?.[TOKEN_WIRE_KEY]).toBe(KEY);
    expect(wire.properties).toMatchObject({ plan: 'pro', token: KEY });
  });

  test('mints a properties bag carrying the token when the event had NO properties (undefined guard)', () => {
    const wire = mapEventToWire(makeEvent({ properties: undefined }), { token: KEY });

    // The bag was minted just to carry the auth key — without a body key the endpoint
    // rejects the event; the whole FIX #1 defect was the missing per-event key.
    expect(wire.properties).toEqual({ token: KEY });
    expect(wire.properties?.[TOKEN_WIRE_KEY]).toBe(KEY);
  });

  test('EVERY mapped event across a mixed set carries properties.token (plain, page, autocapture, no-props)', () => {
    const events = [
      makeEvent({ event: 'purchase', properties: { a: 1 } }),
      makeEvent({ event: '/dashboard', isPageView: true }),
      makeEvent({ event: AUTOCAPTURE_EVENT, properties: { event_type: 'click' } }),
      makeEvent({ event: 'no_props', properties: undefined }),
    ];

    for (const event of events) {
      const wire = mapEventToWire(event, { token: KEY });
      expect(wire.properties?.[TOKEN_WIRE_KEY]).toBe(KEY);
    }
  });

  test('stamps the token on a merge event AFTER trait-bag normalization — it lands INSIDE properties, not a trait bag', () => {
    const wire = mapEventToWire(
      makeEvent({
        event: MERGE_EVENT,
        internalKind: 'merge',
        properties: {
          [ANONYMOUS_DISTINCT_ID_KEY]: 'anon-1',
          [SET_TRAITS_KEY]: { plan: 'pro' },
        },
      }),
      { token: KEY }
    );

    // Trait bag lifted to a top-level wire key; the token rides inside properties with the
    // retained merge link, never inside the lifted trait bag.
    expect(wire.set_traits).toEqual({ plan: 'pro' });
    expect(wire.properties).toMatchObject({ [ANONYMOUS_DISTINCT_ID_KEY]: 'anon-1', token: KEY });
    expect(wire.set_traits).not.toHaveProperty(TOKEN_WIRE_KEY);
  });

  test('token + geoip compose — both wire stamps land in properties on the same event', () => {
    const wire = mapEventToWire(makeEvent({ properties: { a: 1 } }), {
      token: KEY,
      disableGeoip: true,
    });

    expect(wire.properties).toMatchObject({ a: 1, token: KEY, $geoip_disable: true });
  });

  test('omits the token when no token option is supplied (an unkeyed / no-delivery client)', () => {
    const wire = mapEventToWire(makeEvent({ properties: { plan: 'pro' } }));

    expect(wire.properties ?? {}).not.toHaveProperty(TOKEN_WIRE_KEY);
  });

  test('the token rides IN-BODY (properties), never a top-level envelope key or the event name', () => {
    const wire = mapEventToWire(makeEvent({ properties: undefined }), { token: KEY });

    // Belt-and-braces: the auth key is inside properties (survives gzip + beacon), not a
    // sibling of `event`/`distinct_id`/`uuid`.
    expect(wire).not.toHaveProperty(TOKEN_WIRE_KEY);
    expect(wire.properties?.[TOKEN_WIRE_KEY]).toBe(KEY);
  });
});

describe('wire-mapper — disableGeoip stamps the [WIRE] $geoip_disable property (E6-S6)', () => {
  test('stamps $geoip_disable: true into properties when the toggle is on', () => {
    const wire = mapEventToWire(makeEvent({ properties: { plan: 'pro' } }), { disableGeoip: true });

    expect(wire.properties).toMatchObject({ plan: 'pro', $geoip_disable: true });
  });

  test('mints a properties bag carrying the flag when the event has NO properties (undefined guard)', () => {
    const wire = mapEventToWire(makeEvent({ properties: undefined }), { disableGeoip: true });

    expect(wire.properties).toEqual({ $geoip_disable: true });
  });

  test('omits $geoip_disable when the toggle is absent (default)', () => {
    const wire = mapEventToWire(makeEvent({ properties: { plan: 'pro' } }));

    expect(wire.properties ?? {}).not.toHaveProperty('$geoip_disable');
  });

  test('omits $geoip_disable when the toggle is explicitly false', () => {
    const wire = mapEventToWire(makeEvent({ properties: { plan: 'pro' } }), { disableGeoip: false });

    expect(wire.properties ?? {}).not.toHaveProperty('$geoip_disable');
  });

  test('stamps the flag on a merge event AFTER the trait-bag normalization (both wire transforms compose)', () => {
    const wire = mapEventToWire(
      makeEvent({
        event: MERGE_EVENT,
        internalKind: 'merge',
        properties: {
          [ANONYMOUS_DISTINCT_ID_KEY]: 'anon-1',
          [SET_TRAITS_KEY]: { plan: 'pro' },
          [SET_TRAITS_ONCE_KEY]: { signup: '2026' },
        },
      }),
      { disableGeoip: true }
    );

    // The trait bags were lifted to top-level wire keys; the merge link + the geoip flag
    // remain inside properties.
    expect(wire.set_traits).toEqual({ plan: 'pro' });
    expect(wire.set_traits_once).toEqual({ signup: '2026' });
    expect(wire.properties).toMatchObject({
      [ANONYMOUS_DISTINCT_ID_KEY]: 'anon-1',
      $geoip_disable: true,
    });
    expect(wire.properties ?? {}).not.toHaveProperty(SET_TRAITS_KEY);
  });
});

describe('wire-mapper — group-identify event name + nested group keys (FIX #8)', () => {
  test('maps an adapter-minted group-identify event to the [WIRE] $groupidentify name (keyed off internalKind)', () => {
    const wire = mapEventToWire(
      makeEvent({ event: GROUP_IDENTIFY_EVENT, internalKind: 'group_identify' })
    );

    expect(wire.event).toBe(GROUP_IDENTIFY_WIRE_EVENT);
    expect(wire.event).toBe('$groupidentify');
    // The neutral event name carries no vendor `$`-prefix.
    expect(GROUP_IDENTIFY_EVENT).not.toContain('$');
  });

  test('the group type/key/set stay NESTED in properties — not lifted to top-level (unlike set_traits)', () => {
    const wire = mapEventToWire(
      makeEvent({
        event: GROUP_IDENTIFY_EVENT,
        internalKind: 'group_identify',
        properties: {
          [GROUP_TYPE_KEY]: 'company',
          [GROUP_KEY_KEY]: 'acme',
          [GROUP_SET_KEY]: { plan: 'pro' },
        },
        dedupeId: 'gi-1',
      })
    );

    expect(wire.properties).toMatchObject({
      [GROUP_TYPE_KEY]: 'company',
      [GROUP_KEY_KEY]: 'acme',
      [GROUP_SET_KEY]: { plan: 'pro' },
    });
    // Nested, never top-level fields on the wire event.
    expect(wire).not.toHaveProperty(GROUP_TYPE_KEY);
    expect(wire).not.toHaveProperty(GROUP_KEY_KEY);
    expect(wire.uuid).toBe('gi-1');
  });

  // DEFECT #14 fix: a consumer event literally named `group_identify` (no internalKind)
  // is NOT swapped to $groupidentify — it keeps its own name and props.
  test('a consumer event named group_identify (no internalKind) keeps its own name + props', () => {
    const wire = mapEventToWire(
      makeEvent({ event: GROUP_IDENTIFY_EVENT, properties: { real: 1 } })
    );

    expect(wire.event).toBe(GROUP_IDENTIFY_EVENT);
    expect(wire.event).not.toBe('$groupidentify');
    expect(wire.properties).toEqual({ real: 1 });
  });

  // The structural discriminant is never wire-visible on an autocapture / group-identify event.
  test('internalKind is never emitted on an autocapture or group-identify wire event', () => {
    const acWire = mapEventToWire(
      makeEvent({ event: AUTOCAPTURE_EVENT, internalKind: 'autocapture', properties: { a: 1 } })
    );
    const giWire = mapEventToWire(
      makeEvent({ event: GROUP_IDENTIFY_EVENT, internalKind: 'group_identify', properties: { g: 1 } })
    );

    for (const wire of [acWire, giWire]) {
      expect(wire).not.toHaveProperty('internalKind');
      expect(JSON.stringify(wire)).not.toContain('internalKind');
    }
  });
});

describe('wire-mapper — groups super-prop renamed to $groups on EVERY event (FIX #8)', () => {
  test('renames the neutral `groups` super-prop to its [WIRE] $groups form in properties', () => {
    const wire = mapEventToWire(
      makeEvent({ event: 'purchase', properties: { [GROUPS_KEY]: { company: 'acme' }, plan: 'pro' } })
    );

    expect(wire.properties?.[GROUPS_WIRE_KEY]).toEqual({ company: 'acme' });
    // The neutral key is gone (renamed), the co-resident prop untouched.
    expect(wire.properties).not.toHaveProperty(GROUPS_KEY);
    expect(wire.properties?.plan).toBe('pro');
  });

  test('the rename runs on a PLAIN event (pass-through path), not only group-identify', () => {
    const wire = mapEventToWire(
      makeEvent({ event: 'any_event', properties: { [GROUPS_KEY]: { workspace: 'w1' } } })
    );

    expect(wire.properties?.[GROUPS_WIRE_KEY]).toEqual({ workspace: 'w1' });
  });

  test('an event WITHOUT the groups super-prop is untouched (no $groups minted)', () => {
    const wire = mapEventToWire(makeEvent({ event: 'purchase', properties: { plan: 'pro' } }));

    expect(wire.properties ?? {}).not.toHaveProperty(GROUPS_WIRE_KEY);
    expect(wire.properties ?? {}).not.toHaveProperty(GROUPS_KEY);
  });

  test('groups rename + token compose on the same event', () => {
    const wire = mapEventToWire(
      makeEvent({ properties: { [GROUPS_KEY]: { company: 'acme' } } }),
      { token: 'k-1' }
    );

    expect(wire.properties?.[GROUPS_WIRE_KEY]).toEqual({ company: 'acme' });
    expect(wire.properties?.[TOKEN_WIRE_KEY]).toBe('k-1');
  });

  test('FIX #3: a CONSUMER property literally named `groups` (no reserved prefix) reaches the wire as `groups`, uncorrupted', () => {
    // The internal membership key is now the reserved-prefix GROUPS_KEY ('__ak_groups'); a
    // consumer key named `groups` has no reserved prefix ⇒ policy undefined ⇒ NOT renamed. Before
    // the fix the blanket `groups in properties` check corrupted it to $groups.
    const wire = mapEventToWire(
      makeEvent({ event: 'purchase', properties: { groups: { a: 1 }, plan: 'pro' } })
    );

    // The consumer key rides UNTOUCHED under its own name.
    expect(wire.properties?.groups).toEqual({ a: 1 });
    // No internal wire rename happened — there was no reserved-prefix membership key.
    expect(wire.properties).not.toHaveProperty(GROUPS_WIRE_KEY);
    expect(wire.properties?.plan).toBe('pro');
  });

  test('FIX #3: a consumer `groups` prop and the library membership super-prop COEXIST on ONE event', () => {
    // Both live on the same event: the reserved-prefix membership key (GROUPS_KEY = '__ak_groups')
    // and a consumer key named `groups`. The membership renames to $groups; the consumer key stays.
    const wire = mapEventToWire(
      makeEvent({
        event: 'purchase',
        properties: { [GROUPS_KEY]: { company: 'acme' }, groups: { consumerOwned: true } },
      })
    );

    expect(wire.properties?.[GROUPS_WIRE_KEY]).toEqual({ company: 'acme' });
    expect(wire.properties?.groups).toEqual({ consumerOwned: true });
    // The two are distinct keys on the wire — the consumer's is not the wire membership key.
    expect(GROUPS_WIRE_KEY).not.toBe('groups');
  });
});
