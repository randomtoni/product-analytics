import { RESERVED_PAGELEAVE_EVENT, type NeutralEvent, type NeutralProperties } from 'analytics-kit';
import {
  GEOIP_DISABLE_WIRE_KEY,
  MERGE_EVENT,
  PAGELEAVE_WIRE_EVENT,
  PAGEVIEW_WIRE_EVENT,
  SET_TRAITS_KEY,
  SET_TRAITS_ONCE_KEY,
} from './persistence-keys';

// The [WIRE] shape of a single captured event — the object the transport POSTs
// (S2 wraps a `data:[]` array of these). Every key here is adapter-internal wire
// vocabulary; none of it appears on the neutral surface. Kept in one place so the
// wire vocabulary lives behind the adapter and a second backend adapter maps its
// own shape from the same NeutralEvent.
//
// - `uuid` is the top-level idempotency key: the value carried verbatim from the
//   neutral `dedupeId`. It is NOT `$insert_id` (a separate legacy random
//   browser-enrichment property that is not the dedup key and is never emitted
//   here). The neutral field name is `dedupeId` — the SAME name node (E7) exposes
//   for its own idempotency key — so client- and server-side retries dedupe on one
//   agreed value.
// - On a merge/traits event (`event === MERGE_EVENT`) the two person-trait bags are
//   lifted OUT of `properties` to the top-level `set_traits` / `set_traits_once`
//   wire keys; the retained prior anon id (`anonymous_distinct_id`) stays inside
//   `properties`. All of these are de-branded [WIRE] names, never neutral surface.
export interface WireEvent {
  event: string;
  distinct_id: string;
  // Already allowlist-filtered by the neutral pipeline upstream; the mapper is the last [WIRE] boundary, NOT a filtering point.
  properties?: NeutralProperties;
  timestamp?: string;
  uuid: string;
  set_traits?: NeutralProperties;
  set_traits_once?: NeutralProperties;
}

// Lay a NeutralEvent out into its [WIRE] shape. Value-agnostic on the id: it
// carries whatever `dedupeId` holds to the top-level `uuid` — it does NOT
// re-generate or re-version the id (the id is stamped once, at capture, then
// replayed unchanged across a retry, which is all dedupe requires).
//
// This is the single wire-mapper for the E5 transport. The pass-through mapping is
// the base every event takes; the merge/traits normalization (keyed off
// `MERGE_EVENT`, the adapter-emitted merge name — NOT a consumer string) layers on
// top of it, lifting the trait bags to top-level wire keys.
// The adapter-internal, library-set wire toggles the mapper stamps onto the event.
// disableGeoip resolves once at adapter construction — never a consumer value, so it
// crosses no allowlist; it is applied here, at the [WIRE] boundary, not on the neutral
// surface.
export interface WireMapOptions {
  disableGeoip?: boolean;
}

export function mapEventToWire(event: NeutralEvent, options?: WireMapOptions): WireEvent {
  const base: WireEvent = {
    event: wireEventName(event),
    distinct_id: event.distinctId,
    properties: event.properties,
    timestamp: event.timestamp?.toISOString(),
    uuid: event.dedupeId,
  };

  const mapped =
    event.event !== MERGE_EVENT || event.properties === undefined
      ? base
      : normalizeMergeEvent(base, event.properties);

  return stampGeoipDisable(mapped, options?.disableGeoip);
}

// Stamp the [WIRE] $geoip_disable property when the library toggle is on. An event with
// no other properties still carries the flag (the properties bag is minted here if
// absent — mirrors posthog-core-stateless.ts:1168's undefined guard).
function stampGeoipDisable(wire: WireEvent, disableGeoip?: boolean): WireEvent {
  if (disableGeoip !== true) {
    return wire;
  }
  return { ...wire, properties: { ...wire.properties, [GEOIP_DISABLE_WIRE_KEY]: true } };
}

// Swap the neutral event name/marker for its [WIRE] name. A pageview is recognized by
// the neutral `isPageView` marker (its `event` name is the router path, not a fixed
// token); the pageleave by its reserved neutral event name. Every other event carries
// its neutral name through verbatim. The `$`-prefixed tokens live only here (+ their
// constants) — never on the neutral surface.
function wireEventName(event: NeutralEvent): string {
  if (event.isPageView === true) {
    return PAGEVIEW_WIRE_EVENT;
  }
  if (event.event === RESERVED_PAGELEAVE_EVENT) {
    return PAGELEAVE_WIRE_EVENT;
  }
  return event.event;
}

// Split the merge event's property bag: the two trait bags become top-level
// `set_traits` / `set_traits_once` wire keys; every other property (including the
// retained `anonymous_distinct_id` merge link) stays inside `properties`. An absent
// bag is omitted rather than emitted as an empty object.
function normalizeMergeEvent(base: WireEvent, properties: NeutralProperties): WireEvent {
  const rest: NeutralProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key === SET_TRAITS_KEY || key === SET_TRAITS_ONCE_KEY) {
      continue;
    }
    rest[key] = value;
  }

  const wire: WireEvent = {
    ...base,
    properties: Object.keys(rest).length > 0 ? rest : undefined,
  };
  if (SET_TRAITS_KEY in properties) {
    wire.set_traits = properties[SET_TRAITS_KEY] as NeutralProperties;
  }
  if (SET_TRAITS_ONCE_KEY in properties) {
    wire.set_traits_once = properties[SET_TRAITS_ONCE_KEY] as NeutralProperties;
  }
  return wire;
}

// Assemble the [WIRE] `data:[]` batch body from mapped wire events, applying the
// per-event `timestamp → offset` rewrite. `offset` is the millisecond age of the
// event relative to `now` (send time); the absolute `timestamp` is dropped in
// favour of the offset. An event with no timestamp carries no offset. This whole
// envelope shape is adapter-internal — it never reaches the neutral surface.
export function assembleBatchBody(wireEvents: WireEvent[], now: number): string {
  const data = wireEvents.map((wire) => rewriteTimestampToOffset(wire, now));
  return JSON.stringify({ data });
}

function rewriteTimestampToOffset(wire: WireEvent, now: number): Record<string, unknown> {
  const { timestamp, ...rest } = wire;
  if (timestamp === undefined) {
    return rest;
  }
  return { ...rest, offset: Math.abs(now - new Date(timestamp).getTime()) };
}
