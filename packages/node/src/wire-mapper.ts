import type { NeutralEvent, NeutralProperties } from 'analytics-kit';

// Reserved internal event NAMES the trait verbs mint under — node's own, never a
// consumer event (mirrors the browser's `MERGE_EVENT = 'identify'` adapter-internal
// name and the seam's reserved-name string-constant pattern). The wire-mapper keys
// off these to apply the trait/group [WIRE] normalization; the consumer reaches these
// paths through the `setTraits`/`setGroupTraits` verbs, never by typing the string.
export const SET_TRAITS_EVENT = 'set_traits';
export const SET_GROUP_TRAITS_EVENT = 'set_group_traits';

// Adapter-internal [WIRE] property key names, de-branded from posthog-js NODE's
// `$set`/`$set_once` (person) and `$group_type`/`$group_key`/`$group_set` (group).
// Node NESTS these inside wire `properties` (NOT the browser's top-level lift). The
// trait verbs stash the raw bags under these keys at mint; the neutral surface never
// sees them.
export const WIRE_SET_KEY = 'set';
export const WIRE_SET_ONCE_KEY = 'set_once';
export const WIRE_GROUP_TYPE_KEY = 'group_type';
export const WIRE_GROUP_KEY_KEY = 'group_key';
export const WIRE_GROUP_SET_KEY = 'group_set';

// The [WIRE] shape of a single server-side captured event and its batch envelope —
// node's OWN de-branded mapping, re-implemented (the seam defines no canonical wire
// format). Node's envelope is `{ api_key, batch, sent_at }`, entirely distinct from
// the browser adapter's `{ data: [] }` + timestamp→offset shape, so this shares no
// module with the browser wire-mapper. Every key here is adapter-internal wire
// vocabulary; none of it appears on the neutral surface.
//
// - `uuid` is the top-level idempotency key: the value carried verbatim from the
//   neutral `dedupeId` (the SAME neutral field name the browser uses), so client- and
//   server-side retries dedupe on one agreed value. It is NOT `$insert_id` (a separate
//   legacy random browser-enrichment property, never the node dedup key — not emitted).
// - No pageview/pageleave/autocapture name-swaps and no geoip toggle: those are
//   browser-only enrichment concerns. Node's mapper is a plain pass-through plus the
//   `dedupeId → uuid` placement.
export interface WireEvent {
  uuid: string;
  event: string;
  distinct_id: string;
  properties?: NeutralProperties;
  timestamp?: string;
}

export interface WireBatchEnvelope {
  api_key: string;
  batch: WireEvent[];
  sent_at: string;
}

export function mapEventToWire(event: NeutralEvent): WireEvent {
  const wire: WireEvent = {
    uuid: event.dedupeId,
    event: event.event,
    distinct_id: event.distinctId,
    properties: event.properties,
    timestamp: event.timestamp?.toISOString(),
  };

  // Recognize the adapter-internal trait/group events by the STRUCTURAL `internalKind`
  // discriminant the trait verbs mint them with — NOT by the event NAME. A consumer event
  // literally named `set_traits`/`set_group_traits` (reachable under an untyped taxonomy)
  // has `internalKind === undefined`, so it falls through to the plain pass-through above
  // with its properties intact. The emitted wire event NAME is unchanged (still SET_TRAITS_EVENT
  // etc.) — only the RECOGNITION moved off the name.
  if (event.internalKind === 'set_traits') {
    wire.properties = mapTraitProperties(event.properties);
  } else if (event.internalKind === 'set_group_traits') {
    wire.properties = mapGroupProperties(event.properties);
  }

  return wire;
}

// Rename the neutral wrapper keys the `setTraits` verb stashed the raw bags under
// (SET_KEY/SET_ONCE_KEY) into the de-branded [WIRE] `set`/`set_once` nested keys.
// Only the present bag is emitted (an absent `once` bag yields no `set_once` key).
function mapTraitProperties(properties: NeutralProperties | undefined): NeutralProperties {
  const props = properties ?? {};
  const wire: NeutralProperties = {};
  if (WIRE_SET_KEY in props) {
    wire[WIRE_SET_KEY] = props[WIRE_SET_KEY];
  }
  if (WIRE_SET_ONCE_KEY in props) {
    wire[WIRE_SET_ONCE_KEY] = props[WIRE_SET_ONCE_KEY];
  }
  return wire;
}

// Rename the neutral wrapper keys the `setGroupTraits` verb stashed into the
// de-branded [WIRE] group-identify nested keys (group_type/group_key/group_set).
function mapGroupProperties(properties: NeutralProperties | undefined): NeutralProperties {
  const props = properties ?? {};
  const wire: NeutralProperties = {};
  if (WIRE_GROUP_TYPE_KEY in props) {
    wire[WIRE_GROUP_TYPE_KEY] = props[WIRE_GROUP_TYPE_KEY];
  }
  if (WIRE_GROUP_KEY_KEY in props) {
    wire[WIRE_GROUP_KEY_KEY] = props[WIRE_GROUP_KEY_KEY];
  }
  if (WIRE_GROUP_SET_KEY in props) {
    wire[WIRE_GROUP_SET_KEY] = props[WIRE_GROUP_SET_KEY];
  }
  return wire;
}

export function assembleBatchEnvelope(
  apiKey: string,
  events: NeutralEvent[],
  now: Date
): WireBatchEnvelope {
  return {
    api_key: apiKey,
    batch: events.map(mapEventToWire),
    sent_at: now.toISOString(),
  };
}
